-- P02 roles, job table and dispatch table (owner decisions Y34/Y35).
--
-- Runs as the P02 migration role, never as a runtime role. The migration role
-- owns every object below; FORCE ROW LEVEL SECURITY binds it like any other
-- role, so even the owner reads no tenant row without a tenant context.
--
-- Runtime roles are NOLOGIN, NOSUPERUSER, NOBYPASSRLS. Deployments connect
-- with a LOGIN role that is a member of exactly one of them and drops to it
-- with SET LOCAL ROLE inside each transaction.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'p02_api') THEN
    CREATE ROLE p02_api NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'p02_worker') THEN
    CREATE ROLE p02_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

CREATE SCHEMA p02;
REVOKE ALL ON SCHEMA p02 FROM PUBLIC;
GRANT USAGE ON SCHEMA p02 TO p02_api, p02_worker;

-- One row per job, tenant-private. The command is the p02-job.v1 command
-- document exactly as validated by the API; its identity fields must agree
-- with the row so a row cannot carry another tenant's command.
CREATE TABLE p02.jobs (
  tenant_id text NOT NULL
    CONSTRAINT jobs_tenant_format CHECK (tenant_id ~ '^ten_[a-z0-9]{16,64}$'),
  job_id text NOT NULL
    CONSTRAINT jobs_job_format CHECK (job_id ~ '^[a-z][a-z0-9_-]{2,127}$'),
  idempotency_key text NOT NULL
    CONSTRAINT jobs_idempotency_format CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  operation text NOT NULL
    CONSTRAINT jobs_operation_known CHECK (operation IN ('fetch-source')),
  command jsonb NOT NULL
    CONSTRAINT jobs_command_bounded CHECK (octet_length(command::text) <= 65536),
  state text NOT NULL DEFAULT 'queued'
    CONSTRAINT jobs_state_known CHECK (state IN ('queued', 'running', 'succeeded', 'refused', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT jobs_attempts_bounded CHECK (attempts BETWEEN 0 AND 100),
  result jsonb
    CONSTRAINT jobs_result_bounded CHECK (result IS NULL OR octet_length(result::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, job_id),
  CONSTRAINT jobs_idempotency_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT jobs_command_matches_row CHECK (
    command->>'schemaVersion' = 'libre-ai.p02-job.v1'
    AND command->>'kind' = 'command'
    AND command->>'tenantId' = tenant_id
    AND command->>'jobId' = job_id
    AND command->>'idempotencyKey' = idempotency_key
    AND command->'operation'->>'type' = operation
  ),
  CONSTRAINT jobs_result_matches_row CHECK (
    result IS NULL OR (
      result->>'schemaVersion' = 'libre-ai.p02-job.v1'
      AND result->>'kind' = 'result'
      AND result->>'tenantId' = tenant_id
      AND result->>'jobId' = job_id
      AND result->>'status' = state
    )
  )
);

ALTER TABLE p02.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE p02.jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY jobs_tenant_isolation ON p02.jobs
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT ON p02.jobs TO p02_api;
GRANT SELECT ON p02.jobs TO p02_worker;
GRANT UPDATE (state, attempts, result, updated_at) ON p02.jobs TO p02_worker;

-- Dispatch: identifiers and timing only, no command, no result. It is the one
-- table the worker reads across tenants, to learn which tenant context to
-- enter next; everything it then reads goes through the tenant policy above.
CREATE TABLE p02.job_dispatch (
  tenant_id text NOT NULL,
  job_id text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_expires_at timestamptz,
  claims integer NOT NULL DEFAULT 0 CONSTRAINT dispatch_claims_bounded CHECK (claims BETWEEN 0 AND 100),
  PRIMARY KEY (tenant_id, job_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES p02.jobs (tenant_id, job_id) ON DELETE CASCADE,
  CONSTRAINT dispatch_lease_complete CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX job_dispatch_ready ON p02.job_dispatch (available_at, tenant_id, job_id);

ALTER TABLE p02.job_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE p02.job_dispatch FORCE ROW LEVEL SECURITY;
-- The API only ever inserts the dispatch row of a job of its own tenant.
CREATE POLICY dispatch_api_enqueue ON p02.job_dispatch FOR INSERT TO p02_api
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
-- The worker sees every dispatch row: they carry identifiers only.
CREATE POLICY dispatch_worker ON p02.job_dispatch FOR ALL TO p02_worker
  USING (true) WITH CHECK (true);

GRANT INSERT ON p02.job_dispatch TO p02_api;
GRANT SELECT, UPDATE (available_at, lease_token, lease_expires_at, claims), DELETE
  ON p02.job_dispatch TO p02_worker;

-- Every new job is dispatchable in the same transaction; an idempotent
-- re-enqueue that inserts nothing dispatches nothing.
CREATE FUNCTION p02.dispatch_new_job() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, p02 AS $$
BEGIN
  INSERT INTO p02.job_dispatch (tenant_id, job_id) VALUES (NEW.tenant_id, NEW.job_id);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION p02.dispatch_new_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION p02.dispatch_new_job() TO p02_api;
CREATE TRIGGER jobs_dispatch AFTER INSERT ON p02.jobs
  FOR EACH ROW EXECUTE FUNCTION p02.dispatch_new_job();
