#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

read_env() {
  local key="$1"
  local fallback="$2"
  local value="${!key:-}"
  if [ -n "${value}" ]; then
    printf '%s' "${value}"
    return
  fi

  if [ -f .env ]; then
    local line
    line="$(grep -E "^${key}=" .env | tail -n 1 || true)"
    if [ -n "${line}" ]; then
      value="${line#*=}"
      value="${value%\"}"
      value="${value#\"}"
      printf '%s' "${value}"
      return
    fi
  fi

  printf '%s' "${fallback}"
}

MYSQL_ROOT_PASSWORD="$(read_env MYSQL_ROOT_PASSWORD root)"
MYSQL_DATABASE_CORE="$(read_env MYSQL_DATABASE_CORE copart_core)"
MYSQL_DATABASE_MEDIA="$(read_env MYSQL_DATABASE_MEDIA copart_media)"

echo "[db-reset] Ensuring MySQL container is running..."
docker compose up -d mysql >/dev/null

echo "[db-reset] Waiting for MySQL..."
until docker compose exec -T mysql mysqladmin ping -h 127.0.0.1 -uroot -p"${MYSQL_ROOT_PASSWORD}" --silent >/dev/null 2>&1; do
  sleep 2
done

SQL="
SET FOREIGN_KEY_CHECKS=0;
TRUNCATE TABLE \`${MYSQL_DATABASE_MEDIA}\`.\`photo_fetch_attempts\`;
TRUNCATE TABLE \`${MYSQL_DATABASE_MEDIA}\`.\`lot_images\`;
TRUNCATE TABLE \`${MYSQL_DATABASE_CORE}\`.\`lots\`;
TRUNCATE TABLE \`${MYSQL_DATABASE_CORE}\`.\`ingest_runs\`;
TRUNCATE TABLE \`${MYSQL_DATABASE_CORE}\`.\`photo_runs\`;
TRUNCATE TABLE \`${MYSQL_DATABASE_CORE}\`.\`app_locks\`;
SET FOREIGN_KEY_CHECKS=1;
"

echo "[db-reset] Truncating runtime tables..."
docker compose exec -T mysql mysql --force -uroot -p"${MYSQL_ROOT_PASSWORD}" -e "${SQL}"

echo "[db-reset] Done."
