import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
test("offline CI has read-only permission, pinned actions and no AWS credentials", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(ci, /contents: read/);
  assert.doesNotMatch(ci, /id-token: write|configure-aws-credentials/);
  assert.match(ci, /image\.test\.ts/);
  for (const name of ["ci", "deploy", "destroy", "publish-image"]) {
    const text = readFileSync(".github/workflows/" + name + ".yml", "utf8");
    for (const match of text.matchAll(/uses:\s*([^\s#]+)/g))
      assert.match(match[1], /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+@[a-f0-9]{40}$/);
    assert.doesNotMatch(text, /run:\s*[^\n]*\$\{\{\s*inputs/);
  }
});
test("live workflows guard locally before OIDC and require main protected environment", () => {
  for (const name of ["deploy", "destroy", "publish-image"]) {
    const text = readFileSync(".github/workflows/" + name + ".yml", "utf8");
    assert.ok(
      text.indexOf("scripts/aws-session.mjs prepare") <
        text.indexOf("aws-actions/configure-aws-credentials@"),
    );
    assert.match(text, /environment: aws-demo/);
    assert.match(text, /refs\/heads\/main/);
    assert.match(text, /APPROVED_REPOSITORY/);
    assert.doesNotMatch(
      text,
      /path:\s*\.local\/|path:\s*results\/\*|path:\s*\*\*/,
    );
  }
});
