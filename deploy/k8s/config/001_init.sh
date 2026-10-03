#!/bin/sh
set -eu
# Only this hook goes in initdb.d. SQL is mounted elsewhere to avoid a second execution without variables.
: "${LEDGER_APP_PASSWORD:?missing app password}"
: "${LEDGER_READER_PASSWORD:?missing reader password}"
psql -X --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --set "app_pw=$LEDGER_APP_PASSWORD" --set "reader_pw=$LEDGER_READER_PASSWORD" \
  --file /etc/agent-ledger-init/001_init.sql
