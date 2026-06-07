// Multi-key rotation / failover selfcheck for OpenAICompatibleConnector.
// HERMETIC: no DB, no config, NO real network — an INJECTED fetch captures the
// Authorization header per call and returns canned responses, so we can prove
// the behavior that makes "give it 4-5 keys" actually EFFECTIVE:
//   • pool resolution from the plural NVIDIA_API_KEYS (+ legacy singular), deduped
//   • round-robin load spread across the pool
//   • automatic FAILOVER on 429 / 401 / 403 to the next key
//   • per-key COOLDOWN so a throttled/exhausted key is skipped next time
//   • whole-pool-throttled → throws LOUD (real status), never a silent empty answer
//   • a non-key error (500) is surfaced immediately and does NOT burn the pool
//   • streaming + embeddings fail over too (failover is on the initial response)
//   • the no-key local path sends no Authorization header (unchanged)
//
// Run: npm --prefix server run keyrotation:selfcheck

import { OpenAICompatibleConnector } from "../src/connectors/OpenAICompatibleConnector.js";
import { ConnectorError } from "../src/connectors/Connector.js";
import type { ConnectorDescriptor } from "../../shared/connector.js";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// --- env determinism: wipe every key var so the developer's real .env/shell
// can't leak into the pool. Each test sets exactly what it needs. ----------------
for (const v of [
  "NVIDIA_API_KEY", "NVIDIA_API_KEYS",
  "GEMINI_API_KEY", "GEMINI_API_KEYS", "GOOGLE_AI_API_KEY", "GOOGLE_AI_API_KEYS",
  "OPENAI_API_KEY", "OPENAI_API_KEYS", "LMSTUDIO_API_KEY", "LMSTUDIO_API_KEYS",
]) {
  delete process.env[v];
}
function setNvidiaKeys(plural?: string, singular?: string): void {
  if (plural === undefined) delete process.env.NVIDIA_API_KEYS;
  else process.env.NVIDIA_API_KEYS = plural;
  if (singular === undefined) delete process.env.NVIDIA_API_KEY;
  else process.env.NVIDIA_API_KEY = singular;
}

// --- injected fetch ------------------------------------------------------------
interface FakeSpec {
  status: number;
  json?: unknown;
  sse?: string[];
  retryAfter?: number;
}
function fakeResponse(spec: FakeSpec): Response {
  const ok = spec.status >= 200 && spec.status < 300;
  let body: unknown = null;
  if (spec.sse) {
    const chunks = spec.sse.map((s) => new TextEncoder().encode(s));
    let i = 0;
    body = {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true },
        releaseLock: () => {},
      }),
    };
  }
  return {
    ok,
    status: spec.status,
    url: "",
    headers: {
      get: (k: string) => {
        const key = k.toLowerCase();
        if (key === "content-type") return "application/json";
        if (key === "retry-after" && spec.retryAfter !== undefined) return String(spec.retryAfter);
        return null;
      },
    },
    json: async () => spec.json ?? {},
    text: async () => JSON.stringify(spec.json ?? {}),
    body,
  } as unknown as Response;
}
function makeFetch(plan: (callIndex: number, key: string) => FakeSpec) {
  const keysUsed: string[] = [];
  let calls = 0;
  const impl = (async (_url: unknown, init: RequestInit | undefined) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.authorization ?? headers.Authorization ?? "";
    keysUsed.push(typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : "");
    return fakeResponse(plan(calls++, keysUsed[keysUsed.length - 1]));
  }) as unknown as typeof fetch;
  return { impl, keysUsed: () => keysUsed, calls: () => calls };
}

const CHAT_OK: FakeSpec = { status: 200, json: { choices: [{ message: { content: "ok" } }] } };
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function nvidiaDesc(embeddingModel?: string): ConnectorDescriptor {
  return {
    id: "nvidia",
    name: "NVIDIA",
    kind: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "meta/llama-3.3-70b-instruct",
    embeddingModel,
    enabled: true,
    isDefault: false,
    state: "idle",
    createdAt: "",
    updatedAt: "",
    isLocal: false,
  };
}
function localDesc(): ConnectorDescriptor {
  return {
    id: "local",
    name: "Local",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    enabled: true,
    isDefault: false,
    state: "ok",
    createdAt: "",
    updatedAt: "",
    isLocal: true,
  };
}

// ============================================================================
// 1. Pool resolution
// ============================================================================
{
  setNvidiaKeys("k1, k2 ,k3");
  const c = new OpenAICompatibleConnector(nvidiaDesc(), { fetchImpl: makeFetch(() => CHAT_OK).impl });
  check("plural NVIDIA_API_KEYS → pool of 3 (whitespace trimmed)", c.keyCount === 3);
}
{
  setNvidiaKeys(undefined, "solo");
  const c = new OpenAICompatibleConnector(nvidiaDesc(), { fetchImpl: makeFetch(() => CHAT_OK).impl });
  check("legacy singular NVIDIA_API_KEY → pool of 1 (backward compatible)", c.keyCount === 1);
}
{
  setNvidiaKeys("k1,k2", "k2"); // singular duplicates a plural entry
  const c = new OpenAICompatibleConnector(nvidiaDesc(), { fetchImpl: makeFetch(() => CHAT_OK).impl });
  check("plural+singular merged & order-preserving deduped → [k1,k2]", c.keyCount === 2);
}

// ============================================================================
// 2. Failover on 429
// ============================================================================
{
  setNvidiaKeys("k1,k2,k3");
  const f = makeFetch((_i, key) => (key === "k3" ? CHAT_OK : { status: 429 }));
  const c = new OpenAICompatibleConnector(nvidiaDesc(), { fetchImpl: f.impl });
  const out = await c.send("hi");
  check("429,429 → fails over and succeeds on k3", out === "ok");
  check("failover tried keys in order k1→k2→k3", eq(f.keysUsed(), ["k1", "k2", "k3"]));
}

// ============================================================================
// 3. Round-robin load spread (all keys healthy)
// ============================================================================
{
  setNvidiaKeys("k1,k2,k3");
  const f = makeFetch(() => CHAT_OK);
  const c = new OpenAICompatibleConnector(nvidiaDesc(), { fetchImpl: f.impl });
  await c.send("a");
  await c.send("b");
  await c.send("c");
  check("3 healthy calls spread one-each across k1,k2,k3", eq(f.keysUsed(), ["k1", "k2", "k3"]));
  await c.send("d");
  check("round-robin wraps back to k1 on the 4th call", f.keysUsed()[3] === "k1");
}

// ============================================================================
// 4. Cooldown — a 429'd key is SKIPPED on the next request
// ============================================================================
{
  setNvidiaKeys("k1,k2");
  const f = makeFetch((_i, key) => (key === "k1" ? { status: 429 } : CHAT_OK));
  const c = new OpenAICompatibleConnector(nvidiaDesc(), { fetchImpl: f.impl });
  await c.send("first"); // k1 429 (cooled), k2 ok
  const afterFirst = [...f.keysUsed()];
  await c.send("second");
  const second = f.keysUsed().slice(afterFirst.length);
  check("first call: k1(429)→k2", eq(afterFirst, ["k1", "k2"]));
  check("second call SKIPS cooled k1, goes straight to k2", eq(second, ["k2"]));
}

// ============================================================================
// 5. Whole pool throttled → throws LOUD with the real status
// ============================================================================
{
  setNvidiaKeys("k1,k2");
  const f = makeFetch(() => ({ status: 429 }));
  const c = new OpenAICompatibleConnector(nvidiaDesc(), { fetchImpl: f.impl });
  let err: unknown = null;
  try {
    await c.send("x");
  } catch (e) {
    err = e;
  }
  check(
    "all keys 429 → throws ConnectorError(429), never a silent empty answer",
    err instanceof ConnectorError && err.status === 429,
  );
  check("all-429 sweep still tried BOTH keys", eq(f.keysUsed(), ["k1", "k2"]));
}

// ============================================================================
// 6. Auth error (401) fails over AND sticks a (longer) cooldown
// ============================================================================
{
  setNvidiaKeys("k1,k2");
  const f = makeFetch((_i, key) => (key === "k1" ? { status: 401 } : CHAT_OK));
  const c = new OpenAICompatibleConnector(nvidiaDesc(), { fetchImpl: f.impl });
  await c.send("first");
  await c.send("second");
  check("401 fails over k1→k2", eq(f.keysUsed().slice(0, 2), ["k1", "k2"]));
  check("401-cooled key skipped on next call", eq(f.keysUsed().slice(2), ["k2"]));
}

// ============================================================================
// 7. Non-key error (500) surfaces immediately — does NOT burn the pool
// ============================================================================
{
  setNvidiaKeys("k1,k2");
  const f = makeFetch(() => ({ status: 500 }));
  const c = new OpenAICompatibleConnector(nvidiaDesc(), { fetchImpl: f.impl });
  let err: unknown = null;
  try {
    await c.send("x");
  } catch (e) {
    err = e;
  }
  check("500 → throws ConnectorError(500)", err instanceof ConnectorError && err.status === 500);
  check("500 does NOT fail over (only k1 tried, rest of pool preserved)", eq(f.keysUsed(), ["k1"]));
}

// ============================================================================
// 8. No-key local path sends NO Authorization header (unchanged behavior)
// ============================================================================
{
  const f = makeFetch(() => CHAT_OK);
  const c = new OpenAICompatibleConnector(localDesc(), { fetchImpl: f.impl });
  check("local runtime → empty key pool", c.keyCount === 0);
  const out = await c.send("x");
  check("no-key path succeeds and sends no Authorization (empty captured key)", out === "ok" && f.keysUsed()[0] === "");
}

// ============================================================================
// 9. Streaming fails over too (failover is on the initial response status)
// ============================================================================
{
  setNvidiaKeys("k1,k2");
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const f = makeFetch((_i, key) => (key === "k2" ? { status: 200, sse } : { status: 429 }));
  const c = new OpenAICompatibleConnector(nvidiaDesc(), { fetchImpl: f.impl });
  const tokens: string[] = [];
  for await (const t of c.stream("x")) tokens.push(t);
  check("stream fails over 429→k2 and yields the token", tokens.join("") === "hi");
  check("stream failover tried k1 then k2", eq(f.keysUsed(), ["k1", "k2"]));
}

// ============================================================================
// 10. Embeddings fail over too (when the descriptor exposes embeddingModel)
// ============================================================================
{
  setNvidiaKeys("k1,k2");
  const f = makeFetch((_i, key) =>
    key === "k2" ? { status: 200, json: { data: [{ embedding: [0.1, 0.2, 0.3] }] } } : { status: 429 },
  );
  const c = new OpenAICompatibleConnector(nvidiaDesc("nv-embed"), { fetchImpl: f.impl });
  check("embed() exposed when embeddingModel set", typeof c.embed === "function");
  const vec = await c.embed!("x");
  check("embed fails over 429→k2 and returns the vector", Array.isArray(vec) && vec.length === 3);
  check("embed failover tried k1 then k2", eq(f.keysUsed(), ["k1", "k2"]));
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
