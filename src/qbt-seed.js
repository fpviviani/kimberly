import 'dotenv/config';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import bencodeMod from 'bencode';
import { QbittorrentClient } from './qbittorrent.js';

function isTrue(v) {
  return v === '1' || String(v || '').toLowerCase() === 'true';
}

function sha1Hex(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

async function infoHashFromTorrentFile(torrentPath) {
  const raw = await fs.readFile(String(torrentPath));
  const decoded = bencodeMod.default.decode(raw);
  const info = decoded?.info;
  if (!info) return '';
  const enc = bencodeMod.default.encode(info);
  return sha1Hex(enc);
}

export async function maybeSeedWithQbittorrent({
  magnet,
  torrentPath,
  savePath,
  logger = console
} = {}) {
  const enabled = isTrue(process.env.QBT_ENABLED);
  if (!enabled) return { ok: true, skipped: true, reason: 'QBT_ENABLED is false' };
  if (!savePath) return { ok: true, skipped: true, reason: 'missing savePath' };

  const baseUrl = process.env.QBT_BASE_URL || 'http://127.0.0.1:8080';
  const username = process.env.QBT_USERNAME || '';
  const password = process.env.QBT_PASSWORD || '';
  const category = process.env.QBT_CATEGORY || '';
  const tags = process.env.QBT_TAGS || process.env.QBT_TAG || '';

  const qbt = new QbittorrentClient({ baseUrl, username, password, logger });
  await qbt.loginBestEffort();

  // Prefer .torrent file when available (avoids being stuck at "Downloading metadata").
  let infoHash = '';

  if (torrentPath) {
    infoHash = await infoHashFromTorrentFile(torrentPath);
    if (!infoHash) return { ok: true, skipped: true, reason: 'could not compute infohash from torrent file' };

    await qbt.addTorrentFile({ torrentPath, savePath, category, tags, paused: true, skipChecking: false, rootFolder: false });
  } else if (magnet && String(magnet).startsWith('magnet:')) {
    infoHash = QbittorrentClient.infoHashFromMagnet(magnet);
    if (!infoHash) return { ok: true, skipped: true, reason: 'could not parse infohash from magnet' };

    await qbt.addMagnet({ magnet, savePath, category, tags, paused: true, skipChecking: false, rootFolder: false });
  } else {
    return { ok: true, skipped: true, reason: 'missing magnet/torrentPath' };
  }

  const t = await qbt.waitForTorrentByInfoHash({ infoHash, timeoutMs: 30_000, pollMs: 1000 });
  if (!t) {
    return { ok: false, error: 'torrent not found in qBittorrent after add' };
  }

  // For magnets, wait until metadata is available; otherwise recheck is unreliable.
  await qbt.waitForMetadata({ infoHash, timeoutMs: 120_000, pollMs: 1000 });

  await qbt.recheck({ hashes: [infoHash] });
  await qbt.start({ hashes: [infoHash] });

  logger?.log?.(`QBIT: seeding started hash=${infoHash} savePath=${savePath}`);
  return { ok: true, seeded: true, infoHash };
}
