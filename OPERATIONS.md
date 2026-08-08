# Operations Runbook

This runbook describes how to operate the Google Maps scraper in production: the
overnight, 10,000+-listing, unattended use case that Phase 2 was built for. It
covers infrastructure setup, the canonical large-run command, proxy and CAPTCHA
budgeting, concurrency tuning, monitoring, alerting, recovery, and post-run
verification. It assumes the Phase 2 milestone (Phases 2.0–2.12 complete) is
installed. It does NOT cover deferred Phase 3/5 features (phone normalization,
email discovery, web dashboard, distributed workers, Stripe billing, etc.).

## Prerequisites

- **Node.js >= 20** (per `package.json` `engines`). Bun is only for the test suite.
- **Playwright Chromium**: `npx playwright install chromium` after `npm install`.
- **PostgreSQL 15+**: `docker-compose.yml` (`postgres:15-alpine`) or external. Set `DATABASE_URL`.
- **Redis 7+**: `docker-compose.yml` (`redis:7-alpine`) or external. Required only when `--queue on` (Phase 2.9). Set `REDIS_URL`.
- **Proxy list file** (`proxies.txt`, set via `PROXY_LIST_FILE` / `--proxyListFile`): one proxy per line. Optional but strongly recommended for runs > ~500 listings.
- **CAPTCHA provider API key** (optional): stored in `.env` as `CAPTCHA_API_KEY`. For dry runs use `--captchaProvider mock` (no key, no cost).
- **RAM**: budget ~250MB per worker + 512MB headroom. An 8GB box comfortably runs `--workers 5`.

See `docker-compose.yml` (PostgreSQL + Redis, named volumes `gmaps_pg` / `gmaps_redis`) and `.env.example` (every Phase 2 env var, with comments).

## First-Time Setup

```bash
git clone <repo> Scraper && cd Scraper
npm install
npx playwright install chromium
docker compose up -d            # PostgreSQL + Redis
cp .env.example .env            # then edit .env (DATABASE_URL, REDIS_URL, ...)
npm run db:migrate              # idempotent — creates schema + Phase 2.2/2.12 columns
npm run verify-stealth          # confirm stealth patches + navigator.webdriver=undefined
```

Verify with a small dry run (no DB writes, no CAPTCHA spend):

```bash
npm start -- --query "Cafe" --location "Berlin" --maxResults 10 --dryRun --yes
```

Expected: 10 businesses extracted, `navigator.webdriver` undefined, exit code 0, no files under `./data/`. Then a tiny real run to DB:

```bash
npm start -- --query "Cafe" --location "Berlin" --maxResults 10 --output db --yes
```

If `npm run db:migrate` fails against an external DB, check `DATABASE_URL` starts with `postgresql://` or `postgres://` (SQLite/`file://` URLs are rejected).

## Running a Production Scrape

The canonical 10k-listing overnight run (per `PHASE2_EXECUTION_PLAN.md` Phase 2.13 task checklist):

```bash
npm start -- \
  --workers 5 \
  --queue on \
  --incremental \
  --deepScrape true \
  --captchaProvider 2captcha \
  --proxyStrategy random \
  --sessionLength 50
```

| Flag | Meaning |
|---|---|
| `--workers 5` | 5 parallel browser workers (each = 1 Chromium ~150–300MB RAM) |
| `--queue on` | Submit jobs to a BullMQ-backed Redis queue (requires `REDIS_URL`) |
| `--incremental` | Skip fresh/unchanged businesses; reuse cached detail within TTL (requires `--output db`) |
| `--deepScrape true` | Open each detail panel for hours, popular times, reviews, photos |
| `--captchaProvider 2captcha` | Auto-solve CAPTCHAs via 2captcha (~$0.003/solve); requires `CAPTCHA_API_KEY` in `.env` |
| `--proxyStrategy random` | Pick a random proxy from the pool per request (best load distribution) |
| `--sessionLength 50` | Requests per proxy before rotation (effective only with `--proxyStrategy sticky`) |

For batch submission of many (query, location) pairs, prepare a CSV (`queries.example.csv` is the template) and submit one job per row:

```bash
npm run batch -- --file queries.csv --queue on --priority 5
```

`batch` submits and exits; `npm start -- --queue on --workers 5 --endless` (or omit `--endless` for a single drain) processes the queue.

### What to monitor during the run

| Signal | How to check | Target |
|---|---|---|
| Queue status | `npm run queue:status` (live, 2s refresh) | waiting decreasing, failed = 0 |
| Run logs | `./logs/` (structured JSON, one per run) | no `error` lines beyond retries |
| DB row growth | `SELECT count(*) FROM businesses;` | approaches expected total |
| CAPTCHA spend | `tail -f data/captcha_cost_log.jsonl` | < $5 for the whole run |
| Proxy burn | `tail -f data/proxy_burn_log.jsonl` | < 20% of pool burned |
| Extraction rate | startup health check + per-batch logs | core fields >= 95% |
| Detail success | end-of-run banner | >= 90% of detail-scraped businesses |
| Heap / RSS | `GET /health` (if `--healthPort` set) | heap < 1024MB/worker, RSS < 4096MB |
| Run duration | end-of-run banner | < 8 hours for 10k |

Phase 2.13 acceptance criteria: >=95% of expected businesses extracted, >=90% detail-scrape success rate, zero crashes/OOM/orphans, CAPTCHA cost < $5, proxy burn < 20% of pool, total runtime < 8 hours.

## Proxy Management

**Proxy list file format** (one per line; `#` lines are comments; formats auto-detected):

```
# protocol://[user:pass@]host:port
http://user:pass@1.2.3.4:8080
# host:port:user:pass
1.2.3.4:8080:user:pass
# host:port (no auth — public proxy)
1.2.3.4:8080
```

Set via `PROXY_LIST_FILE` in `.env` or `--proxyListFile <path>`. `--noProxy` forces a direct connection (Phase 1 behavior), useful for smoke tests.

**Rotation flags:**

- `--proxyStrategy round-robin|random|sticky` (default `random`).
- `--sessionLength <n>` — requests per proxy before rotation; only meaningful with `sticky` (default 1 = rotate every request).
- `--proxyCooldownMs <ms>` — how long a burned proxy sits out (default 600000 = 10 min).
- `--proxyHealthCheck` — probe every proxy with a HEAD request before scraping; dead proxies are skipped at startup.

**Burn detection** (`src/proxy/burn-detector.js`): a proxy is benched into `cooldown` state when any of these fire:

- 3 consecutive HTTP `403` / `429` responses
- Success rate below 50% over the last 20 requests (after at least 5 samples)
- 3 consecutive connection timeouts (`statusCode === 'TIMEOUT'`)

HTTP `407` (Proxy Authentication Required) is a **permanent** burn — the proxy is removed from the pool entirely (bad credentials; retry is pointless). A cooled-down proxy re-enters rotation after `--proxyCooldownMs` with a fresh slate. Every burn event is appended to `data/proxy_burn_log.jsonl` with timestamp, proxy id, reason, recent status codes, and burn kind.

**Adding/replacing proxies mid-run:** edit the proxy list file. New workers pick up the refreshed list on their next acquire (in-flight workers keep their current proxy until release). To force a pool refresh, restart the process with `--resume` (jobs persist in Redis).

**Alerting:** if burn rate exceeds 20% of the pool, either rotate providers (swap the file with a fresh batch) or slow down with `--maxRPM <n>` (default 30; lower = fewer Google requests per minute). Persistent 407s across many proxies usually mean expired credentials — fix the list, don't just add more.

## CAPTCHA Budgeting

**Providers** (`--captchaProvider`):

| Provider | Cost per solve | Notes |
|---|---|---|
| `none` (default) | $0 | Phase 1.8 pause-and-alert; not viable for unattended runs |
| `mock` | $0 | Dry-run solver, returns a fake token; use for end-to-end tests |
| `2captcha` | ~$0.003 | REST API (`in.php` + `res.php`); requires `CAPTCHA_API_KEY` |
| `anticaptcha` | ~$0.002 | JSON-RPC; requires `CAPTCHA_API_KEY` |
| `capsolver` | ~$0.0008 | JSON-RPC; requires `CAPTCHA_API_KEY` |

**Flags:**

- `--captchaApiKey <key>` — or set `CAPTCHA_API_KEY` in `.env`. **Never pass the key on the CLI in shared environments** — `.env` is gitignored.
- `--captchaBudget <usd>` — USD spend cap (default 5.00). Once cumulative solver cost reaches this, the orchestrator stops solving and falls back to Phase 1.8 pause-and-alert. It will NOT spend past the budget. Set `0` to disable auto-solving entirely.
- `--captchaFallbackProvider <p>` — secondary solver tried when the primary fails its retry. Must differ from the primary; cannot be `none`.
- `--noCaptchaSolve` — force pause-and-alert (overrides `--captchaProvider`).

**Cost log** (`src/captcha/cost-log.js`): one JSONL record per solve attempt at `data/captcha_cost_log.jsonl`:

```json
{"ts":"2026-...","provider":"2captcha","type":"recaptcha_v2","cost":0.003,
 "solveTimeMs":12450,"success":true,"url":"https://...","error":null}
```

`log.summary()` returns `{ count, totalCost, avgMs, successCount, successRate, byProvider }` and is printed in the end-of-run banner. The orchestrator checks cumulative spend before each solve — when budget is exceeded, it pauses and alerts (Phase 1.8 behavior), preserving in-flight work via the checkpoint.

**Recommendations:** start dry runs with `--captchaProvider mock` to validate the end-to-end flow without spending money. For production, set a realistic `--captchaBudget` (default $5 covers ~1,600 solves at 2captcha pricing — enough for a typical 10k run with good proxies). Monitor `data/captcha_cost_log.jsonl` mid-run; if solve count rises faster than extraction rate, your IPs are flagged — rotate proxies or lower `--maxRPM`. Provider setup: store the key in `.env` as `CAPTCHA_API_KEY`, never on the CLI.

## Concurrency Tuning

**Worker pool flags** (Phase 2.8):

- `--workers <n>` (default 1 = Phase 1 sequential). Each worker = its own Chromium + proxy + fingerprint + session + rate limiter. Start at 3–5.
- `--workerProxyStrategy shared|isolated` (default `isolated`). `isolated` = each worker pins its own proxy; `shared` = all workers draw from the pool on each task. Use `shared` only when proxies outnumber workers.
- `--workerCrashLimit <n>` (default 3) — retire a worker after this many crashes in a 10-minute window. Retired workers shrink the pool.
- `--workerCooldownMs <ms>` (default 300000 = 5 min) — how long a blocked worker sits out before reviving with a rotated identity.
- `--workerLoadBalancer round-robin|least-busy` (default `round-robin`). Use `least-busy` when task lengths are uneven (mixed list-only and deep-scrape batches).
- `--workerDetailBatchSize <n>` (default 20) — businesses per detail-task batch. With `--workers N --deepScrape true`, detail work is split into batches of N and run in parallel across the pool.
- `--workerTaskRetries <n>` (default = workers) — max re-queues per task across workers. A task is re-tried on another worker after a block/crash; fails after this many re-queues.

**Queue flags** (Phase 2.9):

- `--queue on|off` (default `off` = Phase 2.8 in-process dispatch).
- `--queueConcurrency <n>` (default 1) — how many jobs the worker pulls off the queue in parallel. **Keep `<= --workers`** so the pool can absorb load.
- `--queuePriority <n>` (default 5; 1 = high, 10 = low). `--queueAttempts <n>` (default 3) — BullMQ retry attempts per job; after this many failures the job is dead-lettered.

**Rule of thumb:** `workers × 250MB + 512MB headroom < available RAM`. On 8GB, `--workers 5` with `--queueConcurrency 1` is the sweet spot. On 4GB, cap at `--workers 3` and lower `--maxHeapMb` to 768.

## Database Operations

```bash
npm run db:migrate    # idempotent — creates all tables/indexes, safe to re-run
npm run db:history -- --placeId ChIJxxx        # Phase 2.2 change timeline for one business
npm run db:history -- --placeId ChIJxxx --limit 20
```

`db:migrate` is safe to run on an existing Phase 2.1/2.2/2.12 database — every object uses `IF NOT EXISTS` or a `DO $$ ... ALTER` guard, so missing columns get added and existing ones are skipped.

**Schema overview** (`src/db/schema.sql`):

| Table | Purpose |
|---|---|
| `businesses` | One row per scraped business, keyed by `place_id`. 17 list-view fields + 8 detail fields + geo + `data_hash` + `run_id` + `updated_at` |
| `scrape_runs` | One row per pipeline invocation: query, location, started_at, finished_at, extracted, failed, exit_code, log_path, db_inserted/updated/unchanged, changes_detected |
| `business_snapshots` | Pre-update snapshot of high-value fields (rating, reviews_count, business_status, phone, website) captured before an UPDATE overwrites them |
| `field_changes` | Computed, queryable per-field delta log (field, old_value, new_value, delta, detected_at) |

**Phase 2.12 incremental columns** on `businesses`: `last_list_scraped` (compared vs `--listFreshnessDays`), `last_detail_scraped` (compared vs `--detailCacheTtlDays`; NULL until first successful detail scrape), `change_hash` (SHA-256 of list-view fields only; distinct from `data_hash` which includes detail JSONB — a detail-only change does NOT invalidate list freshness).

**Re-running a query is idempotent:** upserts produce `inserted` / `updated` / `unchanged` counts. Unchanged businesses do NOT get an `updated_at` bump (Phase 2.1 contract); only `last_list_scraped` + `change_hash` refresh.

**Monitoring queries:**

```sql
SELECT count(*) FROM businesses;
SELECT id, query, location, started_at, finished_at, extracted, failed,
       db_inserted, db_updated, db_unchanged, changes_detected, exit_code
  FROM scrape_runs ORDER BY id DESC LIMIT 10;
SELECT field, count(*) FROM field_changes
  WHERE detected_at > NOW() - INTERVAL '24 hours'
  GROUP BY field ORDER BY count DESC;
```

**Backups:** `pg_dump -Fc gmaps_scraper > backup.dump` (compressed custom format; restore with `pg_restore -d gmaps_scraper backup.dump`). The docker-compose volume `gmaps_pg` also survives `docker compose down` (use `down -v` only to wipe data).

## Incremental & Cache Operations

`--incremental` requires `--output db` (freshness is tracked in PostgreSQL). Behavior:

- **First run** = full scrape. Every business is inserted; `last_list_scraped` and `last_detail_scraped` are stamped; `change_hash` is computed from the 15 list-view fields.
- **Second run within `--listFreshnessDays`** (default 1 day) = cache hit. The run-level pre-flight finds the most recent scrape of this (query, location) is fresh -> the browser is NOT launched -> businesses are loaded straight from the DB -> ~0 Google requests, < 30s runtime.
- **Per-business detail cache:** if `last_detail_scraped` is within `--detailCacheTtlDays` (default 7) AND `change_hash` matches, the detail-panel deep-scrape is skipped entirely — cached hours/reviews/photos are merged via `mergeCachedDetail` and `detail_scraped` is set true.

**Flags:**

- `--listFreshnessDays <n>` (default 1) — a business is "fresh" if its `last_list_scraped` is within N days. Fresh + `change_hash` match -> skip detail-scrape.
- `--detailCacheTtlDays <n>` (default 7) — detail data is reused if `last_detail_scraped` is within N days. `0` = always miss.
- `--detailRefreshOnReviewDelta <pct>` (default 10) — force a detail re-scrape when `reviews_count` jumped by more than this percent, even within TTL. Catches review surges. Only positive deltas trigger (0 -> N reports 1000, so any threshold triggers).
- `--noDetailCache` — always deep-scrape (forces reason `no_cache` for every business). One-off flag, no `.env` edit needed.
- `--swrr` — stale-while-revalidate (stub for Phase 5; accepted + logged, behaves like normal incremental).

**Force a full re-scrape:** either `--listFreshnessDays 0` (treats every business as stale) or omit `--incremental` entirely (Phase 2.1/1.5 behavior byte-for-byte).

**Inspect cache freshness:**

```sql
SELECT place_id, name, last_list_scraped, last_detail_scraped, change_hash
  FROM businesses WHERE query = 'Cafe' AND location = 'Berlin'
  ORDER BY last_list_scraped DESC NULLS LAST;
```

The end-of-run banner prints an "Incremental" block with list/detail cache hit counts, preflight skip status, and estimated savings.

## Monitoring & Health

**`--endless` mode** (Phase 2.10): the scraper never exits — it keeps pulling jobs from the BullMQ queue as they arrive (Phase 5 continuous scraping on a single machine). Requires `--queue on`. Auto-enables an aggressive memory monitor, hourly zombie reaper, and the HTTP `/health` endpoint.

**`--healthPort <n>`** (default off; auto-on when `--endless`): binds a tiny HTTP server (Node `http`, no Express) on `--healthHost` (default `127.0.0.1` — NOT exposed externally; set `0.0.0.0` to expose but firewall the port). Default port 9100. `GET /health` returns:

```json
{
  "status": "ok | degraded | unhealthy",
  "uptime": 12345,
  "startedAt": "2026-...",
  "heap":   { "usedMb": 512, "totalMb": 768, "rssMb": 894, "highWaterMb": 1024 },
  "workers":{ "size": 5, "activeSize": 5, "retiredCount": 0, "loadBalancer": "round-robin", "totals": {} },
  "queue":  { "waiting": 12, "active": 1, "completed": 480, "failed": 0, "delayed": 0 },
  "endless": true,
  "version": "1.0.0-phase2.12"
}
```

HTTP status: `200` for `ok`/`degraded`, `503` for `unhealthy` (so a load balancer routes around). `unhealthy` = heap above critical, pool exhausted, or no workers active. `degraded` = RSS/heap above warning, a worker retired, or queue backed up (> 100 waiting).

**Memory thresholds:**

- `--maxHeapMb <n>` (default 1024) — per-worker heap threshold. Crossing it fires `onThreshold`, which restarts the current browser context.
- `--maxRssMb <n>` (default 4096) — total process RSS threshold. Crossing it triggers graceful degradation: pause the queue, wait for in-flight tasks, restart every worker's context, run `global.gc()` (if `--expose-gc`), resume the queue. If RSS is still above threshold after restart, reduce pool size by 1 worker and log a warning.
- `--healthCheckIntervalMs <ms>` (default 30000 for memory monitor, 60000 for worker probe).

**Worker probe** (every 60s): inspects every worker + pings its page with `page.evaluate(() => 1)` to detect unresponsive browsers. Three consecutive timeouts -> worker marked unresponsive and force-restarted. A worker is "stuck" if busy for more than `WORKER_STUCK_AFTER_MS` (default 10 min) with no task completion.

**Zombie reaper** (`src/health/zombie-reaper.js`): runs at startup and shutdown. Scans for orphaned Chromium via `pgrep -f 'chromium|chrome|headless_shell'`, SIGTERM-then-SIGKILLs them. Also runs hourly in `--endless` mode. Prevents the classic "10 Chromiums eating 4GB after a crash" failure.

**Live queue dashboard:** `npm run queue:status` — top-style, refreshes every 2s. Shows queue-wide counts (waiting / active / completed / failed / delayed / total), active jobs (id, type, progress, attemptsMade, elapsed), and recently-failed (dead-lettered) jobs. Modes:

```bash
npm run queue:status -- --once           # single snapshot, then exit
npm run queue:status -- --job <jobId>    # inspect one job
npm run queue:status -- --deadLetter     # list dead-lettered jobs in detail
npm run queue:status -- --retry <jobId>  # retry one dead-lettered job
npm run queue:status -- --retryAll       # retry ALL dead-lettered jobs
```

**Log files:** `./logs/` — structured JSON, one per run (Phase 1.9). Each line is a JSON object with `ts`, `level`, `phase`, `msg`, and contextual fields. `LOG_LEVEL=debug` for verbose; default is `info`.

## Common Alerts & Remediation

| Alert | Likely cause | Fix |
|---|---|---|
| High proxy burn (> 20% pool) | IPs flagged, too aggressive, or provider issue | Lower `--maxRPM`, add fresh proxies, switch `--proxyStrategy random` if on sticky, rotate provider |
| CAPTCHA budget exceeded early | IPs heavily flagged, or budget too low for run size | Raise `--captchaBudget`, reduce `--workers`, swap proxy pool, check if running from a datacenter IP |
| Worker pool shrinking (`retiredCount > 0`) | Site is blocking workers faster than they recover | Increase `--workerCooldownMs`, lower `--maxRPM`, rotate proxies, check `data/proxy_burn_log.jsonl` |
| Extraction rate crash (exit code 3) | Google Maps DOM changed; selectors broken | Check `data/selector-debug/` for card HTML samples, re-verify selectors in `src/extract.js`, bump version in `src/selectors/version.js`. Emergency: `--skipHealthCheck` (not recommended) |
| RSS approaching `--maxRssMb` | Memory leak or too many workers for the box | Lower `--workers`, set `--contextRestartEvery 25`, check for orphaned Chromium (`pgrep -f chromium`), run with `node --expose-gc` |
| Queue backlog growing | `--queueConcurrency` too low, or workers all blocked | Raise `--queueConcurrency` (but keep `<= --workers`), add workers, check `data/proxy_burn_log.jsonl` |
| Orphaned Chromium processes | Previous crash left zombies | Reaper cleans on startup; manual: `pkill -f 'chromium\|chrome\|headless_shell'` (verify before killing) |
| 0% detail success | Detail-panel selectors broken or site returning login walls | Re-run with `--workers 1 --logLevel debug` to inspect a single detail flow; check `data/selector-debug/` |
| `--queue on` won't start | Redis unreachable | `docker compose ps redis`, verify `REDIS_URL`, check `docker compose logs redis` |
| Second run not a cache hit | `last_list_scraped` older than `--listFreshnessDays`, or `--output db` not set | Verify `--incremental` + `--output db` both present; query `last_list_scraped` in DB |

## Troubleshooting

**Q: Run aborted with exit code 3.**
A: Selector failure (Phase 2.11). The startup health check (or first-batch abort) found core fields — name, rating, reviews_count, address — below 50%, meaning Google changed the Maps DOM. Check `data/selector-debug/` for captured card HTML samples. Re-verify selectors in `src/extract.js` against a fixture, bump version + `lastVerifiedDate` in `src/selectors/version.js`, re-run `npm test tests/selectors-fixture.test.js`. For an emergency one-off run, `--skipHealthCheck` bypasses the startup check (but the first-batch abort still fires — use only when you've confirmed the selectors work on the current DOM).

**Q: All proxies burned within the first hour.**
A: Either the provider is serving dead IPs, or you're too aggressive. Lower `--maxRPM` (try 15–20), increase the proxy pool size, add a `--proxyHealthCheck` run to filter dead IPs at startup. Check `data/proxy_burn_log.jsonl` — if most burns are HTTP 407, credentials are bad (fix the list). If most are 429s, Google is rate-limiting your IPs specifically — rotate provider or wait.

**Q: CAPTCHA budget hit in the first 500 businesses.**
A: Either your IPs are flagged (typical for datacenter ranges) or your budget is too low for the run size. At ~$0.003/solve, $5 covers ~1,600 solves — a healthy 10k run with good proxies might need only 50–200 solves. If you're solving 1-in-3 businesses, rotate proxies. Raise `--captchaBudget` for the current run, or reduce `--workers` (less parallel pressure on each IP).

**Q: Workers keep retiring (pool size shrinking).**
A: The site is blocking workers faster than they recover. Increase `--workerCooldownMs` (default 5 min — try 10 min), lower `--maxRPM` (try 15), rotate proxies, switch to `--workerLoadBalancer least-busy` if task lengths are uneven. If `retiredCount` keeps climbing, abort and investigate the block pattern in the logs before burning more proxy budget.

**Q: Heap growing over time.**
A: Chrome memory leak (Playwright/Chromium known issue). Set `--contextRestartEvery 25` (default 50 — lower it to force more frequent restarts). Lower `--workers` so each has more headroom under `--maxHeapMb`. Check for orphaned Chromium processes (`pgrep -f chromium`) — if present, the zombie reaper missed them (kill manually). Running with `node --expose-gc src/index.js` lets the degradation handler call `global.gc()` under RSS pressure.

**Q: Queue stalled — no jobs processing.**
A: Redis is down or unreachable. `docker compose ps redis` (or `redis-cli ping` against your external Redis). Verify `--redisUrl` / `REDIS_URL`. If Redis restarted, jobs persisted in BullMQ's Redis storage resume automatically — restart the worker process with `--queue on`. If the queue is up but stalled, check the worker probe logs for unresponsive-browser detection (3 consecutive probe timeouts -> worker force-restart).

**Q: Second incremental run takes as long as the first.**
A: Either `--incremental` was omitted, `--output db` was not set (incremental requires DB), or the previous run didn't complete (no `last_list_scraped` stamped). Verify both flags are present. Query `SELECT last_list_scraped FROM businesses WHERE query='...' AND location='...';` — if NULL, the previous run crashed before persisting. Also check `--listFreshnessDays` isn't 0 (which forces everything stale).

## Graceful Shutdown & Recovery

**SIGINT (Ctrl-C):** the scraper registers a handler that finishes in-flight tasks, writes the checkpoint (Phase 1.7), reaps orphaned Chromium processes, and exits with code 130. The checkpoint is preserved on disk for `--resume`.

**Resume:** rerun with `--resume` to continue from `.checkpoint.json`. Already-extracted businesses are deduped (skipped), and detail-scrape picks up where it left off. For `--queue on` runs, jobs persist in Redis — a process crash resumes the queue on restart (no `--resume` needed for the queue itself; the search job picks up its checkpoint).

**Checkpoint file:** `.checkpoint.json` in the working directory. Written every `--checkpointInterval` businesses (default 10) during deep-scrape. Cleared on successful completion. `--fresh` ignores/deletes the checkpoint and starts from scratch.

**Dead-letter recovery:** jobs that exhaust `--queueAttempts` retries are dead-lettered for manual inspection. List with `npm run queue:status -- --deadLetter`. Retry one or all:

```bash
npm run queue:status -- --retry <jobId>
npm run queue:status -- --retryAll
```

`queue.deadLetter.retryAll()` semantics: every dead-lettered job is re-queued with its original priority and the attempt counter reset. Use `--retryAll` after fixing the root cause (bad proxies, broken selectors, etc.) — otherwise the jobs will dead-letter again.

## Cost Management

- **CAPTCHA:** ~$0.003/solve (2captcha), ~$0.002 (anticaptcha), ~$0.0008 (capsolver). Budget-guarded by `--captchaBudget` (default $5, hard stop). At $5 / $0.003, you get ~1,600 solves — ample for a 10k run with good proxies (typical: 50–200 solves).
- **Proxy provider:** external cost, varies by provider (Bright Data, Smartproxy, Oxylabs, etc.). The scraper does not bill — track this on the provider's dashboard.
- **Compute:** RAM-bound. ~5 workers fit on an 8GB box; ~3 on a 4GB box. CPU is rarely the bottleneck (Playwright is mostly idle waiting on network).
- **Master roadmap positioning:** Phase 2 runs are sellable as bulk orders at $500–$2k per run (per `SCRAPER_FEATURES.md`). A $5 CAPTCHA budget + a $20–50 proxy spend + a few hours of compute = a deliverable that fetches $500+. The unit economics work because `--incremental` makes repeat runs for the same client nearly free (cache hit < 30s, ~0 requests).

## Post-Run

1. **Verify outputs** in `./data/`: CSV + JSON files (and DB rows if `--output db|all`). Confirm row count matches expected.
2. **Query the DB for a run summary:**
   ```sql
   SELECT id, query, location, started_at, finished_at, extracted, failed,
          db_inserted, db_updated, db_unchanged, changes_detected, exit_code
     FROM scrape_runs ORDER BY id DESC LIMIT 5;
   ```
3. **Review change-tracking deltas** (Phase 2.2) — the high-value deliverable for repeat clients:
   ```bash
   npm run db:history -- --placeId ChIJxxx --limit 20
   ```
   Or aggregate: `SELECT field, count(*) FROM field_changes WHERE run_id = <latest> GROUP BY field;`
4. **Archive logs:** `tar -czf logs/run-<id>-<date>.tgz logs/<run-log>.jsonl`. Keep `data/captcha_cost_log.jsonl` and `data/proxy_burn_log.jsonl` for billing reconciliation and provider charge disputes.
5. **Plan the next incremental run:** with `--incremental` and 1-day `--listFreshnessDays`, a re-scrape of the same (query, location) pairs the next day is a cache hit for unchanged businesses — only changed ones hit Google. Schedule weekly re-scrapes for trend tracking; the `field_changes` table accumulates the history clients pay for.
