# Karaokê

Karaokê caseiro que roda no Mac ligado na TV. As pessoas entram pelo celular via QR code,
escolhem músicas do YouTube, e o servidor prepara cada música: baixa o vídeo, separa a voz do
instrumental com IA e busca a letra sincronizada.

## Requisitos

- macOS com Apple Silicon (a separação usa a GPU via MPS)
- `uv`, `node` + `pnpm`, `ffmpeg` e `rubberband` (todos via Homebrew: `brew install uv node pnpm ffmpeg rubberband`)

## Rodando

```bash
make setup   # instala dependências (Python e frontend)
make run     # builda as telas e sobe tudo na porta 8000
```

O terminal mostra o endereço do palco, o QR code dos celulares e o PIN do anfitrião.

- Palco (TV): abra `http://localhost:8000/stage` no Mac e clique em "Iniciar o palco".
  Atalhos: espaço pausa, `R` recomeça, `S` para, `N` pula, `F` tela cheia, `M` microfones.
- Celulares: escaneiam o QR code (mesma rede Wi-Fi), informam o nome e buscam músicas.
- Anfitrião: no celular, aba com o seu nome, informe o PIN. Só o anfitrião reordena e remove
  músicas dos outros.
- Player: pausar, continuar, recomeçar, parar (volta para a tela de espera com a música ainda na
  fila) e pular. Ficam no card do topo do celular, no painel lateral do palco e nas teclas. Podem
  usar o anfitrião e quem está cantando a música atual.

Na primeira música o modelo de separação é baixado (~80 MB). No M1 Pro, uma música de 4 min
leva cerca de 45 s para separar a voz (modelo MDX-Net Inst HQ 4).

## Microfones

O sinal dos microfones entra no Mac, passa pelo autotune na tela do palco (Web Audio) e sai junto
com a música. Na tela do palco, tecla `M` abre o painel: escolha a entrada e clique em "Ligar
microfones".

- **1 entrada mono**: receptor com uma saída única (os dois microfones chegam misturados). O autotune
  age sobre a mistura; funciona bem quando canta um de cada vez.
- **1 entrada estéreo**: interface de áudio com dois canais, mic 1 na esquerda e mic 2 na direita.
  É o modo que permite autotune independente por cantor.
- **2 dispositivos**: dois adaptadores USB separados.

O Mac não tem entrada P10: é preciso uma interface USB (ou um cabo P10 → USB) entre o receptor e o
computador. Cada cantor ajusta a força do próprio autotune e o tom da música pelo celular; o
anfitrião ajusta tudo, inclusive o reverb.

## Tom, pontuação e dueto

- **Tom**: no celular, aba Fila, engrenagem da música, botões − e + (até 6 semitons). O servidor gera
  uma versão com o tom alterado sem mudar o andamento (Rubber Band, ~3 s por música) e o palco troca
  o arquivo sem perder a posição.
- **Pontuação**: a melodia de referência é extraída dos vocais separados (`melody.json`). Durante a
  música o palco mostra a faixa de notas no topo e o pitch de cada microfone; no fim aparece o
  resultado por cantor e ele fica no histórico ("Últimos resultados" no celular). Precisa dos
  microfones ligados no palco e de uma música com voz separada (versões "já karaokê" não pontuam).
- **Dueto**: na engrenagem da música, escolha o parceiro. A letra alterna as estrofes entre os dois,
  cada um na sua cor, e "Trocar quem começa" inverte as partes.

## Voz guia

O vocal original (separado pela IA) pode tocar junto com o instrumental para ajudar quem não sabe a
letra ou a melodia. No celular, aba Você, card "Voz guia": ligar ou desligar, volume (0 a 100) e
"some quando alguém canta no microfone". Com essa opção, assim que algum microfone capta voz a guia
abaixa em cerca de 0,2 s e volta cerca de 1 s depois do silêncio. Sem microfones ligados no palco,
a guia toca sempre no volume escolhido. Ao mudar o tom da música, a voz guia é regravada no tom
novo junto com o instrumental. Vídeos marcados como "já é karaokê" não têm voz separada, logo não
têm guia.

## Processar no Google Colab (GPU)

Para fazer a separação com o melhor modelo (BS-Roformer) numa GPU, use `colab/karaoke_colab.ipynb`:
liste as músicas, rode as células e baixe o `karaoke-pack-*.zip`. Depois, no Mac:

1. copie o zip para `data/import/`;
2. no celular do anfitrião, aba com o seu nome → **Importar pacotes** (ou reinicie o servidor).

Com o servidor parado, também vale `uv run python -m karaoke.importer pacote.zip`.

## Desenvolvimento

```bash
make dev     # servidor com reload + Vite em http://localhost:5173
```

Variáveis de ambiente (prefixo `KARAOKE_`):

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `PORT` | `8000` | porta do servidor |
| `PUBLIC_URL` | IP da rede local | URL que vai no QR code |
| `DATA_DIR` | `./data` | cache de vídeos, modelos e banco |
| `CACHE_LIMIT_GB` | `20` | limite do cache; apaga as menos usadas |
| `MAX_HEIGHT` | `1080` | resolução máxima do vídeo |
| `SEPARATION` | `1` | `0` desliga a separação de voz (toca o vídeo original) |
| `SEPARATION_MODEL` | `UVR-MDX-NET-Inst_HQ_4.onnx` | modelo do audio-separator |
| `HOST_PIN` | aleatório | PIN fixo do anfitrião |

## Estrutura

- `karaoke/` servidor Python (FastAPI): sessão, fila, busca, pipeline, letras, mídia
- `web/` telas em React: `/stage` (TV) e `/join` (celular); `web/public/worklets/autotune.js` é o autotune,
  `web/src/stage/scoring.ts` a pontuação e `karaoke/melody.py` a melodia de referência
- `colab/` notebook para processar músicas com GPU
- `data/` cache local (ignorado pelo git)
