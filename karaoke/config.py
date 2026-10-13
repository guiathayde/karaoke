"""Configuração via variáveis de ambiente (prefixo KARAOKE_)."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _env(name: str, default: str) -> str:
    return os.environ.get(f"KARAOKE_{name}", default)


@dataclass
class Settings:
    host: str = field(default_factory=lambda: _env("HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: int(_env("PORT", "8000")))
    # URL que os celulares usam. Em dev com o Vite, aponte para a porta 5173.
    public_url: str | None = field(default_factory=lambda: _env("PUBLIC_URL", "") or None)
    data_dir: Path = field(default_factory=lambda: Path(_env("DATA_DIR", str(ROOT / "data"))))
    web_dist: Path = field(default_factory=lambda: Path(_env("WEB_DIST", str(ROOT / "web" / "dist"))))
    cache_limit_gb: float = field(default_factory=lambda: float(_env("CACHE_LIMIT_GB", "20")))
    max_height: int = field(default_factory=lambda: int(_env("MAX_HEIGHT", "1080")))
    separation_enabled: bool = field(
        default_factory=lambda: _env("SEPARATION", "1") not in ("0", "false", "no")
    )
    host_pin: str = field(default_factory=lambda: _env("HOST_PIN", "") or f"{secrets.randbelow(10000):04d}")
    search_results: int = field(default_factory=lambda: int(_env("SEARCH_RESULTS", "12")))
    # No M1 Pro: UVR-MDX-NET-Inst_HQ_4.onnx ~45 s por música; model_bs_roformer_ep_317_sdr_12.9755.ckpt
    # tem qualidade maior mas leva ~27 min (use no Colab com GPU).
    separation_model: str = field(
        default_factory=lambda: _env("SEPARATION_MODEL", "UVR-MDX-NET-Inst_HQ_4.onnx")
    )
    # Reconhecimento de fala (faster-whisper): "base" ao vivo, "small" para alinhar a letra offline
    asr_enabled: bool = field(default_factory=lambda: _env("ASR", "1") not in ("0", "false", "no"))
    asr_model: str = field(default_factory=lambda: _env("ASR_MODEL", "base"))
    align_model: str = field(default_factory=lambda: _env("ALIGN_MODEL", "small"))

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "karaoke.sqlite3"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def tmp_dir(self) -> Path:
        return self.data_dir / "tmp"

    @property
    def import_dir(self) -> Path:
        return self.data_dir / "import"

    @property
    def settings_path(self) -> Path:
        return self.data_dir / "settings.json"

    def ensure_dirs(self) -> None:
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        self.import_dir.mkdir(parents=True, exist_ok=True)


settings = Settings()
