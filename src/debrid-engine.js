function ext(path) {
  const m = String(path || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function pickFiles(files, { requireSrt }) {
  const video = files.filter((f) => {
    const e = ext(f.path);
    return e === 'mkv' || e === 'mp4';
  });
  video.sort((a, b) => String(a.path).localeCompare(String(b.path)));

  const subs = files.filter((f) => ext(f.path) === 'srt');
  subs.sort((a, b) => String(a.path).localeCompare(String(b.path)));

  const chosen = [];
  if (video[0]) chosen.push(video[0]);
  // IMPORTANT: only select .srt in the strict pass (requireSrt=true).
  // In the fallback pass (video-only), never select subtitles even if available.
  if (requireSrt && subs[0]) chosen.push(subs[0]);

  return {
    hasVideo: video.length > 0,
    hasSrt: subs.length > 0,
    chosenIds: chosen.map((f) => f.id),
    chosenPaths: chosen.map((f) => f.path)
  };
}

async function sendOne({ provider, attempt }) {
  if (attempt.magnet) {
    return provider.sendTorrent({ magnet: attempt.magnet });
  }
  if (attempt.torrent_path) {
    if (typeof provider.sendTorrentFile !== 'function') {
      throw new Error('Provider does not support sendTorrentFile');
    }
    return provider.sendTorrentFile({ torrentPath: attempt.torrent_path });
  }
  throw new Error('Attempt has neither magnet nor torrent_path');
}

async function tryAttemptsOnce({ provider, attempts, requireSrt, logger, onSent, onDownloaded }) {
  const verbose = (process.env.DEBRID_VERBOSE === '1') || String(process.env.DEBRID_VERBOSE || '').toLowerCase() === 'true';
  if (verbose) logger.log(`ENGINE: pass=${requireSrt ? 'strict(video+srt)' : 'fallback(video-only)'} attempts=${attempts.length}`);

  for (const attempt of attempts) {
    let id = null;
    try {
      if (verbose) logger.log(`ENGINE: attempt="${attempt.title}" :: sending torrent...`);

      const sent = await sendOne({ provider, attempt });
      id = sent.id;
      if (verbose) logger.log(`ENGINE: attempt="${attempt.title}" :: sent ok id=${id}`);
      if (onSent) await onSent({ attempt, id });

      if (verbose) logger.log(`ENGINE: id=${id} :: fetching torrent info...`);
      const info1 = await provider.getTorrentInfo({ id });
      if (verbose) logger.log(`ENGINE: id=${id} :: status=${info1.status} files=${info1.files?.length ?? 0}`);

      const selection = pickFiles(info1.files, { requireSrt });

      if (!selection.hasVideo) {
        logger.log(`ENGINE: attempt="${attempt.title}" :: skip (no video .mkv/.mp4), removing id=${id}`);
        await provider.removeTorrent({ id });
        continue;
      }

      if (requireSrt && !selection.hasSrt) {
        logger.log(`ENGINE: attempt="${attempt.title}" :: skip (no .srt), removing id=${id}`);
        await provider.removeTorrent({ id });
        continue;
      }

      if (verbose) logger.log(`ENGINE: id=${id} :: selecting files ids=[${selection.chosenIds.join(',')}] paths=[${selection.chosenPaths.join(' | ')}]`);
      await provider.selectFiles({ id, fileIds: selection.chosenIds });
      if (verbose) logger.log(`ENGINE: id=${id} :: selectFiles ok`);

      if (verbose) logger.log(`ENGINE: id=${id} :: re-checking status...`);
      const info2 = await provider.getTorrentInfo({ id });
      if (verbose) logger.log(`ENGINE: id=${id} :: status=${info2.status}`);

      if (info2.status === 'downloaded') {
        logger.log(`ENGINE: attempt="${attempt.title}" :: DOWNLOADED id=${id}`);
        if (onDownloaded) await onDownloaded({ attempt, id });
        return { ok: true, id, selected: selection, attempt };
      }

      if (verbose) logger.log(`ENGINE: attempt="${attempt.title}" :: not downloaded yet (status=${info2.status}), removing id=${id}`);
      await provider.removeTorrent({ id });
    } catch (e) {
      if (id) {
        try {
          if (verbose) logger.log(`ENGINE: attempt="${attempt.title}" :: error, cleaning up id=${id}`);
          await provider.removeTorrent({ id });
        } catch {}
      }
      logger.log(`ENGINE: error for attempt="${attempt.title}": ${String(e?.message || e)}`);
      continue;
    }
  }

  return { ok: false };
}

async function leaveAllInDebridVideoOnly({ provider, attempts, logger, onSent, onDownloading }) {
  const verbose = (process.env.DEBRID_VERBOSE === '1') || String(process.env.DEBRID_VERBOSE || '').toLowerCase() === 'true';
  if (verbose) logger.log(`ENGINE: step3 (leave in debrid video-only) attempts=${attempts.length}`);

  const kept = [];
  for (const attempt of attempts) {
    let id = null;
    try {
      if (verbose) logger.log(`ENGINE: step3 attempt="${attempt.title}" :: sending torrent...`);
      const sent = await sendOne({ provider, attempt });
      id = sent.id;
      if (verbose) logger.log(`ENGINE: step3 attempt="${attempt.title}" :: sent ok id=${id}`);
      if (onSent) await onSent({ attempt, id });

      if (verbose) logger.log(`ENGINE: step3 id=${id} :: fetching torrent info...`);
      const info = await provider.getTorrentInfo({ id });
      if (verbose) logger.log(`ENGINE: step3 id=${id} :: status=${info.status} files=${info.files?.length ?? 0}`);

      const selection = pickFiles(info.files, { requireSrt: false });
      if (!selection.hasVideo) {
        logger.log(`ENGINE: step3 attempt="${attempt.title}" :: skip (no video .mkv/.mp4), removing id=${id}`);
        // keep your debrid clean: remove useless items
        await provider.removeTorrent({ id });
        continue;
      }

      // Video only: remove any .srt from selection for step3
      const videoIds = (info.files || [])
        .filter((f) => {
          const e = ext(f.path);
          return e === 'mkv' || e === 'mp4';
        })
        .sort((a, b) => String(a.path).localeCompare(String(b.path)))
        .slice(0, 1)
        .map((f) => f.id);

      if (verbose) logger.log(`ENGINE: step3 id=${id} :: selecting video-only ids=[${videoIds.join(',')}]`);
      await provider.selectFiles({ id, fileIds: videoIds });
      if (verbose) logger.log(`ENGINE: step3 id=${id} :: selectFiles ok (left in debrid)`);

      kept.push({ id, attempt, selectedVideoIds: videoIds });
      if (onDownloading) await onDownloading({ attempt, id });
      // DO NOT remove: leave it in debrid to keep downloading
    } catch (e) {
      if (id) {
        try {
          if (verbose) logger.log(`ENGINE: step3 attempt="${attempt.title}" :: error, cleaning up id=${id}`);
          await provider.removeTorrent({ id });
        } catch {}
      }
      logger.log(`ENGINE: error in step3 attempt="${attempt.title}": ${String(e?.message || e)}`);
      continue;
    }
  }
  return { ok: false, left_in_debrid: true, kept };
}

/**
 * Two-pass strategy:
 * 1) require video + .srt
 * 2) fallback: require only video
 */
export async function tryMagnetsUntilDownloaded({ provider, attempts, logger = console, onSent, onDownloaded, onDownloading }) {
  const strict = await tryAttemptsOnce({ provider, attempts, requireSrt: true, logger, onSent, onDownloaded });
  if (strict.ok) return strict;

  const fallback = await tryAttemptsOnce({ provider, attempts, requireSrt: false, logger, onSent, onDownloaded });
  if (fallback.ok) return fallback;

  // Step 3: if nothing downloaded in step1/2, leave ALL torrents in debrid (video only) so it keeps trying.
  return leaveAllInDebridVideoOnly({ provider, attempts, logger, onSent, onDownloading });
}
