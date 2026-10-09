"""Busca e download do YouTube via yt-dlp. Funções bloqueantes: chamar em thread."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from pathlib import Path

import yt_dlp

from .models import Video

_YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_YT_URL = re.compile(
    r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/)|youtu\.be/)([A-Za-z0-9_-]{11})"
)


def _thumb(yt_id: str) -> str:
    return f"https://i.ytimg.com/vi/{yt_id}/hqdefault.jpg"


def extract_id(text: str) -> str | None:
    text = text.strip()
    if _YT_ID.match(text):
        return text
    m = _YT_URL.search(text)
    return m.group(1) if m else None


def fix_mojibake(text: str) -> str:
    """Alguns títulos do YouTube vêm com UTF-8 lido como Latin-1 ("LegiÃ£o"). Desfaz quando dá."""
    if "Ã" not in text and "Â" not in text:
        return text
    try:
        fixed = text.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text
    return fixed if fixed.count("\ufffd") == 0 else text


def _to_video(entry: dict) -> Video:
    return Video(
        yt_id=entry["id"],
        title=unicodedata.normalize("NFC", fix_mojibake(entry.get("title") or entry["id"])),
        channel=entry.get("channel") or entry.get("uploader") or "",
        duration=entry.get("duration"),
        thumbnail=_thumb(entry["id"]),
    )


def search(query: str, limit: int = 12) -> list[Video]:
    yt_id = extract_id(query)
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "extract_flat": "in_playlist",
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        if yt_id:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={yt_id}", download=False)
            return [_to_video(info)]
        info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    entries = [e for e in (info or {}).get("entries", []) if e and e.get("id")]
    return [_to_video(e) for e in entries]


def download(
    yt_id: str,
    dest: Path,
    max_height: int,
    on_progress: Callable[[float], None] | None = None,
) -> Video:
    """Baixa vídeo+áudio (mp4) para `dest`. Retorna metadados atualizados."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmpl = str(dest.with_suffix("")) + ".%(ext)s"

    def hook(d: dict) -> None:
        if on_progress and d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            if total:
                on_progress(min(1.0, done / total))

    h = max_height
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "overwrites": True,
        "format": (
            f"bestvideo[height<={h}][ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]"
            f"/bestvideo[height<={h}][ext=mp4]+bestaudio[ext=m4a]"
            f"/bestvideo[height<={h}]+bestaudio/best[height<={h}]/best"
        ),
        "merge_output_format": "mp4",
        "outtmpl": tmpl,
        "progress_hooks": [hook],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={yt_id}", download=True)
    if not dest.exists():
        raise RuntimeError("yt-dlp terminou sem gerar o arquivo esperado")
    return _to_video(info)
