#!/usr/bin/env node
import 'dotenv/config';
import axios from 'axios';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';
import { spawn } from 'node:child_process';

function usage() {
  console.log('Usage:');
  console.log('  kimberly-download --url <http(s)://...> --dest <dir> [--name <filename>] [--unpack]');
  console.log('');
  console.log('Notes:');
  console.log('  --unpack extracts .zip or .rar into --dest');
  console.log('  After unpack, any .srt found inside subfolders is moved up into --dest');
  console.log('');
  console.log('Examples:');
  console.log('  kimberly-download --url "https://example.com/video.mp4" --dest "/path/to/Downloads"');
  console.log('  kimberly-download --url "https://example.com/subs.rar" --dest "/path/to/Downloads" --unpack --delete-archive-after');
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
    if (!base || base === '/') return null;
    // URLs often include percent-encoding (%20 etc.). Decode for a friendly on-disk name.
    try {
      return decodeURIComponent(base);
    } catch {
      return base;
    }
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
    headers: { 'User-Agent': 'kimberly-download/0.1' }
  });
  await pipeline(resp.data, createWriteStream(outPath));
  return {
    contentType: String(resp.headers?.['content-type'] || ''),
    outPath
  };
}

async function unzipFile(zipPath, destDir) {
  await ensureDir(destDir);
  await pipeline((await fs.open(zipPath, 'r')).createReadStream(), unzipper.Extract({ path: destDir }));
}

function isWindows() {
  return process.platform === 'win32';
}

async function fileExists(p) {
  return await fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

async function find7zBinary() {
  const envPath = String(process.env.SEVEN_ZIP_PATH || '').trim();
  if (envPath) return envPath;

  // If 7z is in PATH, spawning "7z"/"7z.exe" will work.
  // For Windows local installs, also try common locations.
  if (!isWindows()) return '7z';

  const candidates = [
    '7z',
    '7z.exe',
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe'
  ];

  for (const c of candidates) {
    if (c === '7z' || c === '7z.exe') return c;
    if (await fileExists(c)) return c;
  }

  return '7z';
}

async function run7zExtract(archivePath, destDir) {
  await ensureDir(destDir);
  const bin = await find7zBinary();
  await new Promise((resolve, reject) => {
    const child = spawn(bin, ['x', '-y', `-o${destDir}`, archivePath], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`7z exited ${code}`))));
  });
}

async function listFilesRecursive(dir) {
  const out = [];
  async function walk(d) {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(p);
    }
  }
  await walk(dir);
  return out;
}

async function moveExtensionsToTop(destDir, exts) {
  const wanted = new Set(exts.map((e) => e.toLowerCase()));
  const files = await listFilesRecursive(destDir);
  const matches = files.filter((p) => wanted.has(path.extname(p).toLowerCase()));

  for (const src of matches) {
    const base = path.basename(src);
    const target0 = path.join(destDir, base);
    if (path.resolve(src) === path.resolve(target0)) continue;

    let target = target0;

    const exists = await fs
      .stat(target)
      .then(() => true)
      .catch(() => false);

    // avoid clobber
    if (exists) {
      const ext = path.extname(base);
      const nameNoExt = base.slice(0, -ext.length);
      for (let i = 2; i < 1000; i++) {
        const cand = path.join(destDir, `${nameNoExt}.${i}${ext}`);
        const candExists = await fs
          .stat(cand)
          .then(() => true)
          .catch(() => false);
        if (!candExists) {
          target = cand;
          break;
        }
      }
    }

    await fs.rename(src, target).catch(async (e) => {
      // cross-device fallback
      if (e?.code === 'EXDEV') {
        await fs.copyFile(src, target);
        await fs.rm(src, { force: true });
        return;
      }
      throw e;
    });
  }
}

async function moveInterestingFilesToTop(destDir) {
  // Put subs and common video files at the movie folder root.
  await moveExtensionsToTop(destDir, ['.srt', '.mkv', '.mp4', '.avi', '.m2ts']);
}

async function main() {
  const url = getArg('--url');
  const dest = getArg('--dest');
  const name = getArg('--name');

  // Back-compat: --unzip means unpack, but requires zip
  const unzip = hasFlag('--unzip');
  const unpack = hasFlag('--unpack') || unzip;
  const deleteArchiveAfter = hasFlag('--delete-archive-after') || hasFlag('--delete-zip-after');

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

  const lower = outPath.toLowerCase();
  const isZip = lower.endsWith('.zip') || String(contentType).includes('zip');
  const isRar = lower.endsWith('.rar') || String(contentType).includes('rar');
  const isArchive = isZip || isRar;

  if (unzip && !isZip) {
    throw new Error('Requested --unzip but the downloaded file does not look like a .zip');
  }

  if (unpack) {
    if (!isArchive) {
      console.log('Unpack requested, but file is not a .zip/.rar. Skipping extract.');
      return;
    }

    console.log(`Extracting archive to: ${dest}`);

    if (isZip) {
      await unzipFile(outPath, dest);
    } else {
      await run7zExtract(outPath, dest);
    }

    // If the archive contains video/subs under subfolders, move them up to the movie root.
    await moveInterestingFilesToTop(dest);

    console.log('Extracted.');

    if (deleteArchiveAfter) {
      await fs.rm(outPath, { force: true });
      console.log('Deleted archive after extract.');
    }
  }
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
