'use strict';

/**
 * tests/enrichment-email.test.js — Phase 3.5 — Email Discovery & Verification tests
 *
 * Coverage (per PHASE3_EXECUTION_PLAN.md §3.5 task checklist + acceptance):
 *   - extractDomain: URL parsing, www stripping, FQDN root-dot, missing scheme,
 *     bare domain, invalid/null input.
 *   - extractDomainFromEmail: local-part stripping, invalid shapes.
 *   - isValidEmailShape: valid/missing-@/double-@/bad-TLD/spaces/null.
 *   - discoverEmails: pattern-guess candidate generation (no HTTP).
 *   - discoverEmailsFromHtml: mailto: links, plain-text, dedup, domain filter.
 *   - resolveMx: DI-stubbed dns.resolveMx (records / empty / error).
 *   - smtpProbe: DI-stubbed net.createConnection — full 250 path, 550 invalid,
 *     450 unverified, MAIL FROM rejected, timeout, error, multi-line EHLO.
 *   - verifyEmail: MX + SMTP composition — verified / invalid / no_mx /
 *     lookup-error / probe-reject / lowest-priority MX / bad email shape.
 *   - verifyEmailSafe: never throws — delegates on happy path, safe default
 *     when verifyEmail rejects internally.
 *   - enrichEmail: single-business pipeline — website discovery, verify on/off,
 *     no-website, non-object.
 *   - enrichEmailsBatch: batch mutation, stats shape, skipped, verify-on counts,
 *     empty batch.
 *   - ENRICHMENT_COLUMNS + STATUS_* + __version + COMMON_LOCAL_PARTS exports.
 *
 * All tests are fully offline. dns + net are replaced via the module's DI seams
 * (_setDns / _setNet); the SMTP probe socket is a mock EventEmitter that emits
 * canned server replies in response to client writes.
 *
 * Run: bun test tests/enrichment-email.test.js
 */

const { EventEmitter } = require('events');

const {
  __version,
  ENRICHMENT_COLUMNS,
  extractDomain,
  extractDomainFromEmail,
  isValidEmailShape,
  discoverEmails,
  discoverEmailsFromHtml,
  resolveMx,
  smtpProbe,
  verifyEmail,
  verifyEmailSafe,
  enrichEmail,
  enrichEmailsBatch,
  STATUS_VERIFIED,
  STATUS_UNVERIFIED,
  STATUS_INVALID,
  STATUS_NO_MX,
  COMMON_LOCAL_PARTS,
  _setDns,
  _setNet,
} = require('../src/enrichment/email');

// ---------------------------------------------------------------------------
// DI stub helpers
// ---------------------------------------------------------------------------

/**
 * Stub `dns` module. Pass an array of MX records (happy path), an empty array
 * (no MX), or an Error (lookup failure).
 */
function makeDnsStub(mx) {
  return {
    resolveMx(domain, cb) {
      if (mx instanceof Error) cb(mx);
      else cb(null, Array.isArray(mx) ? mx : []);
    },
  };
}

/**
 * Mock SMTP socket. `opts` provides canned replies keyed by SMTP step:
 *   { greeting, ehlo, mail, rcpt }  — each a CRLF-terminated server line.
 * Special flags:
 *   { error: true }   — emits 'error' instead of greeting (connection refused).
 *   { timeout: true } — emits 'timeout' instead of greeting.
 *
 * The greeting / reply is emitted on process.nextTick so the probe's handlers
 * are attached before the first 'data' fires (mirrors real socket async).
 */
function makeSmtpSocket(opts) {
  opts = opts || {};
  const sock = new EventEmitter();
  sock.setTimeout = () => {};
  sock.setEncoding = () => {};
  sock.write = (chunk) => {
    const s = String(chunk);
    if (s.startsWith('EHLO') && opts.ehlo !== undefined) {
      process.nextTick(() => sock.emit('data', opts.ehlo));
    } else if (s.startsWith('MAIL FROM') && opts.mail !== undefined) {
      process.nextTick(() => sock.emit('data', opts.mail));
    } else if (s.startsWith('RCPT TO') && opts.rcpt !== undefined) {
      process.nextTick(() => sock.emit('data', opts.rcpt));
    }
    // QUIT and anything else: ignore.
  };
  sock.destroy = () => {};

  process.nextTick(() => {
    if (opts.error) {
      sock.emit('error', new Error('connection refused'));
    } else if (opts.timeout) {
      sock.emit('timeout');
    } else if (opts.greeting !== undefined) {
      sock.emit('data', opts.greeting);
    }
  });
  return sock;
}

/** Build a net stub whose createConnection returns a makeSmtpSocket(opts). */
function makeNetStub(socketOpts) {
  return {
    createConnection: () => makeSmtpSocket(socketOpts),
  };
}

/** Common verified SMTP reply set. */
const VERIFIED_REPLIES = {
  greeting: '220 mx1.example.com ESMTP\r\n',
  ehlo: '250 mx1.example.com\r\n',
  mail: '250 OK\r\n',
  rcpt: '250 OK\r\n',
};

/** Common invalid-recipient SMTP reply set. */
const INVALID_REPLIES = {
  greeting: '220 mx1.example.com ESMTP\r\n',
  ehlo: '250 mx1.example.com\r\n',
  mail: '250 OK\r\n',
  rcpt: '550 5.1.1 No such user\r\n',
};

// Reset DI seams after every test so no stub leaks into the next file or test.
afterEach(() => {
  _setDns(null);
  _setNet(null);
});

// ---------------------------------------------------------------------------
// 1. extractDomain (pure)
// ---------------------------------------------------------------------------

describe('Phase 3.5 — extractDomain', () => {
  test('https://www.example.com/path → example.com', () => {
    expect(extractDomain('https://www.example.com/path')).toBe('example.com');
  });

  test('http://example.co.uk → example.co.uk (preserves second-level domain)', () => {
    expect(extractDomain('http://example.co.uk')).toBe('example.co.uk');
  });

  test('strips leading www.', () => {
    expect(extractDomain('https://www.example.com')).toBe('example.com');
  });

  test('handles missing scheme (bare domain + path)', () => {
    expect(extractDomain('example.com/contact')).toBe('example.com');
  });

  test('strips FQDN trailing root dot', () => {
    expect(extractDomain('https://example.com.')).toBe('example.com');
  });

  test('lowercases uppercase hostnames', () => {
    expect(extractDomain('HTTPS://WWW.EXAMPLE.COM/Path')).toBe('example.com');
  });

  test('null / undefined / number / empty / whitespace → null', () => {
    expect(extractDomain(null)).toBe(null);
    expect(extractDomain(undefined)).toBe(null);
    expect(extractDomain(123)).toBe(null);
    expect(extractDomain('')).toBe(null);
    expect(extractDomain('   ')).toBe(null);
  });

  test('rejects localhost (no dot)', () => {
    expect(extractDomain('http://localhost')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 2. extractDomainFromEmail (pure)
// ---------------------------------------------------------------------------

describe('Phase 3.5 — extractDomainFromEmail', () => {
  test('info@example.com → example.com', () => {
    expect(extractDomainFromEmail('info@example.com')).toBe('example.com');
  });

  test('lowercases uppercase and handles dotted local-part', () => {
    expect(extractDomainFromEmail('First.Last@SUB.EXAMPLE.COM')).toBe('sub.example.com');
  });

  test('no @ / trailing @ / no dot in domain / non-string → null', () => {
    expect(extractDomainFromEmail('notanemail')).toBe(null);
    expect(extractDomainFromEmail('info@')).toBe(null);
    expect(extractDomainFromEmail('info@localhost')).toBe(null);
    expect(extractDomainFromEmail(null)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 3. isValidEmailShape (pure)
// ---------------------------------------------------------------------------

describe('Phase 3.5 — isValidEmailShape', () => {
  test('valid address → true', () => {
    expect(isValidEmailShape('info@example.com')).toBe(true);
  });

  test('missing @ → false', () => {
    expect(isValidEmailShape('notanemail')).toBe(false);
  });

  test('double @ → false', () => {
    expect(isValidEmailShape('a@b@c.com')).toBe(false);
  });

  test('bad TLD (1 char) → false', () => {
    expect(isValidEmailShape('a@b.c')).toBe(false);
  });

  test('spaces in local part → false', () => {
    expect(isValidEmailShape('a b@c.com')).toBe(false);
  });

  test('null / undefined / empty → false', () => {
    expect(isValidEmailShape(null)).toBe(false);
    expect(isValidEmailShape(undefined)).toBe(false);
    expect(isValidEmailShape('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. discoverEmails (pure — pattern guess, no HTTP)
// ---------------------------------------------------------------------------

describe('Phase 3.5 — discoverEmails', () => {
  test('returns candidates combining COMMON_LOCAL_PARTS × domain', () => {
    const cands = discoverEmails('https://www.example.com');
    expect(cands).toContain('info@example.com');
    expect(cands).toContain('contact@example.com');
    expect(cands).toContain('hello@example.com');
    expect(cands).toContain('admin@example.com');
  });

  test('first candidate is info@ (highest hit-rate ordering)', () => {
    expect(discoverEmails('example.com')[0]).toBe('info@example.com');
  });

  test('candidate count matches COMMON_LOCAL_PARTS length', () => {
    expect(discoverEmails('example.com')).toHaveLength(COMMON_LOCAL_PARTS.length);
  });

  test('invalid website → empty array', () => {
    expect(discoverEmails(null)).toEqual([]);
    expect(discoverEmails('not-a-url')).toEqual([]);
    expect(discoverEmails('http://localhost')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. discoverEmailsFromHtml (pure)
// ---------------------------------------------------------------------------

describe('Phase 3.5 — discoverEmailsFromHtml', () => {
  test('extracts mailto: link target', () => {
    const html = '<a href="mailto:info@example.com">Email us</a>';
    expect(discoverEmailsFromHtml(html)).toContain('info@example.com');
  });

  test('extracts plain-text email from page content', () => {
    const html = '<p>Contact us@x.com today for a quote.</p>';
    expect(discoverEmailsFromHtml(html)).toContain('us@x.com');
  });

  test('deduplicates repeated addresses', () => {
    const html = 'mailto:info@example.com and info@example.com again';
    const result = discoverEmailsFromHtml(html);
    expect(result.filter((e) => e === 'info@example.com')).toHaveLength(1);
  });

  test('domain filter keeps only matching bare domain', () => {
    const html = 'info@example.com and sales@other.com and admin@mail.example.com';
    const result = discoverEmailsFromHtml(html, 'example.com');
    expect(result).toContain('info@example.com');
    expect(result).not.toContain('sales@other.com');
    expect(result).not.toContain('admin@mail.example.com');
  });

  test('no domain filter → returns all plausible addresses', () => {
    const html = 'info@example.com and sales@other.com';
    const result = discoverEmailsFromHtml(html);
    expect(result).toContain('info@example.com');
    expect(result).toContain('sales@other.com');
  });

  test('mailto with ?subject= strips query string', () => {
    const html = '<a href="mailto:hello@example.com?subject=Hi">Email</a>';
    expect(discoverEmailsFromHtml(html)).toContain('hello@example.com');
  });

  test('non-string / empty html → empty array', () => {
    expect(discoverEmailsFromHtml(null)).toEqual([]);
    expect(discoverEmailsFromHtml('')).toEqual([]);
    expect(discoverEmailsFromHtml('   ')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. resolveMx (DI seam — _setDns)
// ---------------------------------------------------------------------------

describe('Phase 3.5 — resolveMx (DI seam)', () => {
  test('returns MX records from the stub', async () => {
    _setDns(makeDnsStub([{ exchange: 'mx1.example.com', priority: 10 }]));
    const records = await resolveMx('example.com');
    expect(records).toHaveLength(1);
    expect(records[0].exchange).toBe('mx1.example.com');
    expect(records[0].priority).toBe(10);
  });

  test('empty records → empty array', async () => {
    _setDns(makeDnsStub([]));
    const records = await resolveMx('example.com');
    expect(records).toEqual([]);
  });

  test('lookup error → rejects', async () => {
    _setDns(makeDnsStub(new Error('ENOTFOUND example.com')));
    await expect(resolveMx('example.com')).rejects.toThrow('ENOTFOUND');
  });

  test('DI seam is used — calls the injected resolveMx, not real dns', async () => {
    let calledWith = null;
    _setDns({
      resolveMx(domain, cb) {
        calledWith = domain;
        cb(null, []);
      },
    });
    await resolveMx('probe.example.org');
    expect(calledWith).toBe('probe.example.org');
  });
});

// ---------------------------------------------------------------------------
// 7. smtpProbe (DI seam — _setNet)
// ---------------------------------------------------------------------------

describe('Phase 3.5 — smtpProbe (DI seam)', () => {
  test('full 250 conversation → verified', async () => {
    _setNet(makeNetStub(VERIFIED_REPLIES));
    const status = await smtpProbe('mx1.example.com', 'info@example.com', 5000);
    expect(status).toBe(STATUS_VERIFIED);
  });

  test('RCPT TO 251 (user not local, will forward) → verified', async () => {
    _setNet(makeNetStub({
      greeting: '220 mx1\r\n',
      ehlo: '250 OK\r\n',
      mail: '250 OK\r\n',
      rcpt: '251 user not local; will forward\r\n',
    }));
    const status = await smtpProbe('mx1.example.com', 'info@example.com', 5000);
    expect(status).toBe(STATUS_VERIFIED);
  });

  test('RCPT TO 550 → invalid', async () => {
    _setNet(makeNetStub(INVALID_REPLIES));
    const status = await smtpProbe('mx1.example.com', 'bad@example.com', 5000);
    expect(status).toBe(STATUS_INVALID);
  });

  test('RCPT TO 450 (transient) → unverified', async () => {
    _setNet(makeNetStub({
      greeting: '220 mx1\r\n',
      ehlo: '250 OK\r\n',
      mail: '250 OK\r\n',
      rcpt: '450 4.7.1 Try later\r\n',
    }));
    const status = await smtpProbe('mx1.example.com', 'info@example.com', 5000);
    expect(status).toBe(STATUS_UNVERIFIED);
  });

  test('MAIL FROM rejected (non-2xx) → resolves unverified (not reject)', async () => {
    _setNet(makeNetStub({
      greeting: '220 mx1\r\n',
      ehlo: '250 OK\r\n',
      mail: '550 5.7.1 No spam\r\n',
    }));
    const status = await smtpProbe('mx1.example.com', 'info@example.com', 5000);
    expect(status).toBe(STATUS_UNVERIFIED);
  });

  test('timeout event → rejects', async () => {
    _setNet(makeNetStub({ timeout: true }));
    await expect(
      smtpProbe('mx1.example.com', 'info@example.com', 5000),
    ).rejects.toThrow('smtp probe failed');
  });

  test('connection error event → rejects', async () => {
    _setNet(makeNetStub({ error: true }));
    await expect(
      smtpProbe('mx1.example.com', 'info@example.com', 5000),
    ).rejects.toThrow('smtp probe failed');
  });

  test('multi-line EHLO response (250-.../250) → verified', async () => {
    _setNet(makeNetStub({
      greeting: '220 mx1.example.com ESMTP\r\n',
      ehlo: '250-mx1.example.com\r\n250-PIPELINING\r\n250 SIZE 10240000\r\n',
      mail: '250 OK\r\n',
      rcpt: '250 OK\r\n',
    }));
    const status = await smtpProbe('mx1.example.com', 'info@example.com', 5000);
    expect(status).toBe(STATUS_VERIFIED);
  });
});

// ---------------------------------------------------------------------------
// 8. verifyEmail (DI seams — _setDns + _setNet)
// ---------------------------------------------------------------------------

describe('Phase 3.5 — verifyEmail (DI seams)', () => {
  test('MX + SMTP 250 → verified, mxHost set', async () => {
    _setDns(makeDnsStub([{ exchange: 'mx1.example.com', priority: 10 }]));
    _setNet(makeNetStub(VERIFIED_REPLIES));
    const r = await verifyEmail('info@example.com');
    expect(r.status).toBe(STATUS_VERIFIED);
    expect(r.mxHost).toBe('mx1.example.com');
  });

  test('SMTP 550 → invalid, mxHost set', async () => {
    _setDns(makeDnsStub([{ exchange: 'mx1.example.com', priority: 10 }]));
    _setNet(makeNetStub(INVALID_REPLIES));
    const r = await verifyEmail('bad@example.com');
    expect(r.status).toBe(STATUS_INVALID);
    expect(r.mxHost).toBe('mx1.example.com');
  });

  test('no MX records → no_mx, mxHost null', async () => {
    _setDns(makeDnsStub([]));
    const r = await verifyEmail('info@example.com');
    expect(r.status).toBe(STATUS_NO_MX);
    expect(r.mxHost).toBe(null);
  });

  test('MX lookup error → unverified, mxHost null', async () => {
    _setDns(makeDnsStub(new Error('ENOTFOUND')));
    const r = await verifyEmail('info@example.com');
    expect(r.status).toBe(STATUS_UNVERIFIED);
    expect(r.mxHost).toBe(null);
  });

  test('SMTP probe rejects (timeout) → unverified, mxHost still set', async () => {
    _setDns(makeDnsStub([{ exchange: 'mx1.example.com', priority: 10 }]));
    _setNet(makeNetStub({ timeout: true }));
    const r = await verifyEmail('info@example.com');
    expect(r.status).toBe(STATUS_UNVERIFIED);
    expect(r.mxHost).toBe('mx1.example.com');
  });

  test('picks lowest-priority (primary) MX host', async () => {
    _setDns(makeDnsStub([
      { exchange: 'mx2.example.com', priority: 20 },
      { exchange: 'mx1.example.com', priority: 10 },
    ]));
    let connectedHost = null;
    _setNet({
      createConnection: (opts) => {
        connectedHost = opts.host;
        return makeSmtpSocket(VERIFIED_REPLIES);
      },
    });
    const r = await verifyEmail('info@example.com');
    expect(r.status).toBe(STATUS_VERIFIED);
    expect(r.mxHost).toBe('mx1.example.com');
    expect(connectedHost).toBe('mx1.example.com');
  });

  test('bad email shape (no domain) → unverified, mxHost null', async () => {
    const r = await verifyEmail('notanemail');
    expect(r.status).toBe(STATUS_UNVERIFIED);
    expect(r.mxHost).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 9. verifyEmailSafe (never throws)
// ---------------------------------------------------------------------------

describe('Phase 3.5 — verifyEmailSafe (DI seams)', () => {
  test('delegates to verifyEmail on the happy path', async () => {
    _setDns(makeDnsStub([{ exchange: 'mx1.example.com', priority: 10 }]));
    _setNet(makeNetStub(VERIFIED_REPLIES));
    const r = await verifyEmailSafe('info@example.com');
    expect(r.status).toBe(STATUS_VERIFIED);
    expect(r.mxHost).toBe('mx1.example.com');
  });

  test('never throws — returns safe default when verifyEmail rejects internally', async () => {
    // MX records with a null entry cause mxRecords.sort() to throw inside
    // verifyEmail (the comparator accesses .priority on null). verifyEmailSafe
    // catches the rejection and returns the safe { unverified, null } default.
    _setDns(makeDnsStub([null, { exchange: 'mx1.example.com', priority: 10 }]));
    const r = await verifyEmailSafe('info@example.com');
    expect(r.status).toBe(STATUS_UNVERIFIED);
    expect(r.mxHost).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 10. enrichEmail (single-business pipeline)
// ---------------------------------------------------------------------------

describe('Phase 3.5 — enrichEmail', () => {
  test('business with website → sets email + email_status (unverified by default)', async () => {
    const biz = { place_id: 'abc', name: 'Cafe', website: 'https://www.example.com' };
    const r = await enrichEmail(biz);
    expect(r.email).toBe('info@example.com');
    expect(r.email_status).toBe(STATUS_UNVERIFIED);
    // Mutates in place.
    expect(biz.email).toBe('info@example.com');
    expect(biz.email_status).toBe(STATUS_UNVERIFIED);
  });

  test('no website → email null, email_status null', async () => {
    const biz = { place_id: 'abc', name: 'Cafe' };
    const r = await enrichEmail(biz);
    expect(r.email).toBe(null);
    expect(r.email_status).toBe(null);
    expect(biz.email).toBe(null);
    expect(biz.email_status).toBe(null);
  });

  test('verify on (stubbed verified) → status verified', async () => {
    _setDns(makeDnsStub([{ exchange: 'mx1.example.com', priority: 10 }]));
    _setNet(makeNetStub(VERIFIED_REPLIES));
    const biz = { website: 'example.com' };
    const r = await enrichEmail(biz, { verify: true });
    expect(r.email).toBe('info@example.com');
    expect(r.email_status).toBe(STATUS_VERIFIED);
    expect(biz.email_status).toBe(STATUS_VERIFIED);
  });

  test('verify on (stubbed invalid) → status invalid', async () => {
    _setDns(makeDnsStub([{ exchange: 'mx1.example.com', priority: 10 }]));
    _setNet(makeNetStub(INVALID_REPLIES));
    const biz = { website: 'example.com' };
    const r = await enrichEmail(biz, { verify: true });
    expect(r.email_status).toBe(STATUS_INVALID);
  });

  test('non-object business → { null, null }', async () => {
    const r = await enrichEmail(null);
    expect(r.email).toBe(null);
    expect(r.email_status).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 11. enrichEmailsBatch (batch pipeline + stats)
// ---------------------------------------------------------------------------

describe('Phase 3.5 — enrichEmailsBatch', () => {
  test('attaches email + unverified status to all businesses (verify off)', async () => {
    const biz = [
      { place_id: '1', website: 'a.com' },
      { place_id: '2', website: 'b.com' },
    ];
    const stats = await enrichEmailsBatch(biz);
    expect(biz[0].email).toBe('info@a.com');
    expect(biz[0].email_status).toBe(STATUS_UNVERIFIED);
    expect(biz[1].email).toBe('info@b.com');
    expect(biz[1].email_status).toBe(STATUS_UNVERIFIED);
    expect(stats.withEmail).toBe(2);
  });

  test('stats shape is correct', async () => {
    const stats = await enrichEmailsBatch([{ website: 'a.com' }]);
    expect(stats.total).toBe(1);
    expect(stats.withEmail).toBe(1);
    expect(stats.verified).toBe(0);
    expect(stats.invalid).toBe(0);
    expect(stats.noMx).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(stats.costUsd).toBe(0);
  });

  test('empty batch → all zeros', async () => {
    const stats = await enrichEmailsBatch([]);
    expect(stats.total).toBe(0);
    expect(stats.withEmail).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(stats.costUsd).toBe(0);
  });

  test('skipped count for businesses with no website', async () => {
    const biz = [
      { place_id: '1', website: 'a.com' },
      { place_id: '2' }, // no website → skipped
    ];
    const stats = await enrichEmailsBatch(biz);
    expect(stats.withEmail).toBe(1);
    expect(stats.skipped).toBe(1);
  });

  test('verify on with stubbed verified → counts verified', async () => {
    _setDns(makeDnsStub([{ exchange: 'mx1.example.com', priority: 10 }]));
    _setNet(makeNetStub(VERIFIED_REPLIES));
    const biz = [{ place_id: '1', website: 'example.com' }];
    const stats = await enrichEmailsBatch(biz, { verify: true });
    expect(stats.verified).toBe(1);
    expect(stats.withEmail).toBe(1);
    expect(biz[0].email_status).toBe(STATUS_VERIFIED);
  });
});

// ---------------------------------------------------------------------------
// 12. Constants & exports
// ---------------------------------------------------------------------------

describe('Phase 3.5 — constants & exports', () => {
  test('ENRICHMENT_COLUMNS = [email, email_status]', () => {
    expect(ENRICHMENT_COLUMNS).toEqual(['email', 'email_status']);
  });

  test('STATUS constants are the expected strings', () => {
    expect(STATUS_VERIFIED).toBe('verified');
    expect(STATUS_UNVERIFIED).toBe('unverified');
    expect(STATUS_INVALID).toBe('invalid');
    expect(STATUS_NO_MX).toBe('no_mx');
  });

  test('__version is a number and COMMON_LOCAL_PARTS includes core prefixes', () => {
    expect(typeof __version).toBe('number');
    expect(COMMON_LOCAL_PARTS).toContain('info');
    expect(COMMON_LOCAL_PARTS).toContain('contact');
    expect(COMMON_LOCAL_PARTS).toContain('hello');
  });
});
