import axios from 'axios';
import FormData from 'form-data';
import { createReadStream } from 'node:fs';

function base(url) {
  return String(url || '').replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseBtihFromMagnet(magnet) {
  const s = String(magnet || '');
  if (!s.startsWith('magnet:?')) return '';
  const m = s.match(/\bxt=urn:btih:([a-zA-Z0-9]+)\b/);
  if (!m) return '';
  return m[1];
}

function isHex40(s) {
  return /^[a-fA-F0-9]{40}$/.test(s);
}

function base32ToHex(b32) {
  // RFC4648 base32 decode for btih (20 bytes)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(b32 || '').toUpperCase().replace(/=+$/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return out.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizeInfoHash(hashOrBtih) {
  const s = String(hashOrBtih || '').trim();
  if (!s) return '';
  if (isHex40(s)) return s.toLowerCase();
  // base32 btih is usually 32 chars
  if (/^[A-Z2-7]{32}$/i.test(s)) {
    const hex = base32ToHex(s);
    return isHex40(hex) ? hex.toLowerCase() : '';
  }
  return '';
}

export class QbittorrentClient {
  constructor({ baseUrl, username, password, logger = console } = {}) {
    this.baseUrl = base(baseUrl || 'http://127.0.0.1:8080');
    this.username = username ? String(username) : '';
    this.password = password ? String(password) : '';
    this.logger = logger;

    this.api = axios.create({
      baseURL: this.baseUrl,
      timeout: 30_000,
      // keep cookies (SID)
      withCredentials: true,
      validateStatus: () => true
    });
  }

  async loginBestEffort() {
    // If qBittorrent is configured without auth (or bypass localhost), requests may work without login.
    if (!this.username && !this.password) return { ok: true, skipped: true };

    const resp = await this.api.post('/api/v2/auth/login', new URLSearchParams({
      username: this.username,
      password: this.password
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (resp.status >= 200 && resp.status < 300 && String(resp.data || '').toLowerCase().includes('ok')) {
      return { ok: true };
    }

    // Non-fatal: some setups block login endpoint when auth is disabled.
    this.logger?.log?.(`QBIT: login skipped/failed status=${resp.status}`);
    return { ok: false, status: resp.status };
  }

  async listTorrents() {
    const resp = await this.api.get('/api/v2/torrents/info');
    if (resp.status !== 200 || !Array.isArray(resp.data)) {
      throw new Error(`QBIT: list torrents failed status=${resp.status}`);
    }
    return resp.data;
  }

  async addMagnet({ magnet, savePath, category = '', tags = '', paused = true, skipChecking = false } = {}) {
    if (!magnet) throw new Error('QBIT: addMagnet missing magnet');
    const body = new URLSearchParams();
    body.set('urls', String(magnet));
    if (savePath) body.set('savepath', String(savePath));
    if (category) body.set('category', String(category));
    if (tags) body.set('tags', String(tags));
    body.set('paused', paused ? 'true' : 'false');
    body.set('skip_checking', skipChecking ? 'true' : 'false');

    const resp = await this.api.post('/api/v2/torrents/add', body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (resp.status !== 200) {
      throw new Error(`QBIT: add magnet failed status=${resp.status} body=${String(resp.data || '')}`);
    }

    return { ok: true };
  }

  async addTorrentFile({ torrentPath, savePath, category = '', tags = '', paused = true, skipChecking = false } = {}) {
    if (!torrentPath) throw new Error('QBIT: addTorrentFile missing torrentPath');

    const form = new FormData();
    form.append('torrents', createReadStream(String(torrentPath)));
    if (savePath) form.append('savepath', String(savePath));
    if (category) form.append('category', String(category));
    if (tags) form.append('tags', String(tags));
    form.append('paused', paused ? 'true' : 'false');
    form.append('skip_checking', skipChecking ? 'true' : 'false');

    const resp = await this.api.post('/api/v2/torrents/add', form, {
      headers: form.getHeaders()
    });

    if (resp.status !== 200) {
      throw new Error(`QBIT: add torrent file failed status=${resp.status} body=${String(resp.data || '')}`);
    }

    return { ok: true };
  }

  async recheck({ hashes } = {}) {
    const body = new URLSearchParams();
    body.set('hashes', Array.isArray(hashes) ? hashes.join('|') : String(hashes || ''));
    const resp = await this.api.post('/api/v2/torrents/recheck', body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (resp.status !== 200) throw new Error(`QBIT: recheck failed status=${resp.status}`);
    return { ok: true };
  }

  async start({ hashes } = {}) {
    const body = new URLSearchParams();
    body.set('hashes', Array.isArray(hashes) ? hashes.join('|') : String(hashes || ''));

    // qBittorrent WebAPI uses "resume" (not "start") in v2.
    const resp = await this.api.post('/api/v2/torrents/resume', body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (resp.status !== 200) throw new Error(`QBIT: resume failed status=${resp.status}`);
    return { ok: true };
  }

  async waitForTorrentByInfoHash({ infoHash, timeoutMs = 20_000, pollMs = 1000 } = {}) {
    const target = normalizeInfoHash(infoHash);
    if (!target) throw new Error('QBIT: waitForTorrentByInfoHash missing/invalid infoHash');

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const list = await this.listTorrents();
      const hit = list.find((t) => String(t.hash || '').toLowerCase() === target);
      if (hit) return hit;
      await sleep(pollMs);
    }
    return null;
  }

  static infoHashFromMagnet(magnet) {
    const btih = parseBtihFromMagnet(magnet);
    return normalizeInfoHash(btih);
  }
}
