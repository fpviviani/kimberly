import axios from 'axios';

function base(url) {
  return String(url || '').replace(/\/+$/, '');
}

/**
 * Refresh a Plex library section.
 * Env-friendly defaults:
 * - PLEX_BASE_URL (default http://127.0.0.1:32400)
 * - PLEX_TOKEN (required)
 */
export async function plexRefreshSection({ sectionId, plexBaseUrl = process.env.PLEX_BASE_URL || 'http://127.0.0.1:32400', plexToken = process.env.PLEX_TOKEN }) {
  if (!plexToken) throw new Error('Missing env PLEX_TOKEN');
  if (!sectionId) throw new Error('Missing sectionId');
  const url = `${base(plexBaseUrl)}/library/sections/${encodeURIComponent(sectionId)}/refresh`;
  // Plex expects GET for refresh.
  await axios.get(url, { params: { 'X-Plex-Token': plexToken }, timeout: 30_000 });
  return { ok: true };
}

export async function plexEmptyTrash({ sectionId, plexBaseUrl = process.env.PLEX_BASE_URL || 'http://127.0.0.1:32400', plexToken = process.env.PLEX_TOKEN }) {
  if (!plexToken) throw new Error('Missing env PLEX_TOKEN');
  if (!sectionId) throw new Error('Missing sectionId');
  const url = `${base(plexBaseUrl)}/library/sections/${encodeURIComponent(sectionId)}/emptyTrash`;
  await axios.put(url, null, { params: { 'X-Plex-Token': plexToken }, timeout: 30_000 });
  return { ok: true };
}

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractVideoAttributes(xml) {
  // Very small XML "parser" just to read attributes from <Video ...> tags.
  // Plex returns XML by default.
  const out = [];
  const re = /<Video\b([^>]*)>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1] || '';
    const get = (name) => {
      const r = new RegExp(`\\b${name}=\\"([^\\"]*)\\"`);
      const mm = attrs.match(r);
      return mm ? decodeXmlEntities(mm[1]) : '';
    };
    out.push({
      ratingKey: get('ratingKey'),
      title: get('title'),
      year: get('year') ? Number(get('year')) : null,
      viewCount: get('viewCount') ? Number(get('viewCount')) : 0,
      lastViewedAt: get('lastViewedAt') ? Number(get('lastViewedAt')) : null
    });
  }
  return out;
}

/**
 * Best-effort check: is a movie watched in Plex?
 * Uses section search and looks at viewCount/lastViewedAt.
 */
export async function plexIsMovieWatched({
  title,
  year,
  sectionId = process.env.PLEX_SECTION_ID_FILMES || '1',
  plexBaseUrl = process.env.PLEX_BASE_URL || 'http://127.0.0.1:32400',
  plexToken = process.env.PLEX_TOKEN
} = {}) {
  if (!plexToken) throw new Error('Missing env PLEX_TOKEN');
  if (!title) throw new Error('plexIsMovieWatched: missing title');

  const url = `${base(plexBaseUrl)}/library/sections/${encodeURIComponent(sectionId)}/all`;

  // Use title filter to reduce payload.
  const resp = await axios.get(url, {
    params: {
      type: 1,
      title: String(title),
      'X-Plex-Token': plexToken
    },
    timeout: 30_000,
    responseType: 'text'
  });

  const xml = String(resp.data || '');
  const vids = extractVideoAttributes(xml);

  // Prefer exact title+year when year is known.
  const wantTitle = String(title).trim().toLowerCase();
  let cand = vids.find((v) => String(v.title || '').trim().toLowerCase() === wantTitle && year && Number(v.year) === Number(year));
  if (!cand) cand = vids.find((v) => String(v.title || '').trim().toLowerCase() === wantTitle);

  if (!cand) return { ok: true, found: false, watched: false, viewCount: 0, lastViewedAt: null };

  const watched = Number(cand.viewCount || 0) > 0 || Boolean(cand.lastViewedAt);
  return {
    ok: true,
    found: true,
    watched,
    viewCount: Number(cand.viewCount || 0),
    lastViewedAt: cand.lastViewedAt ? new Date(Number(cand.lastViewedAt) * 1000).toISOString() : null
  };
}
