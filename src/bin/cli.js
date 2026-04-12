#!/usr/bin/env node
import 'dotenv/config';
import pLimit from 'p-limit';
import { fetchLetterboxdListMovies } from '../letterboxd.js';
import { prowlarrSearch } from '../prowlarr.js';
import { defaultCachePath, loadCache, saveCache, getCachedMovie, upsertCachedMovie } from '../cache.js';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { initDailyLogger } from '../logging.js';
import { acquireLock, defaultLockPath } from '../lock.js';

// STUB: if you implement torrent downloading, uncomment the import below.
import { downloadTorrentStub } from '../torrent-download.stub.js';

function bytesToGiB(b) {
  return b / (1024 ** 3);
}

function normalizeCodec(c) {
  const s = String(c ?? '').toLowerCase();
  if (!s) return '';
  if (s === 'hevc') return 'h265';
  return s;
}

function priorityRank({ res, codec }) {
  const r = String(res ?? '').toLowerCase();
  const c = normalizeCodec(codec);

  // 1 - 4k (2160p) any codec
  if (r === '2160p') return 1;

  // 2 - 1080p h265/x265 (and hevc)
  if (r === '1080p' && (c === 'h265' || c === 'x265')) return 2;

  // 3 - 1080p h264/x264
  if (r === '1080p' && (c === 'h264' || c === 'x264')) return 3;

  // 4 - 1080p any codec (including unknown)
  if (r === '1080p') return 4;

  // 5 - 720p any codec
  if (r === '720p') return 5;

  // 6 - no resolution detected (or others)
  return 6;
}


function isDebridActiveTorrent(t) {
  if (!t || typeof t !== 'object') return false;
  if (t.downloading) return true;
  const st = String(t.status || t.debrid_status || '').toLowerCase();
  return st === 'queued' || st === 'downloading';
}

function pickLinks(release) {
  // Different indexers/providers may name it differently.
  const candidates = [
    release.magnetUrl,
    release.downloadUrl,
    release.guid,
    release.infoUrl
  ].filter(Boolean);

  const magnet = candidates.find((u) => typeof u === 'string' && u.startsWith('magnet:')) || '';
  const torrentUrl = candidates.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u) && !u.startsWith('magnet:')) || '';

  return { magnet, torrentUrl };
}

function normalizeReleaseTitle(s) {
  return String(s ?? '')
    .toLowerCase()
    // remove bracketed tags: [..] (..) {..}
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    // remove any remaining special characters (keep letters/numbers)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokens(s) {
  const norm = normalizeReleaseTitle(s);
  const stop = new Set(['the', 'a', 'an', 'of', 'and', 'or']);
  return norm
    .split(' ')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t.length >= 3)
    .filter((t) => !stop.has(t));
}

function releaseMatchesMovieTitle(movieTitle, releaseTitle) {
  const tokens = titleTokens(movieTitle);
  if (!tokens.length) return true;

  const releaseNorm = normalizeReleaseTitle(releaseTitle);
  const hay = ` ${releaseNorm} `;

  // Special handling for 1-word movie titles (too ambiguous: e.g. "Dreams").
  // Require:
  // - the token appears as a whole word in the release title
  // - AND the release title isn't "too long" (heuristic to avoid matching unrelated titles)
  //
  // This keeps reasonable variants like "Akira Kurosawa's Dreams" (few tokens),
  // while rejecting unrelated long titles like "Summer Dreams the Story of the Beach Boys".
  if (tokens.length === 1) {
    const t = tokens[0];
    if (!hay.includes(` ${t} `)) return false;

    const relTokens = titleTokens(releaseTitle);
    return relTokens.length > 0 && relTokens.length <= 4;
  }

  return tokens.every((t) => hay.includes(` ${t} `));
}

function parseReleaseTitle(releaseTitle) {
  const s = normalizeReleaseTitle(releaseTitle);

  const year = (s.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || '';

  // Resolution: accept 2160p/1080p... and also bare numbers like "1080" or shorthand "108"
  let res = (s.match(/\b(2160p|1080p|720p|480p|576p)\b/) || [])[1] || '';
  if (!res) {
    const mNum = s.match(/\b(2160|1080|720|576|480)\b/);
    if (mNum) res = `${mNum[1]}p`;
  }
  if (!res) {
    // shorthand like "108" -> 1080p (common in some titles)
    const mShort = s.match(/\b(216|108|72|57|48)\b/);
    if (mShort) {
      const map = { '216': '2160p', '108': '1080p', '72': '720p', '57': '576p', '48': '480p' };
      res = map[mShort[1]] || '';
    }
  }

  // Codec: accept spaced forms like "h 265" / "h 264"
  let codec = (s.match(/\b(x265|x264|h265|h264|hevc|xvid|av1|avc)\b/) || [])[1] || '';
  if (!codec) {
    const m = s.match(/\b(h)\s*(26[45])\b/);
    if (m) codec = `h${m[2]}`; // h264/h265
  }

  // Build a "name" index by removing technical tokens.
  const cleaned = s
    .replace(/\b(19\d{2}|20\d{2})\b/g, ' ')
    .replace(/\b(2160p|1080p|720p|480p|576p|2160|1080|720|576|480|216|108|72|57|48)\b/g, ' ')
    .replace(/\b(x265|x264|h265|h264|hevc|xvid|av1|avc)\b/g, ' ')
    .replace(/\b(h)\s*(26[45])\b/g, ' ')
    .replace(/\b(bluray|bdrip|brrip|webrip|webdl|web|hdrip|dvdrip|dvd|remux|repack|proper)\b/g, ' ')
    .replace(/\b(dts|ac3|aac|ddp|atmos|truehd|flac|mp3|5\s*1|7\s*1|stereo)\b/g, ' ')
    .replace(/\b(multi|multisub|sub|subs|legendado|dub|dublado)\b/g, ' ')
    .replace(/\b(ita|italian|eng|english|spa|spanish|pt|por|portuguese|castellano)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const name = cleaned.split(' ').slice(0, 16).join(' ');

  return { name, year, codec, res };
}

const args = process.argv.slice(2);

function parseMovieLabel(s) {
  const raw = String(s || '').trim();
  if (!raw) return null;

  // Expected format: "name - year" (year optional)
  // We split on the LAST " - " to preserve titles containing hyphens.
  const idx = raw.lastIndexOf(' - ');
  if (idx === -1) return { title: raw, year: null };

  const title = raw.slice(0, idx).trim();
  const yearRaw = raw.slice(idx + 3).trim();
  const yearNum = Number(yearRaw);
  const year = Number.isFinite(yearNum) && yearNum > 1800 && yearNum < 2200 ? yearNum : null;
  return { title: title || raw, year };
}

function parseMoviesArrayArg(val) {
  const s = String(val || '').trim();
  if (!s) return null;

  // Primary: JSON array string
  if (s.startsWith('[')) {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) throw new Error('movies arg must be a JSON array');
    return parsed.map(parseMovieLabel).filter(Boolean);
  }

  return null;
}

// CLI modes:
// 1) List URL: node src/bin/cli.js "https://boxd.it/..."
// 2) Movies array: node src/bin/cli.js --movies '["Title - 1999", "Other - 2001"]'
//    (also accepts passing the JSON array as the first arg)
let listUrl = '';
let moviesFromArg = null;

if (args[0] === '--movies' || args[0] === '-m') {
  moviesFromArg = parseMoviesArrayArg(args[1]);
  if (!moviesFromArg) throw new Error('Missing/invalid --movies JSON array');
} else {
  // Auto-detect JSON array
  const maybeMovies = parseMoviesArrayArg(args[0]);
  if (maybeMovies) {
    moviesFromArg = maybeMovies;
  } else {
    listUrl = String(args[0] || '').trim();
  }
}
const maxGiB = Number(process.env.MAX_GIB || '10');
const minGiB = Number(process.env.MIN_GIB || '1');
const maxBytes = maxGiB * (1024 ** 3);
const minBytes = minGiB * (1024 ** 3);
const maxTorrents = Number(process.env.MAX_TORRENTS || '20');
const englishTitleOnly = (process.env.ENGLISH_TITLE_ONLY || '0') === '1' || (process.env.ENGLISH_TITLE_ONLY || '').toLowerCase() === 'true';
const excludeTerms = (process.env.EXCLUDE_TERMS || '').trim();
const excludeTermList = excludeTerms
  ? excludeTerms.split(',').map(s => normalizeReleaseTitle(s)).filter(Boolean)
  : [];
// Used only for de-dup. Bucket in GiB (e.g. 0.1 groups 1.23GiB and 1.31GiB separately; 0.25 groups them together)
const dedupeSizeBucketGiB = Number(process.env.DEDUPE_SIZE_BUCKET_GIB || '0.1');
const hdOnly = (process.env.HD_ONLY || '0') === '1' || (process.env.HD_ONLY || '').toLowerCase() === 'true';

// Allow list URL fallback from env
if (!listUrl && !moviesFromArg) {
  listUrl = String(process.env.LETTERBOXD_LIST_URL || process.env.LETTERBOXD_LIST || '').trim();
}

if (!listUrl && !moviesFromArg) {
  console.error('Usage:');
  console.error('  kimberly <letterboxd_list_url>');
  console.error('  kimberly --movies "[\\"Title - 1999\\", \\"Other - 2001\\"]"');
  console.error('Env: LETTERBOXD_LIST_URL (fallback), PROWLARR_URL (default http://localhost:9696), PROWLARR_API_KEY (required), MAX_GIB (default 10)');
  process.exit(2);
}

const baseUrl = process.env.PROWLARR_URL || 'http://localhost:9696';
const apiKey = process.env.PROWLARR_API_KEY;
if (!apiKey) {
  console.error('Missing env PROWLARR_API_KEY');
  process.exit(2);
}

const concurrency = Number(process.env.CONCURRENCY || '3');
const limit = pLimit(concurrency);

const prowlarrTimeoutMs = Number(process.env.PROWLARR_TIMEOUT_MS || '30000');

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

// Single-instance lock to prevent concurrent runs (which can corrupt staging/cache temp files).
const lockPath = defaultLockPath({ projectRoot, name: 'kimberly-cli' });
let lock = null;
try {
  lock = await acquireLock({ lockPath, name: 'kimberly-cli', logger: console });
} catch (e) {
  if (e && e.code === 'LOCKED') {
    console.error(String(e.message || e));
    process.exit(0);
  }
  throw e;
}

const dailyLog = await initDailyLogger({ projectRoot, logger: console });

const cachePath = process.env.CACHE_FILE ? process.env.CACHE_FILE : defaultCachePath();
let cache = await loadCache(cachePath);

// Write a CLI snapshot for orchestration (OpenClaw cron) without needing to read the huge cache.json.
// This file is intentionally pretty-printed (multi-line) to be compatible with the OpenClaw read tool.
const cronStatePath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'memory', 'cron-state.json');
async function loadCronState() {
  try {
    const raw = await fs.readFile(cronStatePath, 'utf8');
    const data = JSON.parse(raw);
    return (data && typeof data === 'object') ? data : {};
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return {};
    return {};
  }
}
async function saveCronState(data) {
  const dir = path.dirname(cronStatePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${cronStatePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, cronStatePath);
}

const movies = moviesFromArg ? moviesFromArg : await fetchLetterboxdListMovies(listUrl);

if (!movies.length) {
  console.error('No movies found on the Letterboxd list page. Is it public?');
  process.exit(1);
}

const rewriteCache = (process.env.REWRITE_CACHE || '0') === '1' || String(process.env.REWRITE_CACHE || '').toLowerCase() === 'true';

// Limit how many NEW movies we add to the cache per run (to avoid bursts).
// - If <= 0: unlimited
const maxNewMoviesPerRunRaw = Number(process.env.MAX_NEW_MOVIES_PER_RUN || '5');
const maxNewMoviesPerRun = maxNewMoviesPerRunRaw > 0 ? maxNewMoviesPerRunRaw : Number.POSITIVE_INFINITY;

let newCount = 0;
const allowProcess = new Set();
for (const m of movies) {
  const cached = getCachedMovie(cache, m.title);
  const isNew = !cached;

  // If rewriteCache is true, we allow re-processing cached movies.
  if (!isNew || rewriteCache) {
    allowProcess.add(m.title);
    continue;
  }

  if (newCount < maxNewMoviesPerRun) {
    allowProcess.add(m.title);
    newCount += 1;
  }
}

const results = [];

await Promise.all(
  movies.map((movie) =>
    limit(async () => {
      if (!allowProcess.has(movie.title)) {
        // Skip adding this new movie to cache in this run.
        results.push({ movie, skipped: true, reason: `max new movies per run reached (${maxNewMoviesPerRunRaw})` });
        return;
      }

      const cached = getCachedMovie(cache, movie.title);
      const cachedTorrentCount = cached?.torrents ? Object.keys(cached.torrents).length : 0;
      const cachedAnyDownloading = cached?.torrents && typeof cached.torrents === 'object'
        ? Object.values(cached.torrents).some((t) => isDebridActiveTorrent(t))
        : false;

      // If this movie is already done OR already active in Debrid (queued/downloading), do NOT search/send more.
      // This avoids spamming Debrid with duplicate torrents (e.g., Murder à la Mod).
      if (cached && cached.process_executed === true) {
        results.push({ movie, skipped: true, reason: 'process_executed=true' });
        return;
      }
      if (cached && cachedAnyDownloading) {
        results.push({ movie, skipped: true, reason: 'already active in debrid (queued/downloading)' });
        return;
      }

      if (!cached) {
        await dailyLog.log(`NEW_MOVIE: ${movie.title}${movie.year ? ` (${movie.year})` : ''}`);
      }

      // If it is cached BUT empty (0 torrents), we should retry the search even without REWRITE_CACHE.
      // This can happen when the first pass failed / query was too generic (e.g. Toll/Pedágio).
      if (cached && !rewriteCache && cachedTorrentCount > 0) {
        const matches = Object.entries(cached.torrents).map(([title, v]) => ({
          title,
          parsedName: title,
          parsedYear: movie.year ? String(movie.year) : '',
          parsedCodec: v.codec || '',
          parsedRes: v.resolution || '',
          sizeGiB: typeof v.tamanho === 'number' ? v.tamanho : Number(v.tamanho),
          downloadUrl: v.magnet || v.torrent_url || ''
        }));
        // If it's cached, do not re-write anything.
        results.push({ movie, query: '(cache)', matches });
        return;
      }

      // Build one or more queries for Prowlarr.
      // Some titles are too generic or too punctuation-sensitive and need alternate queries.
      const queries = [];
      const primaryQ = movie.year ? `${movie.title} ${movie.year}` : movie.title;
      queries.push(primaryQ);

      // Also try a "sanitized" query (remove punctuation like apostrophes) to avoid Prowlarr/Indexer sensitivity.
      // Example: "Don't Play Us Cheap" -> "Dont Play Us Cheap"
      const sanitizeQuery = (s) => String(s || '')
        .replace(/[\u2019']/g, '') // remove apostrophes (don’t -> dont)
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const sanitizedTitle = sanitizeQuery(movie.title);
      if (sanitizedTitle && sanitizedTitle.toLowerCase() !== String(movie.title || '').trim().toLowerCase()) {
        const q2 = movie.year ? `${sanitizedTitle} ${movie.year}` : sanitizedTitle;
        queries.push(q2);
      }

      // Hardcoded override for the Brazilian movie "Pedágio" (Letterboxd title: "Toll", 2023)
      if (String(movie.title || '').trim().toLowerCase() === 'toll' && Number(movie.year) === 2023) {
        queries.push(`Pedágio ${movie.year}`);
        queries.push(`Pedagio ${movie.year}`);
      }



      let releases = [];
      try {
        const seen = new Set();
        for (const q of queries) {
          const batch = await prowlarrSearch({ baseUrl, apiKey, query: q, timeoutMs: prowlarrTimeoutMs });
          for (const r of batch) {
            const key = String(r?.guid || r?.downloadUrl || r?.title || '');
            if (!key || seen.has(key)) continue;
            seen.add(key);
            releases.push(r);
          }
        }
      } catch (e) {
        const msg = String(e?.message || e);
        await dailyLog.log(`ERROR: cli movie="${movie.title}" msg=${JSON.stringify(msg)}`);
        results.push({ movie, error: msg });
        return;
      }

      const q = primaryQ;

      const titleMatchers = [movie.title];

      // Also accept a sanitized version of the movie title for title-matching.
      // Example: "Don't Play Us Cheap" -> "Dont Play Us Cheap"
      const sanitizeTitleForMatch = (s) => String(s || '')
        .replace(/[\u2019']/g, '') // remove apostrophes
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const sanitizedMatch = sanitizeTitleForMatch(movie.title);
      if (sanitizedMatch && sanitizedMatch.toLowerCase() !== String(movie.title || '').trim().toLowerCase()) {
        titleMatchers.push(sanitizedMatch);
      }

      if (String(movie.title || '').trim().toLowerCase() === 'toll' && Number(movie.year) === 2023) {
        titleMatchers.push('Pedágio');
        titleMatchers.push('Pedagio');
      }

      // Per-movie size overrides (some TV docs are < 1 GiB).
      let movieMinBytes = minBytes;
      let movieMaxBytes = maxBytes;
      if (String(movie.title || '').trim().toLowerCase() === 'john ford & monument valley') {
        // Allow smaller releases for this TV documentary.
        movieMinBytes = 0.05 * (1024 ** 3); // ~50 MiB
      }

      const filtered = (await Promise.all(
        releases
          .filter((r) => typeof r?.size === 'number' && r.size >= movieMinBytes && r.size <= movieMaxBytes)
          .map(async (r) => {
            const parsed = parseReleaseTitle(r.title);
            const picked = pickLinks(r);
            const obj = {
              title: r.title,
              parsedName: parsed.name,
              parsedYear: parsed.year,
              parsedCodec: parsed.codec,
              parsedRes: parsed.res,
              size: r.size,
              sizeGiB: Number(bytesToGiB(r.size).toFixed(2)),
              indexer: r.indexer,
              seeders: r.seeders,
              leechers: r.leechers,
              publishDate: r.publishDate,
              magnet: picked.magnet || '',
              torrentUrl: picked.torrentUrl || ''
            };

            // STUB (commented): if this release has no magnet, this is where you would download a .torrent
            // and set torrent_path in the cache.
            //
            // NOTE: do NOT download .torrent files here.
            // Doing it at this stage can be extremely slow because this runs for every raw release.
            // We do the optional .torrent download later, only for the final selected matches.

            return obj;
          })
      ))
        .filter((r) => r && (r.magnet || r.torrentUrl))
        .filter((r) => (englishTitleOnly ? titleMatchers.some((t) => releaseMatchesMovieTitle(t, r.title)) : true))
        .filter((r) => {
          if (!excludeTermList.length) return true;
          const t = normalizeReleaseTitle(r.title);
          return !excludeTermList.some((term) => t.includes(term));
        });

      // Sort: best priority first, then smaller first, then more seeders.
      filtered.sort((a, b) => {
        const pa = priorityRank({ res: a.parsedRes, codec: a.parsedCodec });
        const pb = priorityRank({ res: b.parsedRes, codec: b.parsedCodec });
        if (pa !== pb) return pa - pb;
        if (a.size !== b.size) return a.size - b.size;
        return (b.seeders ?? 0) - (a.seeders ?? 0);
      });

      // De-dup releases by parsed indices:
      // name + year + codec + resolution + (size bucket)
      const seen = new Set();
      const deduped = [];
      for (const rel of filtered) {
        const bucket = dedupeSizeBucketGiB > 0 ? dedupeSizeBucketGiB : 0.1;
        const sizeKey = Math.round((rel.sizeGiB ?? 0) / bucket);

        // Prefer parsed year; fallback to Letterboxd movie year if missing.
        const yearKey = rel.parsedYear || (movie.year ? String(movie.year) : '');
        const nameKey = englishTitleOnly ? normalizeReleaseTitle(movie.title) : normalizeReleaseTitle(rel.parsedName || rel.title);
        const codecKey = rel.parsedCodec || '';
        const resKey = rel.parsedRes || '';

        const key = `${nameKey}__${yearKey}__${codecKey}__${resKey}__${sizeKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(rel);
      }

      let finalMatches = deduped;

      // If HD_ONLY is enabled: return ONLY 1080p/2160p releases when any exist.
      // If none exist, fall back to the pre-filter list.
      const preHdOnly = finalMatches;
      if (hdOnly) {
        const hd = preHdOnly.filter((r) => {
          const res = String(r.parsedRes || '').toLowerCase();
          return res === '1080p' || res === '2160p';
        });
        finalMatches = hd.length ? hd : preHdOnly;
      }

      // Optional: download .torrent files for releases that don't have a magnet.
      // (Do this only for the finalMatches to avoid downloading hundreds of candidates.)
      {
        const dlLimit = pLimit(3);
        finalMatches = await Promise.all(
          finalMatches.map((m) =>
            dlLimit(async () => {
              // If Prowlarr provided a torrent URL, save the .torrent even if we also have a magnet.
              // This is useful for qBittorrent seeding (avoids being stuck at "Downloading metadata").
              if (!m.torrentUrl || typeof m.torrentUrl !== 'string' || !/^https?:\/\//i.test(m.torrentUrl)) return m;

              try {
                const safeBase = String(m.title || 'torrent')
                  .replace(/[^a-zA-Z0-9]+/g, '_')
                  .replace(/^_+|_+$/g, '')
                  .slice(0, 120);

                const dl = await downloadTorrentStub({
                  url: m.torrentUrl,
                  outPath: `torrents/${safeBase}.torrent`,
                  headers: { 'X-Api-Key': apiKey },
                  timeoutMs: 60_000
                });

                if (dl?.kind === 'saved') {
                  return { ...m, torrent_path: dl.path };
                }

                if (dl?.kind === 'redirect' && typeof dl.location === 'string' && dl.location.startsWith('magnet:')) {
                  // If the torrent endpoint redirects to a magnet, keep the magnet too.
                  return { ...m, magnet: m.magnet || dl.location };
                }
              } catch {
                // non-fatal
              }

              return m;
            })
          )
        );
      }

      // Persist cache ONLY with the final list that we'd return.
      cache = upsertCachedMovie(
        cache,
        movie.title,
        finalMatches.map((m) => ({
          title: m.title,
          codec: (m.parsedCodec || '').toUpperCase(),
          resolution: (m.parsedRes || '').toUpperCase(),
          tamanho: m.sizeGiB,
          magnet: m.magnet || '',
          torrent_url: m.torrentUrl || '',
          torrent_path: m.torrent_path || '',
          // defaults for debrid flags
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

      results.push({ movie, query: q, matches: finalMatches });
    })
  )
);

// Stable output order: same as list
results.sort((a, b) => {
  const ai = movies.findIndex((m) => m.title === a.movie.title && m.year === a.movie.year);
  const bi = movies.findIndex((m) => m.title === b.movie.title && m.year === b.movie.year);
  return ai - bi;
});

// Update cron-state snapshot for orchestration.
{
  const prev = await loadCronState();

  const snap = {};
  for (const m of movies) {
    const entry = getCachedMovie(cache, m.title);
    const torrents = entry?.torrents && typeof entry.torrents === 'object' ? entry.torrents : {};
    const any_downloading = Object.values(torrents).some((t) => isDebridActiveTorrent(t));

    snap[m.title] = {
      process_executed: Boolean(entry?.process_executed),
      any_downloading
    };
  }

  const next = {
    ...prev,
    lastRunAt: new Date().toISOString(),
    lastCliKeys: prev?.cliKeys && typeof prev.cliKeys === 'object' ? prev.cliKeys : (prev?.lastCliKeys && typeof prev.lastCliKeys === 'object' ? prev.lastCliKeys : {}),
    cliKeys: snap
  };

  await saveCronState(next);
}

// Output: JSON array of movie titles from cache where process_executed != true
// (requested for orchestration)
const pendingMovies = Object.keys(cache)
  .map((title) => ({ title, entry: getCachedMovie(cache, title) }))
  .filter((x) => {
    if (!x.entry) return false;
    if (x.entry.process_executed === true) return false;
    const torrents = x.entry.torrents && typeof x.entry.torrents === 'object' ? x.entry.torrents : {};
    const any_downloading = Object.values(torrents).some((t) => isDebridActiveTorrent(t));
    // If already downloading in Debrid, don't keep it in pending list (avoid re-sending).
    if (any_downloading) return false;
    return true;
  })
  .map((x) => x.title);

const pendingJson = JSON.stringify(pendingMovies);
console.log(pendingJson);

const executeDebrid = (process.env.EXECUTE_DEBRID || '0') === '1' || (process.env.EXECUTE_DEBRID || '').toLowerCase() === 'true';
if (executeDebrid) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./debrid-cli.js', import.meta.url).pathname], {
      stdio: ['pipe', 'inherit', 'inherit'],
      env: process.env
    });

    child.stdin.write(pendingJson);
    child.stdin.end();

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`debrid-cli exited with code ${code}`));
    });
  });
}
