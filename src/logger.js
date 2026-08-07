'use strict';

/**
 * src/logger.js — Phase 1.9 (minimal version for Phase 1.4)
 *
 * Dual-sink logger:
 *   - Console: colorized, human-readable
 *   - File: JSON lines at logs/{query}_{location}_{timestamp}.log
 *
 * Levels: debug < info < warn < error
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};

function ts() {
  return new Date().toISOString();
}

function sanitizeName(s) {
  return String(s || 'run').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function createLogger({ level = 'info', query = 'run', location = 'loc', logDir = './logs' } = {}) {
  const minLevel = LEVELS[level] ?? LEVELS.info;

  let fileStream = null;
  try {
    fs.mkdirSync(path.resolve(logDir), { recursive: true });
    const file = path.join(logDir, `${sanitizeName(query)}_${sanitizeName(location)}_${stamp()}.log`);
    fileStream = fs.createWriteStream(file, { flags: 'a' });
    fileStream.on('error', () => {
      /* swallow — file logging is best-effort */
    });
  } catch {
    /* best-effort */
  }

  function log(levelName, msg, ctx = {}) {
    if (LEVELS[levelName] < minLevel) return;
    const line = `[${ts()}] ${levelName.toUpperCase().padEnd(5)} ${msg}`;
    // console
    const color = COLORS[levelName] || '';
    // eslint-disable-next-line no-console
    console.log(`${color}${line}${COLORS.reset}`);
    // file (JSON lines)
    if (fileStream) {
      fileStream.write(JSON.stringify({ ts: ts(), level: levelName, msg, ...ctx }) + '\n');
    }
  }

  return {
    debug: (m, c) => log('debug', m, c),
    info: (m, c) => log('info', m, c),
    warn: (m, c) => log('warn', m, c),
    error: (m, c) => log('error', m, c),
    child: (extra) => ({
      debug: (m, c) => log('debug', m, { ...extra, ...c }),
      info: (m, c) => log('info', m, { ...extra, ...c }),
      warn: (m, c) => log('warn', m, { ...extra, ...c }),
      error: (m, c) => log('error', m, { ...extra, ...c }),
    }),
    close: () => {
      if (fileStream) fileStream.end();
    },
  };
}

module.exports = { createLogger, LEVELS };
