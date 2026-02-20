#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import axios from 'axios';
import { spawn } from 'node:child_process';

function isWindows() {
  return process.platform === 'win32';
}

async function exists(p) {
  return await fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

function parseEnvFile(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith('#')) continue;
    const idx = l.indexOf('=');
    if (idx === -1) continue;
    const k = l.slice(0, idx).trim();
    const v = l.slice(idx + 1); // keep raw (no trim)
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

function extractVarsFromExample(text) {
  const lines = String(text || '').split(/\r?\n/);
  const vars = [];

  for (const line of lines) {
    const trimmed = String(line).trim();
    const m = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) {
      const key = m[1];
      const def = m[2] ?? '';
      vars.push({ key, def });
    }
  }

  return vars;
}

function tFactory(lang) {
  const isPT = lang === 'pt';
  return {
    lang,
    title: isPT ? 'Assistente de configuração do .env' : '.env setup wizard',
    chooseLang: 'Choose language / Escolha o idioma:',
    langOptions: '1) Português  2) English',
    invalid: isPT ? 'Opção inválida.' : 'Invalid option.',
    foundExisting: isPT ? 'Já existe um .env. Como você quer proceder?' : 'A .env file already exists. What do you want to do?',
    existingOptions: isPT
      ? '1) Sobrescrever (recomendo se você quer refazer tudo)\n2) Atualizar (usar valores atuais como default e re-perguntar tudo)\n3) Cancelar'
      : '1) Overwrite (recommended if you want to redo everything)\n2) Update (use current values as defaults and re-ask everything)\n3) Cancel',
    cancelled: isPT ? 'Cancelado.' : 'Cancelled.',
    explainEnter: isPT
      ? 'Dica: aperte ENTER para aceitar o valor default mostrado entre [colchetes].'
      : 'Tip: press ENTER to accept the default value shown in [brackets].',
    varPrompt: isPT ? 'Valor' : 'Value',
    writing: isPT ? 'Escrevendo .env...' : 'Writing .env...',
    done: isPT ? 'Pronto! .env atualizado.' : 'Done! .env updated.',
    nextSteps: isPT
      ? 'Próximos passos: rode o CLI (ex.: node src/cli.js) e veja se conecta no Prowlarr.'
      : 'Next steps: run the CLI (e.g. node src/cli.js) and check if it can reach Prowlarr.',
    askTests: isPT ? 'Quer rodar um teste de conexão agora? (s/N)' : 'Run a connectivity test now? (y/N)',
    testing: isPT ? 'Testando conexões...' : 'Testing connectivity...',
    testOk: 'OK',
    testFail: isPT ? 'FALHOU' : 'FAILED',
    skipped: isPT ? 'pulou (não configurado)' : 'skipped (not configured)',
    askCron: isPT ? 'Quer criar o agendamento automático (cron/tasks) agora? (s/N)' : 'Create scheduled tasks (cron) now? (y/N)',
    askCronOs: isPT ? 'Qual sistema? 1) Linux (cron)  2) Windows (schtasks)' : 'Which OS? 1) Linux (cron)  2) Windows (schtasks)'
  };
}

const HELP = {
  PROWLARR_URL: {
    pt: 'URL do Prowlarr (ex.: http://localhost:9696).',
    en: 'Prowlarr base URL (e.g. http://localhost:9696).',
  },
  PROWLARR_API_KEY: {
    pt: 'API key do Prowlarr (Settings → General).',
    en: 'Prowlarr API key (Settings → General).',
  },
  REALDEBRID_URL: {
    pt: 'Base URL da API do Real-Debrid (default já funciona).',
    en: 'Real-Debrid API base URL (default should work).',
  },
  REALDEBRID_API_KEY: {
    pt: 'Token/API key do Real-Debrid.',
    en: 'Real-Debrid token/API key.',
  },
  DEBRID_VERBOSE: {
    pt: 'Logs detalhados do fluxo de debrid.',
    en: 'Verbose logging for the debrid flow.',
  },
  DEBRID_RETRY_DELAY_MS: {
    pt: 'Delay base (ms) para retry quando tomar 429 (rate limit).',
    en: 'Base retry delay (ms) on HTTP 429 rate limit.',
  },
  MIN_GIB: {
    pt: 'Tamanho mínimo (GiB) do release (filtra coisas muito pequenas).',
    en: 'Minimum release size (GiB).',
  },
  MAX_GIB: {
    pt: 'Tamanho máximo (GiB) do release.',
    en: 'Maximum release size (GiB).',
  },
  MAX_TORRENTS: {
    pt: 'Máximo de releases mantidos por filme no cache.',
    en: 'Max releases kept per movie in the cache.',
  },
  HD_ONLY: {
    pt: 'Se true, prioriza só 1080p/2160p quando existir pelo menos um HD.',
    en: 'If true, keep only 1080p/2160p releases when any exist.',
  },
  ENGLISH_TITLE_ONLY: {
    pt: 'Se true, exige que o título do release bata com o título do Letterboxd (tokens).',
    en: 'If true, require release title to match the Letterboxd title (token-based).',
  },
  EXCLUDE_TERMS: {
    pt: 'Termos para excluir do título do release (separados por vírgula).',
    en: 'Comma-separated terms to exclude from release titles.',
  },
  DEDUPE_SIZE_BUCKET_GIB: {
    pt: 'Bucket (GiB) para deduplicação por tamanho (agrupar releases muito parecidos e manter só 1).',
    en: 'Size bucket (GiB) for de-duplication (group similar releases and keep only one).',
  },
  CONCURRENCY: {
    pt: 'Quantas buscas no Prowlarr em paralelo.',
    en: 'How many Prowlarr searches in parallel.',
  },
  PROWLARR_TIMEOUT_MS: {
    pt: 'Timeout (ms) das requisições ao Prowlarr.',
    en: 'Prowlarr request timeout (ms).',
  },
  CACHE_FILE: {
    pt: 'Arquivo JSON do cache.',
    en: 'Cache JSON file.',
  },
  REWRITE_CACHE: {
    pt: 'Se true, reescreve o cache do filme mesmo se já existir.',
    en: 'If true, rewrite a movie cache entry even if it already exists.',
  },
  MAX_NEW_MOVIES_PER_RUN: {
    pt: 'Limite de filmes novos adicionados ao cache por execução.',
    en: 'Limit how many new movies can be added per run.',
  },
  LETTERBOXD_LIST_URL: {
    pt: 'URL da lista do Letterboxd (usado quando você roda o cli.js sem argumento).',
    en: 'Letterboxd list URL (used when running cli.js without args).',
  },
  EXECUTE_DEBRID: {
    pt: 'Se true, o cli.js roda o debrid-cli.js automaticamente após finalizar (manda torrents pro Real-Debrid e tenta finalizar download/import).',
    en: 'If true, cli.js runs debrid-cli.js after finishing (send torrents to Real-Debrid and try to finalize download/import).',
  },
  AUTO_DOWNLOAD: {
    pt: 'Se true, baixa automaticamente quando o torrent termina de ser cacheado no Real-Debrid.',
    en: 'If true, auto-download when the torrent finishes caching on Real-Debrid.',
  },
  AUTO_DOWNLOAD_DEST_DIR: {
    pt: 'Pasta final da sua biblioteca de filmes (destino). Se integrar com Plex, use a mesma pasta da biblioteca de Filmes do Plex.',
    en: 'Final movies library folder (destination). If integrating with Plex, use the same Movies library folder Plex is watching.',
  },
  AUTO_DOWNLOAD_STAGING_DIR: {
    pt: 'Pasta temporária de staging (fora da biblioteca do Plex). (default: staging downloads)',
    en: 'Temporary staging folder (keep outside Plex library). (default: staging downloads)',
  },
  SEVEN_ZIP_PATH: {
    pt: 'Caminho do 7z (principalmente no Windows) para extrair .rar.',
    en: 'Path to 7z binary (mainly on Windows) to extract .rar.',
  },
  DIR_NAME_MOVIE_ONLY: {
    pt: 'Se true, a pasta do filme fica só com o nome (sem ano/tmdb).',
    en: 'If true, movie folder name is only the title (no year/tmdb).',
  },
  AUTO_DOWNLOAD_REUSE_STAGING: {
    pt: 'Se true, reaproveita staging se uma execução anterior foi interrompida.',
    en: 'If true, reuse staging if a previous run was interrupted.',
  },
  PLEX_BASE_URL: {
    pt: 'Base URL do Plex (ex.: http://127.0.0.1:32400).',
    en: 'Plex base URL (e.g. http://127.0.0.1:32400).',
  },
  PLEX_TOKEN: {
    pt: 'Token do Plex.',
    en: 'Plex token.',
  },
  PLEX_SECTION_ID_FILMES: {
    pt: 'ID da biblioteca/section de Filmes no Plex (se você só tiver uma biblioteca, provavelmente será 1).',
    en: 'Plex Movies library section id (if you only have one library, it is likely 1).',
  },
  PLEX_REFRESH_AFTER_DOWNLOAD: {
    pt: 'Se true, dá refresh no Plex após o auto-download finalizar.',
    en: 'If true, refresh Plex after auto-download.',
  },
  RADARR_BASE_URL: {
    pt: 'Base URL do Radarr (ex.: http://127.0.0.1:7878). Necessário se você quer que o Bazarr baixe legendas via Radarr.',
    en: 'Radarr base URL (e.g. http://127.0.0.1:7878). Useful if you want Bazarr to fetch subtitles via Radarr.',
  },
  RADARR_API_KEY: {
    pt: 'API key do Radarr.',
    en: 'Radarr API key.',
  },
  RADARR_QUALITY_PROFILE_ID: {
    pt: 'ID do quality profile no Radarr (se você não sabe o que está fazendo, mantenha o default).',
    en: 'Radarr quality profile id (keep the default if you are not sure).',
  },
  RADARR_ROOT_FOLDER_PATH: {
    pt: 'Pasta raiz de filmes no Radarr. Se integrar com Plex, use a mesma pasta da biblioteca de Filmes do Plex.',
    en: 'Radarr root folder path. If integrating with Plex, use the same Movies library folder Plex is watching.',
  },
  RADARR_IMPORT_AFTER_DOWNLOAD: {
    pt: 'Se true, importa o filme no Radarr após baixar. Para o Bazarr baixar legendas automaticamente via Radarr, isso precisa estar true.',
    en: 'If true, import the movie into Radarr after download. If you want Bazarr to fetch subtitles via Radarr, this should be true.',
  },
  LOGS_ENABLED: {
    pt: 'Se true, grava logs diários em ./logs.',
    en: 'If true, append daily logs under ./logs.',
  },
  LOGS_RETENTION_DAYS: {
    pt: 'Quantos dias manter de logs (contando hoje).',
    en: 'How many log days to keep (counting today).',
  },
  CRON_USE_DOCKER: {
    pt: 'Se true/1, o cron/tasks chama docker compose (em vez de executar node direto).',
    en: 'If true/1, cron/tasks runs docker compose (instead of running node directly).',
  },
  CRON_CLI_EVERY_MIN: {
    pt: 'Intervalo (min) para rodar o cli.js via cron/task scheduler.',
    en: 'Interval (min) to run cli.js via cron/task scheduler.',
  },
  CRON_MONITOR_AFTER_CLI_MIN: {
    pt: 'Quantos minutos após o cli.js rodar para rodar o debrid-monitor.js.',
    en: 'How many minutes after cli.js to run debrid-monitor.js.',
  },
  OUTPUT_JSON: {
    pt: 'Se true/false, imprime um JSON mais detalhado ao final (quando suportado).',
    en: 'If true/false, print a more detailed JSON at the end (when supported).',
  }
};

function maskIfSecret(key, val) {
  const k = String(key || '').toUpperCase();
  const v = String(val ?? '');
  const looksSecret = k.includes('API_KEY') || k.includes('TOKEN') || k.includes('PASSWORD') || k.includes('SECRET');
  if (!looksSecret) return v;
  if (!v) return v;
  if (v.length <= 6) return '*'.repeat(v.length);
  return `${v.slice(0, 2)}***${v.slice(-2)}`;
}

function normalizeAnswer(ans) {
  return String(ans ?? '').trim();
}

async function testConnections({ answers, tr, logger = console }) {
  const results = [];

  const prowlarrUrl = String(answers.PROWLARR_URL || '').trim();
  const prowlarrKey = String(answers.PROWLARR_API_KEY || '').trim();
  if (prowlarrUrl && prowlarrKey) {
    try {
      const url = String(prowlarrUrl).replace(/\/+$/, '') + '/api/v1/system/status';
      await axios.get(url, { headers: { 'X-Api-Key': prowlarrKey }, timeout: 15_000 });
      results.push({ name: 'Prowlarr', ok: true });
    } catch (e) {
      results.push({ name: 'Prowlarr', ok: false, msg: String(e?.response?.status || e?.message || e) });
    }
  } else {
    results.push({ name: 'Prowlarr', skipped: true });
  }

  const rdUrl = String(answers.REALDEBRID_URL || '').trim().replace(/\/+$/, '');
  const rdKey = String(answers.REALDEBRID_API_KEY || '').trim();
  if (rdUrl && rdKey) {
    try {
      await axios.get(rdUrl + '/user', { headers: { Authorization: `Bearer ${rdKey}` }, timeout: 15_000 });
      results.push({ name: 'Real-Debrid', ok: true });
    } catch (e) {
      results.push({ name: 'Real-Debrid', ok: false, msg: String(e?.response?.status || e?.message || e) });
    }
  } else {
    results.push({ name: 'Real-Debrid', skipped: true });
  }

  const plexUrl = String(answers.PLEX_BASE_URL || '').trim().replace(/\/+$/, '');
  const plexToken = String(answers.PLEX_TOKEN || '').trim();
  if (plexUrl && plexToken) {
    try {
      await axios.get(plexUrl + '/identity', { params: { 'X-Plex-Token': plexToken }, timeout: 15_000 });
      results.push({ name: 'Plex', ok: true });
    } catch (e) {
      results.push({ name: 'Plex', ok: false, msg: String(e?.response?.status || e?.message || e) });
    }
  } else {
    results.push({ name: 'Plex', skipped: true });
  }

  const radarrUrl = String(answers.RADARR_BASE_URL || '').trim().replace(/\/+$/, '');
  const radarrKey = String(answers.RADARR_API_KEY || '').trim();
  if (radarrUrl && radarrKey) {
    try {
      await axios.get(radarrUrl + '/api/v3/system/status', { params: { apikey: radarrKey }, timeout: 15_000 });
      results.push({ name: 'Radarr', ok: true });
    } catch (e) {
      results.push({ name: 'Radarr', ok: false, msg: String(e?.response?.status || e?.message || e) });
    }
  } else {
    results.push({ name: 'Radarr', skipped: true });
  }

  logger.log('\n' + tr.testing);
  for (const r of results) {
    if (r.skipped) {
      logger.log(`- ${r.name}: ${tr.skipped}`);
    } else if (r.ok) {
      logger.log(`- ${r.name}: ${tr.testOk}`);
    } else {
      logger.log(`- ${r.name}: ${tr.testFail}${r.msg ? ` (${r.msg})` : ''}`);
    }
  }

  return results;
}

async function main() {
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const examplePath = path.join(projectRoot, '.env.example');
  const envPath = path.join(projectRoot, '.env');

  const rl = readline.createInterface({ input, output });

  try {
    output.write('\n');
    const choose = await rl.question(`$${' '}${'Choose language / Escolha o idioma:'}\n${' '}${'1) Português  2) English'}\n> `);
    const lang = String(choose || '').trim() === '1' ? 'pt' : (String(choose || '').trim() === '2' ? 'en' : 'pt');
    const tr = tFactory(lang);

    output.write(`\n${tr.title}\n`);

    if (tr.lang === 'pt') {
      output.write('Este projeto automatiza: pegar filmes de uma lista do Letterboxd, buscar releases no Prowlarr, mandar pro Real-Debrid e (opcionalmente) baixar/organizar na sua pasta de filmes, atualizar Plex e importar no Radarr.\n');
    } else {
      output.write('This project automates: reading movies from a Letterboxd list, searching releases on Prowlarr, sending to Real-Debrid and (optionally) downloading/organizing into your movies folder, refreshing Plex, and importing into Radarr.\n');
    }

    output.write(`${tr.explainEnter}\n\n`);

    if (!(await exists(examplePath))) {
      throw new Error('.env.example not found');
    }

    const exampleText = await fs.readFile(examplePath, 'utf-8');
    const vars = extractVarsFromExample(exampleText);
    if (!vars.length) {
      throw new Error('No variables found in .env.example');
    }

    let mode = 'overwrite';
    let current = {};
    if (await exists(envPath)) {
      const ans = await rl.question(`${tr.foundExisting}\n${tr.existingOptions}\n> `);
      const a = String(ans || '').trim();
      if (a === '3') {
        output.write(`${tr.cancelled}\n`);
        process.exit(0);
      }
      mode = a === '2' ? 'update' : 'overwrite';
      try {
        current = parseEnvFile(await fs.readFile(envPath, 'utf-8'));
      } catch {
        current = {};
      }
    }

    const answers = {};

    // Ask if the user will use Docker (sets CRON_USE_DOCKER default)
    {
      const q = tr.lang === 'pt'
        ? 'Você pretende usar Docker para rodar o stack (Prowlarr/Radarr/Bazarr e o crawler)?\nVantagens: não precisa instalar Node/Prowlarr/Radarr/Bazarr manualmente; tudo sobe com docker compose.\nUsar Docker? (s/N): '
        : 'Will you use Docker to run the stack (Prowlarr/Radarr/Bazarr and the crawler)?\nPros: no need to install Node/Prowlarr/Radarr/Bazarr manually; everything comes up with docker compose.\nUse Docker? (y/N): ';
      const ans = await rl.question(`\n${q}`);
      const a = String(ans || '').trim().toLowerCase();
      const yes = tr.lang === 'pt' ? (a === 's' || a === 'sim' || a === 'y' || a === 'yes') : (a === 'y' || a === 'yes' || a === 's' || a === 'sim');
      // Default: false (no)
      answers.CRON_USE_DOCKER = yes ? 'true' : 'false';
    }

    for (const v of vars) {
      const key = v.key;
      const exampleDefault = v.def ?? '';
      let defaultVal = mode === 'update' && Object.prototype.hasOwnProperty.call(current, key) ? String(current[key]) : String(exampleDefault);

      // If user answered the Docker question, use it as the default for CRON_USE_DOCKER
      if (key === 'CRON_USE_DOCKER' && typeof answers.CRON_USE_DOCKER === 'string' && answers.CRON_USE_DOCKER) {
        defaultVal = answers.CRON_USE_DOCKER;
      }

      output.write(`\n=== ${key} ===\n`);
      const help = HELP?.[key]?.[tr.lang] || '';
      if (help) {
        output.write(`${help}\n`);
      }

      // Standardized hint line: required/optional + default
      const requiredBase = (key === 'PROWLARR_API_KEY' || key === 'LETTERBOXD_LIST_URL');
      const hintStatus = tr.lang === 'pt' ? (requiredBase ? 'Obrigatório' : 'Opcional') : (requiredBase ? 'Required' : 'Optional');
      const hintDefault = maskIfSecret(key, defaultVal);
      if (tr.lang === 'pt') {
        output.write(`Status: ${hintStatus}. Default: ${hintDefault || '(vazio)'}\n`);
      } else {
        output.write(`Status: ${hintStatus}. Default: ${hintDefault || '(empty)'}\n`);
      }

      const shown = maskIfSecret(key, defaultVal);
      const q = `${tr.varPrompt} [${shown}]: `;
      const raw = await rl.question(q);
      const a = normalizeAnswer(raw);
      answers[key] = a ? a : defaultVal;
    }

    // Conditional required fields (based on chosen feature flags)
    const isTrue = (v) => v === '1' || String(v || '').toLowerCase() === 'true';
    const isBlank = (v) => {
      const s = String(v ?? '').trim();
      return !s || s === '""' || s === "''";
    };

    const requireKeys = new Map();
    requireKeys.set('PROWLARR_API_KEY', tr.lang === 'pt' ? 'sempre necessário para buscar no Prowlarr' : 'always required to query Prowlarr');
    requireKeys.set('LETTERBOXD_LIST_URL', tr.lang === 'pt' ? 'necessário para o projeto saber qual lista do Letterboxd usar' : 'required so the project knows which Letterboxd list to use');

    const executeDebrid = isTrue(answers.EXECUTE_DEBRID);
    const autoDownload = isTrue(answers.AUTO_DOWNLOAD);
    const plexRefresh = isTrue(answers.PLEX_REFRESH_AFTER_DOWNLOAD);
    const radarrImport = isTrue(answers.RADARR_IMPORT_AFTER_DOWNLOAD);

    if (executeDebrid || autoDownload) {
      requireKeys.set('REALDEBRID_URL', tr.lang === 'pt' ? 'necessário porque você habilitou debrid/auto-download' : 'required because debrid/auto-download is enabled');
      requireKeys.set('REALDEBRID_API_KEY', tr.lang === 'pt' ? 'necessário porque você habilitou debrid/auto-download' : 'required because debrid/auto-download is enabled');
    }

    if (autoDownload) {
      requireKeys.set('AUTO_DOWNLOAD_DEST_DIR', tr.lang === 'pt' ? 'necessário porque AUTO_DOWNLOAD=true' : 'required because AUTO_DOWNLOAD=true');
    }

    if (plexRefresh) {
      requireKeys.set('PLEX_BASE_URL', tr.lang === 'pt' ? 'necessário porque PLEX_REFRESH_AFTER_DOWNLOAD=true' : 'required because PLEX_REFRESH_AFTER_DOWNLOAD=true');
      requireKeys.set('PLEX_TOKEN', tr.lang === 'pt' ? 'necessário porque PLEX_REFRESH_AFTER_DOWNLOAD=true' : 'required because PLEX_REFRESH_AFTER_DOWNLOAD=true');
      requireKeys.set('PLEX_SECTION_ID_FILMES', tr.lang === 'pt' ? 'necessário porque PLEX_REFRESH_AFTER_DOWNLOAD=true' : 'required because PLEX_REFRESH_AFTER_DOWNLOAD=true');
    }

    if (radarrImport) {
      requireKeys.set('RADARR_BASE_URL', tr.lang === 'pt' ? 'necessário porque RADARR_IMPORT_AFTER_DOWNLOAD=true' : 'required because RADARR_IMPORT_AFTER_DOWNLOAD=true');
      requireKeys.set('RADARR_API_KEY', tr.lang === 'pt' ? 'necessário porque RADARR_IMPORT_AFTER_DOWNLOAD=true' : 'required because RADARR_IMPORT_AFTER_DOWNLOAD=true');
      requireKeys.set('RADARR_ROOT_FOLDER_PATH', tr.lang === 'pt' ? 'necessário porque RADARR_IMPORT_AFTER_DOWNLOAD=true' : 'required because RADARR_IMPORT_AFTER_DOWNLOAD=true');
      requireKeys.set('RADARR_QUALITY_PROFILE_ID', tr.lang === 'pt' ? 'necessário porque RADARR_IMPORT_AFTER_DOWNLOAD=true' : 'required because RADARR_IMPORT_AFTER_DOWNLOAD=true');
    }

    for (const [k, because] of requireKeys.entries()) {
      while (isBlank(answers[k])) {
        output.write(`\n${tr.lang === 'pt' ? 'Campo obrigatório' : 'Required field'}: ${k} (${because})\n`);
        const help = HELP?.[k]?.[tr.lang] || '';
        if (help) output.write(`${help}\n`);
        const raw = await rl.question(`${tr.varPrompt} []: `);
        const a = normalizeAnswer(raw);
        if (a) answers[k] = a;
      }
    }

    const headerLines = [
      '# Local configuration',
      '#',
      '# Generated by: node scripts/setup-env.js',
      `# Platform: ${isWindows() ? 'windows' : process.platform}`,
      '#',
      '# NOTE: This file may contain secrets. Do not commit it.',
      ''
    ];

    const outLines = [...headerLines];
    for (const v of vars) {
      outLines.push(`${v.key}=${answers[v.key] ?? ''}`);
    }
    outLines.push('');

    output.write(`\n${tr.writing}\n`);
    const tmp = `${envPath}.tmp`;
    await fs.writeFile(tmp, outLines.join('\n'), 'utf-8');
    await fs.rename(tmp, envPath);

    output.write(`${tr.done}\n${tr.nextSteps}\n`);

    const testAns = await rl.question(`\n${tr.askTests} `);
    const a = String(testAns || '').trim().toLowerCase();
    const yes = tr.lang === 'pt' ? (a === 's' || a === 'sim' || a === 'y' || a === 'yes') : (a === 'y' || a === 'yes' || a === 's' || a === 'sim');
    if (yes) {
      await testConnections({ answers, tr, logger: console });
    }

    const cronAns = await rl.question(`\n${tr.askCron} `);
    const ca = String(cronAns || '').trim().toLowerCase();
    const cronYes = tr.lang === 'pt' ? (ca === 's' || ca === 'sim' || ca === 'y' || ca === 'yes') : (ca === 'y' || ca === 'yes' || ca === 's' || ca === 'sim');
    if (cronYes) {
      const osAns = await rl.question(`${tr.askCronOs}\n> `);
      const os = String(osAns || '').trim();
      const script = os === '2' ? './cron-windows.js' : './cron-linux.js';
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [new URL(script, import.meta.url).pathname], { stdio: 'inherit', env: { ...process.env, ...answers } });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`cron script exited ${code}`))));
      });
    }
  } finally {
    rl.close();
  }
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
