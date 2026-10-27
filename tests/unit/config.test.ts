import test from "node:test";
import assert from "node:assert/strict";
import { databaseConnection } from "../../src/config.js";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
test("AWS database configuration verifies TLS and constructs injected master credentials safely", () => {
  const env = {
    AWS_MODE: "true",
    DATABASE_HOST: "demo.synthetic.ap-southeast-2.rds.amazonaws.com",
    DATABASE_USER: "p14owner",
    DATABASE_PASSWORD: "synthetic+password:@",
    DATABASE_NAME: "retaildemo",
    DATABASE_OPTIONS: "?sslmode=verify-full&sslrootcert=/app/config/rds-ca.pem",
  };
  const url = new URL(databaseConnection(env));
  assert.throws(() => databaseConnection(env, "api"), {
    code: "invalid_database_role",
  });
  assert.equal(decodeURIComponent(url.password), env.DATABASE_PASSWORD);
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
  for (const change of [
    { DATABASE_OPTIONS: "?sslmode=disable" },
    { DATABASE_HOST: "localhost" },
    { DATABASE_OPTIONS: "?sslmode=verify-full&sslrootcert=/tmp/untrusted.pem" },
  ])
    assert.throws(() => databaseConnection({ ...env, ...change }), {
      code: "invalid_database_tls",
    });
  const text = readFileSync("config/rds-ca.pem", "utf8");
  const certs = text.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  )!;
  assert.equal(certs.length, 3);
  for (const pem of certs) {
    const cert = new X509Certificate(pem);
    assert.equal(cert.subject, cert.issuer);
    assert.equal(cert.ca, true);
  }
});
