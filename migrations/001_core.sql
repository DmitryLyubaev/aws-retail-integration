CREATE TABLE app.tenants (tenant_id text PRIMARY KEY);
CREATE TABLE app.events (
  tenant_id text NOT NULL REFERENCES app.tenants,
  delivery_id uuid NOT NULL,
  sale_reference text NOT NULL,
  raw bytea NOT NULL,
  raw_sha256 char(64) NOT NULL,
  canonical text NOT NULL,
  business_sha256 char(64) NOT NULL,
  sale jsonb NOT NULL,
  current_generation integer NOT NULL DEFAULT 1 CHECK (current_generation > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, delivery_id),
  UNIQUE (tenant_id, sale_reference)
);
CREATE TABLE app.event_aliases (
  tenant_id text NOT NULL, event_id text NOT NULL, delivery_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES app.events
);
CREATE TABLE app.generations (
  tenant_id text NOT NULL, delivery_id uuid NOT NULL, generation integer NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivering','retry_wait','delivered','failed')),
  failure_code text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL DEFAULT (now()+interval '300 seconds'),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  fence uuid, attempt_id uuid, lease_until timestamptz,
  receipt jsonb,
  PRIMARY KEY (tenant_id, delivery_id, generation),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES app.events
);
CREATE TABLE app.outbox (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, delivery_id uuid NOT NULL, generation integer NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','publishing','published','failed')),
  failures integer NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 5),
  fence uuid, lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, delivery_id, generation),
  FOREIGN KEY (tenant_id, delivery_id, generation) REFERENCES app.generations
);
CREATE TABLE app.attempts (
  tenant_id text NOT NULL, delivery_id uuid NOT NULL, generation integer NOT NULL,
  attempt_id uuid NOT NULL, fence uuid NOT NULL,
  state text NOT NULL DEFAULT 'claimed', code text,
  started_at timestamptz NOT NULL, finished_at timestamptz,
  PRIMARY KEY (tenant_id, delivery_id, generation, attempt_id),
  FOREIGN KEY (tenant_id, delivery_id, generation) REFERENCES app.generations
);
CREATE TABLE app.audit (
  id bigserial PRIMARY KEY, tenant_id text NOT NULL, delivery_id uuid NOT NULL, generation integer NOT NULL,
  at timestamptz NOT NULL DEFAULT now(), kind text NOT NULL, code text, attempt_id uuid,
  event_key text NOT NULL,
  UNIQUE (tenant_id, delivery_id, generation, event_key),
  FOREIGN KEY (tenant_id, delivery_id, generation) REFERENCES app.generations
);
CREATE TABLE app.replay_requests (
  tenant_id text NOT NULL, request_id text NOT NULL, delivery_id uuid NOT NULL,
  expected_generation integer NOT NULL, result_generation integer NOT NULL,
  PRIMARY KEY (tenant_id, request_id),
  FOREIGN KEY (tenant_id, delivery_id, result_generation) REFERENCES app.generations
);
CREATE TABLE app.quarantine (
  id uuid PRIMARY KEY, message_id text NOT NULL, body_sha256 char(64) NOT NULL, code text NOT NULL,
  tenant_id text, delivery_id uuid, generation integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, body_sha256)
);
CREATE INDEX outbox_due ON app.outbox (next_attempt_at) WHERE state IN ('pending','publishing');
CREATE INDEX generations_due ON app.generations (next_attempt_at) WHERE state IN ('pending','delivering','retry_wait');
GRANT USAGE ON SCHEMA app TO p14_app;
GRANT SELECT ON app.tenants TO p14_app;
GRANT SELECT, INSERT ON app.events TO p14_app;
GRANT UPDATE(current_generation) ON app.events TO p14_app;
GRANT SELECT, INSERT ON app.event_aliases, app.audit, app.replay_requests, app.quarantine TO p14_app;
GRANT SELECT, INSERT, UPDATE ON app.generations, app.outbox, app.attempts TO p14_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO p14_app;
