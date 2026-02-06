import { spawn } from 'node:child_process';
import { plexRefreshSection } from './plex.js';

function isTrue(v) {
  return v === '1' || String(v || '').toLowerCase() === 'true';
}

function safeDirName(name) {
  return String(name || 'movie')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

/**
 * Auto-downloads video/subtitle links using Real-Debrid unrestrict/link and our downloader tool.
 *
 * - Creates a per-movie folder inside destDir
 * - Unrestricts each link (video/subtitle)
 * - Downloads each unrestrict "download" URL
 * - Optionally refreshes Plex once at the end
 */
export async function runAutoDownload({
  provider,
  movieTitle,
  destDir,
  debridUrls,
  refreshPlex = isTrue(process.env.PLEX_REFRESH_AFTER_DOWNLOAD),
  plexSectionId = process.env.PLEX_SECTION_ID_FILMES || '1',
  logger = console
}) {
  if (!destDir) throw new Error('runAutoDownload: missing destDir');

  const movieDestDir = `${String(destDir).replace(/\/+$/, '')}/${safeDirName(movieTitle)}`;

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

  logger.log(`AUTO_DOWNLOAD: movie="${movieTitle}" dir="${movieDestDir}" items=${toUnrestrict.length}`);

  let successCount = 0;
  let failCount = 0;

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
        const child = spawn(
          process.execPath,
          [new URL('./tools/download-file.js', import.meta.url).pathname, '--url', downloadUrl, '--dest', movieDestDir],
          { stdio: 'inherit', env: process.env }
        );
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`download exited ${code}`))));
      });

      successCount += 1;
    } catch (e) {
      failCount += 1;
      logger.error(`AUTO_DOWNLOAD: failed (${item.kind}): ${String(e?.message || e)}`);
    }
  }

  const downloadedAny = successCount > 0;
  const okAll = successCount === toUnrestrict.length;

  if (downloadedAny && refreshPlex) {
    try {
      await plexRefreshSection({ sectionId: plexSectionId });
      logger.log(`PLEX: refresh triggered (section=${plexSectionId})`);
    } catch (e) {
      logger.error(`PLEX: refresh failed: ${String(e?.message || e)}`);
    }
  }

  return { ok: okAll, okAll, downloadedAny, movieDestDir, successCount, failCount };
}
