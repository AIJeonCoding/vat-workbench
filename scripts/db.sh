#!/usr/bin/env bash
# 로컬 테스트용 PostgreSQL을 프로젝트 안(.pgdata)에서 5433 포트로 띄운다.
set -euo pipefail
PG_BIN="${PG_BIN:-$(dirname "$(command -v pg_ctl || echo /opt/homebrew/opt/postgresql@16/bin/pg_ctl)")}"
DATA="$(cd "$(dirname "$0")/.." && pwd)/.pgdata"
PORT="${PGPORT:-5433}"

case "${1:-start}" in
  start)
    if [ ! -d "$DATA" ]; then
      "$PG_BIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 >/dev/null
    fi
    "$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA/server.log" -w start
    for db in vat vat_test; do
      "$PG_BIN/psql" -h /tmp -p "$PORT" -U postgres -tc "select 1 from pg_database where datname='$db'" | grep -q 1 \
        || "$PG_BIN/createdb" -h /tmp -p "$PORT" -U postgres "$db"
    done
    ;;
  stop)
    "$PG_BIN/pg_ctl" -D "$DATA" -m fast stop
    ;;
esac
