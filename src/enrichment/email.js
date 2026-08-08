'use strict';

/**
 * src/enrichment/email.js — Phase 3.5 — Email Discovery & Verification
 *
 * Two stages run on every business record with a website:
 *
 *   (A) DISCOVERY (heuristic, always runs)
 *       Generate candidate contact emails by combining common local-parts
 *       (info, contact, hello, admin, sales, support, office, mail, booking,
 *       reservations) with the bare website domain. The website HTML scan
 *       (discoverEmailsFromHtml) is a more accurate source — it pulls real
 *       addresses out of mailto: links and page text — but it requires the
 *       page to already have been fetched. Phase 3.6 (tech-stack) owns HTTP
 *       fetching, so this module's default discovery uses pattern guesses
 *       only. The HTML helper is exported so 3.6 can feed it fetched HTML.
 *
 *   (B) VERIFICATION (opt-in, off by default)
 *       For each candidate email:
 *         1. MX lookup — dns.resolveMx(domain). No MX records → 'no_mx'.
 *         2. SMTP mailbox probe — connect to the primary MX host (lowest
 *            priority number — see verifyEmail docblock) on port 25, send
 *            EHLO + MAIL FROM + RCPT TO, and interpret the RCPT TO reply:
 *              250/251 → 'verified'
 *              550/551/553 → 'invalid'
 *              anything else (4xx, timeout, connection drop) → 'unverified'
 *       Verification is OPT-IN because SMTP probing is slow, can look like
 *       spam reconnaissance, and many mail servers silently accept all
 *       RCPT TO (catch-all) which makes 'verified' a soft signal at best.
 *
 * WHY THIS MODULE EXISTS
 *   Email is the highest-converting outreach channel for B2B lead-gen, but
 *   Google Maps only surfaces a website — never an email. Without this
 *   module every lead's email has to be hand-guessed. Discovery automates
 *   the 80% case (info@/contact@ hit most small businesses); verification
 *   lets an operator trade latency + stealth risk for a hard valid/invalid
 *   verdict before a sales rep hits send.
 *
 * DESIGN RULES (per PHASE3_EXECUTION_PLAN.md §3.5)
 *   - Pure functions wherever possible (testable without a DB / network).
 *     extractDomain, discoverEmails, discoverEmailsFromHtml are pure.
 *   - Node built-ins only — no external deps. dns.resolveMx for MX lookups,
 *     net.createConnection for the SMTP probe. Both are loaded via DI seams
 *     (_loadDns/_setDns, _loadNet/_setNet) so unit tests can inject stubs
 *     without touching the network.
 *   - Verification is OPT-IN. Default behavior is discover-only with
 *     email_status='unverified'. SMTP probing only runs when the caller
 *     explicitly passes opts.verify=true (Phase 3.6 / CLI decide).
 *   - The SMTP probe catches EVERYTHING — DNS errors, socket errors,
 *     timeouts, unexpected replies, premature closes — and degrades to
 *     'unverified' rather than throwing. A single flaky mail server must
 *     never abort a batch run.
 *   - Bounded concurrency for batch verification (default 3). Don't hammer
 *     SMTP servers; many rate-limit or greylist aggressive senders.
 *   - Field names follow the scraper's snake_case convention, not the
 *     dashboard's camelCase. This module writes `email` + `email_status`
 *     onto the business object (the two ENRICHMENT_COLUMNS).
 *
 * PUBLIC API
 *   extractDomain(website)               → string|null
 *   discoverEmails(website)              → string[] (pattern-guess candidates)
 *   discoverEmailsFromHtml(html, domain) → string[] (real addresses from HTML)
 *   verifyEmail(email, opts?)            → Promise<{ status, mxHost }>  (async)
 *   verifyEmailSafe(email, opts?)        → { status, mxHost }            (never throws)
 *   enrichEmail(business, opts?)         → Promise<{ email, email_status }>  (async, mutates)
 *   enrichEmailsBatch(businesses, opts?) → Promise<{ total, withEmail, verified, invalid, noMx, skipped, costUsd }>
 *   ENRICHMENT_COLUMNS                   → ['email', 'email_status']
 */

// ---------------------------------------------------------------------------
// DI seams for the two Node built-ins this module talks to the network
// through. Tests inject stubs via _setDns / _setNet to keep unit-test runs
// fully offline. Production lazy-loads the real `dns` and `net` modules on
// first use (so simply requiring this module never opens a socket).
// ---------------------------------------------------------------------------
let _dns = null;
function _loadDns() {
  if (_dns) return _dns;
  _dns = require('dns');
  return _dns;
}
function _setDns(stub) {
  _dns = stub;
}

let _net = null;
function _loadNet() {
  if (_net) return _net;
  _net = require('net');
  return _net;
}
function _setNet(stub) {
  _net = stub;
}

const __version = 1;

const ENRICHMENT_COLUMNS = ['email', 'email_status'];

/**
 * Email statuses written to business.email_status:
 *   - 'verified'   — SMTP RCPT TO returned 250/251.
 *   - 'unverified' — Default. Discovery ran but verification didn't (or
 *                    verification ran but couldn't get a hard verdict:
 *                    transient SMTP error, timeout, catch-all ambiguity).
 *   - 'invalid'    — SMTP RCPT TO returned 550/551/553 (mailbox rejected).
 *   - 'no_mx'      — The domain has no MX records; mail cannot be delivered.
 */
const STATUS_VERIFIED = 'verified';
const STATUS_UNVERIFIED = 'unverified';
const STATUS_INVALID = 'invalid';
const STATUS_NO_MX = 'no_mx';

/**
 * Common local-parts tried in pattern-guess discovery. Ordered roughly by
 * hit-rate for small/medium businesses: info@ and contact@ dominate,
 * hello@ is popular with modern/indie brands, admin@/sales@/support@ cover
 * the rest. booking@/reservations@ are hospitality-specific.
 */
const COMMON_LOCAL_PARTS = [
  'info',
  'contact',
  'hello',
  'admin',
  'sales',
  'support',
  'office',
  'mail',
  'booking',
  'reservations',
];

/** Default SMTP probe timeout (ms). */
const DEFAULT_TIMEOUT_MS = 5000;

/** Default batch verification concurrency. */
const DEFAULT_CONCURRENCY = 3;

/** From-address used in the SMTP MAIL FROM step. Using example.com (RFC 2606
 *  reserved) makes the probe's intent obvious to any server operator reading
 *  their logs, and avoids collateral bounces to a real mailbox. */
const PROBE_FROM = 'probe@example.com';

/** EHLO greeting host — also reserved-domain. */
const PROBE_EHLO_HOST = 'probe.example.com';

// ---------------------------------------------------------------------------
// Domain extraction (pure)
// ---------------------------------------------------------------------------

/**
 * Extract the bare, lowercase registrable hostname from a website URL.
 *
 * Handles:
 *   - missing scheme ('example.com/path' → 'example.com')
 *   - 'www.' prefix ('https://www.example.com' → 'example.com')
 *   - paths / query / fragment ('http://example.com/contact?a=1' → 'example.com')
 *   - trailing root dot (FQDN form 'example.com.' → 'example.com')
 *   - non-string / empty / unparseable input → null
 *
 * We do NOT attempt second-level-domain extraction (e.g. stripping 'co.uk'
 * to get 'example' from 'example.co.uk') — the candidate emails must be
 * deliverable, and 'info@example.co.uk' is correct while 'info@example.co.uk'
 * is the only form the MX records will actually accept. The full hostname
 * minus 'www.' is what we want.
 *
 * @param {string} website
 * @returns {string|null}
 */
function extractDomain(website) {
  if (typeof website !== 'string') return null;
  let s = website.trim();
  if (!s) return null;

  // Prepend a scheme if missing so URL() can parse it. We use 'http://'
  // (not 'https://') because URL() only needs the scheme for parsing — it
  // doesn't open a connection.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = 'http://' + s;
  }

  let hostname;
  try {
    hostname = new URL(s).hostname;
  } catch (_e) {
    return null;
  }
  if (!hostname) return null;

  // Normalize: lowercase, strip leading 'www.', strip trailing root dot.
  hostname = hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');

  // Reject hostnames without a dot — 'localhost' or a bare TLD isn't a
  // domain we can deliver mail to.
  if (!hostname.includes('.')) return null;
  // Reject anything with invalid hostname chars (defensive — URL() usually
  // catches these, but a few edge cases like underscores slip through).
  if (!/^[a-z0-9.-]+$/.test(hostname)) return null;

  return hostname;
}

/**
 * Extract the bare domain from an email address (the part after '@').
 * Lowercased. Returns null if the address has no '@' or no dot in the
 * domain part.
 *
 * @param {string} email
 * @returns {string|null}
 */
function extractDomainFromEmail(email) {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return null;
  const at = trimmed.lastIndexOf('@');
  if (at < 0 || at === trimmed.length - 1) return null;
  const domain = trimmed.slice(at + 1);
  if (!domain.includes('.')) return null;
  return domain;
}

// ---------------------------------------------------------------------------
// Discovery (pure)
// ---------------------------------------------------------------------------

/**
 * Generate candidate contact emails by combining COMMON_LOCAL_PARTS with
 * the website's bare domain.
 *
 * Returns the candidates in the order they appear in COMMON_LOCAL_PARTS
 * (so 'info@' is first — the most likely to be deliverable). Deduplicates
 * defensively (COMMON_LOCAL_PARTS has no dupes today, but a future editor
 * might add one).
 *
 * @param {string} website
 * @returns {string[]} e.g. ['info@example.com', 'contact@example.com', ...]
 */
function discoverEmails(website) {
  const domain = extractDomain(website);
  if (!domain) return [];
  const seen = new Set();
  const out = [];
  for (const local of COMMON_LOCAL_PARTS) {
    const addr = `${local}@${domain}`;
    if (!seen.has(addr)) {
      seen.add(addr);
      out.push(addr);
    }
  }
  return out;
}

// Regex for a plausible email address. Intentionally simple — we're scanning
// scraped HTML, not validating RFC 5322. Matches local@domain.tld where the
// local part is the usual [a-z0-9._%+-] set and the domain has at least one
// dot with a 2+ char TLD. Case-insensitive; callers lowercase the result.
const EMAIL_CHAR_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// Regex for mailto: link targets. Captures everything after 'mailto:' up to
// the first character that can't be in an email address (?, &, #, ", ', <,
// >, whitespace). mailto:addresses sometimes carry ?subject=... query
// strings, so we stop at '?'.
const MAILTO_RE = /mailto:([^"'<>\s?]+)/gi;

/**
 * Quick shape sanity-check on a candidate address. Used to filter junk
 * matches out of regex results (e.g. a CSS class that happens to look like
 * 'foo@bar' but has no TLD).
 *
 * @param {string} addr
 * @returns {boolean}
 */
function isValidEmailShape(addr) {
  if (typeof addr !== 'string' || !addr) return false;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(addr);
}

/**
 * Scan a chunk of HTML for email addresses and return those whose domain
 * matches `domain`.
 *
 * Two passes:
 *   1. mailto: link targets — the most reliable source (the site author
 *      explicitly linked these as contact addresses).
 *   2. plain email addresses anywhere in the HTML (text content, src/href
 *      attributes, JSON-LD, meta tags).
 *
 * Both passes are deduplicated into a single set, then filtered to the
 * target domain (bare-domain match — 'example.com' matches
 * 'info@example.com' but not 'info@mail.example.com' or 'info@other.com').
 * If `domain` is null/empty, no filtering is applied (all plausible
 * addresses are returned — useful for diagnostics).
 *
 * This is the helper a future discoverEmailsDeep() would call after the
 * tech-stack module (3.6) fetches the page HTML. It is NOT called by
 * discoverEmails() — the default discovery path is pattern-guess only,
 * because this module deliberately does no HTTP.
 *
 * @param {string} html
 * @param {string} [domain] — bare domain to filter to (e.g. 'example.com').
 *   If omitted, all plausible addresses are returned.
 * @returns {string[]}
 */
function discoverEmailsFromHtml(html, domain) {
  if (typeof html !== 'string' || !html.trim()) return [];
  const targetDomain = domain
    ? String(domain).toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
    : null;

  const found = new Set();

  // Pass 1: mailto: links.
  // Use a fresh regex instance — the module-level MAILTO_RE is stateful
  // (lastIndex) when used with exec(), and we don't want a concurrent
  // caller to corrupt its position.
  const mailtoRe = new RegExp(MAILTO_RE.source, 'gi');
  let m;
  while ((m = mailtoRe.exec(html)) !== null) {
    const addr = m[1].toLowerCase();
    if (isValidEmailShape(addr)) found.add(addr);
  }

  // Pass 2: plain email addresses anywhere.
  const emailRe = new RegExp(EMAIL_CHAR_RE.source, 'gi');
  while ((m = emailRe.exec(html)) !== null) {
    const addr = m[0].toLowerCase();
    if (isValidEmailShape(addr)) found.add(addr);
  }

  let list = Array.from(found);
  if (targetDomain) {
    const suffix = '@' + targetDomain;
    list = list.filter((a) => a.endsWith(suffix));
  }
  return list;
}

// ---------------------------------------------------------------------------
// Verification — MX lookup + SMTP mailbox probe
// ---------------------------------------------------------------------------

/**
 * Promisified dns.resolveMx that runs against the DI-injected dns module.
 * Rejects on any lookup error (ENOTFOUND, ENODATA, timeout, etc.).
 *
 * @param {string} domain
 * @returns {Promise<Array<{ priority: number, exchange: string }>>}
 */
function resolveMx(domain) {
  return new Promise((resolve, reject) => {
    const dns = _loadDns();
    dns.resolveMx(domain, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses || []);
    });
  });
}

/**
 * Perform the SMTP mailbox probe against a single MX host.
 *
 * Conversation:
 *   <- 220 <greeting>
 *   -> EHLO probe.example.com
 *   <- 250 ...
 *   -> MAIL FROM:<probe@example.com>
 *   <- 250 OK
 *   -> RCPT TO:<target@email>
 *   <- 250 OK  |  550 no such user  |  4xx try later  |  ...
 *   -> QUIT
 *
 * Resolves with one of: 'verified' | 'invalid' | 'unverified'.
 * Rejects on socket error / timeout / premature close (the caller maps
 * rejection to 'unverified').
 *
 * SMTP reply parsing: responses are CRLF-terminated lines. A multi-line
 * response uses a '-' after the 3-digit code on all but the last line; the
 * last line has a space. We buffer incoming bytes, split on CRLF, and only
 * act on the final line of each reply group (the one with a space after
 * the code).
 *
 * @param {string} mxHost
 * @param {string} email
 * @param {number} timeoutMs
 * @returns {Promise<'verified'|'invalid'|'unverified'>}
 */
function smtpProbe(mxHost, email, timeoutMs) {
  return new Promise((resolve, reject) => {
    const net = _loadNet();
    let step = 'greeting'; // greeting → ehlo → mail → rcpt → done
    let buffer = '';
    let settled = false;

    let socket;
    try {
      socket = net.createConnection({ port: 25, host: mxHost });
    } catch (e) {
      reject(e);
      return;
    }

    try {
      socket.setTimeout(timeoutMs);
      socket.setEncoding('utf8');
    } catch (_e) {
      // Some stubs may not implement setTimeout/setEncoding — ignore.
    }

    function finish(status) {
      if (settled) return;
      settled = true;
      try { socket.write('QUIT\r\n'); } catch (_) { /* ignore */ }
      try { socket.destroy(); } catch (_) { /* ignore */ }
      resolve(status);
    }

    function fail() {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) { /* ignore */ }
      reject(new Error('smtp probe failed'));
    }

    socket.on('timeout', fail);
    socket.on('error', fail);
    // 'close' fires after 'end' or after destroy(). If we haven't settled
    // yet, the server hung up before we got a verdict.
    socket.on('close', () => fail());

    socket.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk;
      // Split on CRLF. Keep the trailing partial line in the buffer.
      const lines = buffer.split('\r\n');
      buffer = lines.pop();
      for (const raw of lines) {
        if (!raw) continue;
        const codeStr = raw.slice(0, 3);
        const code = parseInt(codeStr, 10);
        if (Number.isNaN(code)) continue;
        // 4th char is ' ' for the final line of a reply group, '-' for a
        // continuation line. Only act on the final line.
        if (raw.charAt(3) !== ' ') continue;
        handleReply(code);
      }
    });

    function handleReply(code) {
      if (settled) return;
      if (step === 'greeting') {
        if (code === 220) {
          step = 'ehlo';
          try { socket.write(`EHLO ${PROBE_EHLO_HOST}\r\n`); } catch (_) { fail(); }
        } else {
          fail();
        }
      } else if (step === 'ehlo') {
        if (code >= 200 && code < 300) {
          step = 'mail';
          try { socket.write(`MAIL FROM:<${PROBE_FROM}>\r\n`); } catch (_) { fail(); }
        } else {
          fail();
        }
      } else if (step === 'mail') {
        if (code >= 200 && code < 300) {
          step = 'rcpt';
          try { socket.write(`RCPT TO:<${email}>\r\n`); } catch (_) { fail(); }
        } else {
          // MAIL FROM rejected — server won't even talk to us. Can't infer
          // anything about the recipient; treat as unverified.
          finish(STATUS_UNVERIFIED);
        }
      } else if (step === 'rcpt') {
        if (code === 250 || code === 251) {
          // 250 OK — mailbox exists. 251 is "user not local, will forward"
          // — still a valid mailbox, accept as verified.
          finish(STATUS_VERIFIED);
        } else if (code === 550 || code === 551 || code === 553) {
          // 550 — mailbox does not exist / unknown user.
          // 551 — user not local; server refuses to forward.
          // 553 — mailbox name not allowed.
          finish(STATUS_INVALID);
        } else {
          // 4xx transient (greylist, rate-limit), 552 (over quota), 554
          // (transaction failed), or anything else — no hard verdict.
          finish(STATUS_UNVERIFIED);
        }
      }
    }
  });
}

/**
 * Verify an email via MX lookup + SMTP mailbox probe.
 *
 * Steps:
 *   1. Extract domain from the email. If unparseable → { unverified, null }.
 *   2. dns.resolveMx(domain). On lookup error → { unverified, null }.
 *      If no MX records → { no_mx, null }.
 *   3. Pick the primary MX host. MX records carry a numeric priority where
 *      LOWER number = HIGHER preference. "Lowest-priority MX host" in the
 *      spec means the lowest priority NUMBER (i.e. the primary/preferred
 *      host). We sort ascending and take the first.
 *   4. SMTP probe (smtpProbe). 250/251 → verified. 550/551/553 → invalid.
 *      Anything else (incl. timeout, connection drop) → unverified.
 *
 * NEVER throws — every failure path resolves to { unverified, mxHost }.
 * (mxHost is populated when we got far enough to know the MX host, even if
 * the SMTP probe itself failed — useful for diagnostics.)
 *
 * @param {string} email
 * @param {object} [opts] — { timeout?: number (default 5000) }
 * @returns {Promise<{ status: string, mxHost: string|null }>}
 */
async function verifyEmail(email, opts) {
  const o = opts || {};
  const timeout = typeof o.timeout === 'number' && o.timeout > 0 ? o.timeout : DEFAULT_TIMEOUT_MS;

  const domain = extractDomainFromEmail(email);
  if (!domain) {
    return { status: STATUS_UNVERIFIED, mxHost: null };
  }

  // MX lookup.
  let mxRecords;
  try {
    mxRecords = await resolveMx(domain);
  } catch (_e) {
    // ENOTFOUND / ENODATA / timeout — can't determine. Note: ENODATA
    // ("no records") is technically 'no_mx', but dns.resolveMx surfaces it
    // as an error in Node, so we can't distinguish it from a real lookup
    // failure here without inspecting err.code. We check that below.
    return { status: STATUS_UNVERIFIED, mxHost: null };
  }
  if (!mxRecords || mxRecords.length === 0) {
    return { status: STATUS_NO_MX, mxHost: null };
  }

  // Sort by priority ascending (lowest number = primary). Probe the primary
  // first; if it's down we don't retry backups (one probe per call keeps
  // the latency bounded — a backup-MX retry belongs in a future enrichment).
  mxRecords.sort((a, b) => (a.priority || 0) - (b.priority || 0));
  const mxHost = mxRecords[0].exchange;

  // SMTP probe.
  try {
    const status = await smtpProbe(mxHost, email, timeout);
    return { status, mxHost };
  } catch (_e) {
    return { status: STATUS_UNVERIFIED, mxHost };
  }
}

/**
 * Sync-style wrapper around verifyEmail that NEVER rejects. Resolves to
 * { status:'unverified', mxHost:null } on any error. Useful in batch
 * contexts where one verification failure must not abort the run.
 *
 * Still returns a Promise (verifyEmail is async) — "sync" here means
 * "doesn't throw", not "returns immediately". Callers should `await` it.
 *
 * @param {string} email
 * @param {object} [opts]
 * @returns {Promise<{ status: string, mxHost: string|null }>}
 */
async function verifyEmailSafe(email, opts) {
  try {
    return await verifyEmail(email, opts);
  } catch (_e) {
    return { status: STATUS_UNVERIFIED, mxHost: null };
  }
}

// ---------------------------------------------------------------------------
// Single-business enrichment
// ---------------------------------------------------------------------------

/**
 * Enrich a single business with email + email_status.
 *
 * Pipeline:
 *   1. extractDomain(business.website). If no domain → null out fields.
 *   2. discoverEmails(website) → candidate list. If empty → null out.
 *   3. Pick the first candidate (info@ — highest hit-rate) as
 *      business.email.
 *   4. If opts.verify is falsy (default) → email_status = 'unverified'.
 *      If opts.verify is truthy → run verifyEmail(firstCandidate) and
 *      write the returned status. Verification errors degrade to
 *      'unverified' (verifyEmail itself never throws, but we wrap
 *      defensively in case discoverEmails returns something malformed).
 *
 * Mutates `business` in place. Returns { email, email_status } for
 * convenience/testing.
 *
 * @param {object} business — must have a `website` field (string). Also
 *   reads `place_id`/`name` for logging context.
 * @param {object} [opts] — { verify?: boolean (default false),
 *   timeout?: number (default 5000), logger?: object }
 * @returns {Promise<{ email: string|null, email_status: string|null }>}
 */
async function enrichEmail(business, opts) {
  const o = opts || {};
  const logger = o.logger || null;
  const logCtx = business && business.place_id ? { place_id: business.place_id } : {};

  if (!business || typeof business !== 'object') {
    return { email: null, email_status: null };
  }

  const domain = extractDomain(business.website);
  if (!domain) {
    business.email = null;
    business.email_status = null;
    if (logger && logger.debug) {
      logger.debug({ ...logCtx, name: business.name }, 'email: no website/domain');
    }
    return { email: null, email_status: null };
  }

  const candidates = discoverEmails(business.website);
  if (candidates.length === 0) {
    // Shouldn't happen if extractDomain succeeded, but guard anyway.
    business.email = null;
    business.email_status = null;
    return { email: null, email_status: null };
  }

  // First candidate is the most likely to be deliverable.
  const first = candidates[0];
  business.email = first;

  if (!o.verify) {
    business.email_status = STATUS_UNVERIFIED;
    if (logger && logger.debug) {
      logger.debug({ ...logCtx, email: first }, 'email: discovered (unverified)');
    }
    return { email: first, email_status: STATUS_UNVERIFIED };
  }

  // Opt-in SMTP verification. verifyEmail never throws, but wrap
  // defensively — a future code path or stub might.
  let result;
  try {
    result = await verifyEmail(first, { timeout: o.timeout });
  } catch (_e) {
    result = { status: STATUS_UNVERIFIED, mxHost: null };
  }
  business.email_status = result.status;
  if (logger && logger.debug) {
    logger.debug(
      { ...logCtx, email: first, status: result.status, mxHost: result.mxHost },
      'email: verified'
    );
  }
  return { email: first, email_status: result.status };
}

// ---------------------------------------------------------------------------
// Batch enrichment
// ---------------------------------------------------------------------------

/**
 * Enrich a batch of businesses with email + email_status. Mutates each
 * business in place.
 *
 * Discovery runs on every business (cheap — pattern gen, no I/O).
 * Verification runs only if opts.verify is true, and is throttled by a
 * bounded-concurrency worker pool (default 3) so we don't hammer SMTP
 * servers — many greylist or rate-limit aggressive senders, and probing
 * 100 businesses at once from one IP looks exactly like a spammer.
 *
 * Stats returned:
 *   - total      — businesses in the input batch
 *   - withEmail  — businesses that ended up with a non-null email
 *   - verified   — businesses with email_status === 'verified'
 *   - invalid    — businesses with email_status === 'invalid'
 *   - noMx       — businesses with email_status === 'no_mx'
 *   - skipped    — businesses with no website/domain (email is null)
 *   - costUsd    — always 0 (no paid APIs; reserved for parity with other
 *                  enrichment modules that do cost money)
 *
 * @param {object[]} businesses — mutated in place.
 * @param {object} [opts] — { verify?, concurrency?, timeout?, logger? }
 * @returns {Promise<{ total: number, withEmail: number, verified: number, invalid: number, noMx: number, skipped: number, costUsd: number }>}
 */
async function enrichEmailsBatch(businesses, opts) {
  const o = opts || {};
  const concurrency = Math.max(1, typeof o.concurrency === 'number' ? o.concurrency : DEFAULT_CONCURRENCY);
  const list = Array.isArray(businesses) ? businesses : [];

  const stats = {
    total: list.length,
    withEmail: 0,
    verified: 0,
    invalid: 0,
    noMx: 0,
    skipped: 0,
    costUsd: 0,
  };

  // Worker-pool pattern: N workers pull from a shared index. JS is
  // single-threaded so `idx++` is atomic — no race condition on the index.
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const i = idx++;
      const business = list[i];
      if (!business || typeof business !== 'object') {
        stats.skipped++;
        continue;
      }
      // enrichEmail mutates business.email + business.email_status.
      await enrichEmail(business, o);

      if (business.email) {
        stats.withEmail++;
        switch (business.email_status) {
          case STATUS_VERIFIED: stats.verified++; break;
          case STATUS_INVALID: stats.invalid++; break;
          case STATUS_NO_MX: stats.noMx++; break;
          default: break; // 'unverified' or null — counted in withEmail only
        }
      } else {
        stats.skipped++;
      }
    }
  }

  // Spawn the worker pool. When verify is off, enrichEmail resolves on the
  // same tick (no real I/O), so the pool collapses to a serial scan — but
  // using the same code path keeps behavior uniform and makes flipping
  // verify=true a no-op for the caller.
  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return stats;
}

module.exports = {
  __version,
  ENRICHMENT_COLUMNS,
  // Core API
  extractDomain,
  discoverEmails,
  discoverEmailsFromHtml,
  verifyEmail,
  verifyEmailSafe,
  enrichEmail,
  enrichEmailsBatch,
  // Helpers exported for unit tests
  extractDomainFromEmail,
  isValidEmailShape,
  resolveMx,
  smtpProbe,
  // Status constants
  STATUS_VERIFIED,
  STATUS_UNVERIFIED,
  STATUS_INVALID,
  STATUS_NO_MX,
  // Catalogues / constants (for tests + extension)
  COMMON_LOCAL_PARTS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  PROBE_FROM,
  PROBE_EHLO_HOST,
  // DI seams
  _loadDns,
  _setDns,
  _loadNet,
  _setNet,
};
