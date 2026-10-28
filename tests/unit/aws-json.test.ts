import test from "node:test";
import assert from "node:assert/strict";
import * as session from "../../scripts/aws-session.mjs";

const parse = (session as any).parseAwsJson;
function decode(result: any) {
  assert.equal(
    typeof parse,
    "function",
    "AWS JSON response normalization is required",
  );
  return parse(result);
}

for (const [name, stdout] of [
  ["empty", ""],
  ["whitespace", " \n\t"],
])
  test(`a successful quiet AWS ${name} response is an empty object`, () => {
    assert.deepEqual(decode({ code: 0, stdout, stderr: "" }), {});
  });

test("a successful JSON response retains its returned fields", () => {
  assert.deepEqual(decode({ code: 0, stdout: '{"Versions":[]}', stderr: "" }), {
    Versions: [],
  });
});

test("an unsuccessful empty AWS response remains an error", () => {
  assert.throws(
    () => decode({ code: 1, stdout: "", stderr: "AccessDenied" }),
    /aws_read_failed/,
  );
});

test("a timed-out AWS response remains an error even with exit zero", () => {
  assert.throws(
    () => decode({ code: 0, timedOut: true, stdout: "", stderr: "" }),
    /aws_read_failed/,
  );
});

test("an interrupted AWS response cannot become an empty success", () => {
  assert.throws(
    () => decode({ code: null, stdout: "", stderr: "" }),
    /aws_read_failed/,
  );
});

test("malformed nonempty AWS output is never treated as an empty result", () => {
  assert.throws(
    () => decode({ code: 0, stdout: "{", stderr: "" }),
    SyntaxError,
  );
});
