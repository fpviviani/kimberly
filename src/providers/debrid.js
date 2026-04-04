import axios from 'axios';
import FormData from 'form-data';
import { createReadStream } from 'node:fs';

function base(url) {
  return String(url || '').replace(/\/+$/, '');
}

function coerceInfo(resp) {
  // Real-Debrid returns an object. Old mock returned [{...}].
  if (Array.isArray(resp)) return resp[0] || null;
  return resp;
}

function axiosErrDetails(e) {
  const status = e?.response?.status;
  const data = e?.response?.data;
  const headers = e?.response?.headers;
  let body = '';
  try {
    if (typeof data === 'string') body = data;
    else if (data != null) body = JSON.stringify(data);
  } catch {}
  const msg = String(e?.message || e);
  return { status, body, msg, headers };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfterMs(headers) {
  const v = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s) && s > 0) return Math.round(s * 1000);
  // If it's an HTTP date, ignore for now.
  return null;
}

async function axiosWith429Retry(reqFn, { url, maxRetries = 3, baseDelayMs = 3000 }) {
  // "maxRetries=3" => up to 4 total attempts.
  // Desired schedule (default): 3s, 6s, 9s
  let attempt = 0;
  while (true) {
    try {
      return await reqFn();
    } catch (e) {
      const d = axiosErrDetails(e);
      const is429 = d.status === 429;
      if (!is429 || attempt >= maxRetries) throw e;

      const retryAfter = parseRetryAfterMs(d.headers);
      const linear = Math.round(baseDelayMs * (attempt + 1));
      const waitMs = retryAfter ?? linear;

      // eslint-disable-next-line no-console
      console.log(`429 from ${url} -> retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(waitMs);
      attempt += 1;
      continue;
    }
  }
}

const retryBaseDelayMs = Number(process.env.DEBRID_RETRY_DELAY_MS || '3000');

export class DebridProvider {
  /**
   * @param {{ baseUrl: string, apiKey?: string }} opts
   */
  constructor({ baseUrl, apiKey }) {
    if (!baseUrl) throw new Error('DebridProvider: missing baseUrl');
    this.baseUrl = base(baseUrl);
    this.apiKey = apiKey ? String(apiKey) : '';
  }

  _authHeaders() {
    // Auth header only. Content-Type should be set per-request.
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  async sendTorrent({ magnet }) {
    if (!magnet?.startsWith('magnet:')) throw new Error('sendTorrent requires a magnet link');

    const url = `${this.baseUrl}/torrents/addMagnet`;

    // Real-Debrid expects application/x-www-form-urlencoded for addMagnet.
    // (curl equivalent: --data-urlencode "magnet=<...>")
    const body = new URLSearchParams();
    body.set('magnet', magnet);

    let data;
    try {
      ({ data } = await axiosWith429Retry(
        () =>
          axios.post(url, body, {
            headers: {
              ...this._authHeaders(),
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }),
        { url, baseDelayMs: retryBaseDelayMs }
      ));
      if (process.env.DEBRID_VERBOSE === '1' || String(process.env.DEBRID_VERBOSE || '').toLowerCase() === 'true') {
        console.log(`HTTP OK: POST ${url}`);
      }
    } catch (e) {
      const d = axiosErrDetails(e);
      throw new Error(`sendTorrent failed: url=${url} status=${d.status ?? 'n/a'} err=${d.msg}${d.body ? ` body=${d.body}` : ''}`);
    }

    if (!data?.id) throw new Error(`sendTorrent: missing id in response (url=${url})`);
    return { id: String(data.id) };
  }

  async sendTorrentFile({ torrentPath }) {
    if (!torrentPath) throw new Error('sendTorrentFile requires torrentPath');
    const form = new FormData();
    form.append('file', createReadStream(torrentPath));

    const url = `${this.baseUrl}/torrents/addTorrent`;

    let data;
    try {
      ({ data } = await axiosWith429Retry(
        () => axios.put(url, form, { headers: { ...form.getHeaders(), ...this._authHeaders() } }),
        { url, baseDelayMs: retryBaseDelayMs }
      ));
      if (process.env.DEBRID_VERBOSE === '1' || String(process.env.DEBRID_VERBOSE || '').toLowerCase() === 'true') {
        console.log(`HTTP OK: PUT ${url}`);
      }
    } catch (e) {
      const d = axiosErrDetails(e);
      throw new Error(`sendTorrentFile failed: url=${url} status=${d.status ?? 'n/a'} err=${d.msg}${d.body ? ` body=${d.body}` : ''}`);
    }

    if (!data?.id) throw new Error(`sendTorrentFile: missing id in response (url=${url})`);
    return { id: String(data.id) };
  }

  async listTorrents() {
    const url = `${this.baseUrl}/torrents`;

    let data;
    try {
      ({ data } = await axiosWith429Retry(() => axios.get(url, { headers: this._authHeaders() }), { url, baseDelayMs: retryBaseDelayMs }));
      if (process.env.DEBRID_VERBOSE === '1' || String(process.env.DEBRID_VERBOSE || '').toLowerCase() === 'true') {
        console.log(`HTTP OK: GET ${url}`);
      }
    } catch (e) {
      const d = axiosErrDetails(e);
      throw new Error(`listTorrents failed: url=${url} status=${d.status ?? 'n/a'} err=${d.msg}${d.body ? ` body=${d.body}` : ''}`);
    }

    if (!Array.isArray(data)) return [];
    return data
      .map((t) => ({
        id: t?.id != null ? String(t.id) : '',
        filename: t?.filename != null ? String(t.filename) : '',
        status: t?.status != null ? String(t.status) : ''
      }))
      .filter((t) => t.id);
  }

  async getTorrentInfo({ id }) {
    const url = `${this.baseUrl}/torrents/info/${encodeURIComponent(id)}`;

    let data;
    try {
      ({ data } = await axiosWith429Retry(() => axios.get(url, { headers: this._authHeaders() }), { url, baseDelayMs: retryBaseDelayMs }));
      if (process.env.DEBRID_VERBOSE === '1' || String(process.env.DEBRID_VERBOSE || '').toLowerCase() === 'true') {
        console.log(`HTTP OK: GET ${url}`);
      }
    } catch (e) {
      const d = axiosErrDetails(e);
      throw new Error(`getTorrentInfo failed: url=${url} status=${d.status ?? 'n/a'} err=${d.msg}${d.body ? ` body=${d.body}` : ''}`);
    }

    const info = coerceInfo(data);
    if (!info) throw new Error(`getTorrentInfo: empty response (url=${url})`);

    const status = String(info.status || '');
    const files = Array.isArray(info.files) ? info.files : [];
    const links = Array.isArray(info.links) ? info.links : [];

    return {
      id: info?.id != null ? String(info.id) : String(id),
      status,
      files: files.map((f) => ({
        id: Number(f.id),
        path: String(f.path || ''),
        bytes: typeof f.bytes === 'number' ? f.bytes : Number(f.bytes || 0),
        selected: typeof f.selected === 'number' ? f.selected : Number(f.selected || 0)
      })),
      links: links.map((l) => String(l || ''))
    };
  }

  async selectFiles({ id, fileIds }) {
    const files = fileIds.join(',');

    const url = `${this.baseUrl}/torrents/selectFiles/${encodeURIComponent(id)}`;

    // Real-Debrid expects application/x-www-form-urlencoded for selectFiles.
    const body = new URLSearchParams();
    body.set('files', files);

    try {
      await axiosWith429Retry(
        () =>
          axios.post(url, body, {
            headers: {
              ...this._authHeaders(),
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }),
        { url, baseDelayMs: retryBaseDelayMs }
      );
      if (process.env.DEBRID_VERBOSE === '1' || String(process.env.DEBRID_VERBOSE || '').toLowerCase() === 'true') {
        console.log(`HTTP OK: POST ${url}`);
      }
    } catch (e) {
      const d = axiosErrDetails(e);
      throw new Error(`selectFiles failed: url=${url} status=${d.status ?? 'n/a'} err=${d.msg}${d.body ? ` body=${d.body}` : ''}`);
    }

    return { ok: true };
  }

  async removeTorrent({ id }) {
    const url = `${this.baseUrl}/torrents/delete/${encodeURIComponent(id)}`;
    try {
      await axiosWith429Retry(() => axios.delete(url, { headers: this._authHeaders() }), { url, baseDelayMs: retryBaseDelayMs });
      if (process.env.DEBRID_VERBOSE === '1' || String(process.env.DEBRID_VERBOSE || '').toLowerCase() === 'true') {
        console.log(`HTTP OK: DELETE ${url}`);
      }
    } catch (e) {
      const d = axiosErrDetails(e);
      throw new Error(`removeTorrent failed: url=${url} status=${d.status ?? 'n/a'} err=${d.msg}${d.body ? ` body=${d.body}` : ''}`);
    }
    return { ok: true };
  }

  async unrestrictLink({ link }) {
    if (!link) throw new Error('unrestrictLink requires link');
    const url = `${this.baseUrl}/unrestrict/link`;

    const body = new URLSearchParams();
    body.set('link', String(link));

    let data;
    try {
      ({ data } = await axiosWith429Retry(
        () =>
          axios.post(url, body, {
            headers: {
              ...this._authHeaders(),
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }),
        { url, baseDelayMs: retryBaseDelayMs }
      ));
      if (process.env.DEBRID_VERBOSE === '1' || String(process.env.DEBRID_VERBOSE || '').toLowerCase() === 'true') {
        console.log(`HTTP OK: POST ${url}`);
      }
    } catch (e) {
      const d = axiosErrDetails(e);
      throw new Error(`unrestrictLink failed: url=${url} status=${d.status ?? 'n/a'} err=${d.msg}${d.body ? ` body=${d.body}` : ''}`);
    }

    if (!data?.download) throw new Error(`unrestrictLink: missing download in response (url=${url})`);
    return {
      id: data?.id != null ? String(data.id) : '',
      filename: data?.filename != null ? String(data.filename) : '',
      mimeType: data?.mimeType != null ? String(data.mimeType) : '',
      filesize: typeof data?.filesize === 'number' ? data.filesize : Number(data?.filesize || 0),
      download: String(data.download)
    };
  }
}
