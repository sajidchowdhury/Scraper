'use strict';

/**
 * src/enrichment/email.js — Phase 3.5 — Email Discovery & Verification
 *
 * STUB (Phase 3.0). Implemented in Phase 3.5.
 *
 * Will discover business emails from the website domain (info@, contact@,
 * hello@ patterns + page scrape) and verify them via MX lookup + SMTP mailbox
 * check. Writes `email` + `email_status` (verified | unverified | invalid | no_mx).
 *
 * Public API (planned):
 *   discoverEmails(website)            → string[] (candidate emails)
 *   verifyEmail(email)                 → { status, mxHost }
 *   ENRICHMENT_COLUMNS                 → ['email', 'email_status']
 */

const __version = 1;

/**
 * Discover candidate emails from a business website.
 *
 * @param {string} _website
 * @returns {string[]}
 * @implements Phase 3.5
 */
function discoverEmails(_website) {
  // TODO Phase 3.5 — implement pattern guesses (info/contact/hello@) + page scrape.
  return [];
}

/**
 * Verify an email via MX lookup + SMTP mailbox check.
 *
 * @param {string} _email
 * @returns {{ status: string, mxHost: string|null }}
 * @implements Phase 3.5
 */
function verifyEmail(_email) {
  // TODO Phase 3.5 — implement DNS MX + smtp-connection RCPT TO probe.
  return { status: 'unverified', mxHost: null };
}

module.exports = {
  __version,
  discoverEmails,
  verifyEmail,
  ENRICHMENT_COLUMNS: ['email', 'email_status'],
};
