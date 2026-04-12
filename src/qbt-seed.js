import 'dotenv/config';
import { QbittorrentClient } from './qbittorrent.js';

function isTrue(v) {
  return v === '1' || String(v || '').toLowerCase() === 'true';
}

export async function maybeSeedWithQbittorrent({
  magnet,
  savePath,
  logger = console
} = {}) {
  const enabled = isTrue(process.env.QBT_ENABLED);
  if (!enabled) return { ok: true, skipped: true, reason: 'QBT_ENABLED is false' };

  if (!magnet || !String(magnet).startsWith('magnet:')) {
    return { ok: true, skipped: true, reason: 'missing magnet' };
  }
  if (!savePath) return { ok: true, skipped: true, reason: 'missing savePath' };

  const baseUrl = process.env.QBT_BASE_URL || 'http://127.0.0.1:8080';
  const username = process.env.QBT_USERNAME || '';
  const password = process.env.QBT_PASSWORD || '';
  const category = process.env.QBT_CATEGORY || '';
  const tags = process.env.QBT_TAGS || process.env.QBT_TAG || '';

  const qbt = new QbittorrentClient({ baseUrl, username, password, logger });
  await qbt.loginBestEffort();

  const infoHash = QbittorrentClient.infoHashFromMagnet(magnet);
  if (!infoHash) {
    return { ok: true, skipped: true, reason: 'could not parse infohash from magnet' };
  }

  // Add paused -> recheck -> start
  await qbt.addMagnet({ magnet, savePath, category, tags, paused: true, skipChecking: false });

  const t = await qbt.waitForTorrentByInfoHash({ infoHash, timeoutMs: 30_000, pollMs: 1000 });
  if (!t) {
    return { ok: false, error: 'torrent not found in qBittorrent after add' };
  }

  await qbt.recheck({ hashes: [infoHash] });
  await qbt.start({ hashes: [infoHash] });

  logger?.log?.(`QBIT: seeding started hash=${infoHash} savePath=${savePath}`);
  return { ok: true, seeded: true, infoHash };
}
