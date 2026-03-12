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
MYSQL_USER="$(read_env MYSQL_USER copart)"
MYSQL_PASSWORD="$(read_env MYSQL_PASSWORD copart)"

echo "[db-drop] Ensuring MySQL container is running..."
docker compose up -d mysql >/dev/null

echo "[db-drop] Waiting for MySQL..."
until docker compose exec -T mysql mysqladmin ping -h 127.0.0.1 -uroot -p"${MYSQL_ROOT_PASSWORD}" --silent >/dev/null 2>&1; do
  sleep 2
done

SQL="
DROP DATABASE IF EXISTS \`${MYSQL_DATABASE_CORE}\`;
DROP DATABASE IF EXISTS \`${MYSQL_DATABASE_MEDIA}\`;
CREATE DATABASE \`${MYSQL_DATABASE_CORE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE \`${MYSQL_DATABASE_MEDIA}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${MYSQL_USER}'@'%' IDENTIFIED BY '${MYSQL_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE_CORE}\`.* TO '${MYSQL_USER}'@'%';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE_MEDIA}\`.* TO '${MYSQL_USER}'@'%';
FLUSH PRIVILEGES;
"

echo "[db-drop] Dropping and recreating databases..."
docker compose exec -T mysql mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" -e "${SQL}"

echo "[db-drop] Done. Run migrations next: make migrate"
