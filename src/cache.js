import { promises as fs } from 'node:fs';
import path from 'node:path';

export function defaultCachePath() {
  // project root relative to this file: ../cache.json
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'cache.json');
}

export async function loadCache(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') return data;
    return {};
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return {};
    throw e;
  }
}

export async function saveCache(cachePath, data) {
  const dir = path.dirname(cachePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${cachePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, cachePath);
}

export function getCachedMovie(cache, movieTitle) {
  const key = String(movieTitle || '').trim();
  const entry = cache?.[key];
  if (!entry || typeof entry !== 'object') return null;

  // New schema: { process_executed, torrents: { ... } }
  if (entry.torrents && typeof entry.torrents === 'object') {
    const torrentTitles = Object.keys(entry.torrents);
    if (torrentTitles.length === 0) return null;
    return entry;
  }

  // Backward-compat schema: { "Torrent title": {..}, ... }
  const torrentTitles = Object.keys(entry);
  if (torrentTitles.length === 0) return null;
  return { process_executed: false, torrents: entry };
}

export function upsertCachedMovie(cache, movieTitle, releases) {
  const key = String(movieTitle || '').trim();
  if (!key) return cache;
  if (!cache || typeof cache !== 'object') cache = {};

  const prevEntry = getCachedMovie(cache, key) || { process_executed: false, torrents: {} };
  const prevTorrents = prevEntry.torrents || {};

  const torrents = {};

  for (const r of releases) {
    const t = String(r.title || '').trim();
    if (!t) continue;

    const prevTorrent = (prevTorrents[t] && typeof prevTorrents[t] === 'object') ? prevTorrents[t] : {};

    torrents[t] = {
      codec: r.codec ?? prevTorrent.codec ?? '',
      resolution: r.resolution ?? prevTorrent.resolution ?? '',
      tamanho: r.tamanho ?? r.sizeGiB ?? prevTorrent.tamanho ?? null,
      magnet: r.magnet ?? prevTorrent.magnet ?? '',
      torrent_url: r.torrent_url ?? prevTorrent.torrent_url ?? '',
      torrent_path: r.torrent_path ?? prevTorrent.torrent_path ?? '',
      sent_to_debrid: r.sent_to_debrid ?? prevTorrent.sent_to_debrid ?? false,
      downloaded: r.downloaded ?? prevTorrent.downloaded ?? false,
      downloading: r.downloading ?? prevTorrent.downloading ?? false,
      debrid_id: r.debrid_id ?? prevTorrent.debrid_id ?? '',
      // Direct debrid links (mapped from getTorrentInfo().links)
      debrid_urls: r.debrid_urls ?? prevTorrent.debrid_urls ?? { video: '', subtitle: '' },
      last_auto_download_error: r.last_auto_download_error ?? prevTorrent.last_auto_download_error ?? ''
    };
  }

  cache[key] = {
    process_executed: prevEntry.process_executed ?? false,
    torrents
  };

  return cache;
}

export function patchCachedTorrent(cache, movieTitle, torrentTitle, patch) {
  const m = String(movieTitle || '').trim();
  const t = String(torrentTitle || '').trim();
  if (!m || !t) return cache;
  if (!cache || typeof cache !== 'object') cache = {};

  const entry = getCachedMovie(cache, m) || { process_executed: false, torrents: {} };
  const torrents = entry.torrents || {};
  const prevTorrent = (torrents[t] && typeof torrents[t] === 'object') ? torrents[t] : {};

  torrents[t] = { ...prevTorrent, ...patch };

  cache[m] = { process_executed: entry.process_executed ?? false, torrents };
  return cache;
}

export function patchMovie(cache, movieTitle, patch) {
  const m = String(movieTitle || '').trim();
  if (!m) return cache;
  if (!cache || typeof cache !== 'object') cache = {};
  const entry = getCachedMovie(cache, m) || { process_executed: false, torrents: {} };
  cache[m] = { ...entry, ...patch, torrents: entry.torrents || {} };
  return cache;
}
