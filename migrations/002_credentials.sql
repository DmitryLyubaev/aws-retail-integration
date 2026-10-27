CREATE TABLE app.credentials (
  token_sha256 char(64) PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES app.tenants,
  actor_id text NOT NULL,
  permissions text[] NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);
GRANT SELECT ON app.credentials TO p14_app;
