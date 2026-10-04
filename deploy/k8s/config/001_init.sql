\set ON_ERROR_STOP on
BEGIN;
CREATE SCHEMA IF NOT EXISTS ledger;
REVOKE ALL ON SCHEMA ledger FROM PUBLIC;
CREATE TABLE IF NOT EXISTS ledger.records (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE,
  hash text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$'),
  prev_hash text NOT NULL,
  written_at timestamptz NOT NULL,
  call_id text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('intent', 'outcome')),
  line text NOT NULL
);
CREATE INDEX IF NOT EXISTS records_written_at ON ledger.records (written_at, seq);
CREATE INDEX IF NOT EXISTS records_call_id ON ledger.records (call_id);
CREATE OR REPLACE FUNCTION ledger.refuse_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ledger.records is append-only'; END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'ledger.records'::regclass AND tgname = 'records_append_only') THEN
    CREATE TRIGGER records_append_only BEFORE UPDATE OR DELETE ON ledger.records
      FOR EACH ROW EXECUTE FUNCTION ledger.refuse_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'ledger.records'::regclass AND tgname = 'records_no_truncate') THEN
    CREATE TRIGGER records_no_truncate BEFORE TRUNCATE ON ledger.records
      EXECUTE FUNCTION ledger.refuse_mutation();
  END IF;
END $$;
-- Fire even when the superuser sets session_replication_role=replica; explicit disable/drop remains an admin power.
ALTER TABLE ledger.records ENABLE ALWAYS TRIGGER records_append_only;
ALTER TABLE ledger.records ENABLE ALWAYS TRIGGER records_no_truncate;
-- psql quotes password literals; reruns deliberately do not rotate existing role passwords.
SELECT format('CREATE ROLE ledger_app LOGIN PASSWORD %L', :'app_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_app') \gexec
SELECT format('CREATE ROLE ledger_reader LOGIN PASSWORD %L', :'reader_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_reader') \gexec
REVOKE ALL ON ledger.records FROM PUBLIC, ledger_app, ledger_reader;
GRANT USAGE ON SCHEMA ledger TO ledger_app, ledger_reader;
GRANT SELECT, INSERT ON ledger.records TO ledger_app;
GRANT SELECT ON ledger.records TO ledger_reader;
COMMIT;
