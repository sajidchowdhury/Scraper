#!/usr/bin/env bash
#
# scripts/run-10k.sh — Phase 2.13 — Definitive 10,000-listing overnight run
#
# The Phase 2 acceptance test. Submits 50 (query, location) pairs (~10,000
# expected businesses) to the queue, then runs a 5-worker pool with the full
# Phase 2 stack (proxy rotation, fingerprint, stealth, session rotation,
# incremental caching, CAPTCHA solving, deep-scrape) until the queue drains.
#
# Success criteria (from PHASE2_EXECUTION_PLAN.md §2.13):
#   - >= 95% of expected businesses extracted
#   - >= 90% detail-scrape success rate
#   - < 8 hours wall-clock
#   - < $5 USD CAPTCHA spend
#   - < 20% of proxy pool burned
#   - Zero crashes / OOM kills / orphaned processes
#
# Prerequisites:
#   - docker compose up -d  (PostgreSQL + Redis running)
#   - npm run db:migrate    (schema created)
#   - .env populated: DATABASE_URL, REDIS_URL, CAPTCHA_API_KEY, PROXY_LIST_FILE
#   - proxies.txt with >= 25 proxies (5 workers × 5 for rotation headroom)
#   - npx playwright install chromium
#
# Usage:
#   ./scripts/run-10k.sh                 # full run (default)
#   ./scripts/run-10k.sh --dryRun        # submit jobs but don't process (queue only)
#   ./scripts/run-10k.sh --workers 3     # fewer workers (lower-RAM machine)
#   ./scripts/run-10k.sh --captchaProvider mock   # no API cost (smoke test)
#
# Output:
#   - ./logs/phase2-10k-<timestamp>.log   (structured run log)
#   - ./benchmarks/phase2-10k-run.json    (summary — populated by the operator
#                                          from the run log + DB queries)
#
# Exit codes: 0 success, 1 prerequisite missing, 2 run failed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ---------------------------------------------------------------------------
# Defaults + arg parsing
# ---------------------------------------------------------------------------
WORKERS=5
CAPTCHA_PROVIDER="${CAPTCHA_PROVIDER:-2captcha}"
DRY_RUN=0
QUERIES_FILE="$ROOT_DIR/queries-10k.csv"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_DIR="$ROOT_DIR/logs"
RUN_LOG="$LOG_DIR/phase2-10k-$TIMESTAMP.log"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workers) WORKERS="$2"; shift 2 ;;
    --captchaProvider) CAPTCHA_PROVIDER="$2"; shift 2 ;;
    --dryRun) DRY_RUN=1; shift ;;
    --queries) QUERIES_FILE="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$LOG_DIR" "$ROOT_DIR/benchmarks"

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------
echo "[run-10k] Phase 2.13 — definitive 10,000-listing overnight run"
echo "[run-10k] workers=$WORKERS captchaProvider=$CAPTCHA_PROVIDER dryRun=$DRY_RUN"
echo "[run-10k] queries=$QUERIES_FILE"
echo "[run-10k] log=$RUN_LOG"

fail() { echo "[run-10k] PREREQUISITE FAILED: $1" >&2; exit 1; }

[[ -f "$QUERIES_FILE" ]] || fail "queries file not found: $QUERIES_FILE (generate with scripts/gen-10k-queries.js)"
[[ -f "$ROOT_DIR/.env" ]] || fail ".env not found (copy .env.example and populate DATABASE_URL, REDIS_URL, CAPTCHA_API_KEY, PROXY_LIST_FILE)"
command -v docker >/dev/null 2>&1 || fail "docker not installed"
docker compose ps --status running 2>/dev/null | grep -qE 'postgres|redis' \
  || fail "postgres/redis not running (run: docker compose up -d)"

# Confirm the DB is migrated (businesses table exists).
node -e "require('./src/db').runMigration(process.env.DATABASE_URL).then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})" \
  || fail "db:migrate failed (run: npm run db:migrate)"

# Confirm proxies are configured (unless --noProxy).
[[ -n "${PROXY_LIST_FILE:-}" ]] || fail "PROXY_LIST_FILE not set in .env (10k run requires proxies)"
[[ -f "${PROXY_LIST_FILE}" ]] || fail "proxy list file not found: $PROXY_LIST_FILE"
PROXY_COUNT=$(grep -cv '^\s*$\|^\s*#' "$PROXY_LIST_FILE" || true)
echo "[run-10k] proxies available: $PROXY_COUNT"
[[ "$PROXY_COUNT" -ge "$WORKERS" ]] || fail "need >= $WORKERS proxies, found $PROXY_COUNT"

# Confirm CAPTCHA API key (unless mock/none).
if [[ "$CAPTCHA_PROVIDER" != "mock" && "$CAPTCHA_PROVIDER" != "none" ]]; then
  [[ -n "${CAPTCHA_API_KEY:-}" ]] || fail "CAPTCHA_API_KEY not set (required for $CAPTCHA_PROVIDER)"
fi

echo "[run-10k] prerequisites OK"

# ---------------------------------------------------------------------------
# Step 1 — batch-submit the 50 search jobs to the queue
# ---------------------------------------------------------------------------
echo "[run-10k] step 1/2 — submitting $(grep -cv '^\s*$\|^\s*#' "$QUERIES_FILE") jobs to the queue..."
npm run batch -- --file "$QUERIES_FILE" --queue on --redisUrl "${REDIS_URL:-redis://localhost:6379}" 2>&1 | tee -a "$RUN_LOG"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[run-10k] --dryRun: jobs submitted, not processing. Monitor with: npm run queue:status"
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 2 — run the 5-worker pool against the queue until it drains
# ---------------------------------------------------------------------------
echo "[run-10k] step 2/2 — starting $WORKERS-worker pool (this is the overnight run)..."
START_EPOCH=$(date +%s)

# The canonical Phase 2.13 command (from PHASE2_EXECUTION_PLAN.md §2.13).
# --endless keeps the worker pulling until the queue is empty + SIGINT, then
# it drains + exits cleanly. Monitor in another terminal: npm run queue:status.
npm start -- \
  --workers "$WORKERS" \
  --queue on \
  --incremental \
  --deepScrape true \
  --captchaProvider "$CAPTCHA_PROVIDER" \
  --proxyStrategy random \
  --sessionLength 50 \
  --endless \
  2>&1 | tee -a "$RUN_LOG" &
SCRAPER_PID=$!

echo "[run-10k] scraper PID=$SCRAPER_PID. Monitor: npm run queue:status"
echo "[run-10k] To stop after the queue drains, send SIGINT: kill -INT $SCRAPER_PID"
echo "[run-10k] (the scraper finishes in-flight jobs + writes checkpoint on SIGINT)"

wait "$SCRAPER_PID" || true
END_EPOCH=$(date +%s)
WALL_SECONDS=$((END_EPOCH - START_EPOCH))
WALL_HOURS=$(awk "BEGIN{printf \"%.2f\", $WALL_SECONDS/3600}")

echo "[run-10k] run finished. wall-clock: ${WALL_HOURS}h (${WALL_SECONDS}s)"

# ---------------------------------------------------------------------------
# Step 3 — capture the summary to benchmarks/phase2-10k-run.json
# ---------------------------------------------------------------------------
echo "[run-10k] step 3/3 — capturing summary to benchmarks/phase2-10k-run.json"

# Query the DB for the run totals + verify success criteria.
node -e '
const { createPool, closePool } = require("./src/db");
const fs = require("fs");
(async () => {
  const pool = createPool(process.env.DATABASE_URL);
  if (!pool) { console.error("DATABASE_URL not set"); process.exit(1); }
  const b = await pool.query("SELECT COUNT(*) AS n FROM businesses");
  const r = await pool.query("SELECT COUNT(*) AS runs, COALESCE(SUM(extracted),0) AS extracted, COALESCE(SUM(db_inserted),0) AS ins, COALESCE(SUM(db_updated),0) AS upd, COALESCE(SUM(db_unchanged),0) AS unc, COALESCE(SUM(changes_detected),0) AS chg FROM scrape_runs WHERE started_at > NOW() - INTERVAL '\''12 hours'\''");
  const det = await pool.query("SELECT COUNT(*) FILTER (WHERE detail_scraped) AS scraped, COUNT(*) AS total FROM businesses WHERE last_detail_scraped > NOW() - INTERVAL '\''12 hours'\''");
  const summary = {
    metadata: {
      recordedAt: new Date().toISOString(),
      phase: "phase2-10k",
      purpose: "Phase 2.13 definitive 10,000-listing overnight acceptance run",
      command: "npm start -- --workers 5 --queue on --incremental --deepScrape true --captchaProvider 2captcha --proxyStrategy random --sessionLength 50 --endless",
      scraperVersion: require("./package.json").version,
      logFile: "'"$RUN_LOG"'",
      wallClockSeconds: '"$WALL_SECONDS"',
      wallClockHours: '"$WALL_HOURS"',
    },
    results: {
      totalBusinesses: Number(b.rows[0].n),
      runsInWindow: Number(r.rows[0].runs),
      extracted: Number(r.rows[0].extracted),
      dbInserted: Number(r.rows[0].ins),
      dbUpdated: Number(r.rows[0].upd),
      dbUnchanged: Number(r.rows[0].unc),
      changesDetected: Number(r.rows[0].chg),
      detailScraped: Number(det.rows[0].scraped),
      detailTotal: Number(det.rows[0].total),
    },
    criteria: {
      extractedPctOfTarget: null,
      detailSuccessPct: null,
      under8Hours: '"$WALL_HOURS"' < 8,
      captchaSpendUsd: null,
      proxyBurnPct: null,
      zeroCrashes: null,
    },
    note: "captchaSpendUsd + proxyBurnPct + zeroCrashes must be read from the run log (logs/captcha-cost.jsonl + proxy burn events). Populate criteria.* from the log before marking Phase 2 accepted.",
  };
  if (summary.results.detailTotal > 0) {
    summary.criteria.detailSuccessPct = Math.round(summary.results.detailScraped / summary.results.detailTotal * 1000) / 10;
  }
  if (summary.results.extracted > 0) {
    summary.criteria.extractedPctOfTarget = Math.round(summary.results.extracted / 10000 * 1000) / 10;
  }
  fs.writeFileSync("./benchmarks/phase2-10k-run.json", JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary.results, null, 2));
  await closePool(pool);
})().catch(e => { console.error(e.message); process.exit(1); });
'

echo "[run-10k] done. Review benchmarks/phase2-10k-run.json against the success criteria."
