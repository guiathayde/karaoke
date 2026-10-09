"""Letras sincronizadas via lrclib.net (gratuito, sem chave)."""

from __future__ import annotations

import re
import unicodedata

import httpx

from .models import LyricLine

API = "https://lrclib.net/api"
UA = "karaoke-local/0.1 (https://github.com/guiathayde/karaoke)"

_NOISE = re.compile(
    r"[\(\[\{][^\)\]\}]*(official|oficial|video|vídeo|clipe|lyric|letra|audio|áudio|hd|4k|"
    r"remaster|ao vivo|live|visualizer|legendado|karaok[eê]|instrumental|playback|cover)"
    r"[^\)\]\}]*[\)\]\}]",
    re.IGNORECASE,
)
_FEAT = re.compile(r"\s*(feat\.?|ft\.?|part\.?|com)\s+.*$", re.IGNORECASE)
_SEP = re.compile(r"\s+[-–—|]\s+")
_LRC = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")


def clean_title(title: str) -> str:
    t = _NOISE.sub("", unicodedata.normalize("NFC", title))
    t = re.sub(r"\s*[\(\[\{]\s*[\)\]\}]", "", t)
    t = re.sub(r"[\"“”]", "", t)
    t = re.sub(r"\s{2,}", " ", t).strip(" -–|")
    return t


def guess_artist_track(title: str) -> tuple[str, str] | None:
    parts = _SEP.split(clean_title(title), maxsplit=1)
    if len(parts) != 2:
        return None
    artist, track = parts[0].strip(), _FEAT.sub("", parts[1]).strip()
    return (artist, track) if artist and track else None


def parse_lrc(text: str) -> list[LyricLine]:
    lines: list[LyricLine] = []
    for raw in text.splitlines():
        stamps = _LRC.findall(raw)
        if not stamps:
            continue
        content = _LRC.sub("", raw).strip()
        for mm, ss in stamps:
            lines.append(LyricLine(t=int(mm) * 60 + float(ss), text=content))
    lines.sort(key=lambda line: line.t)
    return lines


def _score(item: dict, duration: float | None) -> float | None:
    if not item.get("syncedLyrics") or item.get("instrumental"):
        return None
    if duration and item.get("duration"):
        diff = abs(float(item["duration"]) - duration)
        if diff > 8:
            return None
        return diff
    return 4.0


async def fetch_synced(title: str, duration: float | None) -> tuple[list[LyricLine], str] | None:
    """Tenta algumas buscas e devolve (linhas, descrição da fonte) ou None."""
    queries: list[str] = []
    guess = guess_artist_track(title)
    if guess:
        queries.append(f"{guess[0]} {guess[1]}")
    cleaned = clean_title(title)
    if cleaned and cleaned not in queries:
        queries.append(cleaned)
    title = unicodedata.normalize("NFC", title)
    if title not in queries:
        queries.append(title)

    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": UA}) as client:
        for q in queries:
            try:
                r = await client.get(f"{API}/search", params={"q": q})
                r.raise_for_status()
            except httpx.HTTPError:
                continue
            best: tuple[float, dict] | None = None
            for item in r.json():
                s = _score(item, duration)
                if s is not None and (best is None or s < best[0]):
                    best = (s, item)
            if best:
                item = best[1]
                lines = parse_lrc(item["syncedLyrics"])
                if lines:
                    source = f"lrclib: {item.get('artistName')} - {item.get('trackName')}"
                    return lines, source
    return None
