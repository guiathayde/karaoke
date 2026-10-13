"""Pontuação de letra ao vivo.

O palco manda o áudio de cada microfone (16 kHz, int16) com o tempo do vídeo. O Whisper transcreve
em blocos conforme o áudio chega e cada linha da letra é comparada com as palavras ouvidas na sua
janela de tempo. A linha é creditada ao cantor dono dela (dueto: estrofes alternadas) ou ao cantor
do microfone, quando há um canal por pessoa.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from itertools import pairwise

import numpy as np

from . import asr
from .models import LyricLine, QueueEntry, Singer, Song

log = logging.getLogger("karaoke.lyric")

GATE_RMS = 0.01  # abaixo disso o microfone está em silêncio
MIN_NEW_AUDIO = 6.0  # segundos acumulados antes de transcrever um bloco
OVERLAP = 1.5


def lyric_blocks(lines: list[LyricLine]) -> list[int]:
    """Mesma regra da tela: estrofe nova em pausa longa, linha vazia ou a cada 4 linhas."""
    gaps = sorted(b.t - a.t for a, b in pairwise(lines) if b.t - a.t > 0)
    median = gaps[len(gaps) // 2] if gaps else 4.0
    threshold = max(3.5, median * 2.2)
    blocks: list[int] = []
    block, size, prev_t, prev_empty = -1, 0, float("-inf"), False
    for line in lines:
        empty = line.text.strip() == ""
        if line.t - prev_t > threshold or prev_empty or size >= 4:
            block += 1
            size = 0
        blocks.append(block)
        size += 1
        prev_t, prev_empty = line.t, empty
    return blocks


@dataclass
class MicStream:
    chunks: list[tuple[float, np.ndarray]] = field(default_factory=list)
    latest: float = -1.0

    def add(self, t: float, samples: np.ndarray) -> None:
        if t < self.latest - 5:  # voltou no tempo (recomeçar): descarta o que veio depois
            self.chunks = [(ct, c) for ct, c in self.chunks if ct < t]
        self.chunks.append((t, samples))
        self.latest = max(self.latest, t + len(samples) / asr.SR)
        if len(self.chunks) > 4000:  # ~7 min de áudio
            del self.chunks[:1000]

    def audio(self, t0: float, t1: float) -> np.ndarray:
        parts = [c for ct, c in self.chunks if ct + len(c) / asr.SR > t0 and ct < t1]
        if not parts:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(parts).astype(np.float32) / 32768.0

    def rms(self, t0: float, t1: float) -> float:
        y = self.audio(t0, t1)
        return float(np.sqrt(np.mean(y * y))) if y.size else 0.0


class LyricScorer:
    def __init__(
        self,
        entry: QueueEntry,
        song: Song,
        singers: dict[str, Singer],
        model_name: str,
        send: Callable[[dict], Awaitable[None]],
    ) -> None:
        self.entry = entry
        self.song = song
        self.singers = singers
        self.model_name = model_name
        self.send = send
        lines = song.lyrics or []
        blocks = lyric_blocks(lines)
        self.language = asr.guess_language([line.text for line in lines])
        self.lines: list[tuple[int, LyricLine, float, float]] = []  # (índice, linha, início, fim da janela)
        for i, line in enumerate(lines):
            if not line.text.strip():
                continue
            nxt = lines[i + 1].t if i + 1 < len(lines) else line.t + 6
            end = min(nxt, line.t + 8)
            self.lines.append((i, line, line.t - 1.0, end + 1.0))
        self.owner: dict[int, str | None] = {}
        for i, line in enumerate(lines):
            if len(entry.singer_ids) >= 2:
                idx = blocks[i] % 2
                if entry.duet_swap:
                    idx = 1 - idx
                self.owner[i] = entry.singer_ids[idx]
            else:
                self.owner[i] = entry.singer_ids[0] if entry.singer_ids else None
        self.streams: dict[int, MicStream] = {}
        self.heard: dict[int, list[asr.Word]] = {}
        self.transcribed_until: dict[int, float] = {}
        self.scored: set[tuple[int, int]] = set()
        self.points: dict[str, float] = {}
        self.busy = False
        self._task: asyncio.Task | None = None

    # --- entrada de áudio ---------------------------------------------------
    def feed(self, mic: int, t: float, samples: np.ndarray) -> None:
        if mic not in self.streams:
            self.streams[mic] = MicStream()
            self.heard[mic] = []
            self.transcribed_until[mic] = 0.0
        self.streams[mic].add(t, samples)
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None

    # --- laço de transcrição e avaliação -----------------------------------
    async def _loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(0.5)
                for mic in list(self.streams):
                    await self._transcribe_pending(mic)
                    await self._score_ready(mic)
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("pontuação de letra falhou")

    async def _transcribe_pending(self, mic: int) -> None:
        stream = self.streams[mic]
        last = self.transcribed_until[mic]
        if stream.latest - last < MIN_NEW_AUDIO or self.busy:
            return
        t0 = max(0.0, last - OVERLAP)
        t1 = stream.latest
        y = stream.audio(t0, t1)
        if y.size < asr.SR:
            return
        self.busy = True
        try:
            words = await asyncio.to_thread(
                asr.transcribe_words, y, self.model_name, self.language, t0=t0, beam_size=1, block=t1 - t0 + 1, step=t1 - t0 + 1
            )
        finally:
            self.busy = False
        self.heard[mic].extend(w for w in words if w.start >= last)
        self.transcribed_until[mic] = t1

    async def _score_ready(self, mic: int) -> None:
        until = self.transcribed_until[mic]
        for i, line, start, end in self.lines:
            if (i, mic) in self.scored or until < end + 0.3:
                continue
            self.scored.add((i, mic))
            singer_id = self._credit(mic, i)
            if singer_id is None:
                continue
            stream = self.streams[mic]
            heard = [w.token for w in self.heard[mic] if start <= w.start < end]
            score = asr.match_ratio(line.text, heard) if stream.rms(start, end) >= GATE_RMS else 0.0
            self.points[singer_id] = self.points.get(singer_id, 0.0) + score
            await self.send(
                {
                    "type": "lyric",
                    "entry_id": self.entry.id,
                    "line": i,
                    "mic": mic,
                    "singer_id": singer_id,
                    "score": round(score, 2),
                    "heard": " ".join(heard)[:80],
                    "totals": self.totals(),
                }
            )

    def _credit(self, mic: int, line_index: int) -> str | None:
        owner = self.owner.get(line_index)
        mic_singer = next((s.id for s in self.singers.values() if s.mic == mic), None)
        if len(self.streams) <= 1:
            return owner or mic_singer or f"mic{mic}"
        if len(self.entry.singer_ids) >= 2:
            # dueto com um canal por pessoa: só o dono da linha pontua nela
            if mic_singer is not None and mic_singer != owner:
                return None
            return owner
        return mic_singer or (owner if mic == 1 else f"mic{mic}")

    def lines_for(self, singer_id: str) -> int:
        if len(self.entry.singer_ids) >= 2 and singer_id in self.entry.singer_ids:
            return sum(1 for i, _, _, _ in self.lines if self.owner.get(i) == singer_id)
        return len(self.lines)

    def totals(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for singer_id, pts in self.points.items():
            n = max(1, self.lines_for(singer_id))
            out[singer_id] = round(10000 * pts / n)
        return out
