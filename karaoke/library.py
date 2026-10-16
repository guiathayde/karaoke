"""Biblioteca: o que já está no Mac, o que já foi processado no Colab (catálogo) e os pedidos para o Colab.

O Mac não enxerga o Drive. O notebook mantém `MyDrive/karaoke/catalogo.json` e põe uma cópia em cada
pacote; ao importar um pacote o catálogo local é mesclado. Os pedidos ficam em `data/pedidos.json` e
o anfitrião copia a lista (`requests_text`) para o notebook.
"""

from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import Any, Literal

from pydantic import TypeAdapter, ValidationError

from .models import CatalogEntry, Song, SongRequest, Video

log = logging.getLogger("karaoke.library")

Where = Literal["local", "drive", "requested"]
_REQUESTS = TypeAdapter(list[SongRequest])
_YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def is_local(song: Song | None) -> bool:
    """Música pronta para tocar no Mac (importada ou processada aqui)."""
    return song is not None and song.status == "ready" and song.has_original


class Library:
    def __init__(self, data_dir: Path) -> None:
        self.catalog_path = data_dir / "catalogo.json"
        self.requests_path = data_dir / "pedidos.json"
        self.catalog: dict[str, CatalogEntry] = {}
        self.catalog_updated_at: str | None = None
        self.requests: list[SongRequest] = []
        self.rev = 0
        self._load()

    # --- persistência -----------------------------------------------------
    def _load(self) -> None:
        if self.catalog_path.exists():
            try:
                self._merge(json.loads(self.catalog_path.read_text()))
            except ValueError:
                log.warning("catálogo local inválido: %s", self.catalog_path)
        if self.requests_path.exists():
            try:
                self.requests = _REQUESTS.validate_json(self.requests_path.read_text())
            except ValidationError:
                log.warning("pedidos inválidos: %s", self.requests_path)

    def _save_catalog(self) -> None:
        data = {
            "updated_at": self.catalog_updated_at,
            "songs": {k: v.model_dump() for k, v in sorted(self.catalog.items())},
        }
        self.catalog_path.write_text(json.dumps(data, ensure_ascii=False, indent=1))

    def _save_requests(self) -> None:
        self.requests_path.write_text(_REQUESTS.dump_json(self.requests, indent=1).decode())

    # --- catálogo ---------------------------------------------------------
    def _merge(self, data: Any) -> int:
        """Une o catálogo recebido ao atual (pacotes podem ser importados fora de ordem)."""
        songs = data.get("songs") if isinstance(data, dict) else None
        if not isinstance(songs, dict):
            return 0
        added = 0
        for yt_id, raw in songs.items():
            try:
                entry = CatalogEntry.model_validate({**raw, "yt_id": yt_id})
            except (ValidationError, TypeError):
                continue
            cur = self.catalog.get(yt_id)
            if cur is None or (entry.processed_at or "") >= (cur.processed_at or ""):
                added += cur is None
                self.catalog[yt_id] = entry
        updated = data.get("updated_at")
        if isinstance(updated, str) and updated > (self.catalog_updated_at or ""):
            self.catalog_updated_at = updated
        return added

    def merge_catalog(self, data: Any) -> int:
        added = self._merge(data)
        self._save_catalog()
        self.rev += 1
        return added

    def remove_catalog(self, yt_id: str) -> bool:
        if yt_id not in self.catalog:
            return False
        del self.catalog[yt_id]
        self._save_catalog()
        self.rev += 1
        return True

    # --- pedidos ----------------------------------------------------------
    def add_request(self, video: Video, is_karaoke_version: bool, requested_by: str | None) -> SongRequest:
        if not _YT_ID.match(video.yt_id):
            raise ValueError("ID de vídeo inválido")
        existing = next((r for r in self.requests if r.video.yt_id == video.yt_id), None)
        if existing:
            return existing
        req = SongRequest(video=video, is_karaoke_version=is_karaoke_version, requested_by=requested_by, at=time.time())
        self.requests.append(req)
        self._save_requests()
        self.rev += 1
        return req

    def remove_requests(self, yt_ids: set[str]) -> int:
        before = len(self.requests)
        self.requests = [r for r in self.requests if r.video.yt_id not in yt_ids]
        removed = before - len(self.requests)
        if removed:
            self._save_requests()
            self.rev += 1
        return removed

    def prune_requests(self, songs: dict[str, Song]) -> int:
        """Tira dos pedidos o que já chegou ao Mac ou já está no catálogo."""
        done = {r.video.yt_id for r in self.requests if r.video.yt_id in self.catalog or is_local(songs.get(r.video.yt_id))}
        return self.remove_requests(done)

    def requests_text(self) -> str:
        """Lista no formato do SONGS do notebook: comentário com o título e o link (prefixo karaoke: quando for o caso)."""
        lines: list[str] = []
        for r in self.requests:
            lines.append(f"# {r.video.title}".replace("\n", " "))
            url = f"https://www.youtube.com/watch?v={r.video.yt_id}"
            lines.append(f"karaoke: {url}" if r.is_karaoke_version else url)
        return "\n".join(lines) + ("\n" if lines else "")

    # --- consulta ---------------------------------------------------------
    def where(self, yt_id: str, songs: dict[str, Song]) -> Where | None:
        if is_local(songs.get(yt_id)):
            return "local"
        if yt_id in self.catalog:
            return "drive"
        if any(r.video.yt_id == yt_id for r in self.requests):
            return "requested"
        return None

    def snapshot(self, songs: dict[str, Song]) -> dict[str, Any]:
        local = sorted(
            (
                {
                    "video": s.video.model_dump(),
                    "has_instrumental": s.has_instrumental,
                    "has_lyrics": bool(s.lyrics),
                    "karaoke": s.lyrics_source == "video",
                    "in_catalog": yt_id in self.catalog,
                }
                for yt_id, s in songs.items()
                if is_local(s)
            ),
            key=lambda x: x["video"]["title"].casefold(),
        )
        drive = sorted(
            (e.model_dump() for yt_id, e in self.catalog.items() if not is_local(songs.get(yt_id))),
            key=lambda x: x["title"].casefold(),
        )
        return {
            "local": local,
            "drive": drive,
            "requests": [r.model_dump() for r in self.requests],
            "catalog_size": len(self.catalog),
            "catalog_updated_at": self.catalog_updated_at,
        }
