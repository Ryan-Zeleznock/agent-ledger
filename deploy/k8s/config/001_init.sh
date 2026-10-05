#!/bin/sh
set -eu
# Only this hook goes in initdb.d. SQL is mounted elsewhere to avoid a second execution without variables.
: "${LEDGER_APP_PASSWORD:?missing app password}"
: "${LEDGER_READER_PASSWORD:?missing reader password}"
# server audit P3 (2026-10-05): the superuser may not log in over TCP at all (first matching pg_hba line wins). Local
# socket access via `kubectl exec` stays the cluster-admin path (HOMELAB step 8). Runs once, at initdb.
sed -i '1i host all postgres all reject' "$PGDATA/pg_hba.conf"
psql -X --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --set "app_pw=$LEDGER_APP_PASSWORD" --set "reader_pw=$LEDGER_READER_PASSWORD" \
  --file /etc/agent-ledger-init/001_init.sql
