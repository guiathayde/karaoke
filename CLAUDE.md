# CLAUDE.md

Karaokê caseiro: servidor Python no Mac ligado na TV, convidados entram pelo celular via QR code.
Textos de interface, comentários e mensagens de commit em português do Brasil.

## Comandos

```bash
make setup   # uv sync + pnpm install (requer brew: uv node pnpm ffmpeg rubberband)
make build   # web/dist (tsc --noEmit && vite build)
make run     # build + uvicorn na porta 8000 (modo festa)
make dev     # uvicorn --reload + vite na 5173, QR aponta para a 5173
make lint    # ruff check karaoke + tsc --noEmit
```

Teste manual rápido do servidor sem separar voz: `KARAOKE_SEPARATION=0 KARAOKE_HOST_PIN=1234 uv run uvicorn karaoke.main:app --port 8000`.
Não há testes automatizados; o fluxo foi validado com scripts httpx contra a API e com o Chrome (MCP chrome-devtools). Requisições vindas de loopback são tratadas como anfitrião, o que facilita testar com curl.

## Arquitetura

- `karaoke/` (Python 3.12, FastAPI, uv, `package = false`): `main.py` rotas HTTP/WS + SPA; `session.py` estado em memória (cantores, fila, player, configurações de áudio em `data/settings.json`); `pipeline.py` worker único que prepara músicas (download yt-dlp → separação → mux ffmpeg → melodia → letra) e renderiza variantes de tom; `separator.py` audio-separator (modelo carregado uma vez); `melody.py` pyin → `melody.json`; `lyrics.py` lrclib.net; `storage.py` SQLite + cache em memória dos `Song`; `importer.py` pacotes zip do Colab; `hub.py` broadcast WebSocket coalescido.
- `web/` (React 19, Vite 7, TS estrito, sem roteador): `/stage` (TV) e `/join` (celular). `src/audio/engine.ts` captura dos mics via Web Audio; `public/worklets/autotune.js` é um AudioWorklet puro (YIN + shifter de duas leituras); `src/stage/scoring.ts` pontuação; `src/stage/PitchLane.tsx` faixa de melodia.
- `colab/karaoke_colab.ipynb`: processa na GPU com BS-Roformer e gera `karaoke-pack-*.zip` (`songs/<yt_id>/{song.json, original.mp4, instrumental.mp4, vocals.m4a}`), importado por `data/import/` ou `python -m karaoke.importer`.
- Estado flui só do servidor para as telas: toda mutação é um POST, o servidor chama `changed()` e o hub manda o `State` inteiro por WS. Progresso de reprodução vai em mensagem leve `{type: "progress"}`.

## Convenções e decisões

- Arquivos por música em `data/media/<yt_id>/`: `original.mp4`, `instrumental.mp4`, `vocals.m4a`, `melody.json`, variantes `instrumental_k+2.mp4` / `vocals_k-1.m4a` (`variant_name`). Só nomes aceitos por `is_media_name` são servidos.
- Modelo local padrão `UVR-MDX-NET-Inst_HQ_4.onnx` (~45 s por música no M1 Pro). BS-Roformer fica só no Colab: no MPS leva ~27 min por música. Não trocar o padrão local por Roformer.
- `Song.status` é o estado do processamento base; mudanças de tom e melodia de músicas já em cache não mexem no status (senão o player cai em "waiting" e interrompe a música). Use `rendering` e jobs `key`/`melody` no `_pick`.
- Objetos `Song` do `Storage` são compartilhados em memória: mutar e depois `save()`; progresso aparece no estado sem gravar no banco.
- Permissões: `is_host` = loopback ou cantor com PIN; `require_control` = anfitrião ou cantor da música atual (player, voz guia); dono da entrada ou anfitrião edita tom/dueto.
- Títulos do YouTube: normalizar NFC e desfazer mojibake (`fix_mojibake`) antes de buscar letra no lrclib.
- yt-dlp: usar `yt-dlp[default]` (traz o resolvedor de desafios) e `js_runtimes` com node/deno (`JS_RUNTIMES` em `youtube.py`); sem runtime JS faltam formatos. No Colab, cookies exigem PO token: a célula 1 instala deno e o `bgutil-ytdlp-pot-provider` em modo script e a célula 3 usa os clientes `mweb,tv` quando há cookies.
- Pontuação de letra: `asr.py` (faster-whisper, blocos sobrepostos, sem VAD, áudio normalizado; o VAD corta canto), `align.py` (job `align` no pipeline reposiciona as linhas do lrclib pela transcrição dos vocais + onsets da melodia; `lyrics_aligned` None/False/True), `lyric_score.py` (áudio dos mics chega por `/ws/mic/{n}` em quadros `[float64 tempo do vídeo][int16 16 kHz]`, enviados pelo worklet `tap.js` quando `engine.timeSource` devolve o tempo do vídeo). Um `LyricScorer` por música atual em `main.scorers`; `POST /api/player/finish` junta afinação (palco) e letra (servidor) em `score_details`, e só depois o palco chama `ended`.
- Autotune e efeitos: `Song.key_tonic`/`key_scale` vêm de `melody.detect_key` (Krumhansl sobre o `melody.json`), calculados em `Storage.save` quando há melodia e ainda não há tonalidade (por isso as músicas antigas ganham tonalidade no próximo start). `MicSettings.auto_key` usa essa tonalidade transposta por `playingShift` (0 enquanto a variante de tom é preparada); sem detecção, a correção é cromática. `follow_melody`: o palco manda a melodia (já transposta) e o relógio do vídeo (`[tempo do vídeo, ctx.currentTime]` a cada 250 ms) ao worklet, que mira a nota do vocal na oitava de quem canta se estiver a até 3 st. Dobra, eco (barramento compartilhado) e saturação ficam em `engine.ts`; as predefinições, em `web/src/audio/presets.ts`.
- Palco: ao trocar o `src` do vídeo o navegador zera `currentTime` e dispara `timeupdate`; por isso o `src` é definido imperativamente no efeito depois de ler `lastTime`. A voz guia é um `<audio>` sincronizado ao vídeo por `playbackRate` e seeks.
- Na tela `/join` as três seções ficam sempre montadas; o CSS esconde as inativas no celular (abas) e mostra as três colunas a partir de 960 px.
- pnpm 11 exige `allowBuilds` em `web/pnpm-workspace.yaml` para o esbuild.
- Ruff usa a configuração global do usuário (regras amplas como BLE/PERF/RUF); rode `make lint` antes de terminar.

## Hardware do usuário

Kit Amby AY-M220: dois mics sem fio e um receptor com uma única saída P10 mista. Precisa de interface USB para entrar no Mac; com um canal só, o autotune age na mistura (modo "mono" do painel de microfones). Som sai pela TV via HDMI.
