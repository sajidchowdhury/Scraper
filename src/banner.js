'use strict';

/**
 * src/banner.js — Phase 1.10 — CLI Polish & DX
 *
 * Startup banner: a compact, human-readable snapshot of the *resolved*
 * configuration, printed to stdout before any browser is launched. It exists
 * so the operator gets one last chance to eyeball "what am I about to run?"
 * and Ctrl-C if something looks wrong (wrong city, dry-run off by accident,
 * --deepScrape unexpectedly on, etc.).
 *
 * Behavior:
 *   - Always printed (it's cheap and informative — even in CI it documents
 *     what ran).
 *   - Followed by a 1-second delay so a human can react. The delay is
 *     skippable with `--yes` (alias `-y`) for scripted / non-interactive runs.
 *   - The delay uses an injectable `sleep` function so tests can run
 *     synchronously without a real timer.
 *
 * Why a pure builder + a thin async shell:
 *   The banner *content* is the part that matters most (it's what the user
 *   reads and what we snapshot in tests). Splitting `buildStartupBanner`
 *   (pure string) from `showStartupBanner` (side effects: stdout + sleep)
 *   lets tests assert exact output without touching timers or stdout.
 */

const DEFAULT_DELAY_MS = 1000;

// Phase 2.4 — lazy import to summarize the resolved fingerprint for the banner
// row. Required lazily (not at module top) to keep banner.js free of any
// fingerprint module side effects during unit tests of the pure builder.
const { summarizeFingerprint } = require('./fingerprint');
// Phase 2.5 — list of stealth patch ids (for the banner row count). Required
// lazily so the pure builder is testable in isolation.
const { STEALTH_PATCHES } = require('./stealth-patches');

/**
 * Default sleep — a plain Promise-based delay. Exported so tests can stub it
 * via the `sleep` dependency of `showStartupBanner`.
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format a value for the banner's key/value table. Booleans → "yes"/"no",
 * null/undefined → "—", everything else → String(value).
 */
function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return String(v);
}

/**
 * Build the startup banner string. Pure — no side effects.
 *
 * @param {object} cfg          - Resolved config from loadConfig()
 * @param {object} [opts]
 * @param {string} [opts.name]    - Package name (default 'gmaps-scraper')
 * @param {string} [opts.version] - Package version (default '0.0.0')
 * @param {number} [opts.delayMs] - Delay that *will* be applied (default 1000).
 *                                  Included in the hint line so the user knows
 *                                  how long they have to Ctrl-C.
 * @param {boolean} [opts.delayed]- Whether the delay will actually run. When
 *                                  false (i.e. --yes), the hint line says so.
 * @returns {string}              - The full banner text (no trailing newline).
 */
function buildStartupBanner(cfg, opts = {}) {
  const name = opts.name || 'gmaps-scraper';
  const version = opts.version || '0.0.0';
  const delayMs = opts.delayMs !== undefined ? opts.delayMs : DEFAULT_DELAY_MS;
  const delayed = opts.delayed !== undefined ? opts.delayed : true;

  const rows = [
    ['Query', fmt(cfg.query)],
    ['Location', fmt(cfg.location)],
    ['Max results', fmt(cfg.maxResults === null ? 'all' : cfg.maxResults)],
    ['Output dir', fmt(cfg.outputDir)],
    ['Output file', fmt(cfg.outputFile || '(auto)')],
    ['Dry run', fmt(cfg.dryRun)],
    ['Headless', fmt(cfg.headless)],
    ['Log level', fmt(cfg.logLevel)],
    ['Deep scrape', cfg.deepScrape ? `yes (sample step ${cfg.detail.sampleStep})` : 'no'],
    ['Resume', fmt(cfg.resume)],
    ['Fresh', fmt(cfg.fresh)],
    ['Checkpoint every', `${cfg.checkpointInterval} records`],
    ['Retry', `${cfg.retry.attempts}× (base ${cfg.retry.baseMs}ms)`],
    ['Max RPM', fmt(cfg.antiblock.maxRequestsPerMin)],
    ['Human typing', fmt(cfg.antiblock.humanTyping)],
    ['CAPTCHA pause', cfg.antiblock.captchaPause ? `yes (${cfg.antiblock.captchaWaitMs}ms)` : 'no'],
    // Phase 2.3 — proxy rotation summary. Shows strategy + session length +
    // cooldown when enabled, or "disabled" when --noProxy or no source is set.
    [
      'Proxy',
      cfg.proxy && cfg.proxy.enabled
        ? `${cfg.proxy.strategy} (session ${cfg.proxy.sessionLength}, cooldown ${Math.round(cfg.proxy.cooldownMs / 1000)}s)${cfg.proxy.listFile ? ` [${cfg.proxy.listFile}]` : ''}${cfg.proxy.healthCheck ? ' +healthcheck' : ''}`
        : 'disabled (direct)',
    ],
    // Phase 2.4 — fingerprint summary. Shows the resolved profile summary when
    // a fingerprint was generated, the profile mode (random/fixed) when not yet
    // resolved (e.g. tests), or "disabled" when --noFingerprint / profile 'off'.
    [
      'Fingerprint',
      cfg.fingerprint && cfg.fingerprint.resolved
        ? `${cfg.fingerprint.profile}: ${summarizeFingerprint(cfg.fingerprint.resolved)}`
        : cfg.fingerprint && cfg.fingerprint.profile && cfg.fingerprint.profile !== 'off'
          ? `${cfg.fingerprint.profile} (not yet generated)`
          : 'disabled (Phase 1 behavior)',
    ],
    // Phase 2.5 — stealth summary. Shows patch count + debug state when enabled,
    // or "disabled" when --noStealth / profile 'off'.
    [
      'Stealth',
      cfg.stealth && cfg.stealth.profile === 'on'
        ? `on (${STEALTH_PATCHES.length} patches${cfg.stealth.debug ? ' +debug' : ''})`
        : 'disabled (Phase 1/2.4 behavior)',
    ],
    // Phase 2.6 — CAPTCHA solver summary. Shows provider + budget when a solver
    // is configured, or "none (pause+alert)" when provider is 'none' / unset
    // (Phase 1.8 behavior preserved). --noCaptchaSolve forces 'none'.
    [
      'CAPTCHA',
      cfg.captcha && cfg.captcha.provider && cfg.captcha.provider !== 'none'
        ? `${cfg.captcha.provider} (budget $${cfg.captcha.budget.toFixed(2)}${cfg.captcha.fallbackProvider ? ` +fallback ${cfg.captcha.fallbackProvider}` : ''})`
        : 'none (pause+alert)',
    ],
  ];

  const width = rows.reduce((m, [k]) => Math.max(m, k.length), 0);
  const lines = rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`);

  const hint = delayed
    ? `Starting in ${(delayMs / 1000).toFixed(1)}s — Ctrl-C to abort, --yes to skip.`
    : 'Starting immediately (--yes).';

  return [
    '========================================',
    `${name} v${version}`,
    '----------------------------------------',
    ...lines,
    '----------------------------------------',
    hint,
    '========================================',
  ].join('\n');
}

/**
 * Print the startup banner to `out` and (unless `cfg.yes`) wait `delayMs`.
 *
 * @param {object} cfg          - Resolved config (cfg.yes skips the delay).
 * @param {object} [deps]         - Injectable for tests.
 * @param {string} [deps.name]
 * @param {string} [deps.version]
 * @param {number} [deps.delayMs] - Default 1000. Set 0 to force-skip.
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {object} [deps.out]     - Writable stream (default process.stdout).
 * @returns {Promise<{ delayed: boolean, delayMs: number, banner: string }>}
 */
async function showStartupBanner(cfg, deps = {}) {
  const delayMs = deps.delayMs !== undefined ? deps.delayMs : DEFAULT_DELAY_MS;
  const sleep = deps.sleep || defaultSleep;
  const out = deps.out || process.stdout;
  const name = deps.name || 'gmaps-scraper';
  const version = deps.version || '0.0.0';

  const willDelay = !cfg.yes && delayMs > 0;
  const banner = buildStartupBanner(cfg, { name, version, delayMs, delayed: willDelay });

  out.write(banner + '\n');

  if (willDelay) {
    await sleep(delayMs);
  }
  return { delayed: willDelay, delayMs: willDelay ? delayMs : 0, banner };
}

module.exports = {
  DEFAULT_DELAY_MS,
  buildStartupBanner,
  showStartupBanner,
  defaultSleep,
  fmt,
};
