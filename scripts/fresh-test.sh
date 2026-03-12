#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

INGEST_MAX_ROWS="${INGEST_MAX_ROWS:-1000}"
PHOTO_WORKER_TOTAL="${PHOTO_WORKER_TOTAL:-12}"
PHOTO_BATCH_SIZE="${PHOTO_BATCH_SIZE:-1000}"
PHOTO_FETCH_CONCURRENCY="${PHOTO_FETCH_CONCURRENCY:-150}"
PHOTO_PROGRESS_EVERY_LOTS="${PHOTO_PROGRESS_EVERY_LOTS:-10}"
PHOTO_HTTP_MODE="${PHOTO_HTTP_MODE:-proxy}"
PROXY_LIST_FILE="${PROXY_LIST_FILE:-./proxies.txt}"
PROXY_AUTO_SELECT_FOR_PHOTO="${PROXY_AUTO_SELECT_FOR_PHOTO:-true}"
PROXY_AUTO_SELECT_PROBE_LOTS="${PROXY_AUTO_SELECT_PROBE_LOTS:-20}"
PROXY_MAX_ROUTES_PER_REQUEST="${PROXY_MAX_ROUTES_PER_REQUEST:-5}"
PROXY_PREFLIGHT_TOP_N="${PROXY_PREFLIGHT_TOP_N:-300}"
PROXY_PREFLIGHT_CONCURRENCY="${PROXY_PREFLIGHT_CONCURRENCY:-300}"
PROXY_PREFLIGHT_TIMEOUT_MS="${PROXY_PREFLIGHT_TIMEOUT_MS:-12000}"
PROXY_PREFLIGHT_MIN_WORKING="${PROXY_PREFLIGHT_MIN_WORKING:-250}"
PHOTO_HTTP_TIMEOUT_MS="${PHOTO_HTTP_TIMEOUT_MS:-12000}"
MYSQL_POOL_MIN="${MYSQL_POOL_MIN:-2}"
MYSQL_POOL_MAX="${MYSQL_POOL_MAX:-10}"
PHOTO_ENDPOINT_RETRIES="${PHOTO_ENDPOINT_RETRIES:-1}"
PHOTO_IMAGE_RETRIES="${PHOTO_IMAGE_RETRIES:-1}"
PHOTO_VALIDATE_BY_HEAD_FIRST="${PHOTO_VALIDATE_BY_HEAD_FIRST:-false}"

started_epoch="$(date +%s)"

print_summary() {
  echo "== RESULT SUMMARY =="
  docker compose exec -T mysql sh -lc "
mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -e \"
SELECT id,status,worker_total,workers_finished,workers_succeeded,workers_failed,
       total_lots_scanned,total_lots_processed,total_lots_ok,total_lots_missing,total_images_upserted,
       ROUND(TIMESTAMPDIFF(MICROSECOND,started_at,finished_at)/1000000,2) AS duration_sec,error_message
FROM copart_core.photo_cluster_runs
ORDER BY id DESC
LIMIT 3;

SELECT id,cluster_run_id,worker_index,worker_total,status,lots_scanned,lots_processed,lots_ok,lots_missing,images_upserted,
       http_404_count,ROUND(TIMESTAMPDIFF(MICROSECOND,started_at,finished_at)/1000000,2) AS duration_sec,error_message
FROM copart_core.photo_runs
ORDER BY id DESC
LIMIT 12;

SET @cluster_id=(SELECT id FROM copart_core.photo_cluster_runs ORDER BY id DESC LIMIT 1);
SELECT cluster_run_id,id AS photo_run_id,worker_index,worker_total,status,lots_scanned,lots_processed,lots_ok,lots_missing,
       images_upserted,http_404_count,
       ROUND(TIMESTAMPDIFF(MICROSECOND,started_at,finished_at)/1000000,2) AS duration_sec,error_message
FROM copart_core.photo_runs
WHERE cluster_run_id=@cluster_id
ORDER BY worker_index;

SELECT id,status,rows_total,rows_valid,rows_inserted,rows_updated,rows_unchanged,
       ROUND(TIMESTAMPDIFF(MICROSECOND,started_at,finished_at)/1000000,2) AS duration_sec,error_message
FROM copart_core.ingest_runs
ORDER BY id DESC
LIMIT 3;

SET @s=(SELECT started_at FROM copart_core.photo_runs ORDER BY id DESC LIMIT 1);
SELECT attempt_type, COALESCE(CAST(http_status AS CHAR), 'NULL') AS http_status, COUNT(*) cnt
FROM copart_media.photo_fetch_attempts
WHERE attempted_at>=@s
GROUP BY attempt_type, http_status
ORDER BY attempt_type, cnt DESC;

SELECT attempt_type, error_code, COUNT(*) cnt
FROM copart_media.photo_fetch_attempts
WHERE attempted_at>=@s
  AND error_code IS NOT NULL
GROUP BY attempt_type, error_code
ORDER BY cnt DESC
LIMIT 20;
\"
" || true
}

finish() {
  local exit_code=$?
  print_summary
  ended_epoch="$(date +%s)"
  duration_sec="$((ended_epoch - started_epoch))"
  echo "== END $(date -Is) total_sec=${duration_sec} exit_code=${exit_code} =="
  exit "$exit_code"
}

trap finish EXIT

echo "== START $(date -Is) =="
echo "config: INGEST_MAX_ROWS=${INGEST_MAX_ROWS}, PHOTO_WORKER_TOTAL=${PHOTO_WORKER_TOTAL}, PHOTO_FETCH_CONCURRENCY=${PHOTO_FETCH_CONCURRENCY}, PHOTO_PROGRESS_EVERY_LOTS=${PHOTO_PROGRESS_EVERY_LOTS}, PHOTO_HTTP_MODE=${PHOTO_HTTP_MODE}, PROXY_MAX_ROUTES_PER_REQUEST=${PROXY_MAX_ROUTES_PER_REQUEST}, PROXY_PREFLIGHT_TOP_N=${PROXY_PREFLIGHT_TOP_N}, PROXY_PREFLIGHT_MIN_WORKING=${PROXY_PREFLIGHT_MIN_WORKING}"

echo "== STEP 1/6: Ensure MySQL is up =="
docker compose up -d mysql

echo "== STEP 2/6: Drop and recreate databases =="
./scripts/db-drop.sh

echo "== STEP 3/6: Run migrations =="
docker compose run --rm app node dist/index.js db:migrate

echo "== STEP 4/6: Ingest CSV (direct, limited rows) =="
docker compose run --rm \
  -e HTTP_MODE=direct \
  -e INGEST_MAX_ROWS="${INGEST_MAX_ROWS}" \
  app node dist/index.js ingest:csv

echo "== STEP 5/6: Pre-check due lots and shard split =="
docker compose exec -T mysql sh -lc "
mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" -e \"
SELECT COUNT(*) AS lots_total FROM copart_core.lots;
SELECT COUNT(*) AS due_total
FROM copart_core.lots
WHERE image_url IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM copart_media.lot_images li
    WHERE li.lot_number = lots.lot_number
      AND li.check_status = 'ok'
      AND li.is_full_size = 1
      AND li.variant = 'hd'
  )
  AND (
    photo_status = 'unknown'
    OR (photo_status = 'missing' AND (next_photo_retry_at IS NULL OR next_photo_retry_at <= CURRENT_TIMESTAMP(3)))
  );
SELECT MOD(CRC32(CAST(lot_number AS CHAR)), ${PHOTO_WORKER_TOTAL}) AS worker_shard, COUNT(*) AS due_lots
FROM copart_core.lots
WHERE image_url IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM copart_media.lot_images li
    WHERE li.lot_number = lots.lot_number
      AND li.check_status = 'ok'
      AND li.is_full_size = 1
      AND li.variant = 'hd'
  )
  AND (
    photo_status = 'unknown'
    OR (photo_status = 'missing' AND (next_photo_retry_at IS NULL OR next_photo_retry_at <= CURRENT_TIMESTAMP(3)))
  )
GROUP BY worker_shard
ORDER BY worker_shard;
\"
"

echo "== STEP 6/6: Run photo cluster =="
docker compose run --rm \
  -e HTTP_MODE="${PHOTO_HTTP_MODE}" \
  -e PROXY_LIST_FILE="${PROXY_LIST_FILE}" \
  -e PROXY_AUTO_SELECT_FOR_PHOTO="${PROXY_AUTO_SELECT_FOR_PHOTO}" \
  -e PROXY_AUTO_SELECT_PROBE_LOTS="${PROXY_AUTO_SELECT_PROBE_LOTS}" \
  -e PROXY_MAX_ROUTES_PER_REQUEST="${PROXY_MAX_ROUTES_PER_REQUEST}" \
  -e PROXY_PREFLIGHT_TOP_N="${PROXY_PREFLIGHT_TOP_N}" \
  -e PROXY_PREFLIGHT_CONCURRENCY="${PROXY_PREFLIGHT_CONCURRENCY}" \
  -e PROXY_PREFLIGHT_TIMEOUT_MS="${PROXY_PREFLIGHT_TIMEOUT_MS}" \
  -e PROXY_PREFLIGHT_MIN_WORKING="${PROXY_PREFLIGHT_MIN_WORKING}" \
  -e PHOTO_WORKER_TOTAL="${PHOTO_WORKER_TOTAL}" \
  -e PHOTO_BATCH_SIZE="${PHOTO_BATCH_SIZE}" \
  -e PHOTO_FETCH_CONCURRENCY="${PHOTO_FETCH_CONCURRENCY}" \
  -e PHOTO_PROGRESS_EVERY_LOTS="${PHOTO_PROGRESS_EVERY_LOTS}" \
  -e PHOTO_VALIDATE_BY_HEAD_FIRST="${PHOTO_VALIDATE_BY_HEAD_FIRST}" \
  -e PHOTO_ENDPOINT_RETRIES="${PHOTO_ENDPOINT_RETRIES}" \
  -e PHOTO_IMAGE_RETRIES="${PHOTO_IMAGE_RETRIES}" \
  -e PHOTO_HTTP_TIMEOUT_MS="${PHOTO_HTTP_TIMEOUT_MS}" \
  -e PHOTO_LOG_LOT_RESULTS=false \
  -e MYSQL_POOL_MIN="${MYSQL_POOL_MIN}" \
  -e MYSQL_POOL_MAX="${MYSQL_POOL_MAX}" \
  app node dist/index.js photo:cluster
