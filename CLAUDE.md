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
- `web/` (React 19, Vite 7, TS estrito, sem roteador): `/stage` (TV) e `/join` (celular). `src/audio/engine.ts` captura dos mics via Web Audio; `public/worklets/autotune.js` é um AudioWorklet puro (YIN + shifter de duas leituras); `public/worklets/noisegate.js` faz a supressão de ruído; `src/stage/scoring.ts` pontuação; `src/stage/PitchLane.tsx` faixa de melodia.
- `colab/karaoke_colab.ipynb`: processa na GPU com BS-Roformer e gera `karaoke-pack-*.zip` (`songs/<yt_id>/{song.json, original.mp4, instrumental.mp4, vocals.m4a}`), importado por `data/import/` ou `python -m karaoke.importer`.
- Estado flui só do servidor para as telas: toda mutação é um POST, o servidor chama `changed()` e o hub manda o `State` inteiro por WS. Progresso de reprodução vai em mensagem leve `{type: "progress"}`.

## Convenções e decisões

- Arquivos por música em `data/media/<yt_id>/`: `original.mp4`, `instrumental.mp4`, `vocals.m4a`, `melody.json`, variantes `instrumental_k+2.mp4` / `vocals_k-1.m4a` (`variant_name`). Só nomes aceitos por `is_media_name` são servidos.
- Modelo local padrão `UVR-MDX-NET-Inst_HQ_4.onnx` (~45 s por música no M1 Pro). BS-Roformer fica só no Colab: no MPS leva ~27 min por música. Não trocar o padrão local por Roformer.
- `Song.status` é o estado do processamento base; mudanças de tom e melodia de músicas já em cache não mexem no status (senão o player cai em "waiting" e interrompe a música). Use `rendering` e jobs `key`/`melody` no `_pick`.
- Objetos `Song` do `Storage` são compartilhados em memória: mutar e depois `save()`; progresso aparece no estado sem gravar no banco.
- Permissões: `is_host` = loopback ou cantor com PIN; `require_control` = anfitrião ou cantor da música atual (player, voz guia); dono da entrada ou anfitrião edita tom/dueto.
- Títulos do YouTube: normalizar NFC e desfazer mojibake (`fix_mojibake`) antes de buscar letra no lrclib. Entidades HTML (`&amp;`, que o yt-dlp do Colab às vezes devolve) são decodificadas pelo validador de `Video.title`/`channel`.
- lrclib limita requisições (HTTP 429, `Retry-After` de 1 s, curto demais): `lyrics._search` espera 2, 4, 8, 16 s e `fetch_synced` levanta `LyricsUnavailable` se alguma busca ficou sem resposta, para não gravar `lyrics_source = "none"` por engano. O job `lyrics` do pipeline busca de novo a letra de músicas prontas da fila que estão sem letra (inclusive as importadas do Colab), uma vez por música a cada execução, sem mexer no status. No notebook as buscas passam por um lock (as threads de download disputavam) e a falha vira `"erro: lrclib sem resposta"`. Letra só em texto (`plainLyrics`) é tratada só no Colab: com `ALIGN_LYRICS` a célula 3 transcreve a voz separada na GPU (faster-whisper, porte de `asr.py`/`align.py` com `unsynced`: tempos iniciais pela energia da voz, âncoras sem limite de distância, linhas vazias logo após o verso anterior) e grava `lyrics_aligned`; a letra sincronizada também é alinhada lá, e o job `align` do Mac pula quem já vem com `lyrics_aligned` preenchido. O app no Mac só aceita letra sincronizada.
- yt-dlp: usar `yt-dlp[default]` (traz o resolvedor de desafios) e `js_runtimes` com node/deno (`JS_RUNTIMES` em `youtube.py`); sem runtime JS faltam formatos. No Colab, cookies exigem PO token: a célula 1 instala deno e o `bgutil-ytdlp-pot-provider` em modo script e a célula 3 usa os clientes `mweb,tv` quando há cookies. O Drive é montado no fim da célula 2 (`USE_DRIVE`), antes do processamento: `/content/cookies.txt` enviado é copiado para `MyDrive/<DRIVE_FOLDER>/cookies.txt`, e sem envio os cookies vêm do Drive. O yt-dlp usa uma cópia local (`/content/yt-cookies.txt`) porque regrava o arquivo de cookies ao terminar; a célula 4 salva o zip no Drive ou cai para o download pelo navegador.
- Pontuação de letra: `asr.py` (faster-whisper, blocos sobrepostos, sem VAD, áudio normalizado; o VAD corta canto), `align.py` (job `align` no pipeline reposiciona as linhas do lrclib pela transcrição dos vocais + onsets da melodia; `lyrics_aligned` None/False/True), `lyric_score.py` (áudio dos mics chega por `/ws/mic/{n}` em quadros `[float64 tempo do vídeo][int16 16 kHz]`, enviados pelo worklet `tap.js` quando `engine.timeSource` devolve o tempo do vídeo). Um `LyricScorer` por música atual em `main.scorers`; `POST /api/player/finish` junta afinação (palco) e letra (servidor) em `score_details`, e só depois o palco chama `ended`.
- Autotune e efeitos: `Song.key_tonic`/`key_scale` vêm de `melody.detect_key` (Krumhansl sobre o `melody.json`), calculados em `Storage.save` quando há melodia e ainda não há tonalidade (por isso as músicas antigas ganham tonalidade no próximo start). `MicSettings.auto_key` usa essa tonalidade transposta por `playingShift` (0 enquanto a variante de tom é preparada); sem detecção, a correção é cromática. `follow_melody`: o palco manda a melodia (já transposta) e o relógio do vídeo (`[tempo do vídeo, ctx.currentTime]` a cada 250 ms) ao worklet, que mira a nota do vocal na oitava de quem canta se estiver a até 3 st. Dobra, eco (barramento compartilhado) e saturação ficam em `engine.ts`; as predefinições, em `web/src/audio/presets.ts`.
- Volumes e pré-ganho: `MicSettings.boost_db` (0–36 dB) e `MicSettings.gain` (0–4, slider "Volume do mic") amplificam o canal via `preGain` (`GainNode` logo após o `ChannelSplitterNode`, o passa-altas de 80 Hz e o noise gate, antes do autotune e do `tap.js`), com `DynamicsCompressorNode` por canal e limitador no barramento final para evitar clipping. A atenuação (`gain < 1`) fica no fim da cadeia. `AudioSettings.music.volume` (`POST /api/audio/music`, anfitrião ou cantor atual) vai para o `volume` do `<video>`, e a voz guia é multiplicada por ele.
- Supressão de ruído: `MicSettings.denoise` (0–100, padrão 30, 0 = desligada; fora das predefinições, como boost e volume) controla `noisegate.js`, um expansor para baixo sem atraso (não usar `noiseSuppression` do `getUserMedia`: o Chrome força mono, o que quebra a separação L/R da Q-12, e o processamento é afinado para fala). O piso de ruído é adaptativo (mínimo do nível de 20 ms numa janela de ~4 s; desce na hora, sobe 4 dB/s com o portão fechado e só 0,5 dB/s aberto, para nota longa não virar ruído); abre a piso + 8–18 dB, fecha 4 dB abaixo após 200 ms e, fechado, atenua 10–40 dB. Fica antes do `preGain` para o boost não deslocar o piso; o worklet relata níveis crus e `engine.noise()` soma o pré-ganho para o painel do palco. Não remove a música da TV que vaza no mic enquanto alguém canta.
- Biblioteca (`library.py`): o Mac não acessa o Drive. O notebook mantém `MyDrive/karaoke/catalogo.json` (`{updated_at, songs: {yt_id: CatalogEntry}}`, reconstruído dos zips do Drive na primeira vez) e grava uma cópia na raiz de cada pacote; `importer.import_zip` mescla em `data/catalogo.json` (união, vale o `processed_at` mais novo). Pedidos ao Colab ficam em `data/pedidos.json`, saem quando o vídeo fica pronto no Mac ou entra no catálogo (`prune_requests`), e `GET /api/requests.txt` gera o texto do `SONGS` (o notebook lê `MyDrive/karaoke/pedidos.txt` quando `SONGS` está vazio). `State.library_rev` muda com a biblioteca; o celular busca `/api/library` de novo quando ele muda. A busca devolve `library` (`local`/`drive`/`requested`) por resultado.
- Palco: ao trocar o `src` do vídeo o navegador zera `currentTime` e dispara `timeupdate`; por isso o `src` é definido imperativamente no efeito depois de ler `lastTime`. A voz guia é um `<audio>` sincronizado ao vídeo por `playbackRate` e seeks.
- Na tela `/join` as três seções ficam sempre montadas; o CSS esconde as inativas no celular (abas) e mostra as três colunas a partir de 960 px.
- pnpm 11 exige `allowBuilds` em `web/pnpm-workspace.yaml` para o esbuild.
- Ruff usa a configuração global do usuário (regras amplas como BLE/PERF/RUF); rode `make lint` antes de terminar.

## Hardware do usuário

Interface de áudio USB Q-12 (2 canais: Canal 1 = Esquerdo / Mic 1, Canal 2 = Direito / Mic 2 no modo estéreo) e/ou Kit Amby AY-M220 (dois mics sem fio e um receptor com saída P10 mista). Som sai pela TV via HDMI.
