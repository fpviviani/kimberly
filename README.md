# torrent-auto-crawlerr

Um projeto de automação em Node.js que:

1. Lê uma lista do Letterboxd
2. Extrai **título** e **ano**
3. Busca releases no **Prowlarr**
4. Filtra / deduplica / prioriza releases
5. Persiste o resultado em um cache JSON (`cache.json`)
6. (Opcional) executa um pipeline com Debrid (Real-Debrid) + download automático + refresh do Plex + import no Radarr

## Pré-requisitos

### Obrigatórios

- **Node.js 18+**
- **Prowlarr** instalado e rodando (default: `http://localhost:9696`)
  - você precisa da **API key do Prowlarr** (`PROWLARR_API_KEY`)
- **Uma lista no Letterboxd** (URL tipo `https://boxd.it/xxxx`)
  - você pode passar por argumento ou setar `LETTERBOXD_LIST_URL` no `.env`
- **Conta no Real-Debrid** (para `debrid-cli`/`monitor` e auto-download)
  - você precisa do token em `REALDEBRID_API_KEY` e da base `REALDEBRID_URL`

### Opcionais

- **Plex** (para refresh automático após baixar/importar)
  - requer `PLEX_TOKEN` e `PLEX_SECTION_ID_FILMES`
- **Radarr** (para importar no Radarr após download/import manual)
  - requer `RADARR_API_KEY`
- **Bazarr** (não é usado diretamente pelo script; mas faz sentido ter se você quer legendas automáticas via Radarr/Plex)
- **7-Zip (`7z`)** instalado no sistema
  - só é necessário se você usa `AUTO_DOWNLOAD` e o Real-Debrid devolver arquivos `.rar` (extração via `7z x`)

## Instalação (passo a passo)

1) Clone o repositório

```bash
git clone <repo-url>
cd torrent-auto-crawlerr
```

2) Instale as dependências

```bash
npm i
```

3) Configure o `.env`

Opção A (wizard interativo):

```bash
npm run setup
```

Opção B (manual):

```bash
cp .env.example .env
```

4) (Se escolheu manual) edite o `.env` e configure o mínimo

Obrigatório:
- `PROWLARR_URL` (se não for o default)
- `PROWLARR_API_KEY`
- `LETTERBOXD_LIST_URL` (se quiser rodar o `cli.js` sem passar URL por argumento)

Se você vai usar debrid:
- `REALDEBRID_URL`
- `REALDEBRID_API_KEY`

5) (Opcional) Instalar os comandos CLI globalmente

```bash
npm link
```

Isso cria comandos como `torrent-auto-crawlerr` / `torrent-auto-crawlerr-debrid` no seu PATH.

## Setup no Windows

Se você quiser rodar este projeto no **Windows**:

- Instale o **Node.js 18+**
- Garanta que o **Prowlarr** está acessível e que seu `.env` tem `PROWLARR_URL` + `PROWLARR_API_KEY`
- Configure paths do Windows no `.env` (exemplos):
  - `AUTO_DOWNLOAD_DEST_DIR=C:\\Videos\\Movies`
  - `RADARR_ROOT_FOLDER_PATH=C:\\Videos\\Movies`
- Para extração de `.rar` durante o auto-download:
  - instale o **7-Zip**
  - adicione `7z.exe` no **PATH**, ou sete `SEVEN_ZIP_PATH` no `.env`, por exemplo:
    - `SEVEN_ZIP_PATH=C:\\Program Files\\7-Zip\\7z.exe`

Notas:
- extração de `.zip` **não** precisa de 7-Zip (é feita pelo Node).

## Configuração

Seu `.env` foi criado nos passos de instalação acima.

No mínimo, garanta que você setou `PROWLARR_API_KEY`.

## Uso

## (Opcional) Execução agendada (cron no Linux / Task Scheduler no Windows)

Você pode criar o agendamento automaticamente com:

```bash
npm run cron:linux
# ou
npm run cron:windows
```

Isso usa as variáveis do `.env`:
- `CRON_CLI_EVERY_MIN` (default 20)
- `CRON_MONITOR_AFTER_CLI_MIN` (default 10)

Se você quiser rodar isso automaticamente a cada **X minutos**, você pode agendar o `cli.js` (e opcionalmente o `debrid-monitor.js`).

> Dica: agende apenas o que você precisa. `cli.js` + `debrid-cli.js` podem encher o Debrid com torrents; `debrid-monitor.js` costuma ser o mais seguro para rodar periodicamente.

### Linux (cron)

1) Abra seu crontab:

```bash
crontab -e
```

2) Adicione entradas (exemplo: a cada 30 minutos):

```cron
*/30 * * * * cd <project-root> && /usr/bin/env node src/cli.js >> logs/cli.log 2>&1
*/30 * * * * cd <project-root> && /usr/bin/env node src/debrid-monitor.js >> logs/monitor.log 2>&1
```

Notas:
- Use um path absoluto para `<project-root>`.
- Garanta que o `.env` está configurado (os scripts carregam automaticamente).
- Crie a pasta de logs uma vez:

```bash
mkdir -p <project-root>/logs
```

Para outro intervalo, troque `*/30` por `*/5` (a cada 5 min), `*/10`, etc.

### Windows (Task Scheduler)

1) Abra **Task Scheduler** → **Create Task…**
2) Aba **Triggers** → **New…** → “Daily” e “Repeat task every: X minutes”
3) Aba **Actions** → **New…**
   - **Program/script:** `node` (ou o caminho completo do `node.exe`)
   - **Add arguments:** `src\cli.js`
   - **Start in:** `<project-root>`
4) Repita para o monitor:
   - **Add arguments:** `src\debrid-monitor.js`

Notas:
- Garanta que seu `.env` existe em `<project-root>`.
- Se o Windows não achar `node`, use o path completo (ex.: `C:\\Program Files\\nodejs\\node.exe`).

### Prowlarr CLI (builder do cache)

**Modo A: URL da lista do Letterboxd**

```bash
node src/cli.js "https://boxd.it/xxxx"
```

**Modo A (fallback): usar `LETTERBOXD_LIST_URL` do `.env`**

```bash
# .env
LETTERBOXD_LIST_URL=https://boxd.it/xxxx

# rodar sem args
node src/cli.js
```

**Modo B: array explícito de filmes** (JSON; cada item no formato `"nome - ano"`)

```bash
node src/cli.js --movies "[\"Don't Play Us Cheap - 1973\", \"The French Connection - 1971\"]"
```

Saída: um array JSON com títulos do cache onde `process_executed !== true`.

### Debrid CLI

Rodar usando a URL da lista do Letterboxd:

```bash
node src/debrid-cli.js "https://boxd.it/xxxx"
```

Ou pipeando o array de pendentes do `cli.js`:

```bash
node src/cli.js "https://boxd.it/xxxx" | node src/debrid-cli.js
```

### Debrid monitor

```bash
node src/debrid-monitor.js
```

### Import manual para o Radarr (pasta existente)

Se você baixou um filme manualmente e criou uma pasta dentro da sua biblioteca (ex.: `/path/to/Movies/<Movie Folder>` ou `C:\\Videos\\Movies\\<Movie Folder>`), você pode pedir para este script encontrar a pasta e adicionar no Radarr. Ele também dispara um refresh do Plex.

```bash
node src/manual-import.js "Movie Name - 1999"
# ou sem ano:
node src/manual-import.js "Movie Name"
```

## Variáveis de ambiente úteis

- `REWRITE_CACHE` (default `false`): se `true/1`, o `cli.js` reescreve a entrada de cache **do filme atual** mesmo se já existir.
- `MAX_NEW_MOVIES_PER_RUN` (default `5`): máximo de filmes *novos* que o `cli.js` adiciona ao cache por execução (`0` desabilita limite).
- `DEBRID_VERBOSE` (default `false`): logs detalhados do fluxo de debrid.
- `DEBRID_RETRY_DELAY_MS` (default `3000`): delay base para retry quando o provider retorna HTTP `429`.
  - 1º retry = 3s, 2º = 6s, 3º = 9s

Filtragem / saída:

- `MIN_GIB` / `MAX_GIB`: range de tamanho
- `MAX_TORRENTS`: limita quantos releases ficam por filme
- `HD_ONLY`: se ligado, mantém só 1080p/2160p quando houver HD
- `ENGLISH_TITLE_ONLY`: match por tokens do título do Letterboxd
- `EXCLUDE_TERMS`: termos separados por vírgula para excluir

## Formato do cache (flags de Debrid)

Por filme:

- `process_executed` (bool): default `false`. Se `true`, `debrid-cli` pula o filme.
- `year` (number|null): ano do filme no cache (usado no naming de pasta)
- `torrents`: mapa `{ torrentTitle -> torrentObject }`

Por torrent dentro de `torrents`:

- `sent_to_debrid` (bool)
- `downloaded` (bool)
- `downloading` (bool)
- `debrid_id` (string)
- `debrid_urls` (object): `{ video: string, subtitle: string }`
- `last_auto_download_error` (string)
- `magnet` (string)
- `torrent_url` (string)
- `torrent_path` (string)

## Auto download hook

Existe a flag `AUTO_DOWNLOAD` (default `false`) que liga o auto-download quando um torrent vira `downloaded`.

Related env:

- `AUTO_DOWNLOAD_DEST_DIR` (pasta final)
- `AUTO_DOWNLOAD_STAGING_DIR` (pasta temporária; fora da biblioteca do Plex)
- `DIR_NAME_MOVIE_ONLY` (default `true/1`): controla o naming das pastas de destino
- `AUTO_DOWNLOAD_REUSE_STAGING` (default `true/1`): reaproveita staging se uma execução anterior foi interrompida

Dica: **não renomeamos arquivos**.

Nome das pastas é controlado por `DIR_NAME_MOVIE_ONLY`:

- default (`true`): pasta fica só com o nome do filme
- se `false`: pasta vira `nome-ano-tmdb_<tmdbId>` (quando dá pra resolver tmdbId), senão `nome-ano`

Além disso:

- `PLEX_BASE_URL`
- `PLEX_TOKEN`
- `PLEX_SECTION_ID_FILMES`
- `PLEX_REFRESH_AFTER_DOWNLOAD` (default `false`): se `true/1`, chama `plexRefreshSection` após download/unzip.
- `RADARR_IMPORT_AFTER_DOWNLOAD` (default `false`): se `true/1`, adiciona o filme no Radarr após auto-download.
  - notas: resolve `tmdbId` via `GET /api/v3/parse` com fallback em `GET /api/v3/movie/lookup`.
- `RADARR_BASE_URL` (default `http://127.0.0.1:7878`)
- `RADARR_API_KEY`
- `RADARR_QUALITY_PROFILE_ID` (default `7`)
- `RADARR_ROOT_FOLDER_PATH` (exemplo Linux: `/path/to/Movies`, Windows: `C:\\Videos\\Movies`)

## Orquestração

Se você setar `EXECUTE_DEBRID=true`, depois que o `cli.js` termina ele spawna automaticamente o `debrid-cli.js` e passa o array de filmes pendentes via stdin.

```env
EXECUTE_DEBRID=true
```

## Pasta torrents/ (.torrent files)

Este projeto inclui uma pasta `torrents/` para armazenar arquivos `.torrent` locais.

- `torrents/.gitkeep` mantém a pasta no git
- `torrents/*.torrent` é ignorado no `.gitignore`
- no `cache.json`, quando não há magnet, `torrent_url` pode guardar um link HTTP (ex.: endpoint `/download` do Prowlarr)
- `torrent_path` guarda o caminho do `.torrent` baixado localmente

### Importante (Prowlarr)

Alguns indexers fazem o endpoint `.../download` do Prowlarr responder com `301/302` e `Location: magnet:...`.
Nesse caso **não existe** arquivo `.torrent` para baixar. A lógica do `cli.js` converte esse redirect em magnet e salva em `magnet`, deixando `torrent_path` vazio.

## Baixar um arquivo por URL (zip/mp4/mkv)

Comando: `torrent-auto-crawlerr-download`

```bash
# Baixar um vídeo
 torrent-auto-crawlerr-download --url "https://example.com/video.mkv" --dest "/path/to/Downloads"

# Baixar um .zip e extrair no destino
 torrent-auto-crawlerr-download --url "https://example.com/subs.zip" --dest "/path/to/Downloads" --unzip

# Extrair e deletar o .zip
 torrent-auto-crawlerr-download --url "https://example.com/subs.zip" --dest "/path/to/Downloads" --unzip --delete-zip-after
```

## Importar um .torrent e preencher torrent_path

Comando: `torrent-auto-crawlerr-torrent-import`

```bash
# Importar de um arquivo local
 torrent-auto-crawlerr-torrent-import --movie "phantom of the paradise" \
  --torrent "Phantom of the Paradise 1974 1080p BluRay x265-RARBG" \
  --file "/path/to/file.torrent"

# Importar de uma URL HTTP
 torrent-auto-crawlerr-torrent-import --movie "phantom of the paradise" \
  --torrent "Phantom of the Paradise 1974 1080p BluRay x265-RARBG" \
  --url "https://example.com/file.torrent"
```

## Mudanças recentes / notas (2026-02)

- `cli.js` suporta **dois modos de entrada**:
  - URL de lista (Letterboxd)
  - `--movies` JSON array no formato `"nome - ano"`
- Busca no Prowlarr mais robusta a pontuação (ex.: **Don't → Dont**) tentando uma variação sanitizada.
- Melhorias no debrid/monitor:
  - Mais extensões de vídeo tratadas como vídeo (não só `.mkv/.mp4`; inclui `.avi`, `.m2ts`, `.mts`, `.m4v`, `.mov`).
  - Se um torrent vira `queued/downloading` após seleção de arquivos, a gente **deixa no Debrid** e o monitor finaliza depois.
  - Ao remover um torrent do Debrid, limpa `sent_to_debrid/debrid_id` no cache (evita “phantom sent”).

## Provider base URL + API key (Real-Debrid)


- `REALDEBRID_URL`: se setada, tem prioridade e vira a base URL do provider
- `REALDEBRID_API_KEY`: enviada como `Authorization: Bearer ...`

## Prioridade de qualidade (sorting)

Releases são priorizados nesta ordem:

1) 2160p (4K), qualquer codec
2) 1080p + H265/X265
3) 1080p + H264/X264
4) 1080p (qualquer codec)
5) 720p (qualquer codec)
6) sem resolução detectada

Dentro da mesma prioridade:

- menor tamanho primeiro
- depois mais seeders
