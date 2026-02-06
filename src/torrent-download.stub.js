// STUB: placeholder for downloading a .torrent when no magnet is available.
//
// IMPORTANT:
// - This is intentionally NOT wired to any real torrent/indexer download flow.
// - The URL below is fake (as requested). Replace with your own safe source.
// - Once implemented, you would:
//   1) download the .torrent
//   2) save it under torrents/<something>.torrent
//   3) write that path into cache.json under torrent_path
//
// Example sketch (commented out):
//
import axios from 'axios';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function downloadTorrentStub({ url, outPath, headers = {}, timeoutMs = 60_000 }) {
  // NOTE: Some Prowlarr "download" links may redirect to a magnet: URL.
  // Axios can't follow magnet: redirects, so we disable redirects and let the caller handle it.
  outPath = path.resolve(outPath);

  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    headers,
    timeout: timeoutMs,
    maxRedirects: 0,
    // Accept 2xx and 3xx so we can inspect Location.
    validateStatus: (s) => s >= 200 && s < 400
  });

  // Redirect case: caller may want to switch to magnet instead of downloading.
  const location = resp?.headers?.location;
  if (resp.status >= 300 && resp.status < 400 && typeof location === 'string') {
    return { kind: 'redirect', location };
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, Buffer.from(resp.data));
  return { kind: 'saved', path: outPath };
}
