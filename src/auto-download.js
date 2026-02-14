import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plexRefreshSection } from './plex.js';
import { radarrAddMovieIfMissing, radarrEnabled, radarrResolveTmdbId } from './radarr.js';

function isTrue(v) {
  return v === '1' || String(v || '').toLowerCase() === 'true';
}

function safeDirName(name) {
  return String(name || 'movie')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function safeYearSuffix(year) {
  const y = String(year || '').trim();
  return /^\d{4}$/.test(y) ? y : '';
}

/**
 * Auto-downloads video/subtitle links using Real-Debrid unrestrict/link and our downloader tool.
 *
 * - Creates a per-movie folder inside destDir
 * - Unrestricts each link (video/subtitle)
 * - Downloads each unrestrict "download" URL
 * - Optionally refreshes Plex once at the end
 */
function projectRootDir() {
  // src/auto-download.js -> project root is one level up
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

async function pathExists(p) {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

async function moveDirContents(srcDir, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const e of entries) {
    const src = path.join(srcDir, e.name);
    const dst = path.join(destDir, e.name);
    if (await pathExists(dst)) {
      // If a collision happens, keep the existing file and suffix the moved one.
      const ext = path.extname(e.name);
      const base = e.name.slice(0, -ext.length);
      let moved = false;
      for (let i = 2; i < 1000; i++) {
        const cand = path.join(destDir, `${base}.${i}${ext}`);
        if (!(await pathExists(cand))) {
          await fs.rename(src, cand).catch(async (err) => {
            if (err?.code === 'EXDEV') {
              await fs.copyFile(src, cand);
              await fs.rm(src, { force: true, recursive: true });
              return;
            }
            throw err;
          });
          moved = true;
          break;
        }
      }
      if (!moved) throw new Error(`moveDirContents: too many collisions for ${dst}`);
      continue;
    }

    await fs.rename(src, dst).catch(async (err) => {
      if (err?.code === 'EXDEV') {
        // cross-device fallback (best-effort for files)
        if (e.isDirectory()) {
          // recursive move for dirs
          await fs.mkdir(dst, { recursive: true });
          await moveDirContents(src, dst);
          await fs.rm(src, { recursive: true, force: true });
          return;
        }
        await fs.copyFile(src, dst);
        await fs.rm(src, { force: true });
        return;
      }
      throw err;
    });
  }
}

// Note: we intentionally do NOT rename video/subtitle files.
// Bazarr (and other tools) often expect the original filenames.

export async function runAutoDownload({
  provider,
  movieTitle,
  movieYear,
  destDir,
  debridUrls,
  refreshPlex = isTrue(process.env.PLEX_REFRESH_AFTER_DOWNLOAD),
  plexSectionId = process.env.PLEX_SECTION_ID_FILMES || '1',
  logger = console
}) {
  if (!destDir) throw new Error('runAutoDownload: missing destDir');

  const y = safeYearSuffix(movieYear);

  const dirNameMovieOnly = (process.env.DIR_NAME_MOVIE_ONLY || '1') === '1' || String(process.env.DIR_NAME_MOVIE_ONLY || '').toLowerCase() === 'true';

  // Folder naming (we do not rename files).
  // Default: only the movie name.
  // If DIR_NAME_MOVIE_ONLY=false, include year and tmdb id when possible.
  let tmdbId = null;
  if (!dirNameMovieOnly && radarrEnabled()) {
    try {
      const resolved = await radarrResolveTmdbId({ title: movieTitle, year: y ? Number(y) : null, logger });
      tmdbId = resolved?.tmdbId != null ? Number(resolved.tmdbId) : null;
    } catch {
      tmdbId = null;
    }
  }

  const folderName = dirNameMovieOnly
    ? `${safeDirName(movieTitle)}`
    : (tmdbId
      ? `${safeDirName(movieTitle)}-${y || '0000'}-tmdb_${tmdbId}`
      : (y ? `${safeDirName(movieTitle)}-${y}` : safeDirName(movieTitle)));

  // Stage downloads outside Plex library, then move into the final library folder.
  const stagingBase = process.env.AUTO_DOWNLOAD_STAGING_DIR || path.join(projectRootDir(), 'Downloads');
  const stagingDir = path.join(stagingBase, folderName);

  const movieDestDir = `${String(destDir).replace(/\/+$/, '')}/${folderName}`;

  const videoLink = debridUrls?.video;
  const subtitleLink = debridUrls?.subtitle;

  const toUnrestrict = [
    { kind: 'video', link: videoLink },
    { kind: 'subtitle', link: subtitleLink }
  ].filter((x) => typeof x.link === 'string' && x.link);

  if (!toUnrestrict.length) {
    logger.log(`AUTO_DOWNLOAD: no links for movie="${movieTitle}"`);
    return { ok: true, okAll: true, downloadedAny: false, movieDestDir, successCount: 0, failCount: 0 };
  }

  logger.log(`AUTO_DOWNLOAD: movie="${movieTitle}" stage="${stagingDir}" final="${movieDestDir}" items=${toUnrestrict.length}`);

  async function hasAnyVideoFile(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (ext === '.mkv' || ext === '.mp4' || ext === '.avi' || ext === '.m2ts') return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // If a previous run was killed mid-flight, we might already have the file staged.
  // In that case, do NOT re-download; just move to library and continue.
  const reuseStaging = (process.env.AUTO_DOWNLOAD_REUSE_STAGING || '1') === '1' || String(process.env.AUTO_DOWNLOAD_REUSE_STAGING || '').toLowerCase() === 'true';
  const stagedVideoExists = reuseStaging ? await hasAnyVideoFile(stagingDir) : false;

  let successCount = 0;
  let failCount = 0;

  if (!stagedVideoExists) {
    for (const item of toUnrestrict) {
    try {
      logger.log(`AUTO_DOWNLOAD: unrestricting ${item.kind}...`);
      const unr = await provider.unrestrictLink({ link: item.link });
      const downloadUrl = unr?.download;
      if (!downloadUrl) {
        failCount += 1;
        logger.log(`AUTO_DOWNLOAD: unrestrict returned no download url (${item.kind})`);
        continue;
      }

      logger.log(`AUTO_DOWNLOAD: downloading ${item.kind} -> ${downloadUrl}`);
      await new Promise((resolve, reject) => {
        const args = [new URL('./tools/download-file.js', import.meta.url).pathname, '--url', downloadUrl, '--dest', stagingDir];

        // Sometimes Real-Debrid serves archives (.zip/.rar) for both video and subtitles.
        // --unpack will extract when needed; if not an archive it just does nothing.
        args.push('--unpack', '--delete-archive-after');

        const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`download exited ${code}`))));
      });

      successCount += 1;
    } catch (e) {
      failCount += 1;
      logger.error(`AUTO_DOWNLOAD: failed (${item.kind}): ${String(e?.message || e)}`);
    }
  }
  }

  const downloadedAny = stagedVideoExists ? true : (successCount > 0);
  // If we reused staging, treat it as okAll.
  const okAll = stagedVideoExists ? true : (successCount === toUnrestrict.length);

  // Move staged content into the Plex library only after successful downloads.
  if (okAll && downloadedAny) {
    try {
      await moveDirContents(stagingDir, movieDestDir);
      // best-effort cleanup
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch (e) {
      logger.error(`AUTO_DOWNLOAD: move to library failed: ${String(e?.message || e)}`);
      return { ok: false, okAll: false, downloadedAny, movieDestDir, successCount, failCount };
    }

    if (refreshPlex) {
      try {
        await plexRefreshSection({ sectionId: plexSectionId });
        logger.log(`PLEX: refresh triggered (section=${plexSectionId})`);
      } catch (e) {
        logger.error(`PLEX: refresh failed: ${String(e?.message || e)}`);
      }
    }

    // Optional: add to Radarr only after we moved the files into the final folder.
    if (radarrEnabled()) {
      try {
        await radarrAddMovieIfMissing({
          title: movieTitle,
          year: movieYear,
          moviePath: movieDestDir,
          logger
        });
      } catch (e) {
        logger.error(`RADARR: import failed: ${String(e?.message || e)}`);
      }
    }
  }

  return { ok: okAll, okAll, downloadedAny, movieDestDir, successCount, failCount };
}
