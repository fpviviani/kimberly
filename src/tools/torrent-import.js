#!/usr/bin/env node
import 'dotenv/config';
import axios from 'axios';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

async function download(url) {
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60_000 });
  return Buffer.from(resp.data);
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

  let buf;
  if (url) {
    buf = await download(url);
  } else {
    buf = await fs.readFile(file);
  }

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
