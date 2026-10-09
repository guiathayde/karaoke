"""Separação de voz com audio-separator (BS-Roformer / MDX-Net), rodando em MPS no Apple Silicon.

O modelo fica carregado entre músicas. Não há callback de progresso na biblioteca, então o
progresso é estimado pelo tempo decorrido com base na velocidade da última execução.
"""

from __future__ import annotations

import logging
import shutil
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path

log = logging.getLogger("karaoke.separator")


class SeparationUnavailable(RuntimeError):
    pass


_lock = threading.Lock()
_separator = None
_loaded_model: str | None = None
# segundos de processamento por segundo de áudio; ajustado após cada música
_rate = 0.6


def _get_separator(model: str, model_dir: Path, tmp_dir: Path):
    global _separator, _loaded_model
    try:
        from audio_separator.separator import Separator
    except ImportError as exc:  # pragma: no cover - depende do ambiente
        raise SeparationUnavailable(
            "audio-separator não instalado. Rode `uv sync` ou use KARAOKE_SEPARATION=0."
        ) from exc
    if _separator is None:
        _separator = Separator(
            log_level=logging.WARNING,
            model_file_dir=str(model_dir),
            output_dir=str(tmp_dir),
            output_format="WAV",
        )
    if _loaded_model != model:
        log.info("carregando modelo de separação %s", model)
        _separator.load_model(model_filename=model)
        _loaded_model = model
    return _separator


def separate(
    audio_in: Path,
    instrumental_out: Path,
    vocals_out: Path,
    *,
    model: str,
    model_dir: Path,
    tmp_dir: Path,
    audio_seconds: float | None = None,
    on_progress: Callable[[float], None] | None = None,
) -> None:
    """Gera instrumental_out e vocals_out (WAV) a partir de audio_in. Bloqueante."""
    global _rate
    model_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tag = uuid.uuid4().hex[:8]
    names = {"Instrumental": f"instrumental_{tag}", "Vocals": f"vocals_{tag}"}

    with _lock:
        sep = _get_separator(model, model_dir, tmp_dir)
        expected = (audio_seconds or 240.0) * _rate
        stop = threading.Event()

        def ticker() -> None:
            start = time.monotonic()
            while not stop.wait(1.0):
                if on_progress:
                    on_progress(min(0.95, (time.monotonic() - start) / max(expected, 1.0)))

        t = threading.Thread(target=ticker, daemon=True)
        t.start()
        started = time.monotonic()
        try:
            outputs = sep.separate(str(audio_in), custom_output_names=names)
        finally:
            stop.set()
            t.join(timeout=2)
        elapsed = time.monotonic() - started
        if audio_seconds:
            _rate = max(0.05, elapsed / audio_seconds)
        log.info("separação em %.1fs (%.2fx tempo real) -> %s", elapsed, elapsed / (audio_seconds or elapsed), outputs)

    produced = {Path(p).stem: Path(p) if Path(p).is_absolute() else tmp_dir / Path(p).name for p in outputs}
    inst = produced.get(names["Instrumental"])
    voc = produced.get(names["Vocals"])
    if inst is None or voc is None or not inst.exists() or not voc.exists():
        raise RuntimeError(f"modelo não gerou as duas faixas esperadas: {outputs}")
    instrumental_out.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(inst), str(instrumental_out))
    shutil.move(str(voc), str(vocals_out))
    if on_progress:
        on_progress(1.0)
