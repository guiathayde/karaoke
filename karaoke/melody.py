"""Melodia de referência para a pontuação: contorno de pitch dos vocais separados (librosa.pyin)."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

SR = 22050
HOP = 512


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
