# torrent-auto-crawlerr

A Node.js automation project that:

1. Reads a Letterboxd list
2. Extracts movie **title** and **year**
3. Searches releases on **Prowlarr**
4. Filters / de-dupes / prioritizes releases
5. Persists results to a JSON cache (`cache.json`)
6. (Optional) runs a Debrid pipeline (Real-Debrid) + auto-download + Plex refresh + Radarr import

## Requirements

### If you will use Docker (recommended)

- **Docker + Docker Compose**
- **A Letterboxd list** (URL like `https://boxd.it/xxxx`)
- **Real-Debrid account** (if you will use `EXECUTE_DEBRID`/auto-download)

> With Docker, you don't need to manually install Prowlarr/Radarr/Bazarr/Node — `docker compose up -d` brings everything up.

### If you will NOT use Docker (manual install)

- **Node.js 18+**
- **Prowlarr** installed and running (default: `http://localhost:9696`)
  - website: https://prowlarr.com
  - you need the **Prowlarr API key** (`PROWLARR_API_KEY`)
- **Radarr** (optional, but recommended if you use Bazarr)
  - website: https://radarr.video
- **Bazarr** (optional)
  - website: https://www.bazarr.media
- **A Letterboxd list** (URL like `https://boxd.it/xxxx`)
  - you can pass it as a CLI argument or set `LETTERBOXD_LIST_URL` in `.env`
- **Real-Debrid account** (for `debrid-cli`/`monitor` and auto-download)
  - you need `REALDEBRID_API_KEY` and `REALDEBRID_URL`

### Optional (both cases)

- **Plex** (auto refresh after downloading/importing)
  - requires `PLEX_TOKEN` and `PLEX_SECTION_ID_FILMES`
- **7-Zip (`7z`)** installed
  - only needed if you enable `AUTO_DOWNLOAD` and Real-Debrid returns `.rar` archives (extraction via `7z x`)

## Installation (step by step) — MANUAL MODE (no Docker)

> If you will use **Docker**, skip this section and go straight to: **Docker (Prowlarr/Radarr/Bazarr stack + nice local URLs)**.

1) Clone the repo

```bash
git clone <repo-url>
cd torrent-auto-crawlerr
```

2) Install dependencies

```bash
npm i
```

3) Configure `.env`

Option A (interactive wizard):

```bash
npm run setup
```

Option B (manual):

```bash
cp .env.example .env
```

4) (If manual) edit `.env` and set the minimum required values

Mandatory:
- `PROWLARR_URL` (if not default)
- `PROWLARR_API_KEY`
- `LETTERBOXD_LIST_URL` (if you want to run `cli.js` without passing a URL argument)

If you will use debrid:
- `REALDEBRID_URL`
- `REALDEBRID_API_KEY`

5) (Optional) install the global CLI commands

```bash
npm link
```

This creates commands like `torrent-auto-crawlerr` / `torrent-auto-crawlerr-debrid` in your PATH.

## Docker (Prowlarr/Radarr/Bazarr stack + nice local URLs)

<details>
<summary><strong>(Optional) How to install Docker on Windows</strong></summary>

- Official Docker Desktop docs: https://docs.docker.com/desktop/setup/install/windows-install/

Tips:
- On Windows, Docker Desktop typically uses **WSL 2** (recommended).
- After installing, verify:

```powershell
docker --version
docker compose version
```

</details>

<details>
<summary><strong>(Optional) How to install Docker on Ubuntu (Linux)</strong></summary>

- Official Docker Engine docs (Ubuntu): https://docs.docker.com/engine/install/ubuntu/

After installing, verify:

```bash
docker --version
docker compose version
```

</details>


If you want users to avoid manually installing Prowlarr/Radarr/Bazarr, this repo includes a `docker-compose.yml` that brings everything up.

Requirement: Docker + Docker Compose.

### Start the stack

1) Configure `.env`

Recommended option (interactive wizard):

- If you have Node installed on the host:

```bash
npm run setup
```

- If you are Docker-only (no Node on the host):

```bash
docker compose run --rm crawler-setup
```

> Recommended: the wizard validates required fields and guides you through the flow. Editing `.env` manually is intended for advanced users.

At minimum, you need: `AUTO_DOWNLOAD_DEST_DIR`, `LETTERBOXD_LIST_URL`, and `PROWLARR_API_KEY`.

2) Start the services (GUIs + proxy):

```bash
docker compose up -d
```

3) Run the crawler (no Node install required on the host):

```bash
# runs cli.js (and if EXECUTE_DEBRID=true, it will run debrid-cli inside the container)
docker compose run --rm crawler-cli

# runs the monitor
docker compose run --rm crawler-monitor
```

### Access the GUIs

- Nice URLs via reverse proxy (Caddy):
  - http://localhost/prowlarr
  - http://localhost/radarr
  - http://localhost/bazarr

- Or access the ports directly:
  - http://localhost:9696 (Prowlarr)
  - http://localhost:7878 (Radarr)
  - http://localhost:6767 (Bazarr)

### Important (path-based reverse proxy)

Some apps may require setting a **URL Base** in their UI to work perfectly behind `/radarr`, `/prowlarr`, `/bazarr`.
If anything looks broken (assets/redirects), use the direct ports or configure URL Base in the app.

<details>
<summary><strong>(Required) How to configure Prowlarr to find torrents</strong></summary>

**Prowlarr is required**: it aggregates indexers and is what allows this project to find torrents.

Step by step:

1) Open the Prowlarr UI:
   - http://localhost/prowlarr (or http://localhost:9696)

2) In the menu, go to **Indexers**

3) Click **Add Indexers**
   - Select where you want Prowlarr to search for torrents (e.g. RARBG, YTS, etc.)
   - The more indexers you add, the better your coverage usually is

4) Click **Test All Indexers** to validate that everything works
   - Remove any indexers that are not working (if any)

5) Click **Save** (important)

Done: Prowlarr configured.

If you’re unsure, check Prowlarr’s official quick start:
- https://wiki.servarr.com/prowlarr/quick-start-guide

</details>

<details>
<summary><strong>(Optional) How to configure Bazarr for automatic subtitle downloads</strong></summary>

**Bazarr** is used to **automatically download subtitles** for your media, integrating with Radarr/Sonarr (here we focus on Radarr).

Step by step:

1) Open the Bazarr UI:
   - http://localhost/bazarr (or http://localhost:6767)

2) Go to **Settings → Radarr**
   - Enable **Enabled**
   - Paste the **Radarr API Key**
     - (you can find it in Radarr UI: **Settings → General**)
   - Uncheck **Download only monitored**
   - Click **Save** (important)

3) Go to **Settings → Languages**
   - In **Language filters**, choose your desired language(s)
     - If you choose more than one, it will download subtitles for both
     - Common recommendation: **pt-BR** and **en-US**
   - Click **Add New Profile**
   - Select the same languages you chose in *language filters*
   - Click **Save**

4) Go to **Settings → Providers**
   - Add the subtitle sites/providers.
   - Recommendations:
     - **Gestdown** (free, no login)
     - **Legendas.net** (free, requires login)
     - **OpenSubtitles.com** (free, requires login)
     - **Supersubtitles** (free, no login)
     - **Wizdom** (free, no login)
     - **YIFY Subtitles** (free, no login)
     - **Subdl** (free, requires API Key)
     - **sub2fm.com** (free, requires login)
   - Click **Save**

5) Go to **Settings → Subtitles**
   - **Subtitle folder**: **Alongside media folder**
   - Enable:
     - **Encode subtitles to UTF-8**
     - **Treat embedded subtitles as downloaded**
     - **Show only desired languages**
     - **Adaptive searching**
     - **Search enabled providers simultaneously**
     - **Golden-section search**
     - **Automatic subtitles audio synchronization**
   - Click **Save**

6) (Optional) **Settings → Plex** (only if you want Plex integration)
   - Enable **Enabled**
   - Click **Plex OAuth** and sign in to your Plex account
   - Enable **Refresh movie metadata after downloading subtitles**
   - Click **Save**

If you’re unsure, check the official Bazarr documentation:
- https://wiki.bazarr.media/Getting-Started/Setup-Guide/

</details>

---

## Windows setup

If you want to run this project on **Windows**:

- Install **Node.js 18+**
- Make sure **Prowlarr** is reachable and your `.env` has `PROWLARR_URL` + `PROWLARR_API_KEY`
- Set Windows paths in `.env` (examples):
  - `AUTO_DOWNLOAD_DEST_DIR=C:\\Videos\\Movies`
  - `RADARR_ROOT_FOLDER_PATH=C:\\Videos\\Movies`
- For `.rar` extraction during auto-download:
  - install **7-Zip**
  - add `7z.exe` to your **PATH**, or set `SEVEN_ZIP_PATH` in `.env`, e.g.:
    - `SEVEN_ZIP_PATH=C:\\Program Files\\7-Zip\\7z.exe`

Notes:
- `.zip` extraction does **not** require 7-Zip (handled in Node).

## Configuration

Your `.env` was created in the installation steps above.

At minimum, make sure you set `PROWLARR_API_KEY`.

## Usage

## (Optional) Scheduled runs (Linux cron / Windows Task Scheduler)

You can create the schedule automatically with:

```bash
npm run cron:linux
# or
npm run cron:windows
```

It uses these `.env` variables:
- `CRON_USE_DOCKER` (default false): if true, scheduling calls `docker compose run --rm ...`
- `CRON_CLI_EVERY_MIN` (default 20)
- `CRON_MONITOR_AFTER_CLI_MIN` (default 10)

If you want to run this automatically every **X minutes**, you can schedule `cli.js` (and optionally `debrid-monitor.js`).

> Tip: prefer scheduling **only what you need**. `cli.js` + `debrid-cli.js` can add many torrents to your debrid; `debrid-monitor.js` is usually the safe one to run periodically.

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
- If Windows can’t find `node`, use the full path (e.g. `C:\\Program Files\\nodejs\\node.exe`).

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

Or pipe the pending array from `cli.js`:

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

- `REWRITE_CACHE` (default `false`): if `true/1`, `cli.js` rewrites the cache entry for the current movie.
- `MAX_NEW_MOVIES_PER_RUN` (default `5`): maximum number of *new* movies added to cache per run (`0` disables the limit).
- `DEBRID_VERBOSE` (default `false`): verbose logs for the debrid flow.
- `DEBRID_RETRY_DELAY_MS` (default `3000`): base delay for retries on HTTP `429`.

Filtering / output:

- `MIN_GIB` / `MAX_GIB`: size range filter
- `MAX_TORRENTS`: cap how many releases are kept per movie
- `HD_ONLY`: if enabled, keep only 1080p/2160p when any exist
- `ENGLISH_TITLE_ONLY`: token-based title match against the Letterboxd title
- `EXCLUDE_TERMS`: comma-separated terms to exclude

## Cache format (Debrid flags)

Per movie:

- `process_executed` (bool): default `false`. If `true`, `debrid-cli` skips the movie.
- `year` (number|null): cached movie year (used for naming)
- `torrents`: map `{ torrentTitle -> torrentObject }`

Per torrent inside `torrents`:

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

There is an `AUTO_DOWNLOAD` env flag (default `false`) to auto-download when a torrent becomes `downloaded`.

Related env:

- `AUTO_DOWNLOAD_DEST_DIR` (final library folder)
- `AUTO_DOWNLOAD_STAGING_DIR` (temporary staging folder; keep it outside Plex library)
- `DIR_NAME_MOVIE_ONLY` (default `true/1`): controls destination folder naming
- `AUTO_DOWNLOAD_REUSE_STAGING` (default `true/1`): reuse staging if a previous run was killed

Tip: we do NOT rename files.

Folder naming is controlled by `DIR_NAME_MOVIE_ONLY`:

- default (`true`): folder name is ONLY the movie name
- if `false`: folder name becomes `name-year-tmdb_<tmdbId>` (when tmdbId can be resolved), else `name-year`

Additionally:

- `PLEX_BASE_URL`
- `PLEX_TOKEN`
- `PLEX_SECTION_ID_FILMES`
- `PLEX_REFRESH_AFTER_DOWNLOAD` (default `false`)
- `RADARR_IMPORT_AFTER_DOWNLOAD` (default `false`)
- `RADARR_BASE_URL` (default `http://127.0.0.1:7878`)
- `RADARR_API_KEY`
- `RADARR_QUALITY_PROFILE_ID` (default `7`)
- `RADARR_ROOT_FOLDER_PATH` (example Linux: `/path/to/Movies`, Windows: `C:\\Videos\\Movies`)

## Orchestration

If you set `EXECUTE_DEBRID=true`, after `cli.js` finishes it will automatically spawn `debrid-cli.js` and pass the pending movies array via stdin.

```env
EXECUTE_DEBRID=true
```

## torrents/ folder (.torrent files)

This project includes a `torrents/` folder to store local `.torrent` files.

- `torrents/.gitkeep` keeps the folder in git
- `torrents/*.torrent` is ignored by `.gitignore`
- in `cache.json`, when there is no magnet, `torrent_url` may store an HTTP link (e.g. Prowlarr `/download`)
- `torrent_path` stores the local downloaded `.torrent` file path

### Important (Prowlarr)

Some indexers make Prowlarr’s `.../download` endpoint respond with `301/302` and `Location: magnet:...`.
In this case there is **no `.torrent` file to download**. The `cli.js` logic converts that redirect into a magnet and stores it in `magnet`, leaving `torrent_path` empty.

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

- `cli.js` supports **two input modes**:
  - list URL (Letterboxd)
  - `--movies` JSON array in the format `"name - year"`
- Prowlarr search is more robust to punctuation (e.g. **Don't → Dont**) by trying a sanitized query variant.
- Debrid/monitor improvements:
  - Treat more video extensions as video (not only `.mkv/.mp4`; includes `.avi`, `.m2ts`, `.mts`, `.m4v`, `.mov`).
  - If a torrent becomes `queued/downloading` after file selection, we **leave it in Debrid** and let the monitor finish later.
  - When we remove a torrent from Debrid, we clear stale `sent_to_debrid/debrid_id` in cache (avoid “phantom sent”).

## Provider base URL + API key (Real-Debrid)


- `REALDEBRID_URL`: if set, takes precedence and becomes the provider base URL
- `REALDEBRID_API_KEY`: sent as `Authorization: Bearer ...`

## Quality priority (sorting)

Releases are prioritized in this order:

1) 2160p (4K), any codec
2) 1080p + H265/X265
3) 1080p + H264/X264
4) 1080p (any codec)
5) 720p (any codec)
6) no resolution detected

Within the same priority:

- smaller size first
- then more seeders
