-- Owner sessions of the P02 API (S0.4 groundwork; QN1 -> C mints them after a
-- passkey ceremony in the system browser).
--
-- Only the SHA-256 of a session token is stored. The API resolves a token by
-- putting its hash in the transaction-local `app.session_token_sha256` and
-- reading the one row it may see: the API role can never list sessions,
-- only look up the session it was handed. Minting and revocation belong to
-- the authentication flow and are granted with it, not here.
CREATE TABLE p02.sessions (
  token_sha256 text PRIMARY KEY
    CONSTRAINT sessions_token_hash_format CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  tenant_id text NOT NULL
    CONSTRAINT sessions_tenant_format CHECK (tenant_id ~ '^ten_[a-z0-9]{16,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
);

ALTER TABLE p02.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE p02.sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_lookup_by_token ON p02.sessions FOR SELECT TO p02_api
  USING (
    token_sha256 = current_setting('app.session_token_sha256', true)
    AND revoked_at IS NULL
    AND expires_at > now()
  );
GRANT SELECT ON p02.sessions TO p02_api;
