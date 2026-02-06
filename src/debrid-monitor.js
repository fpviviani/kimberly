#!/usr/bin/env node
import 'dotenv/config';
import { defaultCachePath, loadCache, saveCache, getCachedMovie, patchCachedTorrent, patchMovie } from './cache.js';
import { MockDebridProvider } from './providers/mockDebrid.js';
import { runAutoDownload } from './auto-download.js';

function usage() {
  console.log('Usage: torrent-auto-crawlerr-debrid-monitor');
  console.log('Env: REALDEBRID_URL (or MOCK_DEBRID_BASE_URL) required');
  process.exit(2);
}

const realdebridUrl = process.env.REALDEBRID_URL || process.env.realdebrid_url || '';
const realdebridApiKey = process.env.REALDEBRID_API_KEY || process.env.realdebrid_api_key || '';
const mockBase = process.env.MOCK_DEBRID_BASE_URL || '';
const providerBaseUrl = realdebridUrl || mockBase;
if (!providerBaseUrl) usage();

const cachePath = process.env.CACHE_FILE ? process.env.CACHE_FILE : defaultCachePath();
let cache = await loadCache(cachePath);

const provider = new MockDebridProvider({ baseUrl: providerBaseUrl, apiKey: realdebridApiKey });

let checked = 0;
let newlyDownloaded = 0;

for (const movieTitle of Object.keys(cache)) {
  const entry = getCachedMovie(cache, movieTitle);
  if (!entry) continue;
  if (entry.process_executed) continue;

  const torrents = entry.torrents || {};
  for (const [torrentTitle, t] of Object.entries(torrents)) {
    if (!t || typeof t !== 'object') continue;
    if (!t.downloading) continue;
    if (t.downloaded) continue;
    if (!t.debrid_id) continue;
    if (t.last_auto_download_error) continue;

    checked += 1;
    let info;
    try {
      info = await provider.getTorrentInfo({ id: String(t.debrid_id) });
    } catch {
      continue;
    }

    if (info.status === 'downloaded') {
      // Store debrid direct links (video/subtitle) from getTorrentInfo().
      // Real-Debrid returns `links[]` aligned with `files[]`.
      let video = '';
      let subtitle = '';
      try {
        const files = Array.isArray(info?.files) ? info.files : [];
        const links = Array.isArray(info?.links) ? info.links : [];
        for (let i = 0; i < files.length; i++) {
          const p = String(files[i]?.path || '').toLowerCase();
          const link = typeof links[i] === 'string' ? links[i] : '';
          if (!link) continue;
          if (!subtitle && p.endsWith('.srt')) subtitle = link;
          if (!video && (p.endsWith('.mkv') || p.endsWith('.mp4'))) video = link;
        }
      } catch {}

      cache = patchCachedTorrent(cache, movieTitle, torrentTitle, {
        downloaded: true,
        downloading: false,
        sent_to_debrid: true,
        debrid_urls: { video, subtitle }
      });
      newlyDownloaded += 1;

      console.log(`MONITOR: downloaded movie="${movieTitle}" torrent="${torrentTitle}" id=${String(t.debrid_id)}`);

      // AUTO_DOWNLOAD: unrestrict the stored debrid links and download them, then refresh Plex once.
      const autoDownload = (process.env.AUTO_DOWNLOAD || '0') === '1' || (process.env.AUTO_DOWNLOAD || '').toLowerCase() === 'true';
      const destDir = process.env.AUTO_DOWNLOAD_DEST_DIR;

      let okToMarkExecuted = true;
      if (autoDownload && destDir) {
        const entry2 = getCachedMovie(cache, movieTitle);
        const torrentObj = entry2?.torrents?.[torrentTitle];
        const debridUrls = torrentObj?.debrid_urls;

        const dlRes = await runAutoDownload({
          provider,
          movieTitle,
          destDir,
          debridUrls,
          plexSectionId: process.env.PLEX_SECTION_ID_FILMES || '1',
          logger: console
        });

        okToMarkExecuted = Boolean(dlRes?.okAll);
      }

      if (okToMarkExecuted) {
        cache = patchMovie(cache, movieTitle, { process_executed: true });
      } else {
        const msg = `some downloads failed (movie="${movieTitle}")`;
        cache = patchCachedTorrent(cache, movieTitle, torrentTitle, { last_auto_download_error: msg });
        console.log(`AUTO_DOWNLOAD: not marking process_executed=true because ${msg}`);
      }
    }
  }
}

await saveCache(cachePath, cache);
console.log(`Checked: ${checked}`);
console.log(`Newly downloaded: ${newlyDownloaded}`);
