"""Alinha os tempos da letra (lrclib, de outra versão) ao canto real, pela transcrição dos vocais."""

from __future__ import annotations

import difflib
import json
import logging
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from . import asr
from .models import LyricLine

log = logging.getLogger("karaoke.align")


def load_audio_16k(path: Path) -> np.ndarray:
    import soundfile as sf

    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "a.wav"
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", str(asr.SR), str(wav)],
            check=True, capture_output=True,
        )
        y, _ = sf.read(wav, dtype="float32")
    return y


def voiced_onsets(melody_path: Path | None) -> list[float]:
    if not melody_path or not melody_path.exists():
        return []
    mel = json.loads(melody_path.read_text())
    hop, notes = mel["hop"], mel["notes"]
    return [i * hop for i in range(1, len(notes)) if notes[i] > 0 and notes[i - 1] == 0]


def align_lines(lines: list[LyricLine], words: list[asr.Word], onsets: list[float]) -> tuple[list[LyricLine], dict]:
    """Reposiciona cada linha: âncora onde a transcrição casa, interpolação nas demais."""
    exp = [(tok, i) for i, line in enumerate(lines) for tok in asr.norm_tokens(line.text) if asr.keep_token(tok)]
    heard = [w for w in words if asr.keep_token(w.token)]
    sm = difflib.SequenceMatcher(a=[t for t, _ in exp], b=[w.token for w in heard], autojunk=False)
    matched: dict[int, list[float]] = {}
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            _, li = exp[blk.a + k]
            matched.setdefault(li, []).append(heard[blk.b + k].start)
    ntok = {i: sum(1 for t in asr.norm_tokens(line.text) if asr.keep_token(t)) for i, line in enumerate(lines)}

    anchors: dict[int, float] = {}
    for i, line in enumerate(lines):
        m = sorted(matched.get(i, []))
        if not m:
            continue
        enough = len(m) >= 2 or len(m) >= 0.5 * max(1, ntok[i])
        if enough and (m[-1] - m[0]) <= 8 and abs(m[0] - line.t) <= 15:
            t = m[0]
            near = [o for o in onsets if abs(o - t) <= 1.0]
            if near:  # começa onde a voz começa, não na primeira palavra "forte"
                t = min(near, key=lambda o: abs(o - t))
            anchors[i] = t
    mono: dict[int, float] = {}
    last = -1.0
    for i in sorted(anchors):
        if anchors[i] > last:
            mono[i] = anchors[i]
            last = anchors[i]

    stats = {"lines": len(lines), "anchors": len(mono), "tokens": len(exp), "matched": sum(len(v) for v in matched.values())}
    if len(lines) == 0 or len(mono) < max(3, 0.25 * len(lines)):
        return lines, {**stats, "ok": False}

    keys = sorted(mono)
    out: list[float] = []
    for i, line in enumerate(lines):
        if i in mono:
            out.append(mono[i])
            continue
        prev = max((k for k in keys if k < i), default=None)
        nxt = min((k for k in keys if k > i), default=None)
        if prev is None:
            out.append(line.t + (mono[nxt] - lines[nxt].t))
        elif nxt is None:
            out.append(line.t + (mono[prev] - lines[prev].t))
        else:
            span_o = lines[nxt].t - lines[prev].t
            scale = (mono[nxt] - mono[prev]) / span_o if span_o > 0 else 1.0
            out.append(mono[prev] + (line.t - lines[prev].t) * scale)
    for i in range(1, len(out)):
        out[i] = max(out[i], out[i - 1] + 0.3)
    new_lines = [LyricLine(t=round(max(0.0, t), 2), text=line.text, singer=line.singer) for t, line in zip(out, lines)]
    shifts = [n.t - o.t for n, o in zip(new_lines, lines)]
    return new_lines, {**stats, "ok": True, "shift_mean": round(float(np.mean(shifts)), 2), "shift_max": round(float(np.max(np.abs(shifts))), 2)}


def align_song(vocals_path: Path, melody_path: Path | None, lines: list[LyricLine], model_name: str) -> tuple[list[LyricLine], dict]:
    y = load_audio_16k(vocals_path)
    language = asr.guess_language([line.text for line in lines])
    words = asr.transcribe_words(y, model_name, language)
    return align_lines(lines, words, voiced_onsets(melody_path))
