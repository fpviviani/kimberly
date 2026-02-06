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
