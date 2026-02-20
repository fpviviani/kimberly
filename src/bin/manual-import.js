#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { radarrAddMovieIfMissing } from '../radarr.js';
import { plexRefreshSection } from '../plex.js';

function usage() {
  console.log('Usage: node src/bin/manual-import.js "Movie Name - 1999"');
  console.log('   or: node src/bin/manual-import.js "Movie Name"');
  console.log('Env: RADARR_API_KEY (required), RADARR_BASE_URL, RADARR_ROOT_FOLDER_PATH (or AUTO_DOWNLOAD_DEST_DIR).');
  process.exit(2);
}

function normalize(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}+/gu, '')
    .toLowerCase()
    .replace(/[\[\(\{].*?[\]\)\}]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMovieArg(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const idx = s.lastIndexOf(' - ');
  if (idx === -1) return { title: s, year: null };
  const title = s.slice(0, idx).trim();
  const yearRaw = s.slice(idx + 3).trim();
  const y = Number(yearRaw);
  const year = Number.isFinite(y) && y > 1800 && y < 2200 ? y : null;
  return { title: title || s, year };
}

async function findMovieFolder({ rootDir, title }) {
  const want = normalize(title);
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  // 1) exact-ish matches (normalized)
  for (const d of dirs) {
    if (normalize(d) === want) return path.join(rootDir, d);
  }

  // 2) contains matches
  const hits = [];
  for (const d of dirs) {
    const nd = normalize(d);
    if (!nd) continue;
    if (nd.includes(want) || want.includes(nd)) hits.push(d);
  }

  if (hits.length === 1) return path.join(rootDir, hits[0]);
  if (hits.length > 1) {
    throw new Error(`Found multiple candidate folders for "${title}": ${hits.slice(0, 8).join(' | ')}${hits.length > 8 ? ' ...' : ''}`);
  }

  return null;
}

const arg = process.argv.slice(2).join(' ').trim();
if (!arg) usage();

const parsed = parseMovieArg(arg);
if (!parsed) usage();

const rootDir = process.env.RADARR_ROOT_FOLDER_PATH || process.env.AUTO_DOWNLOAD_DEST_DIR || '';
if (!rootDir) throw new Error('Missing RADARR_ROOT_FOLDER_PATH (or AUTO_DOWNLOAD_DEST_DIR)');

const movieFolder = await findMovieFolder({ rootDir, title: parsed.title });
if (!movieFolder) {
  throw new Error(`Could not find a matching movie folder inside: ${rootDir}`);
}

console.log(`Found folder: ${movieFolder}`);

await radarrAddMovieIfMissing({
  title: parsed.title,
  year: parsed.year,
  moviePath: movieFolder,
  radarrRootFolderPath: rootDir,
  logger: console
});

// Trigger Plex refresh (same as the downloader pipeline does)
try {
  const sectionId = process.env.PLEX_SECTION_ID_FILMES || '1';
  await plexRefreshSection({ sectionId });
  console.log(`PLEX: refresh triggered (section=${sectionId})`);
} catch (e) {
  console.log(`PLEX: refresh failed: ${String(e?.message || e)}`);
}
