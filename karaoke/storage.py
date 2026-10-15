"""Cache de músicas em SQLite + arquivos em disco (data/media/<yt_id>/)."""

from __future__ import annotations

import re
import shutil
import sqlite3
import time
from pathlib import Path

from .melody import key_from_file
from .models import Song

ORIGINAL = "original.mp4"
AUDIO = "audio.wav"
INSTRUMENTAL_WAV = "instrumental.wav"
VOCALS_WAV = "vocals.wav"
VOCALS = "vocals.m4a"
INSTRUMENTAL = "instrumental.mp4"
MELODY = "melody.json"

_VARIANT = re.compile(r"^(?:(?:original|instrumental)_k[+-]\d{1,2}\.mp4|vocals_k[+-]\d{1,2}\.m4a)$")
_MEDIA = re.compile(
    r"^(?:(?:original|instrumental)(?:_k[+-]\d{1,2})?\.mp4|vocals(?:_k[+-]\d{1,2})?\.m4a|melody\.json)$"
)


def variant_name(base: str, semitones: int) -> str:
    """instrumental.mp4, +2 -> instrumental_k+2.mp4; vocals.m4a, -1 -> vocals_k-1.m4a"""
    stem, ext = base.rsplit(".", 1)
    return f"{stem}_k{semitones:+d}.{ext}"


def is_media_name(name: str) -> bool:
    return bool(_MEDIA.match(name))


class Storage:
    def __init__(self, db_path: Path, media_dir: Path) -> None:
        self.media_dir = media_dir
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS songs (
                yt_id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                created_at REAL NOT NULL,
                last_used_at REAL NOT NULL,
                size_bytes INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        self.conn.commit()
        self._cache: dict[str, Song] = {
            yt_id: Song.model_validate_json(data)
            for yt_id, data in self.conn.execute("SELECT yt_id, data FROM songs").fetchall()
        }
        self._reconcile()

    # --- caminhos ---------------------------------------------------------
    def song_dir(self, yt_id: str) -> Path:
        return self.media_dir / yt_id

    def path(self, yt_id: str, name: str) -> Path:
        return self.song_dir(yt_id) / name

    # --- leitura ----------------------------------------------------------
    def get(self, yt_id: str) -> Song | None:
        """Retorna o objeto compartilhado em memória (mutações aparecem no estado na hora)."""
        return self._cache.get(yt_id)

    def all(self) -> dict[str, Song]:
        return dict(self._cache)

    def total_size(self) -> int:
        row = self.conn.execute("SELECT COALESCE(SUM(size_bytes), 0) FROM songs").fetchone()
        return int(row[0])

    # --- escrita ----------------------------------------------------------
    def save(self, song: Song) -> None:
        yt_id = song.video.yt_id
        song.has_original = self.path(yt_id, ORIGINAL).exists()
        song.has_instrumental = self.path(yt_id, INSTRUMENTAL).exists()
        song.has_vocals = self.path(yt_id, VOCALS).exists()
        song.has_melody = self.path(yt_id, MELODY).exists()
        if song.has_melody and song.key_tonic is None:
            found = key_from_file(self.path(yt_id, MELODY))
            if found:
                song.key_tonic, song.key_scale = found
        d = self.song_dir(yt_id)
        song.variants = sorted(p.name for p in d.iterdir() if _VARIANT.match(p.name)) if d.exists() else []
        now = time.time()
        self.conn.execute(
            """
            INSERT INTO songs (yt_id, data, created_at, last_used_at, size_bytes)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(yt_id) DO UPDATE SET data = excluded.data, size_bytes = excluded.size_bytes
            """,
            (yt_id, song.model_dump_json(), now, now, self._dir_size(yt_id)),
        )
        self.conn.commit()
        self._cache[yt_id] = song

    def touch(self, yt_id: str) -> None:
        self.conn.execute("UPDATE songs SET last_used_at = ? WHERE yt_id = ?", (time.time(), yt_id))
        self.conn.commit()

    def delete(self, yt_id: str) -> None:
        shutil.rmtree(self.song_dir(yt_id), ignore_errors=True)
        self.conn.execute("DELETE FROM songs WHERE yt_id = ?", (yt_id,))
        self.conn.commit()
        self._cache.pop(yt_id, None)

    def enforce_limit(self, limit_bytes: int, protected: set[str]) -> list[str]:
        """Apaga as músicas menos usadas até caber no limite. Retorna os ids removidos."""
        removed: list[str] = []
        total = self.total_size()
        if total <= limit_bytes:
            return removed
        rows = self.conn.execute(
            "SELECT yt_id, size_bytes FROM songs ORDER BY last_used_at ASC"
        ).fetchall()
        for yt_id, size in rows:
            if total <= limit_bytes:
                break
            if yt_id in protected:
                continue
            self.delete(yt_id)
            total -= size
            removed.append(yt_id)
        return removed

    # --- internos ---------------------------------------------------------
    def _dir_size(self, yt_id: str) -> int:
        d = self.song_dir(yt_id)
        if not d.exists():
            return 0
        return sum(p.stat().st_size for p in d.rglob("*") if p.is_file())

    def _reconcile(self) -> None:
        """Processamentos interrompidos por um restart voltam para 'pending'."""
        for song in self.all().values():
            if song.status not in ("ready", "error"):
                song.status = "pending"
                song.progress = 0.0
                self.save(song)
            else:
                self.save(song)  # recalcula flags has_* conforme os arquivos no disco
