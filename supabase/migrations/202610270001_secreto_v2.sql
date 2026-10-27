-- Review against scripts/inspect.sql before applying to the existing project.
-- Unknown legacy tables are deliberately not altered or imported.
BEGIN;
CREATE SCHEMA secreto_v2;
REVOKE ALL ON SCHEMA secreto_v2 FROM PUBLIC;
CREATE TABLE secreto_v2.events (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  exchange_date date NOT NULL,
  budget integer NOT NULL CHECK (budget BETWEEN 0 AND 100000000),
  currency text NOT NULL CHECK (currency IN ('USD','EUR','GBP','KES')),
  drawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE secreto_v2.participants (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES secreto_v2.events(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  normalized_name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  pin_hash text NOT NULL,
  recipient_id uuid,
  opened_at timestamptz,
  revealed_at timestamptz,
  UNIQUE(event_id, normalized_name),
  UNIQUE(event_id, id),
  UNIQUE(event_id, recipient_id),
  CHECK (recipient_id IS NULL OR recipient_id <> id),
  FOREIGN KEY(event_id, recipient_id) REFERENCES secreto_v2.participants(event_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE secreto_v2.sessions (
  token_hash text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('admin','participant')),
  participant_id uuid REFERENCES secreto_v2.participants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  CHECK ((role = 'admin' AND participant_id IS NULL) OR (role = 'participant' AND participant_id IS NOT NULL))
);
CREATE INDEX sessions_expiry ON secreto_v2.sessions(expires_at);
CREATE TABLE secreto_v2.attempts (key text PRIMARY KEY, count integer NOT NULL, reset_at timestamptz NOT NULL);
CREATE INDEX attempts_expiry ON secreto_v2.attempts(reset_at);
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'secreto_app') THEN
    CREATE ROLE secreto_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA secreto_v2 TO secreto_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA secreto_v2 TO secreto_app;
ALTER TABLE secreto_v2.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE secreto_v2.participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE secreto_v2.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE secreto_v2.attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY server_only ON secreto_v2.events TO secreto_app USING (true) WITH CHECK (true);
CREATE POLICY server_only ON secreto_v2.participants TO secreto_app USING (true) WITH CHECK (true);
CREATE POLICY server_only ON secreto_v2.sessions TO secreto_app USING (true) WITH CHECK (true);
CREATE POLICY server_only ON secreto_v2.attempts TO secreto_app USING (true) WITH CHECK (true);
REVOKE ALL ON ALL TABLES IN SCHEMA secreto_v2 FROM PUBLIC;
COMMIT;
