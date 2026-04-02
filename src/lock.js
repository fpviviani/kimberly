import { promises as fs } from 'node:fs';
import path from 'node:path';

function nowIso() {
  return new Date().toISOString();
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false;
    throw e;
  }
}

async function readJson(p) {
  const raw = await fs.readFile(p, 'utf8');
  return JSON.parse(raw);
}

async function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function defaultLockPath({ projectRoot, name = 'kimberly-cli' } = {}) {
  // keep it in projectRoot/memory so it's not forgotten, and survives cwd changes
  const root = projectRoot || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  return path.resolve(root, 'memory', `${name}.lock.json`);
}

export async function acquireLock({ lockPath, name = 'kimberly-cli', logger = console } = {}) {
  if (!lockPath) throw new Error('lockPath is required');

  const dir = path.dirname(lockPath);
  await fs.mkdir(dir, { recursive: true });

  // Fast path: if lock exists and pid alive -> refuse.
  if (await exists(lockPath)) {
    try {
      const data = await readJson(lockPath);
      const pid = Number(data?.pid);
      if (await isPidAlive(pid)) {
        const since = data?.startedAt || data?.createdAt || 'unknown';
        const cmd = data?.cmd || '';
        const msg = `Another ${name} instance is already running (pid=${pid}, since=${since}). ${cmd ? `cmd=${cmd}` : ''}`;
        const err = new Error(msg);
        err.code = 'LOCKED';
        throw err;
      }

      // stale lock
      logger?.log?.(`LOCK: removing stale lock (pid=${pid} not alive) at ${lockPath}`);
      await fs.rm(lockPath, { force: true });
    } catch (e) {
      // If lock is corrupt, remove it.
      logger?.log?.(`LOCK: lock read failed; removing ${lockPath}: ${String(e?.message || e)}`);
      await fs.rm(lockPath, { force: true });
    }
  }

  const payload = {
    pid: process.pid,
    name,
    startedAt: nowIso(),
    cmd: process.argv.join(' ')
  };

  // Atomic create.
  try {
    await fs.writeFile(lockPath, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx' });
  } catch (e) {
    if (e?.code === 'EEXIST') {
      const err = new Error(`Another ${name} instance is already running (lock exists: ${lockPath})`);
      err.code = 'LOCKED';
      throw err;
    }
    throw e;
  }

  let released = false;

  async function release() {
    if (released) return;
    released = true;
    try {
      // Only remove if it still refers to our pid.
      const data = await readJson(lockPath).catch(() => null);
      if (Number(data?.pid) === process.pid) {
        await fs.rm(lockPath, { force: true });
      }
    } catch {
      // ignore
    }
  }

  // best-effort cleanup
  process.on('exit', () => {
    // no await here
    try { fs.rm(lockPath, { force: true }); } catch {}
  });

  process.on('SIGINT', async () => {
    await release();
    process.exit(130);
  });
  process.on('SIGTERM', async () => {
    await release();
    process.exit(143);
  });

  return { lockPath, payload, release };
}
