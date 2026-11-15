#!/usr/bin/env bash
# 마이그레이션과 RLS 를 임시 로컬 Postgres 에서 검증한다. (Postgres 15+ 의 initdb/pg_ctl/psql 필요)
#   bash supabase/tests/run-local.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="${PG_BIN:-$(dirname "$(command -v pg_ctl 2>/dev/null || ls /usr/lib/postgresql/*/bin/pg_ctl | tail -1)")}"
dir="$(mktemp -d)"
port="${PG_TEST_PORT:-54329}"
run() { if [ "$(id -u)" = 0 ]; then chown -R postgres "$dir"; su postgres -c "$*"; else bash -c "$*"; fi; }
cleanup() { run "'$bin/pg_ctl' -D '$dir/data' stop -m immediate" >/dev/null 2>&1 || true; rm -rf "$dir"; }
trap cleanup EXIT
run "'$bin/initdb' -D '$dir/data' -U postgres -A trust" >/dev/null
run "'$bin/pg_ctl' -D '$dir/data' -o '-p $port -c listen_addresses=127.0.0.1 -k $dir' -l '$dir/log' -w start" >/dev/null
for f in "$here/00_supabase_stub.sql" "$here"/../migrations/*.sql "$here/01_rls_test.sql"; do
  psql -h 127.0.0.1 -p "$port" -U postgres -v ON_ERROR_STOP=1 -q -f "$f" 2>&1 | sed -e 's/^psql:[^ ]* //' | { if [ -n "${VERBOSE:-}" ]; then cat; else grep -v '^NOTICE:  PASS' || true; fi; }
  [ "${PIPESTATUS[0]}" = 0 ] || { echo "실패: $f"; exit 1; }
done
echo "OK"
