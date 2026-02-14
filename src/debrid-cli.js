#!/usr/bin/env node
import 'dotenv/config';
import pLimit from 'p-limit';
import { fetchLetterboxdListMovies } from './letterboxd.js';
import { prowlarrSearch } from './prowlarr.js';
import { MockDebridProvider } from './providers/mockDebrid.js';
import { tryMagnetsUntilDownloaded } from './debrid-engine.js';
import { defaultCachePath, loadCache, saveCache, getCachedMovie, upsertCachedMovie, patchCachedTorrent, patchMovie } from './cache.js';
import { spawn } from 'node:child_process'
import { runAutoDownload } from './auto-download.js';

function bytesToGiB(b) {
  return b / (1024 ** 3);
}

function normalizeCodec(c) {
  const s = String(c ?? '').toLowerCase();
  if (!s) return '';
  if (s === 'hevc') return 'h265';
  return s;
}

function normalizeReleaseTitle(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseReleaseTitle(releaseTitle) {
  const s = normalizeReleaseTitle(releaseTitle);
  const year = (s.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || '';

  let res = (s.match(/\b(2160p|1080p|720p|480p|576p)\b/) || [])[1] || '';
  if (!res) {
    const mNum = s.match(/\b(2160|1080|720|576|480)\b/);
    if (mNum) res = `${mNum[1]}p`;
  }
  if (!res) {
    const mShort = s.match(/\b(216|108|72|57|48)\b/);
    if (mShort) {
      const map = { '216': '2160p', '108': '1080p', '72': '720p', '57': '576p', '48': '480p' };
      res = map[mShort[1]] || '';
    }
  }

  let codec = (s.match(/\b(x265|x264|h265|h264|hevc|xvid|av1|avc)\b/) || [])[1] || '';
  if (!codec) {
    const m = s.match(/\b(h)\s*(26[45])\b/);
    if (m) codec = `h${m[2]}`;
  }

  const name = s
    .replace(/\b(19\d{2}|20\d{2})\b/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|576p|2160|1080|720|576|480|216|108|72|57|48)\b/g, ' ')
    .replace(/\b(x265|x264|h265|h264|hevc|xvid|av1|avc)\b/g, ' ')
    .replace(/\b(h)\s*(26[45])\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 16)
    .join(' ');

  return { name, year, codec, res };
}

function inferYearFromReleaseTitle(title) {
  const y = parseReleaseTitle(title || '').year;
  return y && /^\d{4}$/.test(String(y)) ? Number(y) : null;
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

const args = process.argv.slice(2);
const maybeMoviesJson = args.find((a) => a?.trim?.().startsWith('['));
const listUrl = args.find((a) => /^https?:\/\//i.test(a)) || null;

let movieTitlesFromArray = null;
if (maybeMoviesJson) {
  try {
    const parsed = JSON.parse(maybeMoviesJson);
    if (!Array.isArray(parsed)) throw new Error('movies json is not an array');
    movieTitlesFromArray = parsed.map(String);
  } catch (e) {
    console.error(`Failed to parse movies JSON array: ${String(e?.message || e)}`);
    process.exit(2);
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  return await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

if (!movieTitlesFromArray && !listUrl) {
  const stdin = (await readStdin()).trim();
  if (stdin) {
    try {
      const parsed = JSON.parse(stdin);
      if (!Array.isArray(parsed)) throw new Error('stdin json is not an array');
      movieTitlesFromArray = parsed.map(String);
    } catch (e) {
      console.error(`Failed to parse stdin movies JSON array: ${String(e?.message || e)}`);
      process.exit(2);
    }
  } else {
    console.error('Usage: node src/debrid-cli.js <letterboxd_list_url>  OR  node src/debrid-cli.js "[\\"movie 1\\",\\"movie 2\\"]"  OR  node src/cli.js <listUrl> | node src/debrid-cli.js');
    process.exit(2);
  }
}

const baseUrl = process.env.PROWLARR_URL || 'http://localhost:9696';
const apiKey = process.env.PROWLARR_API_KEY;
if (!apiKey) {
  console.error('Missing env PROWLARR_API_KEY');
  process.exit(2);
}

// Provider base URL
// - REALDEBRID_URL: for future Real-Debrid integration (currently still using the mock provider class)
// - MOCK_DEBRID_BASE_URL: legacy/mock-only setting
const realdebridUrl = process.env.REALDEBRID_URL || process.env.realdebrid_url || '';
const realdebridApiKey = process.env.REALDEBRID_API_KEY || process.env.realdebrid_api_key || '';
const mockBase = process.env.MOCK_DEBRID_BASE_URL || '';

const providerBaseUrl = realdebridUrl || mockBase;
if (!providerBaseUrl) {
  console.error('Missing env REALDEBRID_URL (or MOCK_DEBRID_BASE_URL for the mock provider)');
  process.exit(2);
}

const maxGiB = Number(process.env.MAX_GIB || '10');
const minGiB = Number(process.env.MIN_GIB || '1');
const maxBytes = maxGiB * (1024 ** 3);
const minBytes = minGiB * (1024 ** 3);
const maxTorrents = Number(process.env.MAX_TORRENTS || '20');

const concurrency = Number(process.env.CONCURRENCY || '3');
const limit = pLimit(concurrency);
const prowlarrTimeoutMs = Number(process.env.PROWLARR_TIMEOUT_MS || '30000');

const cachePath = process.env.CACHE_FILE ? process.env.CACHE_FILE : defaultCachePath();
let cache = await loadCache(cachePath);

const provider = new MockDebridProvider({ baseUrl: providerBaseUrl, apiKey: realdebridApiKey });

let movies;
if (movieTitlesFromArray) {
  // Read movies directly from cache using the passed array
  movies = movieTitlesFromArray.map((t) => ({ title: t, year: null }));
} else {
  movies = await fetchLetterboxdListMovies(listUrl);
}

for (const movie of movies) {
  // Ensure movie exists in cache: prefer cached list; otherwise query Prowlarr and write only the final list.
  const cached = getCachedMovie(cache, movie.title);
  if (cached?.process_executed) {
    console.log(`Movie: ${movie.title} :: skipped (process_executed=true)`);
    continue;
  }

  let candidates = [];

  if (cached) {
    candidates = Object.entries(cached.torrents)
      .map(([title, v]) => ({
        title,
        parsedName: title,
        parsedYear: movie.year ? String(movie.year) : '',
        parsedCodec: String(v.codec || ''),
        parsedRes: String(v.resolution || ''),
        sizeGiB: Number(v.tamanho),
        magnet: (v.magnet && String(v.magnet).startsWith('magnet:')) ? String(v.magnet) : '',
        torrent_path: v.torrent_path ? String(v.torrent_path) : ''
      }))
      .filter((r) => Boolean(r.magnet) || Boolean(r.torrent_path));
  } else {
    const q = movie.year ? `${movie.title} ${movie.year}` : movie.title;
    const releases = await limit(() => prowlarrSearch({ baseUrl, apiKey, query: q, timeoutMs: prowlarrTimeoutMs }));

    const filtered = releases
      .filter((r) => typeof r?.size === 'number' && r.size >= minBytes && r.size <= maxBytes)
      .map((r) => {
        const p = parseReleaseTitle(r.title);
        return {
          title: r.title,
          parsedName: p.name,
          parsedYear: p.year,
          parsedCodec: p.codec,
          parsedRes: p.res,
          sizeGiB: Number(bytesToGiB(r.size).toFixed(2)),
          downloadUrl: r.magnetUrl || r.downloadUrl || r.guid || r.infoUrl
        };
      })
      .filter((r) => typeof r.downloadUrl === 'string' && r.downloadUrl.startsWith('magnet:'));

    filtered.sort((a, b) => {
      const pa = priorityRank({ res: a.parsedRes, codec: a.parsedCodec });
      const pb = priorityRank({ res: b.parsedRes, codec: b.parsedCodec });
      if (pa !== pb) return pa - pb;
      if (a.sizeGiB !== b.sizeGiB) return a.sizeGiB - b.sizeGiB;
      return String(a.title).localeCompare(String(b.title));
    });

    const chosen = filtered.slice(0, maxTorrents);

    cache = upsertCachedMovie(
      cache,
      movie.title,
      chosen.map((m) => ({
        title: m.title,
        codec: (m.parsedCodec || '').toUpperCase(),
        resolution: (m.parsedRes || '').toUpperCase(),
        tamanho: m.sizeGiB,
        magnet: m.downloadUrl,
        torrent_url: '',
        torrent_path: '',
        sent_to_debrid: false,
        downloaded: false,
        downloading: false,
        debrid_id: '',
        debrid_urls: { video: '', subtitle: '' },
        last_auto_download_error: ''
      })),
      { year: movie.year ?? null }
    );
    await saveCache(cachePath, cache);

    candidates = chosen;
  }

  // Sort by priority (already sorted if came from Prowlarr path; cached path keeps insertion order), enforce maxTorrents
  candidates.sort((a, b) => {
    const pa = priorityRank({ res: a.parsedRes, codec: a.parsedCodec });
    const pb = priorityRank({ res: b.parsedRes, codec: b.parsedCodec });
    if (pa !== pb) return pa - pb;
    if (a.sizeGiB !== b.sizeGiB) return a.sizeGiB - b.sizeGiB;
    return String(a.title).localeCompare(String(b.title));
  });

  const chosen = candidates.slice(0, maxTorrents);
  const attempts = chosen.map((r) => ({ title: r.title, magnet: r.magnet || '', torrent_path: r.torrent_path || '' }));

  console.log(`Movie: ${movie.title}${movie.year ? ` (${movie.year})` : ''} :: trying ${attempts.length} magnets`);

  const res = await tryMagnetsUntilDownloaded({
    provider,
    attempts,
    logger: console,
    onSent: async ({ attempt, id }) => {
      cache = patchCachedTorrent(cache, movie.title, attempt.title, { sent_to_debrid: true, debrid_id: String(id) });
      await saveCache(cachePath, cache);
    },
    onDownloading: async ({ attempt, id }) => {
      cache = patchCachedTorrent(cache, movie.title, attempt.title, { downloading: true, sent_to_debrid: true, debrid_id: String(id) });
      await saveCache(cachePath, cache);
    },
    onRemoved: async ({ attempt, id }) => {
      // If we removed it from Debrid, clear the cached id/flags so we don't show phantom "sent".
      cache = patchCachedTorrent(cache, movie.title, attempt.title, { downloading: false, sent_to_debrid: false, downloaded: false, debrid_id: '' });
      await saveCache(cachePath, cache);
    },
    onDownloaded: async ({ attempt, id }) => {
      // Store debrid direct links (video/subtitle) from getTorrentInfo().
      // Real-Debrid returns `links[]` aligned with *selected* files, not the full `files[]`.
      try {
        const info = await provider.getTorrentInfo({ id });
        const files = Array.isArray(info?.files) ? info.files : [];
        const links = Array.isArray(info?.links) ? info.links : [];

        // Build a map for selected files -> link (consume links in order)
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

        // Subtitle: first .srt among selected
        const sub = selected.find((x) => String(x.path || '').toLowerCase().endsWith('.srt'));

        // Video: pick the biggest selected video file
        const vids = selected
          .filter((x) => {
            const p = String(x.path || '').toLowerCase();
            return p.endsWith('.mkv') || p.endsWith('.mp4');
          })
          .sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0));

        const video = vids[0]?.link || '';
        const subtitle = sub?.link || '';

        cache = patchCachedTorrent(cache, movie.title, attempt.title, {
          debrid_urls: { video, subtitle }
        });
      } catch {
        // non-fatal
      }

      cache = patchCachedTorrent(cache, movie.title, attempt.title, { downloaded: true, downloading: false, debrid_id: String(id) });
      await saveCache(cachePath, cache);
    }
  });

  if (res.ok) {
    console.log(`FOUND_DOWNLOADED: id=${res.id}`);

    // AUTO_DOWNLOAD hook: if enabled, unrestrict the stored debrid links and download them.
    const autoDownload = (process.env.AUTO_DOWNLOAD || '0') === '1' || (process.env.AUTO_DOWNLOAD || '').toLowerCase() === 'true';
    const destDir = process.env.AUTO_DOWNLOAD_DEST_DIR;

    // Only mark process_executed=true after ALL required downloads (video/subtitle) finish successfully.
    // If AUTO_DOWNLOAD is disabled, we should NOT mark as executed.
    let okToMarkExecuted = false;

    if (autoDownload && destDir) {
      const entry = getCachedMovie(cache, movie.title);
      const torrentObj = entry?.torrents?.[res.attempt?.title];
      const debridUrls = torrentObj?.debrid_urls;

      const inferredYear = movie.year ?? entry?.year ?? inferYearFromReleaseTitle(res.attempt?.title);
      if (!movie.year && inferredYear && !entry?.year) {
        cache = patchMovie(cache, movie.title, { year: inferredYear });
        await saveCache(cachePath, cache);
      }

      const dlRes = await runAutoDownload({
        provider,
        movieTitle: movie.title,
        movieYear: inferredYear,
        destDir,
        debridUrls,
        plexSectionId: process.env.PLEX_SECTION_ID_FILMES || '1',
        logger: console
      });

      // Only mark movie as executed after we actually downloaded something AND all required downloads succeeded.
      okToMarkExecuted = Boolean(dlRes?.okAll && dlRes?.downloadedAny);
    }

    if (okToMarkExecuted) {
      cache = patchMovie(cache, movie.title, { process_executed: true });
      await saveCache(cachePath, cache);
    } else {
      const msg = autoDownload ? `some downloads failed (movie="${movie.title}")` : `AUTO_DOWNLOAD is disabled (movie="${movie.title}")`;
      cache = patchCachedTorrent(cache, movie.title, res.attempt?.title || '', { last_auto_download_error: msg });
      await saveCache(cachePath, cache);
      console.log(`AUTO_DOWNLOAD: not marking process_executed=true because ${msg}`);
    }
  } else {
    console.log('NO_DOWNLOADED_FOUND');
  }
}
