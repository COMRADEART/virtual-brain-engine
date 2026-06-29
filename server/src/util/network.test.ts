import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLocalUrl,
  isLocalHostname,
  isAllowedRemoteHost,
  assertEgressAllowed,
} from "./network.js";

test("isLocalUrl treats a missing baseUrl as local (stubs cannot leak)", () => {
  assert.equal(isLocalUrl(null), true);
  assert.equal(isLocalUrl(undefined), true);
  assert.equal(isLocalUrl(""), true);
});

test("isLocalUrl rejects malformed URLs (fail closed)", () => {
  assert.equal(isLocalUrl("not a url"), false);
  assert.equal(isLocalUrl("://missing-scheme"), false);
});

test("isLocalUrl accepts loopback hosts (with ports/paths)", () => {
  for (const u of [
    "http://localhost",
    "http://127.0.0.1:8787/api/health",
    "http://[::1]:1234",
    "http://127.5.4.3", // all of 127/8 is loopback
  ]) {
    assert.equal(isLocalUrl(u), true, u);
  }
});

test("isLocalUrl accepts RFC1918 private ranges", () => {
  for (const u of ["http://10.0.0.1", "http://192.168.1.50", "http://172.16.0.1", "http://172.31.255.254"]) {
    assert.equal(isLocalUrl(u), true, u);
  }
});

test("isLocalUrl rejects the 172.16/12 boundary neighbours", () => {
  assert.equal(isLocalUrl("http://172.15.0.1"), false);
  assert.equal(isLocalUrl("http://172.32.0.1"), false);
});

test("isLocalUrl rejects public hosts and public IPs", () => {
  for (const u of ["http://example.com", "https://api.openai.com", "http://8.8.8.8", "http://1.1.1.1"]) {
    assert.equal(isLocalUrl(u), false, u);
  }
});

test("isLocalUrl handles IPv6 link-local / unique-local literals", () => {
  assert.equal(isLocalUrl("http://[fe80::1]"), true);
  assert.equal(isLocalUrl("http://[fc00::1]"), true);
  assert.equal(isLocalUrl("http://[fd12:3456::1]"), true);
  assert.equal(isLocalUrl("http://[2001:db8::1]"), false); // public documentation range
});

test("the fc/fd SSRF trap: DNS names that merely start with fc/fd are NOT local", () => {
  // Regression guard — without the includes(':') check these slip the egress gate.
  assert.equal(isLocalUrl("http://fdroid.org"), false);
  assert.equal(isLocalUrl("http://fc-cdn.example.com"), false);
  assert.equal(isLocalHostname("fdroid.org"), false);
});

test("isAllowedRemoteHost matches the curated providers EXACTLY", () => {
  assert.equal(isAllowedRemoteHost("https://integrate.api.nvidia.com/v1/chat"), true);
  assert.equal(isAllowedRemoteHost("https://generativelanguage.googleapis.com/v1"), true);
  // Look-alike suffix attack must be rejected.
  assert.equal(isAllowedRemoteHost("https://generativelanguage.googleapis.com.evil.com"), false);
  assert.equal(isAllowedRemoteHost("https://api.nvidia.com"), false);
  assert.equal(isAllowedRemoteHost("https://example.com"), false);
  assert.equal(isAllowedRemoteHost(null), false);
});

test("isAllowedRemoteHost honours REMOTE_PROVIDER_ALLOWLIST (lazy + memoized by raw value)", () => {
  const prev = process.env.REMOTE_PROVIDER_ALLOWLIST;
  try {
    process.env.REMOTE_PROVIDER_ALLOWLIST = "my.proxy.internal, Other.Host.COM";
    assert.equal(isAllowedRemoteHost("https://my.proxy.internal"), true);
    assert.equal(isAllowedRemoteHost("https://other.host.com"), true, "matching is case-insensitive");
    assert.equal(isAllowedRemoteHost("https://unlisted.example.com"), false);
  } finally {
    if (prev === undefined) delete process.env.REMOTE_PROVIDER_ALLOWLIST;
    else process.env.REMOTE_PROVIDER_ALLOWLIST = prev;
  }
});

test("assertEgressAllowed gates remote targets only when localOnly is set", () => {
  const blocked = assertEgressAllowed("https://example.com", true);
  assert.equal(blocked.ok, false);
  assert.match((blocked as { reason: string }).reason, /LOCAL_ONLY=true/);

  assert.equal(assertEgressAllowed("http://127.0.0.1:8787", true).ok, true, "local always allowed");
  assert.equal(assertEgressAllowed("https://example.com", false).ok, true, "remote allowed when opted out");
});
