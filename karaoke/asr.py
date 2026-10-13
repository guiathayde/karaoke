"""Reconhecimento de fala (faster-whisper) compartilhado pelo alinhamento da letra e pela pontuação."""

from __future__ import annotations

import logging
import re
import threading
import unicodedata
from dataclasses import dataclass

import numpy as np

log = logging.getLogger("karaoke.asr")

SR = 16000
_models: dict[str, object] = {}
_lock = threading.Lock()

STOPWORDS = {
    # pt
    "o", "a", "os", "as", "e", "de", "do", "da", "dos", "das", "que", "em", "um", "uma", "no", "na",
    "nos", "nas", "se", "me", "te", "eu", "tu", "ele", "ela", "mais", "mas", "nao", "com", "por",
    "pra", "para", "ao", "so", "ja", "la", "ha", "meu", "minha", "seu", "sua", "voce", "vou", "vai",
    # en
    "the", "and", "you", "i", "to", "of", "it", "in", "my", "is", "on", "your", "we", "be", "oh", "yeah", "but", "for", "all", "that", "this", "with", "are", "was", "not",
}


@dataclass
class Word:
    start: float
    end: float
    token: str


def norm_tokens(text: str) -> list[str]:
    t = unicodedata.normalize("NFD", text.lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.findall(r"[a-z0-9]+", t)


def keep_token(tok: str) -> bool:
    return len(tok) >= 3 and tok not in STOPWORDS


_PT_HINTS = {"nao", "voce", "que", "com", "meu", "minha", "coracao", "amor", "tempo", "de", "uma", "para", "eu"}
_EN_HINTS = {"the", "you", "and", "love", "my", "your", "with", "never", "heart", "baby", "i", "me"}


def guess_language(texts: list[str]) -> str:
    """Português ou inglês pela contagem de palavras típicas da letra."""
    toks = [t for text in texts for t in norm_tokens(text)]
    pt = sum(1 for t in toks if t in _PT_HINTS)
    en = sum(1 for t in toks if t in _EN_HINTS)
    return "en" if en > pt else "pt"


def get_model(name: str):
    with _lock:
        if name not in _models:
            from faster_whisper import WhisperModel

            log.info("carregando modelo de fala %s", name)
            _models[name] = WhisperModel(name, device="cpu", compute_type="int8")
        return _models[name]


def normalize_audio(y: np.ndarray) -> np.ndarray:
    peak = float(np.abs(y).max()) if y.size else 0.0
    return (y / peak * 0.9).astype(np.float32) if peak > 1e-4 else y.astype(np.float32)


def transcribe_words(
    y: np.ndarray,
    model_name: str,
    language: str,
    *,
    t0: float = 0.0,
    beam_size: int = 5,
    block: float = 15.0,
    step: float = 12.0,
) -> list[Word]:
    """Transcreve áudio mono 16 kHz em blocos sobrepostos e devolve palavras normalizadas com tempo.

    `t0` é o tempo (na música) da primeira amostra. Canto separado costuma vir baixo, então o
    áudio é normalizado; o detector de silêncio do Whisper fica desligado porque corta o canto.
    """
    model = get_model(model_name)
    y = normalize_audio(y)
    words: list[Word] = []
    pos = 0.0
    total = len(y) / SR
    overlap = (block - step) / 2
    while pos < total:
        seg = y[int(pos * SR) : int((pos + block) * SR)]
        if len(seg) < SR * 0.5:
            break
        segments, _ = model.transcribe(
            seg,
            language=language,
            beam_size=beam_size,
            word_timestamps=True,
            condition_on_previous_text=False,
            vad_filter=False,
        )
        for s in segments:
            for w in s.words or []:
                if pos > 0 and w.start < overlap:
                    continue  # já coberto pelo bloco anterior
                for tok in norm_tokens(w.word):
                    words.append(Word(t0 + pos + w.start, t0 + pos + w.end, tok))
        pos += step
    with _lock:
        pass
    return words


def match_ratio(expected: str, heard: list[str]) -> float:
    """Fração das palavras esperadas encontradas, em ordem, entre as ouvidas."""
    import difflib

    e = norm_tokens(expected)
    if not e:
        return 0.0
    blocks = difflib.SequenceMatcher(a=e, b=heard, autojunk=False).get_matching_blocks()
    return min(1.0, sum(b.size for b in blocks) / len(e))
