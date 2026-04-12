#!/usr/bin/env node
import 'dotenv/config';
import { defaultCachePath, loadCache, saveCache, getCachedMovie, patchCachedTorrent, patchMovie } from '../cache.js';
import { DebridProvider } from '../providers/debrid.js';
import { runAutoDownload } from '../auto-download.js';
import { maybeSeedWithQbittorrent } from '../qbt-seed.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { initDailyLogger } from '../logging.js';
import { acquireLock, defaultLockPath } from '../lock.js';

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

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

// Single-instance lock to prevent concurrent monitor runs.
const lockPath = defaultLockPath({ projectRoot, name: 'kimberly-monitor' });
let lock = null;
try {
  lock = await acquireLock({ lockPath, name: 'kimberly-monitor', logger: console });
} catch (e) {
  if (e && e.code === 'LOCKED') {
    console.error(String(e.message || e));
    process.exit(0);
  }
  throw e;
}

const dailyLog = await initDailyLogger({ projectRoot, logger: console });

function normalizeCodec(c) {
  const s = String(c ?? '').toLowerCase();
  if (!s) return '';
  if (s === 'hevc') return 'h265';
  return s;
}

function parseReleaseMetaFromTitle(title) {
  const s = String(title ?? '').toLowerCase();

  // resolution
  let res = (s.match(/\b(2160p|1080p|720p)\b/) || [])[1] || '';
  if (!res) {
    const mNum = s.match(/\b(2160|1080|720)\b/);
    if (mNum) res = `${mNum[1]}p`;
  }

  // codec
  let codec = '';
  if (s.includes('x265') || s.includes('h265') || s.includes('hevc')) codec = 'x265';
  else if (s.includes('x264') || s.includes('h264') || s.includes('avc')) codec = 'x264';

  return { res, codec };
}

function priorityRank({ res, codec }) {
  const r = String(res ?? '').toLowerCase();
  const c = normalizeCodec(codec);

  if (r === '2160p') return 1;
  if (r === '1080p' && (c === 'h265' || c === 'x265')) return 2;
  if (r === '1080p' && (c === 'h264' || c === 'x264')) return 3;
  if (r === '1080p') return 4;
  if (r === '720p') return 5;
  return 6;
}

function parseIsoDate(s) {
  const d = s ? new Date(String(s)) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

const upgradesEnabled = (process.env.ALLOW_UPGRADES || '0') === '1' || (process.env.ALLOW_UPGRADES || '').toLowerCase() === 'true';
const upgradeWindowHours = Number(process.env.UPGRADE_WINDOW_HOURS || '48');
const upgradeWindowMs = (Number.isFinite(upgradeWindowHours) && upgradeWindowHours > 0) ? upgradeWindowHours * 3600_000 : 48 * 3600_000;

const autoDownload = (process.env.AUTO_DOWNLOAD || '0') === '1' || (process.env.AUTO_DOWNLOAD || '').toLowerCase() === 'true';
const destDir = process.env.AUTO_DOWNLOAD_DEST_DIR;

let checked = 0;
let newlyDownloaded = 0;
let upgraded = 0;

async function ensureDebridUrlsFromInfo({ movieTitle, torrentTitle, debridId }) {
  try {
    const info = await provider.getTorrentInfo({ id: String(debridId) });
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
}

async function checkTorrentStatus({ movieTitle, torrentTitle, t, entry }) {
  if (!t || typeof t !== 'object') return;
  if (!t.debrid_id) return;

  const hasLinks = Boolean(t?.debrid_urls?.video || t?.debrid_urls?.subtitle);
  const hasHardError = Boolean(t.last_auto_download_error && hasLinks);
  if (hasHardError) return;

  // Check status when:
  // - it was sent to debrid but not marked downloaded
  // - it was marked downloading but not downloaded
  // - or it is downloaded but movie isn't executed yet (finish)
  const shouldCheckStatus = Boolean((t.downloading && !t.downloaded) || (t.sent_to_debrid && !t.downloaded));
  const shouldTryFinish = Boolean(t.downloaded && !entry?.process_executed);
  if (!shouldCheckStatus && !shouldTryFinish) return;

  checked += 1;
  let info;
  try {
    info = await provider.getTorrentInfo({ id: String(t.debrid_id) });
  } catch (e) {
    const msg = String(e?.message || e);
    await dailyLog.log(`ERROR: monitor_getTorrentInfo movie="${movieTitle}" release="${torrentTitle}" id=${String(t.debrid_id)} msg=${JSON.stringify(msg)}`);
    return;
  }

  if (info.status !== 'downloaded') {
    const s = String(info.status || '');
    if (s === 'downloading' || s === 'queued') {
      cache = patchCachedTorrent(cache, movieTitle, torrentTitle, { downloading: true, sent_to_debrid: true });
    }
    return;
  }

  // Mark downloaded and store debrid direct links (best-effort)
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

  // Ensure links from selected files if possible
  await ensureDebridUrlsFromInfo({ movieTitle, torrentTitle, debridId: t.debrid_id });

  // If movie isn't executed yet, try to auto-download now.
  if (!entry?.process_executed && autoDownload && destDir) {
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

    const okToMarkExecuted = Boolean(dlRes?.okAll && dlRes?.downloadedAny && dlRes?.movedToLibrary);

    if (okToMarkExecuted) {
      const rank = priorityRank({ res: torrentObj?.resolution, codec: torrentObj?.codec });
      cache = patchMovie(cache, movieTitle, {
        process_executed: true,
        final_path: dlRes?.movieDestDir || null,
        imported_release_title: torrentTitle,
        imported_rank: rank,
        imported_at: new Date().toISOString()
      });

      await dailyLog.log(`DOWNLOADED: movie="${movieTitle}" release="${torrentTitle}" dest="${dlRes?.movieDestDir || destDir}"`);

      // Optional: add the same torrent to qBittorrent for seeding (public torrents).
      // Requires QBT_ENABLED=true and WebUI reachable.
      try {
        const mag = torrentObj?.magnet;
        const tpath = torrentObj?.torrent_path;
        await maybeSeedWithQbittorrent({ magnet: mag, torrentPath: tpath, savePath: dlRes?.movieDestDir, logger: console });
      } catch (e) {
        console.log(`QBIT: seed failed: ${String(e?.message || e)}`);
      }

      // If upgrades are enabled, DO NOT remove better releases from RD.
      // We can still cleanup obviously worse/equal ones.
      try {
        const entry3 = getCachedMovie(cache, movieTitle);
        const torrents3 = entry3?.torrents || {};
        for (const [otherTitle, other] of Object.entries(torrents3)) {
          if (otherTitle === torrentTitle) continue;
          const otherId = other?.debrid_id ? String(other.debrid_id) : '';
          if (!otherId) continue;

          const otherRank = priorityRank({ res: other?.resolution, codec: other?.codec });
          if (upgradesEnabled && otherRank < rank) continue; // keep better candidates

          try {
            await provider.removeTorrent({ id: otherId });
          } catch {}

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

async function maybeUpgradeMovie({ movieTitle }) {
  const entry = getCachedMovie(cache, movieTitle);
  if (!entry?.process_executed) return;
  if (!upgradesEnabled) return;

  const importedAt = parseIsoDate(entry.imported_at);
  if (!importedAt) return;
  if ((Date.now() - importedAt.getTime()) > upgradeWindowMs) return;

  const currentRank = Number(entry.imported_rank || 0) || 0;
  if (!currentRank) return;

  const finalPath = entry?.final_path || null;
  if (!finalPath) return;

  // 1) First try: better downloaded torrents already tracked in cache.
  const torrents = entry.torrents || {};
  let candidates = Object.entries(torrents)
    .filter(([_, t]) => t && typeof t === 'object' && t.downloaded && t.debrid_id)
    .map(([title, t]) => ({
      title,
      debridId: String(t.debrid_id),
      rank: priorityRank({ res: t.resolution, codec: t.codec })
    }))
    .filter((x) => x.rank && x.rank < currentRank);

  // 2) Fallback: look at ALL torrents currently in Real-Debrid and match by title/year.
  if (!candidates.length) {
    try {
      const all = await provider.listTorrents();
      const year = entry?.year ? String(entry.year) : '';
      const movieLower = String(movieTitle).toLowerCase();

      const matched = all.filter((t) => {
        const name = String(t.filename || '').toLowerCase();
        if (!name) return false;
        if (!name.includes(movieLower)) return false;
        if (year && !name.includes(year)) return false;
        return true;
      });

      candidates = matched
        .map((t) => {
          const meta = parseReleaseMetaFromTitle(t.filename || '');
          return {
            title: t.filename || t.id,
            debridId: String(t.id),
            rank: priorityRank({ res: meta.res, codec: meta.codec })
          };
        })
        .filter((x) => x.rank && x.rank < currentRank);
    } catch {
      // ignore
    }
  }

  if (!candidates.length) return;

  candidates.sort((a, b) => a.rank - b.rank);
  const best = candidates[0];
  const bestRank = best.rank;
  const bestTorrentTitle = best.title;
  const bestDebridId = best.debridId;

  // Ensure status is downloaded and we have a direct video link.
  let info;
  try {
    info = await provider.getTorrentInfo({ id: bestDebridId });
  } catch {
    return;
  }

  if (String(info.status || '') !== 'downloaded') return;

  // If no links, select biggest video file.
  if (!Array.isArray(info.links) || info.links.filter(Boolean).length === 0) {
    const vids = (info.files || [])
      .filter((f) => {
        const p = String(f.path || '').toLowerCase();
        return p.endsWith('.mkv') || p.endsWith('.mp4') || p.endsWith('.avi') || p.endsWith('.m2ts') || p.endsWith('.mts') || p.endsWith('.m4v') || p.endsWith('.mov');
      })
      .sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0));

    if (vids[0]?.id) {
      try {
        await provider.selectFiles({ id: bestDebridId, fileIds: [Number(vids[0].id)] });
        info = await provider.getTorrentInfo({ id: bestDebridId });
      } catch {
        // ignore
      }
    }
  }

  // Build debridUrls from info
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

  if (!video) return;

  console.log(`UPGRADE: movie="${movieTitle}" rank ${currentRank} -> ${bestRank} (release="${bestTorrentTitle}")`);
  await dailyLog.log(`UPGRADE: movie="${movieTitle}" from_rank=${currentRank} to_rank=${bestRank} release=${JSON.stringify(bestTorrentTitle)} debridId=${JSON.stringify(bestDebridId)}`);

  // Destructive removal requested by user
  try {
    await fs.rm(finalPath, { recursive: true, force: true });
  } catch {}

  const dlRes = await runAutoDownload({
    provider,
    movieTitle,
    movieYear: entry?.year ?? null,
    destDir,
    debridUrls: { video, subtitle },
    plexSectionId: process.env.PLEX_SECTION_ID_FILMES || '1',
    logger: console
  });

  // Optional: if we have the magnet in cache, seed it in qBittorrent as well.
  // For upgrades discovered via listTorrents(), we often won't have the magnet available.
  try {
    const mag = entry?.torrents?.[bestTorrentTitle]?.magnet;
    await maybeSeedWithQbittorrent({ magnet: mag, savePath: dlRes?.movieDestDir, logger: console });
  } catch {}

  const ok = Boolean(dlRes?.okAll && dlRes?.downloadedAny && dlRes?.movedToLibrary);
  if (!ok) {
    await dailyLog.log(`ERROR: upgrade_failed movie="${movieTitle}" release=${JSON.stringify(bestTorrentTitle)}`);
    return;
  }

  upgraded += 1;
  cache = patchMovie(cache, movieTitle, {
    process_executed: true,
    final_path: dlRes?.movieDestDir || finalPath,
    imported_release_title: bestTorrentTitle,
    imported_rank: bestRank,
    imported_at: new Date().toISOString()
  });
}

for (const movieTitle of Object.keys(cache)) {
  const entry = getCachedMovie(cache, movieTitle);
  if (!entry) continue;

  // 1) Check/refresh torrent statuses (for both executed and non-executed movies)
  const torrents = entry.torrents || {};
  for (const [torrentTitle, t] of Object.entries(torrents)) {
    await checkTorrentStatus({ movieTitle, torrentTitle, t, entry });
  }

  // 2) After updating statuses, attempt an upgrade (if enabled)
  await maybeUpgradeMovie({ movieTitle });
}

await saveCache(cachePath, cache);
console.log(`Checked: ${checked}`);
console.log(`Newly downloaded: ${newlyDownloaded}`);
console.log(`Upgraded: ${upgraded}`);
