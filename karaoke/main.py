"""API HTTP + WebSocket, arquivos estáticos das telas e mídia."""

from __future__ import annotations

import asyncio
import io
import logging
import socket
import struct
from contextlib import asynccontextmanager
from typing import Any

import numpy as np
import segno
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from . import importer, youtube
from .config import settings
from .hub import Hub
from .library import Library, is_local
from .lyric_score import LyricScorer
from .models import (
    AddToQueueBody,
    DuetBody,
    EndedBody,
    GuideUpdateBody,
    HostBody,
    JoinBody,
    KeyBody,
    MicBody,
    MicUpdateBody,
    MoveBody,
    ProgressBody,
    RequestBody,
    ReverbUpdateBody,
    SessionInfo,
    Singer,
    SingersBody,
    Song,
    State,
)
from .pipeline import Pipeline, entry_is_ready
from .session import Session
from .storage import MELODY, VOCALS, Storage, is_media_name

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("karaoke")

MEDIA_TYPES = {VOCALS: "audio/mp4", MELODY: "application/json"}


def media_type(name: str) -> str:
    if name.endswith(".m4a"):
        return "audio/mp4"
    return MEDIA_TYPES.get(name, "video/mp4")


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def base_url() -> str:
    return settings.public_url or f"http://{lan_ip()}:{settings.port}"


# --- estado global -----------------------------------------------------------
settings.ensure_dirs()
storage = Storage(settings.db_path, settings.media_dir)
library = Library(settings.data_dir)
session = Session(lambda e: entry_is_ready(e, storage.get(e.yt_id), settings), settings.settings_path)


def build_state() -> dict[str, Any]:
    songs: dict[str, Song] = {}
    for entry in [*session.queue, *session.history[-10:]]:
        if entry.yt_id not in songs:
            song = storage.get(entry.yt_id)
            if song:
                songs[entry.yt_id] = song
    state = State(
        session=SessionInfo(join_url=f"{base_url()}/join"),
        singers=list(session.singers.values()),
        queue=session.queue,
        history=session.history[-10:],
        player=session.player,
        songs=songs,
        separation_enabled=settings.separation_enabled,
        audio=session.audio,
        library_rev=f"{library.rev}.{sum(1 for s in storage.all().values() if is_local(s))}",
    )
    return state.model_dump(mode="json")


hub = Hub(build_state)


def changed() -> None:
    session.refresh_player()
    hub.notify()
    pipeline.kick()
    _sync_scorer()


# --- pontuação de letra: um avaliador por música em reprodução ---------------
scorers: dict[str, LyricScorer] = {}


def _sync_scorer() -> None:
    """Descarta avaliadores de músicas que já não são a atual."""
    cur = session.current()
    for entry_id in list(scorers):
        if cur is None or entry_id != cur.id:
            scorers.pop(entry_id).stop()


def _scorer_for_current() -> LyricScorer | None:
    cur = session.current()
    if cur is None or not settings.asr_enabled:
        return None
    if cur.id in scorers:
        return scorers[cur.id]
    song = storage.get(cur.yt_id)
    if song is None or not song.lyrics or session.player.status not in ("playing", "paused"):
        return None
    scorers[cur.id] = LyricScorer(cur, song, session.singers, settings.asr_model, hub.send)
    return scorers[cur.id]


pipeline = Pipeline(
    settings,
    storage,
    notify=changed,
    notify_threadsafe=hub.notify_threadsafe,
    pending_entries=lambda: list(session.queue),
    protected_ids=lambda: {e.yt_id for e in session.queue},
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    hub.loop = asyncio.get_running_loop()
    imported = importer.scan_import_dir(settings.import_dir, storage, library)
    library.prune_requests(storage.all())
    if imported:
        log.info("pacotes importados de %s: %s", settings.import_dir, imported)
    task = asyncio.create_task(pipeline.run())
    join_url = f"{base_url()}/join"
    print("\n==============================================")
    print(f"  Palco (abra no Mac):   http://localhost:{settings.port}/stage")
    print(f"  Celulares (QR code):   {join_url}")
    print(f"  PIN do anfitrião:      {settings.host_pin}")
    print(f"  Separação de voz:      {'ligada' if settings.separation_enabled else 'DESLIGADA'}")
    print("==============================================\n")
    segno.make(join_url, error="m").terminal(compact=True)
    yield
    task.cancel()


app = FastAPI(title="Karaokê", lifespan=lifespan)


# --- identidade --------------------------------------------------------------
def client_ip(request: Request) -> str:
    direct = request.client.host if request.client else ""
    if direct in ("127.0.0.1", "::1"):
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return direct


def me(request: Request) -> Singer | None:
    return session.by_token(request.headers.get("x-singer-token"))


def is_host(request: Request) -> bool:
    if client_ip(request) in ("127.0.0.1", "::1"):
        return True
    singer = me(request)
    return bool(singer and singer.is_host)


def require_host(request: Request) -> None:
    if not is_host(request):
        raise HTTPException(403, "Só o anfitrião pode fazer isso")


def require_control(request: Request) -> None:
    """Controles do player: anfitrião ou quem está cantando a música atual."""
    if is_host(request):
        return
    singer = me(request)
    cur = session.current()
    if singer and cur and singer.id in cur.singer_ids:
        return
    raise HTTPException(403, "Só o anfitrião ou quem está cantando pode controlar o player")


def require_singer(request: Request) -> Singer:
    singer = me(request)
    if singer is None:
        raise HTTPException(401, "Entre na sessão primeiro")
    return singer


# --- sessão ------------------------------------------------------------------
@app.get("/api/state")
def get_state(request: Request) -> dict[str, Any]:
    singer = me(request)
    return {**build_state(), "me": singer.model_dump() if singer else None, "is_host": is_host(request)}


@app.post("/api/join")
async def join(body: JoinBody) -> dict[str, Any]:
    singer, token = session.join(body.name)
    changed()
    return {"singer": singer.model_dump(), "token": token}


@app.post("/api/host")
async def become_host(body: HostBody, request: Request) -> dict[str, Any]:
    singer = require_singer(request)
    if body.pin.strip() != settings.host_pin:
        raise HTTPException(403, "PIN incorreto")
    singer.is_host = True
    changed()
    return singer.model_dump()


@app.post("/api/me/mic")
async def set_mic(body: MicBody, request: Request) -> dict[str, Any]:
    singer = require_singer(request)
    if body.mic not in (None, 1, 2):
        raise HTTPException(400, "Microfone deve ser 1 ou 2")
    session.set_mic(singer.id, body.mic)
    changed()
    return singer.model_dump()


# --- busca e fila ------------------------------------------------------------
@app.get("/api/search")
async def search(q: str, request: Request) -> list[dict[str, Any]]:
    if me(request) is None and not is_host(request):
        raise HTTPException(401, "Entre na sessão primeiro")
    q = q.strip()
    if not q:
        return []
    try:
        videos = await asyncio.to_thread(youtube.search, q, settings.search_results)
    except Exception as exc:
        log.exception("busca falhou")
        raise HTTPException(502, f"Busca no YouTube falhou: {str(exc)[:200]}") from exc
    songs = storage.all()
    return [{**v.model_dump(), "library": library.where(v.yt_id, songs)} for v in videos]


@app.post("/api/queue")
async def add_to_queue(body: AddToQueueBody, request: Request) -> dict[str, Any]:
    singer = me(request)
    if singer is None and not is_host(request):
        raise HTTPException(401, "Entre na sessão primeiro")
    singer_ids = body.singer_ids or ([singer.id] if singer else [])
    for sid in singer_ids:
        if sid not in session.singers:
            raise HTTPException(400, "Cantor desconhecido")
    song = storage.get(body.video.yt_id)
    if song is None:
        song = Song(video=body.video)
    elif song.status == "error":
        song.status = "pending"
        song.error = None
    storage.save(song)
    storage.touch(song.video.yt_id)
    entry = session.add(body.video, singer_ids, body.is_karaoke_version)
    changed()
    return entry.model_dump()


@app.delete("/api/queue/{entry_id}", status_code=204)
async def remove_from_queue(entry_id: str, request: Request) -> Response:
    entry = session.entry(entry_id)
    if entry is None:
        raise HTTPException(404, "Música não está na fila")
    singer = me(request)
    owner = singer is not None and singer.id in entry.singer_ids
    if not owner and not is_host(request):
        raise HTTPException(403, "Só quem adicionou ou o anfitrião pode remover")
    session.remove(entry_id)
    changed()
    return Response(status_code=204)


def editable_entry(entry_id: str, request: Request) -> Any:
    entry = session.entry(entry_id)
    if entry is None:
        raise HTTPException(404, "Música não está na fila")
    singer = me(request)
    owner = singer is not None and singer.id in entry.singer_ids
    if not owner and not is_host(request):
        raise HTTPException(403, "Só quem vai cantar ou o anfitrião pode alterar")
    return entry


@app.post("/api/queue/{entry_id}/key")
async def set_key(entry_id: str, body: KeyBody, request: Request) -> dict[str, Any]:
    entry = editable_entry(entry_id, request)
    session.set_key_shift(entry_id, body.semitones)
    changed()
    return entry.model_dump()


@app.post("/api/queue/{entry_id}/singers")
async def set_singers(entry_id: str, body: SingersBody, request: Request) -> dict[str, Any]:
    entry = editable_entry(entry_id, request)
    for sid in body.singer_ids:
        if sid not in session.singers:
            raise HTTPException(400, "Cantor desconhecido")
    session.set_singers(entry_id, body.singer_ids)
    changed()
    return entry.model_dump()


@app.post("/api/queue/{entry_id}/duet")
async def set_duet(entry_id: str, body: DuetBody, request: Request) -> dict[str, Any]:
    entry = editable_entry(entry_id, request)
    session.set_duet_swap(entry_id, body.swap)
    changed()
    return entry.model_dump()


@app.post("/api/queue/{entry_id}/move")
async def move_in_queue(entry_id: str, body: MoveBody, request: Request) -> list[dict[str, Any]]:
    require_host(request)
    if session.entry(entry_id) is None:
        raise HTTPException(404, "Música não está na fila")
    session.move(entry_id, body.position)
    changed()
    return [e.model_dump() for e in session.queue]


# --- player ------------------------------------------------------------------
@app.post("/api/player/next")
async def player_next(request: Request) -> dict[str, Any]:
    require_control(request)
    session.skip()
    changed()
    return session.player.model_dump()


@app.post("/api/player/pause")
async def player_pause(request: Request) -> dict[str, Any]:
    require_control(request)
    session.pause()
    changed()
    return session.player.model_dump()


@app.post("/api/player/play")
async def player_play(request: Request) -> dict[str, Any]:
    require_control(request)
    session.play()
    changed()
    return session.player.model_dump()


@app.post("/api/player/stop")
async def player_stop(request: Request) -> dict[str, Any]:
    require_control(request)
    session.stop()
    changed()
    return session.player.model_dump()


@app.post("/api/player/restart")
async def player_restart(request: Request) -> dict[str, Any]:
    require_control(request)
    session.restart()
    changed()
    return session.player.model_dump()


@app.post("/api/player/progress", status_code=204)
async def player_progress(body: ProgressBody, request: Request) -> Response:
    require_host(request)
    session.set_position(body.position)
    await hub.send({"type": "progress", "entry_id": session.player.entry_id, "position": body.position})
    return Response(status_code=204)


@app.post("/api/player/finish")
async def player_finish(request: Request, body: EndedBody | None = None) -> dict[str, Any]:
    """Fim da música: junta afinação (do palco) e letra (do servidor) por cantor, sem avançar a fila."""
    require_host(request)
    cur = session.current()
    if cur is None:
        return {"score_details": {}}
    pitch = session._attribute_scores(cur, body.scores) if body and body.scores else {}
    scorer = scorers.get(cur.id)
    lyrics = scorer.totals() if scorer else {}
    details: dict[str, dict[str, int]] = {}
    for who in set(pitch) | set(lyrics):
        parts = {k: v for k, v in (("pitch", pitch.get(who)), ("lyrics", lyrics.get(who))) if v is not None}
        parts["total"] = round(sum(parts.values()) / len(parts))
        details[who] = parts
    cur.score_details = details or None
    cur.scores = {who: d["total"] for who, d in details.items()} or None
    changed()
    return {"score_details": details}


@app.post("/api/player/ended")
async def player_ended(request: Request, body: EndedBody | None = None) -> dict[str, Any]:
    require_host(request)
    cur = session.current()
    if cur is not None and cur.scores is None and body and body.scores:
        await player_finish(request, body)
    session.skip()
    changed()
    return session.player.model_dump()


# --- áudio: autotune e reverb ------------------------------------------------
@app.post("/api/audio/mic/{n}")
async def update_mic(n: int, body: MicUpdateBody, request: Request) -> dict[str, Any]:
    if n not in (1, 2):
        raise HTTPException(404, "Microfone deve ser 1 ou 2")
    singer = me(request)
    if not is_host(request) and not (singer and singer.mic == n):
        raise HTTPException(403, "Só o anfitrião ou quem está com este microfone pode ajustar")
    mic = session.audio.mics[n - 1]
    data = body.model_dump(exclude_none=True)
    if data.pop("chromatic", False):
        mic.key = None
        mic.scale = "chromatic"
    for field, value in data.items():
        setattr(mic, field, value)
    if mic.key is not None and mic.scale == "chromatic":
        mic.scale = "major"
    session.save_audio()
    changed()
    return mic.model_dump()


@app.post("/api/audio/reverb")
async def update_reverb(body: ReverbUpdateBody, request: Request) -> dict[str, Any]:
    require_host(request)
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(session.audio.reverb, field, value)
    session.save_audio()
    changed()
    return session.audio.reverb.model_dump()


@app.post("/api/audio/guide")
async def update_guide(body: GuideUpdateBody, request: Request) -> dict[str, Any]:
    require_control(request)
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(session.audio.guide, field, value)
    session.save_audio()
    changed()
    return session.audio.guide.model_dump()


# --- importação de pacotes (zip do Colab) ------------------------------------
@app.post("/api/import/scan")
async def import_scan(request: Request) -> dict[str, Any]:
    require_host(request)
    imported = await asyncio.to_thread(importer.scan_import_dir, settings.import_dir, storage, library)
    changed()
    return {"imported": imported, "import_dir": str(settings.import_dir)}


# --- biblioteca e pedidos para o Colab ----------------------------------------
@app.get("/api/library")
def get_library(request: Request) -> dict[str, Any]:
    if me(request) is None and not is_host(request):
        raise HTTPException(401, "Entre na sessão primeiro")
    songs = storage.all()
    library.prune_requests(songs)  # pedidos que o próprio Mac já processou
    return library.snapshot(songs)


@app.post("/api/requests")
async def add_request(body: RequestBody, request: Request) -> dict[str, Any]:
    require_host(request)
    songs = storage.all()
    where = library.where(body.video.yt_id, songs)
    if where in ("local", "drive"):
        raise HTTPException(409, "Já processada: está no Mac" if where == "local" else "Já processada no Colab")
    singer = me(request)
    try:
        req = library.add_request(body.video, body.is_karaoke_version, singer.name if singer else None)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    changed()
    return req.model_dump()


@app.delete("/api/requests/{yt_id}", status_code=204)
async def remove_request(yt_id: str, request: Request) -> Response:
    require_host(request)
    library.remove_requests({yt_id})
    changed()
    return Response(status_code=204)


@app.get("/api/requests.txt")
def requests_txt(request: Request) -> PlainTextResponse:
    require_host(request)
    return PlainTextResponse(
        library.requests_text(), headers={"Content-Disposition": 'attachment; filename="pedidos.txt"'}
    )


# --- utilidades --------------------------------------------------------------
@app.get("/api/qr.svg")
def qr_svg() -> Response:
    buf = io.BytesIO()
    segno.make(f"{base_url()}/join", error="m").save(buf, kind="svg", scale=10, dark="#111111", light=None)
    return Response(buf.getvalue(), media_type="image/svg+xml")


@app.get("/media/{yt_id}/{name}")
def media(yt_id: str, name: str) -> FileResponse:
    if not is_media_name(name) or "/" in yt_id or ".." in yt_id:
        raise HTTPException(404)
    path = storage.path(yt_id, name)
    if not path.exists():
        raise HTTPException(404, "Arquivo ainda não está pronto")
    return FileResponse(path, media_type=media_type(name))


@app.websocket("/ws/mic/{mic}")
async def websocket_mic(ws: WebSocket, mic: int) -> None:
    """Áudio de um microfone vindo do palco: quadros binários [float64 tempo do vídeo][int16 16 kHz...]."""
    await ws.accept()
    if mic not in (1, 2):
        await ws.close()
        return
    try:
        while True:
            data = await ws.receive_bytes()
            if len(data) < 10:
                continue
            (t,) = struct.unpack_from("<d", data, 0)
            samples = np.frombuffer(data, dtype="<i2", offset=8)
            scorer = _scorer_for_current()
            if scorer is not None:
                scorer.feed(mic, float(t), samples)
    except WebSocketDisconnect:
        pass


@app.websocket("/ws")
async def websocket(ws: WebSocket) -> None:
    await hub.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(ws)


# --- telas (SPA buildada em web/dist) ----------------------------------------
if (settings.web_dist / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=settings.web_dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> FileResponse:
        candidate = settings.web_dist / path
        if path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(settings.web_dist / "index.html")

else:

    @app.get("/{path:path}", include_in_schema=False)
    def no_build(path: str) -> HTMLResponse:
        return HTMLResponse(
            "<h1>Karaokê</h1><p>As telas ainda não foram buildadas. Rode <code>make build</code> "
            "ou use o servidor do Vite em dev (<code>make dev</code>).</p>",
            status_code=503,
        )
