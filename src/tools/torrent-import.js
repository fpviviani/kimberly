#!/usr/bin/env node
import 'dotenv/config';
import axios from 'axios';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { defaultCachePath, loadCache, saveCache, patchCachedTorrent, getCachedMovie } from '../cache.js';

function usage() {
  console.log('Usage:');
  console.log('  kimberly-torrent-import --movie "Movie Title" --torrent "Torrent Title" (--url <http-url> | --file </path/file.torrent>)');
  console.log('Options:');
  console.log('  --out <name.torrent>    Optional output filename under torrents/ (default: slug+hash.torrent)');
  console.log('  --cache <path>          Optional cache file path (default: CACHE_FILE env or cache.json)');
  process.exit(2);
}

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

async function downloadTorrentOrMagnet(startUrl) {
  const seen = new Set();
  let current = String(startUrl || '').trim();

  for (let i = 0; i < 6; i++) {
    if (!current) throw new Error('Empty URL');
    if (seen.has(current)) throw new Error(`Redirect loop while downloading torrent: ${current}`);
    seen.add(current);

    if (current.startsWith('magnet:')) {
      return { kind: 'magnet', magnet: current };
    }

    const resp = await axios.get(current, {
      responseType: 'arraybuffer',
      timeout: 60_000,
      maxRedirects: 0,
      validateStatus: () => true
    });

    // Prowlarr /download can respond with 301/302 Location: magnet:...
    if (resp.status === 301 || resp.status === 302 || resp.status === 303 || resp.status === 307 || resp.status === 308) {
      const loc = resp.headers?.location;
      if (!loc) throw new Error(`Redirected request without Location header (status=${resp.status})`);

      if (String(loc).startsWith('magnet:')) {
        return { kind: 'magnet', magnet: String(loc) };
      }

      // Follow http(s) redirects (absolute or relative)
      const next = new URL(String(loc), current).toString();
      current = next;
      continue;
    }

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Failed to download torrent (status=${resp.status}) from ${current}`);
    }

    return { kind: 'torrent', buf: Buffer.from(resp.data) };
  }

  throw new Error(`Too many redirects while downloading torrent: ${startUrl}`);
}

async function main() {
  const movie = getArg('--movie');
  const torrentTitle = getArg('--torrent');
  const url = getArg('--url');
  const file = getArg('--file');
  const outName = getArg('--out');

  if (!movie || !torrentTitle) usage();
  if ((url && file) || (!url && !file)) usage();

  const cachePath = getArg('--cache') || process.env.CACHE_FILE || defaultCachePath();

  // Load cache + sanity check that torrent exists (optional but helpful)
  const cache = await loadCache(cachePath);
  const entry = getCachedMovie(cache, movie);
  if (!entry) {
    throw new Error(`Movie not found in cache: ${movie}`);
  }
  if (!entry.torrents?.[torrentTitle]) {
    throw new Error(`Torrent title not found under movie in cache. Movie="${movie}" Torrent="${torrentTitle}"`);
  }

  const torrentsDir = path.resolve(path.dirname(cachePath), 'torrents');
  await fs.mkdir(torrentsDir, { recursive: true });

  if (url) {
    const res = await downloadTorrentOrMagnet(url);

    if (res.kind === 'magnet') {
      const patched = patchCachedTorrent(cache, movie, torrentTitle, {
        magnet: res.magnet,
        torrent_url: null,
        torrent_path: null
      });
      await saveCache(cachePath, patched);

      console.log(`Resolved magnet redirect: ${res.magnet.slice(0, 60)}...`);
      console.log('Cache updated: magnet set (torrent_url/torrent_path cleared).');
      if (hasFlag('--print')) {
        console.log(JSON.stringify(patched[movie], null, 2));
      }
      return;
    }

    const buf = res.buf;

    // Determine output filename
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
    const filename = outName || `${slug(torrentTitle) || 'torrent'}-${hash}.torrent`;
    const outPath = path.join(torrentsDir, filename);

    await fs.writeFile(outPath, buf);

    const patched = patchCachedTorrent(cache, movie, torrentTitle, {
      torrent_path: outPath,
      torrent_url: null
    });
    await saveCache(cachePath, patched);

    console.log(`Saved: ${outPath}`);
    console.log('Cache updated: torrent_path set.');
    if (hasFlag('--print')) {
      console.log(JSON.stringify(patched[movie], null, 2));
    }
    return;
  }

  // local file
  const buf = await fs.readFile(file);

  // Determine output filename
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
  const filename = outName || `${slug(torrentTitle) || 'torrent'}-${hash}.torrent`;
  const outPath = path.join(torrentsDir, filename);

  await fs.writeFile(outPath, buf);

  const patched = patchCachedTorrent(cache, movie, torrentTitle, { torrent_path: outPath });
  await saveCache(cachePath, patched);

  console.log(`Saved: ${outPath}`);
  console.log('Cache updated: torrent_path set.');
  if (hasFlag('--print')) {
    console.log(JSON.stringify(patched[movie], null, 2));
  }
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
