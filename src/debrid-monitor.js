#!/usr/bin/env node
import 'dotenv/config';
import { defaultCachePath, loadCache, saveCache, getCachedMovie, patchCachedTorrent, patchMovie } from './cache.js';
import { DebridProvider } from './providers/debrid.js';
import { runAutoDownload } from './auto-download.js';
import path from 'node:path';
import { initDailyLogger } from './logging.js';

function usage() {
  console.log('Usage: kimberly-debrid-monitor');
  console.log('Env: REALDEBRID_URL required');
  process.exit(2);
}

const providerBaseUrl = process.env.REALDEBRID_URL || process.env.realdebrid_url || '';
const realdebridApiKey = process.env.REALDEBRID_API_KEY || process.env.realdebrid_api_key || '';
if (!providerBaseUrl) usage();

const cachePath = process.env.CACHE_FILE ? process.env.CACHE_FILE : defaultCachePath();
let cache = await loadCache(cachePath);

const provider = new DebridProvider({ baseUrl: providerBaseUrl, apiKey: realdebridApiKey });

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dailyLog = await initDailyLogger({ projectRoot, logger: console });

let checked = 0;
let newlyDownloaded = 0;

for (const movieTitle of Object.keys(cache)) {
  let entry = getCachedMovie(cache, movieTitle);
  if (!entry) continue;
  if (entry.process_executed) continue;

  const torrents = entry.torrents || {};
  for (const [torrentTitle, t] of Object.entries(torrents)) {
    // If this movie got executed by a previous torrent in this same run, stop.
    entry = getCachedMovie(cache, movieTitle);
    if (entry?.process_executed) break;
    if (!t || typeof t !== 'object') continue;
    if (!t.debrid_id) continue;

    const hasLinks = Boolean(t?.debrid_urls?.video || t?.debrid_urls?.subtitle);

    // If we previously failed but we had no links, allow retry (common when link mapping was missing).
    const hasHardError = Boolean(t.last_auto_download_error && hasLinks);
    if (hasHardError) continue;

    // Cases we care about:
    // 1) Torrent was left downloading=true and we want to see if it became downloaded.
    // 2) Torrent is already marked downloaded=true but movie isn't executed yet (recover/finish download).
    // 3) Torrent was sent to debrid but we haven't marked it as downloading/downloaded yet (recover state).
    const shouldCheckStatus = Boolean((t.downloading && !t.downloaded) || (t.sent_to_debrid && !t.downloaded));
    const shouldTryFinish = Boolean(t.downloaded && !entry.process_executed);

    if (!shouldCheckStatus && !shouldTryFinish) continue;

    checked += 1;
    let info;
    try {
      info = await provider.getTorrentInfo({ id: String(t.debrid_id) });
    } catch (e) {
      const msg = String(e?.message || e);
      await dailyLog.log(`ERROR: monitor_getTorrentInfo movie="${movieTitle}" release="${torrentTitle}" id=${String(t.debrid_id)} msg=${JSON.stringify(msg)}`);
      continue;
    }

    if (info.status !== 'downloaded') {
      // If it's actively downloading/queued, reflect that in the cache so the user sees "de molho".
      const s = String(info.status || '');
      if (s === 'downloading' || s === 'queued') {
        cache = patchCachedTorrent(cache, movieTitle, torrentTitle, { downloading: true, sent_to_debrid: true });
      }
      continue;
    }

    {
      // Store debrid direct links (video/subtitle) from getTorrentInfo().
      // Real-Debrid returns `links[]` aligned with `files[]`.
      let video = '';
      let subtitle = '';
      try {
        const files = Array.isArray(info?.files) ? info.files : [];
        const links = Array.isArray(info?.links) ? info.links : [];
        const isVideo = (p) => {
          const s = String(p || '').toLowerCase();
          return s.endsWith('.mkv') || s.endsWith('.mp4') || s.endsWith('.avi') || s.endsWith('.m2ts') || s.endsWith('.mts') || s.endsWith('.m4v') || s.endsWith('.mov');
        };
        for (let i = 0; i < files.length; i++) {
          const p = String(files[i]?.path || '');
          const link = typeof links[i] === 'string' ? links[i] : '';
          if (!link) continue;
          const pl = p.toLowerCase();
          if (!subtitle && pl.endsWith('.srt')) subtitle = link;
          if (!video && isVideo(p)) video = link;
        }
      } catch {}

      cache = patchCachedTorrent(cache, movieTitle, torrentTitle, {
        downloaded: true,
        downloading: false,
        sent_to_debrid: true,
        debrid_urls: { video, subtitle }
      });
      if (!t.downloaded) newlyDownloaded += 1;

      console.log(`MONITOR: downloaded movie="${movieTitle}" torrent="${torrentTitle}" id=${String(t.debrid_id)}`);

      // Ensure we have debrid direct links (video/subtitle). Real-Debrid links[] are aligned with selected files.
      try {
        const info = await provider.getTorrentInfo({ id: String(t.debrid_id) });
        const files = Array.isArray(info?.files) ? info.files : [];
        const links = Array.isArray(info?.links) ? info.links : [];

        let j = 0;
        const selected = [];
        for (const f of files) {
          if (!f) continue;
          const sel = Number(f.selected || 0);
          if (sel !== 1) continue;
          const link = typeof links[j] === 'string' ? links[j] : '';
          j += 1;
          if (!link) continue;
          selected.push({ ...f, link });
        }

        const sub = selected.find((x) => String(x.path || '').toLowerCase().endsWith('.srt'));
        const vids = selected
          .filter((x) => {
            const p = String(x.path || '').toLowerCase();
            return p.endsWith('.mkv') || p.endsWith('.mp4') || p.endsWith('.avi') || p.endsWith('.m2ts') || p.endsWith('.mts') || p.endsWith('.m4v') || p.endsWith('.mov');
          })
          .sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0));

        const video = vids[0]?.link || '';
        const subtitle = sub?.link || '';

        cache = patchCachedTorrent(cache, movieTitle, torrentTitle, { debrid_urls: { video, subtitle } });
      } catch {
        // non-fatal
      }

      // AUTO_DOWNLOAD: unrestrict the stored debrid links and download them, then refresh Plex once.
      const autoDownload = (process.env.AUTO_DOWNLOAD || '0') === '1' || (process.env.AUTO_DOWNLOAD || '').toLowerCase() === 'true';
      const destDir = process.env.AUTO_DOWNLOAD_DEST_DIR;

      // Only mark process_executed=true after we actually downloaded something and everything succeeded.
      // If AUTO_DOWNLOAD is disabled, we should NOT mark as executed.
      let okToMarkExecuted = false;
      if (autoDownload && destDir) {
        const entry2 = getCachedMovie(cache, movieTitle);
        const torrentObj = entry2?.torrents?.[torrentTitle];
        const debridUrls = torrentObj?.debrid_urls;

        const dlRes = await runAutoDownload({
          provider,
          movieTitle,
          movieYear: entry?.year ?? null,
          destDir,
          debridUrls,
          plexSectionId: process.env.PLEX_SECTION_ID_FILMES || '1',
          logger: console
        });

        okToMarkExecuted = Boolean(dlRes?.okAll && dlRes?.downloadedAny);
        if (okToMarkExecuted) {
          await dailyLog.log(`DOWNLOADED: movie="${movieTitle}" release="${torrentTitle}" dest="${dlRes?.movieDestDir || destDir}"`);
        }
      }

      if (okToMarkExecuted) {
        cache = patchMovie(cache, movieTitle, { process_executed: true });

        // IMPORTANT: once a movie is successfully executed, stop downloading alternate releases.
        // Best-effort cleanup: remove other RD torrents for this movie to avoid wasting slots/bandwidth.
        try {
          const entry3 = getCachedMovie(cache, movieTitle);
          const torrents3 = entry3?.torrents || {};
          for (const [otherTitle, other] of Object.entries(torrents3)) {
            if (otherTitle === torrentTitle) continue;
            const otherId = other?.debrid_id ? String(other.debrid_id) : '';
            if (!otherId) continue;
            // Remove from RD (ignore failures)
            try {
              await provider.removeTorrent({ id: otherId });
            } catch {}

            // Mark as ignored to avoid any future retries if something toggles flags.
            cache = patchCachedTorrent(cache, movieTitle, otherTitle, {
              downloading: false,
              downloaded: true,
              last_auto_download_error: 'ignored (another release already completed)'
            });
          }
        } catch {}
      } else {
        const msg = autoDownload ? `some downloads failed (movie="${movieTitle}")` : `AUTO_DOWNLOAD is disabled (movie="${movieTitle}")`;
        cache = patchCachedTorrent(cache, movieTitle, torrentTitle, { last_auto_download_error: msg });
        console.log(`AUTO_DOWNLOAD: not marking process_executed=true because ${msg}`);
        if (autoDownload) {
          await dailyLog.log(`ERROR: auto_download movie="${movieTitle}" release="${torrentTitle}" msg=${JSON.stringify(msg)}`);
        }
      }
    }
  }
}

await saveCache(cachePath, cache);
console.log(`Checked: ${checked}`);
console.log(`Newly downloaded: ${newlyDownloaded}`);
