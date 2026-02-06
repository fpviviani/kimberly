import axios from 'axios';

function normalizeBaseUrl(url) {
  return url.replace(/\/+$/, '');
}

/**
 * Query Prowlarr for releases.
 *
 * NOTE: Prowlarr API can vary by version/config.
 * The common endpoint is GET /api/v1/search?query=...
 * Returns an array of releases with fields like:
 * - title
 * - size (bytes)
 * - downloadUrl (often magnet or .torrent)
 * - indexer
 */
export async function prowlarrSearch({ baseUrl, apiKey, query, timeoutMs = 30_000 }) {
  const url = `${normalizeBaseUrl(baseUrl)}/api/v1/search`;
  const { data } = await axios.get(url, {
    params: { query },
    headers: {
      'X-Api-Key': apiKey
    },
    timeout: timeoutMs
  });

  if (!Array.isArray(data)) {
    throw new Error(`Unexpected Prowlarr response (expected array) from ${url}`);
  }

  return data;
}
