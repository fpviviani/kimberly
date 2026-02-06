# torrent-auto-crawlerr

A Node.js automation project that:

1. Reads a Letterboxd list URL
2. Extracts movie **title** and **year**
3. Searches each movie on **Prowlarr**
4. Filters / de-dupes / prioritizes releases
5. Persists the chosen results to a JSON cache
6. (Optional) runs a Debrid pipeline (currently implemented against a provider stub)

## Requirements

- Node.js 18+
- Prowlarr running (default: `http://localhost:9696`)
- Prowlarr API key

## Install

```bash
cd /home/fabio/Workspace/torrent-auto-crawlerr
npm i
npm link   # optional (installs the CLI commands globally)
```

## Configure

Create your `.env`:

```bash
cp .env.example .env
# edit .env and set PROWLARR_API_KEY
```

## Run

### Prowlarr CLI (cache builder)

```bash
node src/cli.js "https://boxd.it/SnAYa"
```

Output: a JSON array with movie titles from the cache where `process_executed !== true`.

### Debrid CLI

Run using the Letterboxd list URL:

```bash
node src/debrid-cli.js "https://boxd.it/SnAYa"
```

Or pipe the pending movies array from `cli.js`:

```bash
node src/cli.js "https://boxd.it/SnAYa" | node src/debrid-cli.js
```

### Debrid monitor

```bash
node src/debrid-monitor.js
```

## Useful environment variables

- `REWRITE_CACHE` (default `false`): if `true/1`, `cli.js` rewrites the cache entry **for the current movie** even if it already exists (does not touch other movies).
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

- `AUTO_DOWNLOAD_DEST_DIR`
- `PLEX_BASE_URL`
- `PLEX_TOKEN`
- `PLEX_SECTION_ID_FILMES`
- `PLEX_REFRESH_AFTER_DOWNLOAD` (default `false`): if `true/1`, calls `plexRefreshSection` after download/unzip.

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
 torrent-auto-crawlerr-download --url "https://example.com/video.mkv" --dest "/home/fabio/Videos"

# Download a .zip and extract to destination
 torrent-auto-crawlerr-download --url "https://example.com/subs.zip" --dest "/home/fabio/Downloads" --unzip

# Extract and delete the .zip
 torrent-auto-crawlerr-download --url "https://example.com/subs.zip" --dest "/home/fabio/Downloads" --unzip --delete-zip-after
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
