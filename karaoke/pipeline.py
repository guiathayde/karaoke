"""Worker que prepara as músicas da fila: download, separação de voz, mux e letra."""

from __future__ import annotations

import asyncio
import logging
import subprocess
from collections.abc import Callable
from pathlib import Path

from . import lyrics as lyrics_api
from . import melody, separator, youtube
from .config import Settings
from .models import QueueEntry, Song, Video
from .storage import (
    AUDIO,
    INSTRUMENTAL,
    INSTRUMENTAL_WAV,
    MELODY,
    ORIGINAL,
    VOCALS,
    VOCALS_WAV,
    Storage,
    variant_name,
)

log = logging.getLogger("karaoke.pipeline")


def needs_instrumental(entry: QueueEntry, settings: Settings) -> bool:
    return settings.separation_enabled and not entry.is_karaoke_version


def entry_is_ready(entry: QueueEntry, song: Song | None, settings: Settings) -> bool:
    if song is None or song.status != "ready":
        return False
    if needs_instrumental(entry, settings):
        return song.has_instrumental
    return song.has_original


def base_file(entry: QueueEntry, settings: Settings) -> str:
    return INSTRUMENTAL if needs_instrumental(entry, settings) else ORIGINAL


def entry_variant_name(entry: QueueEntry, settings: Settings) -> str | None:
    if entry.key_shift == 0:
        return None
    return variant_name(base_file(entry, settings), entry.key_shift)


class Pipeline:
    def __init__(
        self,
        settings: Settings,
        storage: Storage,
        notify: Callable[[], None],
        notify_threadsafe: Callable[[], None],
        pending_entries: Callable[[], list[QueueEntry]],
        protected_ids: Callable[[], set[str]],
    ) -> None:
        self.settings = settings
        self.storage = storage
        self.notify = notify
        self.notify_threadsafe = notify_threadsafe
        self.pending_entries = pending_entries
        self.protected_ids = protected_ids
        self.wake = asyncio.Event()
        self.current_id: str | None = None
        self._failed_variants: set[str] = set()
        self._failed_melody: set[str] = set()

    def kick(self) -> None:
        self.wake.set()

    async def run(self) -> None:
        while True:
            job = self._pick()
            if job is None:
                self.wake.clear()
                await self.wake.wait()
                continue
            entry, song, kind = job
            self.current_id = song.video.yt_id
            try:
                if kind == "base":
                    await self._process(entry, song)
                elif kind == "melody":
                    await self._render_melody(song)
                else:
                    await self._render_key(entry, song)
            except Exception as exc:
                log.exception("falha ao processar %s (%s)", song.video.yt_id, kind)
                if kind == "base":
                    song.status = "error"
                    song.error = str(exc)[:300]
                elif kind == "melody":
                    self._failed_melody.add(song.video.yt_id)
                else:
                    song.rendering = None
                    self._failed_variants.add(entry_variant_name(entry, self.settings) or "")
                self.storage.save(song)
            finally:
                self.current_id = None
                self.notify()
            self._enforce_cache_limit()

    def _pick(self) -> tuple[QueueEntry, Song, str] | None:
        for entry in self.pending_entries():
            song = self.storage.get(entry.yt_id)
            if song is None:
                continue
            if song.status == "error" and song.error:
                continue
            if not entry_is_ready(entry, song, self.settings):
                return entry, song, "base"
        for entry in self.pending_entries():
            song = self.storage.get(entry.yt_id)
            if song is None or not entry_is_ready(entry, song, self.settings):
                continue
            if song.has_vocals and not song.has_melody and song.video.yt_id not in self._failed_melody:
                return entry, song, "melody"
        for entry in self.pending_entries():
            song = self.storage.get(entry.yt_id)
            variant = entry_variant_name(entry, self.settings)
            if song is None or variant is None or variant in song.variants or variant in self._failed_variants:
                continue
            if entry_is_ready(entry, song, self.settings):
                return entry, song, "key"
        return None

    # --- etapas -----------------------------------------------------------
    async def _process(self, entry: QueueEntry, song: Song) -> None:
        yt_id = song.video.yt_id
        song.error = None

        if not song.has_original:
            await self._set(song, "downloading")
            video = await asyncio.to_thread(
                youtube.download,
                yt_id,
                self.storage.path(yt_id, ORIGINAL),
                self.settings.max_height,
                lambda p: self._progress(song, p),
            )
            song.video = Video(**{**song.video.model_dump(), **video.model_dump()})
            self.storage.save(song)

        if needs_instrumental(entry, self.settings) and not song.has_instrumental:
            await self._set(song, "separating")
            await asyncio.to_thread(self._separate, yt_id, song)
            await self._set(song, "muxing")
            await asyncio.to_thread(self._mux, yt_id)
            self.storage.save(song)

        if song.has_vocals and not song.has_melody:
            await self._set(song, "melody")
            try:
                voiced = await asyncio.to_thread(
                    melody.extract, self.storage.path(yt_id, VOCALS), self.storage.path(yt_id, MELODY)
                )
                log.info("melodia de %s: %d frames com voz", yt_id, voiced)
            except Exception:
                log.exception("falha ao extrair melodia de %s", yt_id)
            self.storage.save(song)

        if song.lyrics is None and song.lyrics_source is None:
            await self._set(song, "lyrics")
            found = await lyrics_api.fetch_synced(song.video.title, song.video.duration)
            if found:
                song.lyrics, song.lyrics_source = found
            else:
                song.lyrics_source = "none"
            self.storage.save(song)

        song.progress = 1.0
        await self._set(song, "ready")

    async def _render_melody(self, song: Song) -> None:
        """Melodia para músicas já em cache (sem mudar o status, para não interromper a reprodução)."""
        yt_id = song.video.yt_id
        voiced = await asyncio.to_thread(
            melody.extract, self.storage.path(yt_id, VOCALS), self.storage.path(yt_id, MELODY)
        )
        self.storage.save(song)
        log.info("melodia de %s (cache): %d frames com voz", yt_id, voiced)

    async def _render_key(self, entry: QueueEntry, song: Song) -> None:
        """Gera a variante com o tom alterado (rubberband) mantendo o andamento."""
        yt_id = song.video.yt_id
        base = base_file(entry, self.settings)
        variant = variant_name(base, entry.key_shift)
        song.rendering = variant
        self.storage.save(song)
        self.notify()
        await asyncio.to_thread(self._rubberband, yt_id, base, variant, entry.key_shift)
        song.rendering = None
        self.storage.save(song)
        log.info("tom %+d pronto para %s", entry.key_shift, yt_id)

    def _rubberband(self, yt_id: str, base: str, variant: str, semitones: int) -> None:
        d = self.storage.song_dir(yt_id)
        # a voz guia (vocais separados) precisa acompanhar o tom novo
        vocals = d / VOCALS
        if vocals.exists():
            _shift_audio(vocals, d / variant_name(VOCALS, semitones), semitones, video_source=None)
        _shift_audio(d / base, d / variant, semitones, video_source=d / base)

    def _separate(self, yt_id: str, song: Song) -> None:
        audio = self.storage.path(yt_id, AUDIO)
        if not audio.exists():
            _ffmpeg("-i", str(self.storage.path(yt_id, ORIGINAL)), "-vn", "-ac", "2", "-ar", "44100", str(audio))
        separator.separate(
            audio,
            self.storage.path(yt_id, INSTRUMENTAL_WAV),
            self.storage.path(yt_id, VOCALS_WAV),
            model=self.settings.separation_model,
            model_dir=self.settings.models_dir,
            tmp_dir=self.settings.tmp_dir,
            audio_seconds=song.video.duration,
            on_progress=lambda p: self._progress(song, p),
        )
        audio.unlink(missing_ok=True)

    def _mux(self, yt_id: str) -> None:
        out = self.storage.path(yt_id, INSTRUMENTAL)
        inst_wav = self.storage.path(yt_id, INSTRUMENTAL_WAV)
        voc_wav = self.storage.path(yt_id, VOCALS_WAV)
        _ffmpeg(
            "-i", str(self.storage.path(yt_id, ORIGINAL)),
            "-i", str(inst_wav),
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
            str(out),
        )
        if voc_wav.exists():
            _ffmpeg("-i", str(voc_wav), "-c:a", "aac", "-b:a", "160k", str(self.storage.path(yt_id, VOCALS)))
        inst_wav.unlink(missing_ok=True)
        voc_wav.unlink(missing_ok=True)

    async def _set(self, song: Song, status: str) -> None:
        song.status = status  # type: ignore[assignment]
        song.progress = 0.0
        self.storage.save(song)
        self.notify()

    def _progress(self, song: Song, value: float) -> None:
        if abs(value - song.progress) >= 0.02 or value >= 1.0:
            song.progress = value
            self.notify_threadsafe()

    def _enforce_cache_limit(self) -> None:
        limit = int(self.settings.cache_limit_gb * 1024**3)
        removed = self.storage.enforce_limit(limit, self.protected_ids())
        if removed:
            log.info("cache acima do limite, removidas: %s", removed)
            self.notify()


def _shift_audio(src: Path, dst: Path, semitones: int, video_source: Path | None) -> None:
    """Muda o tom do áudio de `src` com o Rubber Band. Com `video_source`, remonta o mp4 com o vídeo."""
    src_wav = dst.with_name(dst.name + ".src.wav")
    out_wav = dst.with_name(dst.name + ".out.wav")
    try:
        _ffmpeg("-i", str(src), "-vn", "-ac", "2", "-ar", "44100", str(src_wav))
        result = subprocess.run(
            ["rubberband", "-q", "-p", str(semitones), "-c", "4", str(src_wav), str(out_wav)],
            capture_output=True, text=True, check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(f"rubberband falhou: {result.stderr.strip()[-300:]}")
        if video_source is not None:
            _ffmpeg(
                "-i", str(video_source), "-i", str(out_wav),
                "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
                str(dst),
            )
        else:
            _ffmpeg("-i", str(out_wav), "-c:a", "aac", "-b:a", "160k", str(dst))
    finally:
        src_wav.unlink(missing_ok=True)
        out_wav.unlink(missing_ok=True)


def _ffmpeg(*args: str) -> None:
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg falhou: {result.stderr.strip()[-300:]}")
