// Continuity route selfcheck. HERMETIC: tests the pure briefing builder and
// the Express route mounted on a throwaway HTTP server + temp DB.
//
// Run: npm --prefix server run continuity:selfcheck

import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-continuity-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.LOCAL_ONLY = "true";
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1";

const { openDb } = await import("../src/db/sqlite.js");
const { buildBriefing, buildSpokenBriefing } = await import("../src/core/continuity.js");
const { continuityRouter } = await import("../src/routes/continuity.js");
const { ensureConversation, insertMessage } = await import("../src/db/repositories/conversations.js");
const express = (await import("express")).default;

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb();

// ── Pure builder checks ────────────────────────────────────────────────────
{
  const empty = buildBriefing({
    episodes24h: [],
    beliefs: [],
    goals: [],
    people: [],
    openQuestions: [],
    recentConversations: [],
    hoursSinceLastChat: Number.POSITIVE_INFINITY,
    today: { hour: 9, weekday: "Monday" },
  });
  check("builder: empty input produces honest fallback", empty.briefing.includes("no record of prior activity"));
  check("builder: first-time greeting", empty.greeting.includes("Monday morning"));

  const full = buildBriefing({
    episodes24h: [{ title: "Neural nets deep dive", summary: "3 items", at: new Date().toISOString() }],
    beliefs: [{ statement: "Neural nets learn patterns.", confidence: 0.92 }],
    goals: [{ title: "Understand transformers", progress: 0.6 }],
    people: [],
    openQuestions: [{ text: "How do attention heads compose?", from: "working memory" }],
    recentConversations: [{ title: "Symbolic AI comparison", at: new Date().toISOString() }],
    hoursSinceLastChat: 12,
    today: { hour: 14, weekday: "Tuesday" },
  });
  check("builder: includes episode", full.briefing.includes("Neural nets deep dive"));
  check("builder: includes conversation", full.briefing.includes("Symbolic AI comparison"));
  check("builder: includes goal", full.briefing.includes("Understand transformers"));
  check("builder: includes belief", full.briefing.includes("Neural nets learn patterns"));
  check("builder: includes open question", full.briefing.includes("How do attention heads compose?"));
  check("builder: 12h gap greeting", full.greeting.includes("Welcome back"));

  const spoken = buildSpokenBriefing({
    episodes24h: [],
    beliefs: [{ statement: "Neural nets learn patterns.", confidence: 0.92 }],
    goals: [],
    people: [],
    openQuestions: [],
    recentConversations: [{ title: "Symbolic AI comparison", at: new Date().toISOString() }],
    hoursSinceLastChat: 12,
    today: { hour: 14, weekday: "Tuesday" },
  });
  check("spoken: greeting + text", spoken.text.length > 0 && spoken.greeting.length > 0);
}

// ── Route wiring checks ──────────────────────────────────────────────────────
async function routeJson(path: string): Promise<unknown> {
  const app = express();
  app.use("/api", continuityRouter);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await res.text();
    check(`route: ${path} returns 200`, res.status === 200, `status=${res.status}`);
    return JSON.parse(text);
  } finally {
    server.close();
  }
}

{
  const full = await routeJson("/api/continuity?format=full") as Record<string, unknown>;
  check("route: full has generatedAt", typeof full.generatedAt === "string");
  check("route: full has greeting", typeof full.greeting === "string");
  check("route: full has briefing", typeof full.briefing === "string");
  check("route: full arrays present", Array.isArray(full.episodesLast24h) && Array.isArray(full.activeBeliefs));

  const spoken = await routeJson("/api/continuity?format=spoken") as Record<string, unknown>;
  check("route: spoken has greeting", typeof spoken.greeting === "string");
  check("route: spoken has text", typeof spoken.text === "string");
}

// ── Route with seeded conversation ───────────────────────────────────────────
{
  const convo = ensureConversation(undefined, "Continuity test chat");
  insertMessage({ conversationId: convo.id, role: "user", content: "hello" });

  const full = await routeJson("/api/continuity?format=full") as Record<string, unknown>;
  const recent = full.recentConversations as Array<{ title: string | null }>;
  check("route: seeded conversation appears", recent.length > 0 && recent[0].title === "Continuity test chat");
  const briefing = String(full.briefing);
  check("route: briefing mentions conversation", briefing.toLowerCase().includes("continuity test chat"));
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll continuity checks passed");
