# torrent-auto-crawlerr

A Node.js automation project that:

1. Reads a Letterboxd list URL
2. Extracts movie **title** and **year**
3. Searches each movie on **Prowlarr**
4. Filters / de-dupes / prioritizes releases
5. Persists the chosen results to a JSON cache
6. (Optional) runs a Debrid pipeline (currently implemented against a provider stub)

## Pré-requisitos

### Obrigatórios

- **Node.js 18+**
- **Prowlarr** instalado e rodando (default: `http://localhost:9696`)
  - Você precisa do **Prowlarr API key** (`PROWLARR_API_KEY`)
- **Uma lista no Letterboxd** (URL tipo `https://boxd.it/xxxx`)
  - você pode passar por argumento ou setar `LETTERBOXD_LIST_URL` no `.env`
- **Conta no Real-Debrid** (pra debrid-cli/monitor e auto-download)
  - você precisa do token em `REALDEBRID_API_KEY` e da base `REALDEBRID_URL`

### Opcionais

- **Plex** (pra dar refresh automático depois de baixar/importar)
  - requer `PLEX_TOKEN` e `PLEX_SECTION_ID_FILMES`
- **Radarr** (pra importar no Radarr depois do download/import manual)
  - requer `RADARR_API_KEY`
- **Bazarr** (não é usado diretamente pelo script; mas faz sentido ter se você quer legendas automáticas via Radarr/Plex)
- **7-Zip (`7z`)** instalado no sistema
  - só é necessário se você usa `AUTO_DOWNLOAD` e o Real-Debrid devolver arquivos `.rar` (o script extrai via `7z x`)

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

3) Crie o arquivo de configuração `.env`

```bash
cp .env.example .env
```

4) Edite o `.env` e configure o mínimo

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

## Windows setup

If you want to run this project on **Windows**:

- Install **Node.js 18+**
- Make sure **Prowlarr** is reachable and your `.env` has `PROWLARR_URL` + `PROWLARR_API_KEY`
- Set Windows paths in `.env` (examples):
  - `AUTO_DOWNLOAD_DEST_DIR=C:\\Videos\\Movies`
  - `RADARR_ROOT_FOLDER_PATH=C:\\Videos\\Movies`
- For `.rar` extraction during auto-download:
  - Install **7-Zip**
  - Either add `7z.exe` to your **PATH**, or set `SEVEN_ZIP_PATH` in `.env`, e.g.:
    - `SEVEN_ZIP_PATH=C:\\Program Files\\7-Zip\\7z.exe`

Notes:
- `.zip` extraction does **not** require 7-Zip (handled in Node).

## Configure

Your `.env` was created in the installation steps above.

At minimum, make sure you set `PROWLARR_API_KEY`.

## Run

## (Optional) Scheduled runs (Linux cron / Windows Task Scheduler)

If you want to run this automatically every **X minutes**, you can schedule `cli.js` (and optionally `debrid-monitor.js`).

> Tip: prefer scheduling **only what you need**. `cli.js` + `debrid-cli.js` can add a lot of torrents to debrid; `debrid-monitor.js` is usually the safe one to run periodically.

### Linux (cron)

1) Open your crontab:

```bash
crontab -e
```

2) Add entries (example: every 30 minutes):

```cron
*/30 * * * * cd <project-root> && /usr/bin/env node src/cli.js >> logs/cli.log 2>&1
*/30 * * * * cd <project-root> && /usr/bin/env node src/debrid-monitor.js >> logs/monitor.log 2>&1
```

Notes:
- Use an **absolute project path** for `<project-root>`.
- Make sure `.env` is configured (the scripts load it automatically).
- Create the logs folder once:

```bash
mkdir -p <project-root>/logs
```

If you want a different interval, replace `*/30` with `*/5` (every 5 min), `*/10`, etc.

### Windows (Task Scheduler)

1) Open **Task Scheduler** → **Create Task…**
2) Tab **Triggers** → **New…** → set “Daily” and “Repeat task every: X minutes”
3) Tab **Actions** → **New…**
   - **Program/script:** `node` (or the full path to `node.exe`)
   - **Add arguments:** `src\cli.js`
   - **Start in:** `<project-root>`
4) Repeat for the monitor:
   - **Add arguments:** `src\debrid-monitor.js`

Notes:
- Ensure your `.env` exists in `<project-root>`.
- If Windows can’t find `node`, use the full path (e.g. `C:\Program Files\nodejs\node.exe`).

### Prowlarr CLI (cache builder)

**Mode A: Letterboxd list URL**

```bash
node src/cli.js "https://boxd.it/xxxx"
```

**Mode A (fallback): use `LETTERBOXD_LIST_URL` from `.env`**

```bash
# .env
LETTERBOXD_LIST_URL=https://boxd.it/xxxx

# run without args
node src/cli.js
```

**Mode B: explicit movies array** (JSON array; each item is `"name - year"`)

```bash
node src/cli.js --movies "[\"Don't Play Us Cheap - 1973\", \"The French Connection - 1971\"]"
```

Output: a JSON array with movie titles from the cache where `process_executed !== true`.

### Debrid CLI

Run using the Letterboxd list URL:

```bash
node src/debrid-cli.js "https://boxd.it/xxxx"
```

Or pipe the pending movies array from `cli.js`:

```bash
node src/cli.js "https://boxd.it/xxxx" | node src/debrid-cli.js
```

### Debrid monitor

```bash
node src/debrid-monitor.js
```

### Manual import to Radarr (existing folder)

If you downloaded a movie manually and created a folder under your library path (e.g. `/path/to/Movies/<Movie Folder>` or `C:\\Videos\\Movies\\<Movie Folder>`), you can ask this script to find the folder and add it to Radarr. It will also trigger a Plex refresh for the Movies section.

```bash
node src/manual-import.js "Movie Name - 1999"
# or without year:
node src/manual-import.js "Movie Name"
```

## Useful environment variables

- `REWRITE_CACHE` (default `false`): if `true/1`, `cli.js` rewrites the cache entry **for the current movie** even if it already exists (does not touch other movies).
- `MAX_NEW_MOVIES_PER_RUN` (default `5`): maximum number of *new* movies that `cli.js` will add to the cache per run (set to `0` to disable).
- `DEBRID_VERBOSE` (default `false`): enables detailed logs for the debrid flow (engine + HTTP request success logs).
- `DEBRID_RETRY_DELAY_MS` (default `3000`): base delay for retries when the provider returns HTTP `429`.
  - 1st retry = 3s, 2nd = 6s, 3rd = 9s

Filtering / output:

- `MIN_GIB` / `MAX_GIB`: size range filter
- `MAX_TORRENTS`: cap how many releases are kept per movie
- `HD_ONLY`: if enabled, only keep 1080p/2160p when any exist
- `ENGLISH_TITLE_ONLY`: token-based title match against the Letterboxd title
- `EXCLUDE_TERMS`: comma-separated terms to exclude
- `INSPECT_METADATA`: if enabled, only accept releases that contain video + `.srt`

## Cache format (Debrid flags)

Per movie:

- `process_executed` (bool): default `false`. If `true`, `debrid-cli` skips the movie.
- `year` (number|null): cached movie year (used for naming the download folder)
- `torrents`: map `{ torrentTitle -> torrentObject }`

Per torrent inside `torrents`:

- `sent_to_debrid` (bool)
- `downloaded` (bool)
- `downloading` (bool)
- `debrid_id` (string)
- `debrid_urls` (object): `{ video: string, subtitle: string }` (direct debrid links aligned with `files[]`)
- `last_auto_download_error` (string): last auto-download error message (empty string when ok)
- `magnet` (string)
- `torrent_url` (string)
- `torrent_path` (string)

## Auto download hook (stub)

There is an `AUTO_DOWNLOAD` env flag (default `false`) to plug an automatic downloader when a torrent becomes `downloaded`.

Related env:

- `AUTO_DOWNLOAD_DEST_DIR` (final library folder)
- `AUTO_DOWNLOAD_STAGING_DIR` (temporary download folder; keep it outside Plex library)
- `AUTO_DOWNLOAD_REUSE_STAGING` (default `true/1`): if a previous run was killed mid-flight, reuse already-downloaded video in the staging folder and just move/import.

Tip: we do NOT rename files.

Folder naming is controlled by `DIR_NAME_MOVIE_ONLY`:
- default (`true`): folder name is ONLY the movie name
- if `false`: folder name becomes `name-year-tmdb_<tmdbId>` (when tmdbId can be resolved), else `name-year`
- `PLEX_BASE_URL`
- `PLEX_TOKEN`
- `PLEX_SECTION_ID_FILMES`
- `PLEX_REFRESH_AFTER_DOWNLOAD` (default `false`): if `true/1`, calls `plexRefreshSection` after download/unzip.
- `RADARR_IMPORT_AFTER_DOWNLOAD` (default `false`): if `true/1`, adds the movie to Radarr after a successful auto-download (so Bazarr can fetch subtitles).
  - Implementation notes: we resolve `tmdbId` via `GET /api/v3/parse` (prefers `parsedMovieInfo.tmdbId`) with a fallback to `GET /api/v3/movie/lookup`.
- `RADARR_BASE_URL` (default `http://127.0.0.1:7878`)
- `RADARR_API_KEY`
- `RADARR_QUALITY_PROFILE_ID` (default `7`)
- `RADARR_ROOT_FOLDER_PATH` (example Linux: `/path/to/Movies`, Windows: `C:\\Videos\\Movies`)

Stub file:

- `src/auto-download.stub.js`

## Orchestration

If you set `EXECUTE_DEBRID=true`, after `cli.js` finishes it will automatically spawn `debrid-cli.js` and pass the pending movies array via stdin.

```env
EXECUTE_DEBRID=true
```

## torrents/ folder (.torrent files)

This project includes a `torrents/` folder to store local `.torrent` files.

- `torrents/.gitkeep` keeps the folder in git
- `torrents/*.torrent` is ignored by `.gitignore`
- In `cache.json`, when there is no magnet, the field `torrent_url` may store an HTTP link (ex.: Prowlarr `/download` endpoint)
- `torrent_path` is reserved for the local downloaded `.torrent` file path

### Important (Prowlarr)

Some indexers make Prowlarr’s `.../download` endpoint respond with `301/302` and `Location: magnet:...`.
In this case, there is **no `.torrent` file to download**. The `cli.js` logic converts that redirect into a magnet and stores it in `magnet`, leaving `torrent_path` empty.

## Download a file by URL (zip/mp4/mkv)

Command: `torrent-auto-crawlerr-download`

```bash
# Download a video
 torrent-auto-crawlerr-download --url "https://example.com/video.mkv" --dest "/path/to/Downloads"

# Download a .zip and extract to destination
 torrent-auto-crawlerr-download --url "https://example.com/subs.zip" --dest "/path/to/Downloads" --unzip

# Extract and delete the .zip
 torrent-auto-crawlerr-download --url "https://example.com/subs.zip" --dest "/path/to/Downloads" --unzip --delete-zip-after
```

## Import a .torrent and fill torrent_path

Command: `torrent-auto-crawlerr-torrent-import`

```bash
# Import from a local file
 torrent-auto-crawlerr-torrent-import --movie "phantom of the paradise" \
  --torrent "Phantom of the Paradise 1974 1080p BluRay x265-RARBG" \
  --file "/path/to/file.torrent"

# Import from an HTTP URL
 torrent-auto-crawlerr-torrent-import --movie "phantom of the paradise" \
  --torrent "Phantom of the Paradise 1974 1080p BluRay x265-RARBG" \
  --url "https://example.com/file.torrent"
```

## Recent changes / notes (2026-02)

- `cli.js` now supports **two input modes**:
  - list URL (Letterboxd)
  - `--movies` JSON array in the format `"name - year"`
- Prowlarr search is now more robust to punctuation (ex.: **Don't → Dont**) by trying a sanitized query variant.
- Debrid/monitor improvements:
  - Treat more video extensions as video (not only `.mkv/.mp4`; now includes `.avi`, `.m2ts`, `.mts`, `.m4v`, `.mov`).
  - If a torrent becomes `queued/downloading` after file selection, we **leave it in Debrid** and let the monitor finish later.
  - When we remove a torrent from Debrid, we clear stale `sent_to_debrid/debrid_id` in cache (avoid “phantom sent”).

## Provider base URL + API key (RealDebrid stub vs Mock)

At the moment `debrid-cli.js` still instantiates `MockDebridProvider`, but these env vars are already used to configure the provider base URL and API key:

- `REALDEBRID_URL`: if set, takes precedence and becomes the provider base URL
- `REALDEBRID_API_KEY`: passed to the provider stub (currently sent as `Authorization: Bearer ...`)
- `MOCK_DEBRID_BASE_URL`: fallback (when `REALDEBRID_URL` is empty)

## Quality priority (sorting)

Releases are prioritized in this order:

1) 2160p (4K), any codec
2) 1080p + H265/X265
3) 1080p + H264/X264
4) 1080p (any codec, including unknown)
5) 720p (any codec)
6) no resolution detected

Within the same priority:

- smaller size first
- then more seeders
