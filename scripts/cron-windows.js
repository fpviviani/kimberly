#!/usr/bin/env node
import 'dotenv/config';
import { execSync } from 'node:child_process';
import path from 'node:path';

function parseIntMin(name, def) {
  const raw = Number(process.env[name] ?? def);
  const v = Number.isFinite(raw) ? Math.floor(raw) : def;
  if (v < 1 || v > 60) throw new Error(`${name} must be an integer between 1 and 60`);
  return v;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function addMinutes(d, mins) {
  return new Date(d.getTime() + mins * 60_000);
}

function toHHMM(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

function main() {
  const action = process.argv.includes('--remove') ? 'remove' : 'install';

  const every = parseIntMin('CRON_CLI_EVERY_MIN', 20);
  const after = parseIntMin('CRON_MONITOR_AFTER_CLI_MIN', 10);

  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const logsDir = path.join(projectRoot, 'logs');

  const taskCli = 'kimberly-cli';
  const taskMon = 'kimberly-monitor';

  if (action === 'remove') {
    try { run(`schtasks /Delete /TN "${taskCli}" /F`); } catch {}
    try { run(`schtasks /Delete /TN "${taskMon}" /F`); } catch {}
    console.log('Removed scheduled tasks.');
    return;
  }

  const now = new Date();
  const startCli = toHHMM(addMinutes(now, 1));
  const startMon = toHHMM(addMinutes(now, 1 + after));

  const useDocker = (process.env.CRON_USE_DOCKER || '0') === '1' || String(process.env.CRON_USE_DOCKER || '').toLowerCase() === 'true';

  const cliInner = useDocker
    ? `docker compose run --rm crawler-cli`
    : `node src\\cli.js`;

  const monInner = useDocker
    ? `docker compose run --rm crawler-monitor`
    : `node src\\debrid-monitor.js`;

  const cmdCli = `cmd.exe /c "cd /d \"${projectRoot}\" && if not exist \"${logsDir}\" mkdir \"${logsDir}\" && ${cliInner} >> \"${logsDir}\\cron-cli.log\" 2>&1"`;
  const cmdMon = `cmd.exe /c "cd /d \"${projectRoot}\" && if not exist \"${logsDir}\" mkdir \"${logsDir}\" && ${monInner} >> \"${logsDir}\\cron-monitor.log\" 2>&1"`;

  // Create/replace tasks
  try { run(`schtasks /Delete /TN "${taskCli}" /F`); } catch {}
  try { run(`schtasks /Delete /TN "${taskMon}" /F`); } catch {}

  run(`schtasks /Create /TN "${taskCli}" /SC MINUTE /MO ${every} /ST ${startCli} /TR "${cmdCli}" /F`);
  run(`schtasks /Create /TN "${taskMon}" /SC MINUTE /MO ${every} /ST ${startMon} /TR "${cmdMon}" /F`);

  console.log('Installed scheduled tasks.');
  console.log(`- CLI: every ${every} min (start ${startCli})`);
  console.log(`- Monitor: every ${every} min (start ${startMon})`);
}

main();
