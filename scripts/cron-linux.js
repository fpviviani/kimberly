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

function minutesList(every, offset) {
  const out = [];
  for (let m = 0; m < 60; m++) {
    if ((m % every) === offset) out.push(m);
  }
  return out.length ? out.join(',') : '0';
}

function getCrontab() {
  try {
    return execSync('crontab -l', { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf-8');
  } catch {
    return '';
  }
}

function setCrontab(text) {
  execSync('crontab -', { input: text, stdio: ['pipe', 'inherit', 'inherit'] });
}

function stripBlock(text) {
  const begin = '# torrent-auto-crawlerr BEGIN';
  const end = '# torrent-auto-crawlerr END';
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (const l of lines) {
    if (l.trim() === begin) {
      inBlock = true;
      continue;
    }
    if (l.trim() === end) {
      inBlock = false;
      continue;
    }
    if (!inBlock) out.push(l);
  }
  return out.join('\n').trimEnd() + '\n';
}

function main() {
  const action = process.argv.includes('--remove') ? 'remove' : 'install';

  const every = parseIntMin('CRON_CLI_EVERY_MIN', 20);
  const after = parseIntMin('CRON_MONITOR_AFTER_CLI_MIN', 10);
  const offset = ((after % every) + every) % every;

  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const logsDir = path.join(projectRoot, 'logs');

  const current = getCrontab();
  const base = stripBlock(current);

  if (action === 'remove') {
    setCrontab(base);
    console.log('Removed torrent-auto-crawlerr cron block.');
    return;
  }

  const cliMinutes = minutesList(every, 0);
  const monMinutes = minutesList(every, offset);

  const block = [
    '# torrent-auto-crawlerr BEGIN',
    `# cli every ${every} min; monitor ${after} min after (offset=${offset})`,
    `SHELL=/bin/bash`,
    `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    `${cliMinutes} * * * * cd ${projectRoot} && mkdir -p ${logsDir} && /usr/bin/env node src/cli.js >> ${logsDir}/cron-cli.log 2>&1`,
    `${monMinutes} * * * * cd ${projectRoot} && mkdir -p ${logsDir} && /usr/bin/env node src/debrid-monitor.js >> ${logsDir}/cron-monitor.log 2>&1`,
    '# torrent-auto-crawlerr END',
    ''
  ].join('\n');

  const next = (base + '\n' + block).replace(/\n{3,}/g, '\n\n');
  setCrontab(next);
  console.log('Installed torrent-auto-crawlerr cron block.');
  console.log(`- cli minutes: ${cliMinutes}`);
  console.log(`- monitor minutes: ${monMinutes}`);
}

main();
