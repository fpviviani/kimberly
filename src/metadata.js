import WebTorrent from 'webtorrent';
import axios from 'axios';

function isMagnet(url) {
  return typeof url === 'string' && url.startsWith('magnet:');
}

function isHttp(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function hasVideoAndSrt(files) {
  let hasVideo = false;
  let hasSrt = false;
  for (const f of files) {
    const name = (f?.name || '').toLowerCase();
    if (name.endsWith('.mkv') || name.endsWith('.mp4')) hasVideo = true;
    if (name.endsWith('.srt')) hasSrt = true;
    if (hasVideo && hasSrt) return true;
  }
  return false;
}

async function fetchTorrentFile(url, { apiKey, timeoutMs }) {
  // Prowlarr usually accepts X-Api-Key header. Some URLs also embed apikey in query.
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: apiKey ? { 'X-Api-Key': apiKey } : undefined,
    timeout: timeoutMs
  });
  return Buffer.from(resp.data);
}

function withTimeout(promise, ms, label = 'timeout') {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    timeout
  ]);
}

/**
 * Inspect a release download URL (magnet or http(s) .torrent link) and return:
 * { ok: true, hasVideo: boolean, hasSrt: boolean, name: torrent.name, files: [names] }
 */
let sharedClient = null;

function getClient() {
  if (sharedClient) return sharedClient;
  // One WebTorrent client per process to avoid port bind conflicts when inspecting in parallel.
  sharedClient = new WebTorrent({ dht: true, tracker: true });
  // Don't crash the whole process on client-level errors.
  sharedClient.on('error', () => {});
  return sharedClient;
}

export async function inspectReleaseMetadata({ downloadUrl, apiKey, timeoutMs = 120_000 }) {
  const client = getClient();

  const addTorrent = async () => {
    if (isMagnet(downloadUrl)) {
      return client.add(downloadUrl);
    }

    if (isHttp(downloadUrl)) {
      const torrentBuf = await fetchTorrentFile(downloadUrl, { apiKey, timeoutMs });
      return client.add(torrentBuf);
    }

    throw new Error('Unsupported downloadUrl (expected magnet: or http(s) URL)');
  };

  try {
    const torrent = await withTimeout(Promise.resolve().then(addTorrent), timeoutMs, 'add torrent');

    await withTimeout(
      new Promise((resolve, reject) => {
        if (torrent.metadata) return resolve();
        torrent.once('metadata', resolve);
        torrent.once('error', reject);
      }),
      timeoutMs,
      'metadata fetch'
    );

    const files = torrent.files || [];
    const ok = hasVideoAndSrt(files);

    const summary = {
      ok,
      hasVideo: files.some(f => (f.name || '').toLowerCase().endsWith('.mkv') || (f.name || '').toLowerCase().endsWith('.mp4')),
      hasSrt: files.some(f => (f.name || '').toLowerCase().endsWith('.srt')),
      torrentName: torrent.name,
      fileNames: files.map(f => f.name)
    };

    // Stop all activity for this torrent.
    torrent.destroy({ destroyStore: true });

    return summary;
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
