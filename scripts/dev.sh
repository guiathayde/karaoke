#!/usr/bin/env bash
# Sobe o servidor Python (porta 8000) e o Vite (porta 5173) juntos, com recarga automática.
# Os celulares usam a porta do Vite em dev; o QR code já aponta para ela.
set -euo pipefail
cd "$(dirname "$0")/.."
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)"
export KARAOKE_PUBLIC_URL="${KARAOKE_PUBLIC_URL:-http://$IP:5173}"
trap 'kill 0' EXIT INT TERM
uv run uvicorn karaoke.main:app --host 0.0.0.0 --port "${KARAOKE_PORT:-8000}" --reload --reload-dir karaoke &
(cd web && pnpm dev) &
wait
