"""Estado da sessão em memória: cantores, fila, histórico e player."""

from __future__ import annotations

import json
import secrets
import time
from collections.abc import Callable
from pathlib import Path

from .models import AudioSettings, Player, QueueEntry, Singer, Video

COLORS = ["#ff5c8a", "#38bdf8", "#facc15", "#4ade80", "#c084fc", "#fb923c", "#2dd4bf", "#f472b6"]


class Session:
    def __init__(self, is_ready: Callable[[QueueEntry], bool], settings_path: Path | None = None) -> None:
        self._is_ready = is_ready
        self._settings_path = settings_path
        self.audio = self._load_audio()
        self.singers: dict[str, Singer] = {}
        self.tokens: dict[str, str] = {}  # token -> singer_id
        self.queue: list[QueueEntry] = []
        self.history: list[QueueEntry] = []
        self.player = Player()
        self._paused = False
        self._stopped = False

    # --- cantores ---------------------------------------------------------
    def join(self, name: str) -> tuple[Singer, str]:
        singer_id = secrets.token_hex(4)
        singer = Singer(id=singer_id, name=name.strip(), color=COLORS[len(self.singers) % len(COLORS)])
        self.singers[singer_id] = singer
        token = secrets.token_urlsafe(16)
        self.tokens[token] = singer_id
        return singer, token

    def by_token(self, token: str | None) -> Singer | None:
        if not token:
            return None
        singer_id = self.tokens.get(token)
        return self.singers.get(singer_id) if singer_id else None

    def set_mic(self, singer_id: str, mic: int | None) -> None:
        for s in self.singers.values():
            if s.mic == mic and s.id != singer_id and mic is not None:
                s.mic = None
        self.singers[singer_id].mic = mic

    # --- fila -------------------------------------------------------------
    def add(self, video: Video, singer_ids: list[str], is_karaoke_version: bool) -> QueueEntry:
        entry = QueueEntry(
            id=secrets.token_hex(4),
            yt_id=video.yt_id,
            singer_ids=singer_ids,
            is_karaoke_version=is_karaoke_version,
            added_at=time.time(),
        )
        self.queue.append(entry)
        self.refresh_player()
        return entry

    def entry(self, entry_id: str) -> QueueEntry | None:
        return next((e for e in self.queue if e.id == entry_id), None)

    def remove(self, entry_id: str) -> None:
        if self.player.entry_id == entry_id:
            self.skip()
            return
        self.queue = [e for e in self.queue if e.id != entry_id]
        self.refresh_player()

    def remove_song(self, yt_id: str) -> None:
        """Remove da fila e do histórico todas as entradas de um vídeo apagado."""
        cur = self.current()
        if cur and cur.yt_id == yt_id:
            self.player = Player()
            self._paused = False
            self._stopped = False
        self.queue = [e for e in self.queue if e.yt_id != yt_id]
        self.history = [e for e in self.history if e.yt_id != yt_id]
        self.refresh_player()

    def move(self, entry_id: str, position: int) -> None:
        entry = self.entry(entry_id)
        if entry is None:
            return
        self.queue.remove(entry)
        position = max(0, min(position, len(self.queue)))
        self.queue.insert(position, entry)
        self.refresh_player()

    def set_key_shift(self, entry_id: str, semitones: int) -> None:
        entry = self.entry(entry_id)
        if entry:
            entry.key_shift = max(-6, min(6, semitones))
            self.refresh_player()

    # --- player -----------------------------------------------------------
    def current(self) -> QueueEntry | None:
        return self.entry(self.player.entry_id) if self.player.entry_id else None

    def set_singers(self, entry_id: str, singer_ids: list[str]) -> None:
        entry = self.entry(entry_id)
        if entry:
            entry.singer_ids = list(dict.fromkeys(singer_ids))[:2]

    def set_duet_swap(self, entry_id: str, swap: bool) -> None:
        entry = self.entry(entry_id)
        if entry:
            entry.duet_swap = swap

    def skip(self, mic_scores: dict[int, int] | None = None) -> None:
        cur = self.current()
        if cur:
            if mic_scores:
                cur.scores = self._attribute_scores(cur, mic_scores)
            self.queue.remove(cur)
            self.history.append(cur)
            self.history = self.history[-50:]
        self.player = Player()
        self._paused = False
        self._stopped = False
        self.refresh_player()

    def pause(self) -> None:
        self._paused = True
        self.refresh_player()

    def play(self) -> None:
        self._paused = False
        self._stopped = False
        self.refresh_player()

    def stop(self) -> None:
        """Sai da música: ela continua na frente da fila, mas o palco volta para a tela de espera."""
        self._stopped = True
        self._paused = False
        self.player.position = 0.0
        self.refresh_player()

    def restart(self) -> None:
        self._paused = False
        self._stopped = False
        self.player.position = 0.0
        self.player.restart_id += 1
        self.refresh_player()

    def set_position(self, position: float) -> None:
        self.player.position = max(0.0, position)

    def refresh_player(self) -> None:
        """Deriva o estado do player: idle, waiting (processando), playing ou paused."""
        if self.player.entry_id is None and self.queue:
            self.player.entry_id = self.queue[0].id
            self.player.position = 0.0
            self._paused = False
            self._stopped = False
        cur = self.current()
        if cur is None:
            self.player = Player()
            return
        if not self._is_ready(cur):
            self.player.status = "waiting"
        elif self._stopped:
            self.player.status = "stopped"
        elif self._paused:
            self.player.status = "paused"
        else:
            self.player.status = "playing"

    def _attribute_scores(self, entry: QueueEntry, mic_scores: dict[int, int]) -> dict[str, int]:
        """Liga cada microfone ao cantor que o declarou (prioridade para os cantores da música)."""
        result: dict[str, int] = {}
        for mic, points in mic_scores.items():
            owner = next(
                (sid for sid in entry.singer_ids if self.singers.get(sid) and self.singers[sid].mic == mic), None
            )
            if owner is None:
                owner = next((s.id for s in self.singers.values() if s.mic == mic), None)
            result[owner or f"mic{mic}"] = int(points)
        return result

    # --- áudio (autotune / reverb) -----------------------------------------
    def _load_audio(self) -> AudioSettings:
        if self._settings_path and self._settings_path.exists():
            try:
                return AudioSettings.model_validate_json(self._settings_path.read_text())
            except ValueError:
                pass
        return AudioSettings()

    def save_audio(self) -> None:
        if self._settings_path:
            self._settings_path.write_text(json.dumps(self.audio.model_dump(), indent=2))
