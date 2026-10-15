"""Importa pacotes (.zip) gerados pelo notebook do Colab para o cache local.

Formato do pacote: songs/<yt_id>/{song.json, original.mp4, instrumental.mp4, vocals.m4a}
`song.json` segue o modelo `Song` (video, lyrics, lyrics_source). Pacotes novos trazem também
`catalogo.json` na raiz (tudo o que já foi processado no Colab), mesclado na biblioteca.
"""

from __future__ import annotations

import json
import logging
import shutil
import sys
import zipfile
from pathlib import Path

from .library import Library
from .models import Song
from .storage import INSTRUMENTAL, ORIGINAL, VOCALS, Storage

log = logging.getLogger("karaoke.importer")

ALLOWED = {"song.json", ORIGINAL, INSTRUMENTAL, VOCALS}
CATALOG = "catalogo.json"


def import_zip(zip_path: Path, storage: Storage, library: Library | None = None) -> list[str]:
    imported: list[str] = []
    with zipfile.ZipFile(zip_path) as z:
        if library is not None and CATALOG in z.namelist():
            try:
                added = library.merge_catalog(json.loads(z.read(CATALOG)))
                log.info("pacote %s: catálogo mesclado (%d vídeo(s) novo(s))", zip_path.name, added)
            except ValueError as exc:
                log.warning("pacote %s: catalogo.json inválido (%s)", zip_path.name, exc)
        entries: dict[str, dict[str, zipfile.ZipInfo]] = {}
        for info in z.infolist():
            if info.is_dir():
                continue
            parts = Path(info.filename).parts
            if len(parts) < 2 or parts[-1] not in ALLOWED:
                continue
            yt_id = parts[-2]
            if not yt_id or "/" in yt_id or ".." in yt_id:
                continue
            entries.setdefault(yt_id, {})[parts[-1]] = info
        for yt_id, files in entries.items():
            if "song.json" not in files or ORIGINAL not in files:
                log.warning("pacote %s: %s sem song.json ou original.mp4, ignorado", zip_path.name, yt_id)
                continue
            try:
                meta = json.loads(z.read(files["song.json"]))
                song = Song.model_validate(meta)
            except (ValueError, KeyError) as exc:
                log.warning("pacote %s: song.json inválido em %s (%s)", zip_path.name, yt_id, exc)
                continue
            if song.video.yt_id != yt_id:
                log.warning("pacote %s: id da pasta (%s) difere do song.json (%s)", zip_path.name, yt_id, song.video.yt_id)
                continue
            dest = storage.song_dir(yt_id)
            dest.mkdir(parents=True, exist_ok=True)
            for name, info in files.items():
                if name == "song.json":
                    continue
                with z.open(info) as src, (dest / name).open("wb") as out:
                    shutil.copyfileobj(src, out)
            existing = storage.get(yt_id)
            if existing and existing.lyrics and not song.lyrics:
                song.lyrics, song.lyrics_source = existing.lyrics, existing.lyrics_source
            song.status = "ready"
            song.progress = 1.0
            song.error = None
            storage.save(song)
            imported.append(yt_id)
    if library is not None:
        library.prune_requests(storage.all())
    return imported


def scan_import_dir(import_dir: Path, storage: Storage, library: Library | None = None) -> list[str]:
    """Importa todos os .zip da pasta e move os processados para import/done/."""
    import_dir.mkdir(parents=True, exist_ok=True)
    done = import_dir / "done"
    imported: list[str] = []
    for zip_path in sorted(import_dir.glob("*.zip")):
        try:
            ids = import_zip(zip_path, storage, library)
        except zipfile.BadZipFile:
            log.warning("arquivo inválido ignorado: %s", zip_path)
            continue
        imported.extend(ids)
        done.mkdir(exist_ok=True)
        shutil.move(str(zip_path), str(done / zip_path.name))
        log.info("importado %s: %d música(s)", zip_path.name, len(ids))
    return imported


def main(argv: list[str]) -> int:
    from .config import settings

    if not argv:
        print("uso: python -m karaoke.importer pacote.zip [outro.zip ...]")
        return 2
    settings.ensure_dirs()
    storage = Storage(settings.db_path, settings.media_dir)
    library = Library(settings.data_dir)
    for arg in argv:
        ids = import_zip(Path(arg), storage, library)
        print(f"{arg}: {len(ids)} música(s) importada(s): {', '.join(ids) or '-'}")
    print("Se o servidor estiver rodando, reinicie-o (ou use a pasta data/import e o botão Importar).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
