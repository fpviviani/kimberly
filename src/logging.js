import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';

function isTrue(v) {
  return v === '1' || String(v || '').toLowerCase() === 'true';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function todayStampYYMMDD(d = new Date()) {
  const yy = pad2(d.getFullYear() % 100);
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  return `${yy}-${mm}-${dd}`;
}

function dateFromStampYYMMDD(stamp) {
  const m = String(stamp).match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const yy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  const yyyy = 2000 + yy;
  return new Date(yyyy, mm - 1, dd);
}

async function exists(p) {
  return await fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

export async function initDailyLogger({ projectRoot, logger = console } = {}) {
  const enabled = isTrue(process.env.LOGS_ENABLED);
  const retentionDaysRaw = Number(process.env.LOGS_RETENTION_DAYS || '2');
  const retentionDays = Number.isFinite(retentionDaysRaw) && retentionDaysRaw >= 1 ? Math.floor(retentionDaysRaw) : 2;

  const logsDir = path.resolve(projectRoot || process.cwd(), 'logs');
  const stamp = todayStampYYMMDD();
  const logPath = path.join(logsDir, `log-${stamp}.txt`);

  if (!enabled) {
    return {
      enabled: false,
      logPath,
      log: async () => {},
      cleanup: async () => {}
    };
  }

  await fs.mkdir(logsDir, { recursive: true });

  const isFirstRunToday = !(await exists(logPath));
  if (isFirstRunToday) {
    await fs.writeFile(logPath, '', { flag: 'a' });

    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - (retentionDays - 1));

    try {
      const entries = await fs.readdir(logsDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (e.name === '.gitkeep') continue;
        const m = e.name.match(/^log-(\d{2}-\d{2}-\d{2})\.txt$/);
        if (!m) continue;
        const d = dateFromStampYYMMDD(m[1]);
        if (!d) continue;
        d.setHours(0, 0, 0, 0);
        if (d < cutoff) {
          await fs.rm(path.join(logsDir, e.name), { force: true });
        }
      }
    } catch (e) {
      logger?.log?.(`LOGS: cleanup failed: ${String(e?.message || e)}`);
    }
  }

  async function log(msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${String(msg || '').trim()}\n`;
    await fs.appendFile(logPath, line);
  }

  return { enabled: true, logPath, log, cleanup: async () => {} };
}
