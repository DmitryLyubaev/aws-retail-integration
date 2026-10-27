import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
test("offline infrastructure has native encrypted state locking and no paid ingress or scaling resources", () => {
  const files = readdirSync("infra/session").filter((f) => f.endsWith(".tf"));
  const text = files
    .map((f) => readFileSync("infra/session/" + f, "utf8"))
    .join("\n");
  assert.match(text, /use_lockfile\s*=\s*true/);
  assert.match(text, /encrypt\s*=\s*true/);
  assert.doesNotMatch(
    text,
    /resource\s+"aws_(?:nat_gateway|lb|alb|eip|vpc_endpoint|appautoscaling_[^"]+)"/,
  );
  assert.doesNotMatch(text, /from_port\s*=\s*3000/);
  for (const stack of ["bootstrap", "session"]) {
    const lock = readFileSync(
      "infra/" + stack + "/.terraform.lock.hcl",
      "utf8",
    );
    assert.match(lock, /version\s*=\s*"6\.70\.0"/);
    assert.ok((lock.match(/h1:/g) ?? []).length >= 2);
  }
});
