"""Modelos compartilhados entre API, sessão e pipeline."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

SongStatus = Literal["pending", "downloading", "separating", "muxing", "melody", "lyrics", "ready", "error"]
PlayerStatus = Literal["idle", "waiting", "playing", "paused", "stopped"]
Scale = Literal["chromatic", "major", "minor"]
KeyScale = Literal["major", "minor"]


class Video(BaseModel):
    yt_id: str
    title: str
    channel: str = ""
    duration: float | None = None
    thumbnail: str | None = None


class LyricLine(BaseModel):
    t: float
    text: str
    singer: int | None = None  # 1 ou 2 em modo dueto


class Song(BaseModel):
    """Entrada do cache: um vídeo do YouTube e seus arquivos processados."""

    video: Video
    status: SongStatus = "pending"
    progress: float = 0.0  # 0..1 dentro da etapa atual
    error: str | None = None
    has_original: bool = False
    has_instrumental: bool = False
    has_vocals: bool = False
    lyrics: list[LyricLine] | None = None
    lyrics_source: str | None = None
    has_melody: bool = False
    lyrics_aligned: bool | None = None  # None = não tentou alinhar a letra ao canto
    variants: list[str] = Field(default_factory=list)  # ex.: instrumental_k+2.mp4
    rendering: str | None = None  # variante de tom em preparo
    key_tonic: int | None = None  # tonalidade estimada pela melodia (0 = C ... 11 = B), no tom original
    key_scale: KeyScale | None = None


class Singer(BaseModel):
    id: str
    name: str
    color: str
    is_host: bool = False
    mic: int | None = None  # 1 ou 2


class QueueEntry(BaseModel):
    id: str
    yt_id: str
    singer_ids: list[str]
    is_karaoke_version: bool = False
    key_shift: int = 0
    duet_swap: bool = False
    scores: dict[str, int] | None = None  # singer_id (ou "mic1"/"mic2") -> pontos (total)
    score_details: dict[str, dict[str, int]] | None = None  # singer_id -> {pitch, lyrics, total}
    added_at: float


class Player(BaseModel):
    status: PlayerStatus = "idle"
    entry_id: str | None = None
    position: float = 0.0
    restart_id: int = 0  # incrementa a cada "recomeçar"; o palco volta ao início quando muda


class MicSettings(BaseModel):
    enabled: bool = True
    strength: int = Field(70, ge=0, le=100)
    speed_ms: int = Field(20, ge=1, le=500)
    key: int | None = Field(None, ge=0, le=11)  # 0 = C ... 11 = B; None = cromático
    scale: Scale = "chromatic"
    gain: float = Field(1.0, ge=0, le=2)
    auto_key: bool = True  # usa a tonalidade detectada da música (key/scale ficam como reserva)
    follow_melody: bool = False  # corrige para a nota do vocal original em vez da nota mais próxima da escala
    double: int = Field(0, ge=0, le=100)  # dobra de voz
    echo: int = Field(0, ge=0, le=100)
    drive: int = Field(0, ge=0, le=100)  # saturação


class ReverbSettings(BaseModel):
    enabled: bool = True
    amount: int = Field(25, ge=0, le=100)


class GuideSettings(BaseModel):
    """Voz guia: o vocal original separado toca junto com o instrumental."""

    enabled: bool = True
    volume: int = Field(40, ge=0, le=100)
    duck: bool = True  # some quando alguém canta no microfone


class AudioSettings(BaseModel):
    mics: list[MicSettings] = Field(default_factory=lambda: [MicSettings(), MicSettings()])
    reverb: ReverbSettings = Field(default_factory=ReverbSettings)
    guide: GuideSettings = Field(default_factory=GuideSettings)


class CatalogEntry(BaseModel):
    """Vídeo já processado no Colab (catalogo.json do Drive, que vem dentro de cada pacote)."""

    yt_id: str
    title: str = ""
    channel: str = ""
    duration: float | None = None
    karaoke: bool = False  # vídeo que já era versão karaokê (sem separação)
    lyrics: bool = False
    model: str | None = None
    pack: str | None = None  # nome do .zip em que está
    processed_at: str | None = None  # ISO 8601


class SongRequest(BaseModel):
    """Pedido de processamento no Colab feito pelo celular do anfitrião."""

    video: Video
    is_karaoke_version: bool = False
    requested_by: str | None = None
    at: float


class SessionInfo(BaseModel):
    join_url: str
    pin_required: bool = True


class State(BaseModel):
    session: SessionInfo
    singers: list[Singer]
    queue: list[QueueEntry]
    history: list[QueueEntry]
    player: Player
    songs: dict[str, Song]
    separation_enabled: bool
    audio: AudioSettings
    library_rev: str = ""  # muda quando a biblioteca muda (o celular busca /api/library de novo)


# Corpos de requisição
class JoinBody(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class HostBody(BaseModel):
    pin: str


class AddToQueueBody(BaseModel):
    video: Video
    is_karaoke_version: bool = False
    singer_ids: list[str] | None = None


class MoveBody(BaseModel):
    position: int


class ProgressBody(BaseModel):
    position: float


class MicBody(BaseModel):
    mic: int | None


class MicUpdateBody(BaseModel):
    enabled: bool | None = None
    strength: int | None = Field(None, ge=0, le=100)
    speed_ms: int | None = Field(None, ge=1, le=500)
    key: int | None = Field(None, ge=0, le=11)
    chromatic: bool | None = None  # True zera a tonalidade (escala cromática)
    scale: Scale | None = None
    gain: float | None = Field(None, ge=0, le=2)
    auto_key: bool | None = None
    follow_melody: bool | None = None
    double: int | None = Field(None, ge=0, le=100)
    echo: int | None = Field(None, ge=0, le=100)
    drive: int | None = Field(None, ge=0, le=100)


class ReverbUpdateBody(BaseModel):
    enabled: bool | None = None
    amount: int | None = Field(None, ge=0, le=100)


class KeyBody(BaseModel):
    semitones: int = Field(ge=-6, le=6)


class SingersBody(BaseModel):
    singer_ids: list[str] = Field(min_length=1, max_length=2)


class DuetBody(BaseModel):
    swap: bool


class EndedBody(BaseModel):
    scores: dict[int, int] | None = None  # mic (1|2) -> pontos de afinação


class RequestBody(BaseModel):
    video: Video
    is_karaoke_version: bool = False


class GuideUpdateBody(BaseModel):
    enabled: bool | None = None
    volume: int | None = Field(None, ge=0, le=100)
    duck: bool | None = None
