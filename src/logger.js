/**
 * Minimal structured logger.
 *
 * Phase 1.0: thin console wrapper with timestamps + levels.
 * Phase 1.9 (TODO): replace with dual-sink (console + JSON-lines file) logging
 *                   via winston/pino, with per-phase contextual fields.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_NAMES = Object.keys(LEVELS);

function resolveLevel(name) {
  const key = String(name || '').toLowerCase();
  return LEVELS[key] != null ? LEVELS[key] : LEVELS.info;
}

const currentLevel = resolveLevel(process.env.LOG_LEVEL);

function timestamp() {
  return new Date().toISOString();
}

function format(level, message, meta) {
  const base = `[${timestamp()}] [${level.toUpperCase()}] ${message}`;
  if (!meta) return base;
  try {
    return `${base} ${JSON.stringify(meta)}`;
  } catch {
    return `${base} [unserializable meta]`;
  }
}

const logger = {
  level: currentLevel,
  debug(msg, meta) {
    if (currentLevel <= LEVELS.debug) console.debug(format('debug', msg, meta));
  },
  info(msg, meta) {
    if (currentLevel <= LEVELS.info) console.log(format('info', msg, meta));
  },
  warn(msg, meta) {
    if (currentLevel <= LEVELS.warn) console.warn(format('warn', msg, meta));
  },
  error(msg, meta) {
    if (currentLevel <= LEVELS.error) console.error(format('error', msg, meta));
  },
  /** Returns the list of valid level names (used by --help in Phase 1.10). */
  getLevelNames() {
    return LEVEL_NAMES.slice();
  },
};

module.exports = logger;
