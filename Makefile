.PHONY: setup build run dev lint

# Instala dependências Python (uv) e do frontend (pnpm)
setup:
	uv sync
	cd web && pnpm install

# Gera as telas em web/dist (servidas pelo Python)
build:
	cd web && pnpm build

# Modo festa: um único processo na porta 8000. Abra http://localhost:8000/stage no Mac.
run: build
	uv run uvicorn karaoke.main:app --host 0.0.0.0 --port 8000

# Modo desenvolvimento: servidor + Vite com recarga automática
dev:
	./scripts/dev.sh

lint:
	uv run ruff check karaoke
	cd web && pnpm exec tsc --noEmit
