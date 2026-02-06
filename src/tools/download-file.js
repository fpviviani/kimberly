#!/usr/bin/env node
import 'dotenv/config';
import axios from 'axios';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';

function usage() {
  console.log('Usage:');
  console.log('  torrent-auto-crawlerr-download --url <http(s)://...> --dest <dir> [--name <filename>] [--unzip]');
  console.log('');
  console.log('Examples:');
  console.log('  torrent-auto-crawlerr-download --url "https://example.com/video.mp4" --dest "/home/fabio/Videos"');
  console.log('  torrent-auto-crawlerr-download --url "https://example.com/subs.zip" --dest "/home/fabio/Downloads" --unzip --delete-zip-after');
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

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const base = path.basename(u.pathname);
    return base && base !== '/' ? base : null;
  } catch {
    return null;
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function downloadToFile(url, outPath) {
  const resp = await axios.get(url, {
    responseType: 'stream',
    timeout: 120_000,
    headers: { 'User-Agent': 'torrent-auto-crawlerr-download/0.1' }
  });
  await pipeline(resp.data, createWriteStream(outPath));
  return {
    contentType: String(resp.headers?.['content-type'] || ''),
    outPath
  };
}

async function unzipFile(zipPath, destDir) {
  await ensureDir(destDir);
  await pipeline(
    (await fs.open(zipPath, 'r')).createReadStream(),
    unzipper.Extract({ path: destDir })
  );
}

async function main() {
  const url = getArg('--url');
  const dest = getArg('--dest');
  const name = getArg('--name');
  const unzip = hasFlag('--unzip');
  const deleteZipAfter = hasFlag('--delete-zip-after');

  if (!url || !dest) usage();
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are supported');

  await ensureDir(dest);

  const inferred = filenameFromUrl(url) || 'download.bin';
  const outName = name || inferred;
  const outPath = path.resolve(dest, outName);

  console.log(`Downloading: ${url}`);
  console.log(`To: ${outPath}`);

  const { contentType } = await downloadToFile(url, outPath);
  console.log(`Saved. content-type=${contentType || 'unknown'}`);

  const isZip = outPath.toLowerCase().endsWith('.zip') || contentType.includes('zip');

  if (unzip) {
    if (!isZip) {
      throw new Error('Requested --unzip but the downloaded file does not look like a .zip');
    }
    console.log(`Extracting zip to: ${dest}`);
    await unzipFile(outPath, dest);
    console.log('Extracted.');

    if (deleteZipAfter) {
      await fs.rm(outPath, { force: true });
      console.log('Deleted zip after extract.');
    }
  }
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
