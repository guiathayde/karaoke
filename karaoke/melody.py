"""Melodia de referência para a pontuação: contorno de pitch dos vocais separados (librosa.pyin)."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Literal

SR = 22050
HOP = 512

# perfis de Krumhansl-Kessler (peso de cada grau a partir da tônica)
_MAJOR = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
_MINOR = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)
MIN_VOICED = 200  # ~5 s de canto


def _corr(a: list[float], b: tuple[float, ...]) -> float:
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b, strict=True))
    den = (sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b)) ** 0.5
    return num / den if den else 0.0


def detect_key(notes: list[float]) -> tuple[int, Literal["major", "minor"]] | None:
    """Tonalidade pelo histograma de classes de altura da melodia (cada frame com voz conta igual).

    Relativas (C maior / A menor) usam as mesmas notas, então uma confusão entre elas não muda o autotune.
    """
    hist = [0.0] * 12
    voiced = 0
    for n in notes:
        if n > 0:
            hist[round(n) % 12] += 1
            voiced += 1
    if voiced < MIN_VOICED:
        return None
    best: tuple[float, int, Literal["major", "minor"]] = (-2.0, 0, "major")
    for tonic in range(12):
        rotated = hist[tonic:] + hist[:tonic]
        for scale, profile in (("major", _MAJOR), ("minor", _MINOR)):
            r = _corr(rotated, profile)
            if r > best[0]:
                best = (r, tonic, scale)
    return best[1], best[2]


def key_from_file(melody_json: Path) -> tuple[int, Literal["major", "minor"]] | None:
    try:
        return detect_key(json.loads(melody_json.read_text())["notes"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def extract(vocals_path: Path, out_json: Path) -> int:
    """Grava {"hop": segundos, "notes": [midi ou 0 por frame]} e retorna o número de frames vozeados."""
    import librosa
    import numpy as np
    import soundfile as sf

    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "vocals.wav"
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(vocals_path),
             "-ac", "1", "-ar", str(SR), str(wav)],
            check=True, capture_output=True,
        )
        y, sr = sf.read(wav, dtype="float32")
    f0, voiced, _prob = librosa.pyin(y, fmin=65, fmax=1000, sr=sr, frame_length=2048, hop_length=HOP)
    # energia por frame para ignorar respiros e vazamentos fracos
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP)[0]
    n = min(len(f0), len(rms))
    f0, voiced, rms = f0[:n], voiced[:n], rms[:n]
    # a flag de voz do pyin já separa canto de silêncio; o gate só tira vazamentos muito fracos
    gate = float(np.percentile(rms, 90)) * 0.1 if np.any(rms > 0) else 0.0
    midi = np.zeros(n, dtype=np.float32)
    ok = voiced & (~np.isnan(f0)) & (rms >= gate)
    midi[ok] = 69 + 12 * np.log2(f0[ok] / 440)
    # suaviza (mediana de 5 frames) e remove notas isoladas muito curtas (< 4 frames ~ 90 ms)
    med = midi.copy()
    for i in range(2, n - 2):
        win = midi[i - 2 : i + 3]
        nz = win[win > 0]
        med[i] = float(np.median(nz)) if len(nz) >= 3 and midi[i] > 0 else (0 if len(nz) < 3 else med[i])
    midi = med
    i = 0
    while i < n:
        if midi[i] > 0:
            j = i
            while j < n and midi[j] > 0:
                j += 1
            if j - i < 4:
                midi[i:j] = 0
            i = j
        else:
            i += 1
    notes = [round(float(v), 1) if v > 0 else 0 for v in midi]
    out_json.write_text(json.dumps({"hop": HOP / sr, "notes": notes}, separators=(",", ":")))
    return int(sum(1 for v in notes if v))
