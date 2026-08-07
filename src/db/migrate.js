'use strict';

/**
 * src/db/migrate.js — Phase 2.1 — database migration runner
 *
 * Reads src/db/schema.sql and executes it idempotently against the database
 * pointed at by DATABASE_URL. Every statement in schema.sql uses IF NOT EXISTS,
 * so re-running this script is always safe.
 *
 * Usage:
 *   npm run db:migrate                    # uses process.env.DATABASE_URL
 *   node src/db/migrate.js                # same
 *   node src/db/migrate.js "postgresql://..."  # explicit connection string
 *
 * Exit codes:
 *   0 — migration applied (or already up-to-date)
 *   2 — configuration error (DATABASE_URL missing)
 *   3 — runtime error (cannot connect / SQL failed)
 */

const {
  createPool,
  runMigration,
  closePool,
} = require('../db');

async function main() {
  // Allow an explicit connection string as the first positional arg (handy
  // for one-off migrations against a non-default database).
  const argConn = process.argv[2];
  const connectionString = argConn || process.env.DATABASE_URL;

  if (!connectionString) {
    // eslint-disable-next-line no-console
    console.error(
      'db:migrate — DATABASE_URL is not set.\n' +
        'Set it in .env (see .env.example) or pass a connection string:\n' +
        '  node src/db/migrate.js "postgresql://user:pass@host:5432/db"',
    );
    process.exit(2);
  }

  const pool = createPool(connectionString);
  if (!pool) {
    // eslint-disable-next-line no-console
    console.error('db:migrate — failed to create a pool (DATABASE_URL invalid?).');
    process.exit(2);
  }

  try {
    // eslint-disable-next-line no-console
    console.log('db:migrate — running schema.sql ...');
    await runMigration(pool);
    // eslint-disable-next-line no-console
    console.log('db:migrate — schema applied successfully.');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('db:migrate — migration failed:', err.message);
    await closePool(pool);
    process.exit(3);
  }

  await closePool(pool);
  process.exit(0);
}

// Allow requiring this file without auto-running (for unit tests of the
// migrate entry point). When invoked directly (`node src/db/migrate.js`),
// run main().
if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('db:migrate — uncaught error:', err);
    process.exit(3);
  });
}

module.exports = { main };
