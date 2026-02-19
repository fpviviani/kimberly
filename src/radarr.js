import axios from 'axios';

function base(url) {
  return String(url || '').replace(/\/+$/, '');
}

function isTrue(v) {
  return v === '1' || String(v || '').toLowerCase() === 'true';
}

/**
 * Resolve tmdbId for a title/year using Radarr helpers.
 */
export async function radarrResolveTmdbId({
  title,
  year,
  radarrBaseUrl = process.env.RADARR_BASE_URL || 'http://127.0.0.1:7878',
  radarrApiKey = process.env.RADARR_API_KEY,
  logger = console
}) {
  if (!radarrApiKey) throw new Error('Missing env RADARR_API_KEY');
  if (!title) throw new Error('radarrResolveTmdbId: missing title');

  const api = axios.create({
    baseURL: base(radarrBaseUrl),
    timeout: 30_000,
    params: { apikey: radarrApiKey }
  });

  const parseTitle = year ? `${title} (${year})` : String(title);
  let parsed;
  try {
    parsed = (await api.get('/api/v3/parse', { params: { title: parseTitle } })).data;
  } catch {
    parsed = null;
  }

  let tmdbId = parsed?.parsedMovieInfo?.tmdbId ?? parsed?.tmdbId;
  let parsedTitle = parsed?.parsedMovieInfo?.movieTitle ?? parsed?.title ?? title;
  let parsedYear = parsed?.parsedMovieInfo?.year ?? parsed?.year ?? year ?? null;

  if (!tmdbId) {
    const term = year ? `${title} ${year}` : String(title);
    const lookup = (await api.get('/api/v3/movie/lookup', { params: { term } })).data;
    if (Array.isArray(lookup) && lookup[0]?.tmdbId) {
      tmdbId = lookup[0].tmdbId;
      parsedTitle = lookup[0].title || parsedTitle;
      parsedYear = lookup[0].year || parsedYear;
    }
  }

  if (!tmdbId) throw new Error(`Radarr could not resolve tmdbId (title=${parseTitle})`);

  logger?.log?.(`RADARR: resolved tmdbId=${tmdbId} title="${parsedTitle}"`);
  return { ok: true, tmdbId: Number(tmdbId), title: parsedTitle, year: parsedYear };
}

/**
 * Add a movie to Radarr if it doesn't exist yet.
 * This is meant for "library import" only (no monitoring / no searching).
 */
export async function radarrAddMovieIfMissing({
  title,
  year,
  moviePath,
  radarrBaseUrl = process.env.RADARR_BASE_URL || 'http://127.0.0.1:7878',
  radarrApiKey = process.env.RADARR_API_KEY,
  radarrQualityProfileId = Number(process.env.RADARR_QUALITY_PROFILE_ID || '7'),
  radarrRootFolderPath = process.env.RADARR_ROOT_FOLDER_PATH || process.env.AUTO_DOWNLOAD_DEST_DIR || '',
  logger = console
}) { 
  if (!radarrApiKey) throw new Error('Missing env RADARR_API_KEY');
  if (!title) throw new Error('radarrAddMovieIfMissing: missing title');
  if (!moviePath) throw new Error('radarrAddMovieIfMissing: missing moviePath');

  const api = axios.create({
    baseURL: base(radarrBaseUrl),
    timeout: 30_000,
    params: { apikey: radarrApiKey }
  });

  // 1) Resolve tmdbId/title/year
  const resolved = await radarrResolveTmdbId({ title, year, radarrBaseUrl, radarrApiKey, logger });
  const tmdbId = resolved.tmdbId;
  const parsedTitle = resolved.title;
  const parsedYear = resolved.year;

  // 2) Check if already exists
  let exists = false;
  try {
    const movies = (await api.get('/api/v3/movie')).data;
    if (Array.isArray(movies)) {
      exists = movies.some((m) => Number(m?.tmdbId) === Number(tmdbId));
    }
  } catch (e) {
    // non-fatal (we'll attempt add and let Radarr reject if duplicate)
  }

  if (exists) {
    logger.log(`RADARR: already exists tmdbId=${tmdbId} title="${parsedTitle}"`);
    return { ok: true, alreadyExisted: true, tmdbId };
  }

  // 3) Add movie (library import only)
  // Radarr still requires rootFolderPath in the payload.
  // If not explicitly set, infer from the moviePath's parent folder.
  const rootFolderPath = radarrRootFolderPath ? String(radarrRootFolderPath) : String(moviePath).replace(/[\\/][^\\/]+$/, '');

  const payload = {
    title: parsedTitle,
    year: parsedYear,
    tmdbId: Number(tmdbId),
    qualityProfileId: Number(radarrQualityProfileId),
    rootFolderPath,
    path: String(moviePath),
    monitored: false,
    addOptions: {
      searchForMovie: false
    }
  };

  let created;
  try {
    created = (await api.post('/api/v3/movie', payload)).data;
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    let body = '';
    try {
      body = typeof data === 'string' ? data : JSON.stringify(data);
    } catch {}
    throw new Error(`Radarr add movie failed: status=${status ?? 'n/a'} body=${body || '(empty)'}`);
  }

  logger.log(`RADARR: added tmdbId=${tmdbId} title="${parsedTitle}" path="${moviePath}"`);
  return { ok: true, alreadyExisted: false, tmdbId, radarrId: created?.id };
}

export async function radarrRemoveMovieByTmdbId({
  tmdbId,
  radarrBaseUrl = process.env.RADARR_BASE_URL || 'http://127.0.0.1:7878',
  radarrApiKey = process.env.RADARR_API_KEY,
  deleteFiles = false,
  addImportListExclusion = false,
  logger = console
}) {
  if (!radarrApiKey) throw new Error('Missing env RADARR_API_KEY');
  if (!tmdbId) throw new Error('radarrRemoveMovieByTmdbId: missing tmdbId');

  const api = axios.create({
    baseURL: base(radarrBaseUrl),
    timeout: 30_000,
    params: { apikey: radarrApiKey }
  });

  const movies = (await api.get('/api/v3/movie')).data;
  const m = Array.isArray(movies) ? movies.find((x) => Number(x?.tmdbId) === Number(tmdbId)) : null;
  if (!m?.id) {
    logger.log(`RADARR: remove skipped (not found) tmdbId=${tmdbId}`);
    return { ok: true, removed: false };
  }

  await api.delete(`/api/v3/movie/${encodeURIComponent(m.id)}`, {
    params: {
      deleteFiles: Boolean(deleteFiles),
      addImportListExclusion: Boolean(addImportListExclusion)
    }
  });

  logger.log(`RADARR: removed tmdbId=${tmdbId} radarrId=${m.id} title="${m.title || ''}" deleteFiles=${Boolean(deleteFiles)}`);
  return { ok: true, removed: true, radarrId: m.id };
}

export function radarrEnabled() {
  return isTrue(process.env.RADARR_IMPORT_AFTER_DOWNLOAD);
}
