CREATE SCHEMA receiver AUTHORIZATION p14_migrator;
CREATE TABLE receiver.tenants (tenant_id text PRIMARY KEY);
CREATE TABLE receiver.credentials (
 token_sha256 char(64) PRIMARY KEY, tenant_id text NOT NULL REFERENCES receiver.tenants,
 actor_id text NOT NULL, purpose text NOT NULL CHECK (purpose IN ('integration','operator'))
);
CREATE TABLE receiver.sales (
 tenant_id text NOT NULL REFERENCES receiver.tenants, sale_reference text NOT NULL,
 delivery_id uuid NOT NULL, business_sha256 char(64) NOT NULL,
 total text NOT NULL, sale jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,sale_reference), UNIQUE (tenant_id,delivery_id)
);
CREATE TABLE receiver.receipts (
 tenant_id text NOT NULL, sale_reference text NOT NULL, receipt jsonb NOT NULL,
 PRIMARY KEY (tenant_id,sale_reference),
 FOREIGN KEY (tenant_id,sale_reference) REFERENCES receiver.sales
);
CREATE TABLE receiver.faults (
 tenant_id text NOT NULL REFERENCES receiver.tenants, sale_reference text NOT NULL,
 mode text NOT NULL CHECK (mode IN ('accept','reject_422','transient_503_once','commit_drop_once')),
 used boolean NOT NULL DEFAULT false, PRIMARY KEY (tenant_id,sale_reference)
);
GRANT USAGE ON SCHEMA receiver TO p14_receiver;
GRANT SELECT ON receiver.tenants,receiver.credentials TO p14_receiver;
GRANT SELECT,INSERT ON receiver.sales,receiver.receipts TO p14_receiver;
GRANT SELECT,INSERT,UPDATE ON receiver.faults TO p14_receiver;
