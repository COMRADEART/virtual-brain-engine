import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, isExcludedPath } from "./governance.js";

test("redactSecrets scrubs the catalogued credential shapes", () => {
  const cases: string[] = [
    "key sk-abcdefghijklmnopqrstuvwx",
    "key sk-proj-abcdefghijklmnopqrstuvwx",
    "aws AKIAIOSFODNN7EXAMPLE here",
    "gh ghp_abcdefghijklmnopqrstuvwxyz0123",
    "fine github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz",
    "slack xoxb-1234567890-abcdefghij",
    "jwt eyJhbGciOiJIUzI1NiI.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4fwpM",
    "auth Bearer abcdefghijklmnop1234",
    "config api_key=abcdef123456",
    "url https://x.test/cb?access_token=supersecretvalue",
    "password = hunter2hunter",
  ];
  for (const c of cases) {
    const { text, count } = redactSecrets(c);
    assert.ok(count >= 1, `expected a redaction in: ${c}`);
    assert.ok(text.includes("[redacted]"), `expected marker in: ${c}`);
  }
});

test("redactSecrets redacts a PEM private key block", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIBAAJB\n-----END RSA PRIVATE KEY-----";
  const { text, count } = redactSecrets(`leak: ${pem}`);
  assert.equal(count, 1);
  assert.ok(!text.includes("PRIVATE KEY"));
});

test("redactSecrets leaves ordinary prose and PII untouched (PII is the payload)", () => {
  // Deliberately NOT redacted: emails, names, addresses — over-redaction guts the brain.
  for (const clean of ["email alice@example.com", "my name is Alice Smith", "the secret: it was fun"]) {
    assert.deepEqual(redactSecrets(clean), { text: clean, count: 0 }, clean);
  }
});

test("redactSecrets counts every match in a multi-secret field", () => {
  const { count } = redactSecrets("a sk-abcdefghijklmnopqrstuvwx and b AKIAIOSFODNN7EXAMPLE");
  assert.equal(count, 2);
});

test("isExcludedPath blocks obviously-sensitive files", () => {
  for (const p of [
    "C:/Users/me/.env",
    "/home/me/project/.env.local",
    "/home/me/.ssh/id_rsa",
    "/etc/secrets/app.key",
    "backup/server.pem",
    "vault/.git-credentials",
  ]) {
    assert.equal(isExcludedPath(p), true, p);
  }
});

test("isExcludedPath blocks the secret DIRECTORY itself (regression: no trailing sep needed)", () => {
  assert.equal(isExcludedPath("/home/me/.ssh"), true, "listing the .ssh dir must be refused");
  assert.equal(isExcludedPath("/home/me/.aws"), true);
});

test("isExcludedPath allows normal content and handles nullish input", () => {
  assert.equal(isExcludedPath("/home/me/notes/todo.md"), false);
  assert.equal(isExcludedPath(null), false);
  assert.equal(isExcludedPath(undefined), false);
  assert.equal(isExcludedPath(""), false);
});
