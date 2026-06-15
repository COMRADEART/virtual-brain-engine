// Action executor — the trust boundary. A client posts back { actionId, args,
// confirmToken }; NONE of it is trusted. The executor re-derives risk + the
// validation schema from the server registry by id, re-validates args, enforces
// the confirm-token gate for confirm-tier actions, runs the handler, and audits
// the attempt. The risk tier is NEVER read from the submitted plan — that's the
// attack the trust boundary closes (a caller self-labelling a confirm action
// "safe").
//
// Note on the existing `core/safety.ts` gate: that is the autonomous AGENT
// runtime's allow-all audit seam (writes `agent_audit`). User-initiated commands
// are a distinct path with a richer lifecycle (args + confirm state + result),
// so they get their own `action_log`. A future unified allowlist could merge the
// two; today this keeps the user-command trail clean and queryable.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import os from "node:os";
import { CONFIG } from "../config.js";
import { getActionDef, isAllowlisted, validateArgs } from "./registry.js";
import { consumeConfirmToken } from "./confirmTokens.js";
import { insertActionLog } from "../db/repositories/actions.js";
import { keywordSearch, listRecentMemories, upsertMemoryPoint } from "../db/repositories/memory.js";
import { fetchAndIngestUrl } from "../ingest/index.js";
import { isExcludedPath } from "../ingest/governance.js";
import { webSearch } from "../web/search.js";
import { webResearch } from "../web/research.js";
import { githubSearch } from "../github/discovery.js";
import { discoverAndLearn, learnRepoRef } from "../github/index.js";
import { getDefaultConnectorInstance, resolveEmbedFn } from "../connectors/registry.js";
import { runScan, scanState } from "../scanner/indexer.js";
import { surfaceError } from "../util/diagnostics.js";
import type { ActionAuthorization, ActionId, ActionResult, ActionRiskTier, OsDirective } from "../../../shared/actions.js";
import { applyEdits, summarizeFailure, type BuildTestResult, type PatchEdit } from "../../../shared/coding.js";
import {
  cloneRepo,
  listRepoFiles,
  readRepoFile,
  writeRepoFile,
  getRepoStatus,
  commitRepo,
  listBranches,
  checkoutBranch,
} from "./git.js";
import {
  isDynamicAction,
  getDynamicAction,
  getDynamicHandler,
  executeDynamicHandler,
} from "./dynamicRegistry.js";
import { callMcpTool } from "../mcp/hub.js";
import { probeState, recordActionOutcome } from "./consequences.js";

// Filesystem actions touch the REAL machine (same box as the user), so they are
// confirm-tier and guarded here: absolute paths only, and the governance
// exclude-list (.env / .ssh / keys / credentials …) is refused outright — the
// same locations ambient ingest will never capture.
const MAX_READ_BYTES = 256 * 1024;

// A Windows UNC / network path (`\\host\share`, `//host/share`, or the extended
// `\\?\…` form). Node's fs.* on such a path opens an outbound SMB connection and
// triggers an NTLM auth handshake — a non-fetch egress channel the LOCAL_ONLY
// gate (which only sees fetch()) cannot cover. Reject before any fs call.
function isUncPath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

// Validate + CANONICALIZE a path for the file actions. Returns the RESOLVED path
// the caller MUST use (never the raw arg): checking one path and reading another
// is a TOCTOU hole — `..` is normalized here so the exclude check and the actual
// fs call agree. Rejects relative paths, UNC/network roots, and the governance
// exclude-list. NOTE: resolve() normalizes `..` but does NOT resolve symlinks; a
// junction pre-planted into a secret dir plus a user-confirmed action is an
// accepted residual for this single-user, loopback-bound threat model.
function guardFsPath(p: string): { ok: true; path: string } | { ok: false; error: string } {
  if (!isAbsolute(p)) return { ok: false, error: "path must be absolute" };
  if (isUncPath(p)) return { ok: false, error: "refused: UNC / network paths are not allowed" };
  const resolved = resolve(p);
  if (isUncPath(resolved)) return { ok: false, error: "refused: UNC / network paths are not allowed" };
  if (isExcludedPath(resolved)) return { ok: false, error: "refused: sensitive location (.env/.ssh/keys/credentials)" };
  return { ok: true, path: resolved };
}

// ─── "Do any task on the laptop" — shell execution ──────────────────────────
// run-command / launch-app run a REAL child process on the user's own machine.
// They reach the handler ONLY after the executor's allowlist + confirm gate +
// (re-checked) ALLOW_SHELL flag pass. Output is captured and size-capped.
const MAX_SHELL_OUTPUT = 16 * 1024; // per stream

// Kill the command's WHOLE process tree, not just the parent shell — a command
// that backgrounds a grandchild (`Start-Process …`, `foo &`) would otherwise
// outlive a timeout. Windows has no POSIX groups, so taskkill /T walks the tree
// by pid; POSIX run-command is spawned `detached` (its own group), so a negative
// pid SIGKILLs the whole group.
function killProcessTree(child: import("node:child_process").ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    return;
  }
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

function runShellCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveP) => {
    const isWin = process.platform === "win32";
    const file = isWin ? "powershell.exe" : "/bin/sh";
    const args = isWin
      ? ["-NoProfile", "-NonInteractive", "-Command", command]
      : ["-c", command];
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: import("node:child_process").ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: cwd ?? os.homedir(),
        windowsHide: true,
        env: process.env,
        // POSIX: own process group so a timeout can kill the whole tree.
        detached: !isWin,
      });
    } catch (err) {
      resolveP({ code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_SHELL_OUTPUT) stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_SHELL_OUTPUT) stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveP({ code: null, stdout, stderr: stderr || (err instanceof Error ? err.message : String(err)), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout: stdout.slice(0, MAX_SHELL_OUTPUT), stderr: stderr.slice(0, MAX_SHELL_OUTPUT), timedOut });
    });
  });
}

// PowerShell single-quoted literal: everything is literal except ' → ''. Used to
// safely pass an app path / args to Start-Process without a shell-injection hole
// (run-command is deliberately raw; launch-app's app/args are NOT).
function psSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// Shared body of run-build / run-tests. Spawns the (default or supplied) command
// in the guarded cwd and returns a BuildTestResult. A non-zero exit is a NORMAL
// result (passed=false) — the loop must SEE it to fix the code; only spawn
// failure / timeout throws. ALLOW_SHELL is re-checked here (defense in depth).
async function buildOrTest(
  args: Record<string, unknown>,
  defaultCommand: string,
): Promise<{ summary: string; data: BuildTestResult }> {
  if (!CONFIG.allowShell) throw new Error("build/test actions are disabled (set ALLOW_SHELL=true to enable)");
  const g = guardFsPath(String(args.cwd));
  if (!g.ok) throw new Error(`cwd ${g.error}`);
  const command = typeof args.command === "string" && args.command.trim().length > 0 ? args.command.trim() : defaultCommand;
  const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : CONFIG.shellTimeoutMs;
  const r = await runShellCommand(command, g.path, timeoutMs);
  if (r.timedOut) {
    throw new Error(`command timed out after ${timeoutMs}ms${r.stdout ? `\n${r.stdout}` : ""}`);
  }
  const result: BuildTestResult = {
    command,
    cwd: g.path,
    exitCode: r.code,
    passed: r.code === 0,
    stdout: r.stdout,
    stderr: r.stderr,
    truncated: r.stdout.length >= MAX_SHELL_OUTPUT || r.stderr.length >= MAX_SHELL_OUTPUT,
  };
  const summary = result.passed
    ? `✓ \`${command}\` passed (exit 0)`
    : `✗ ${summarizeFailure(result)}`;
  return { summary, data: result };
}

export interface ExecuteInput {
  actionId: string; // untrusted — re-derived against the registry
  args: unknown; // untrusted — re-validated against the registry schema
  confirmToken?: string;
  // SERVER-INTERNAL authorisation channel for the autonomous agent loop's
  // granted-session-scope mode. NOT a per-plan human approval: the user granted
  // this risk ceiling for the whole run up front, so a confirm-tier action whose
  // risk is in `allow` runs WITHOUT a confirm token and is audited honestly as
  // confirmed=false, authorizedVia="session-scope". This must NEVER be populated
  // from client-supplied request data on the per-action /api/actions/execute
  // path — only the agent loop, holding a run-scoped grant the user approved,
  // sets it. A confirm token (when present) always takes precedence.
  sessionScope?: { allow: ActionRiskTier[] };
}

export interface ExecuteResult extends ActionResult {
  // The HTTP status the route should send. Not part of the wire body.
  status: number;
}

// Handlers run ONLY after the allowlist + arg-validation + confirm checks pass.
// Server-surface actions only — os-surface actions return an osDirective instead
// (see osDirectiveFor), so this is a Partial map.
type Handler = (args: Record<string, unknown>) => Promise<{ summary: string; data?: unknown }>;

const HANDLERS: Partial<Record<ActionId, Handler>> = {
  // Keyword search keeps this offline-capable (no embeddings required).
  "search-memory": async (args) => {
    const query = String(args.query);
    const limit = typeof args.limit === "number" ? args.limit : 8;
    const hits = keywordSearch(query, limit);
    return {
      summary: `Found ${hits.length} ${hits.length === 1 ? "memory" : "memories"} for "${query}"`,
      data: hits.map((h) => ({
        id: h.memory.id,
        title: h.memory.title,
        snippet: h.memory.content.slice(0, 200),
      })),
    };
  },
  "recent-memories": async (args) => {
    const limit = typeof args.limit === "number" ? args.limit : 10;
    const mems = listRecentMemories(limit);
    return {
      summary: `Listed ${mems.length} recent ${mems.length === 1 ? "memory" : "memories"}`,
      data: mems.map((m) => ({ id: m.id, title: m.title, snippet: m.content.slice(0, 200) })),
    };
  },
  "create-note": async (args) => {
    const content = String(args.content);
    const title = typeof args.title === "string" && args.title.length > 0 ? args.title : content.slice(0, 60);
    const mem = upsertMemoryPoint({
      sourceType: "manual",
      title,
      content,
      contentHash: createHash("sha1").update(content).digest("hex"),
      importance: 0.5,
      metadata: { source: "action:create-note" },
    });
    return { summary: `Saved note "${title}"`, data: { id: mem.id } };
  },
  "trigger-scan": async () => {
    // Fire-and-forget: runScan streams progress over the bus and can take a
    // while. We return immediately with the current scan state.
    void runScan().catch((err) => surfaceError("action:trigger-scan", err));
    return { summary: "Scan started", data: scanState() };
  },
  // "Learn from the internet". The egress gate lives inside fetchAndIngestUrl
  // (LOCAL_ONLY); a blocked fetch returns a clear reason rather than throwing,
  // so the user sees WHY (and that no traffic left the machine).
  "learn-url": async (args) => {
    const url = String(args.url);
    const r = await fetchAndIngestUrl(url);
    if (r.ingested === 0) {
      return {
        summary: r.reason ? `Couldn't learn ${url} — ${r.reason}` : `Nothing new to learn from ${url}`,
        data: r,
      };
    }
    const dup = r.deduped > 0 ? `, ${r.deduped} already known` : "";
    return {
      summary: `Learned ${r.title ?? url} — ${r.ingested} new memor${r.ingested === 1 ? "y" : "ies"}${dup}`,
      data: r,
    };
  },
  // "Search the web" — live results, no persistence. Egress gated inside
  // webSearch (LOCAL_ONLY); a blocked search returns a clear reason.
  "web-search": async (args) => {
    const query = String(args.query);
    const limit = typeof args.limit === "number" ? args.limit : 5;
    const r = await webSearch(query, { limit });
    if (!r.ok) {
      return { summary: `Couldn't search the web — ${r.reason}`, data: r };
    }
    return {
      summary: `Found ${r.results.length} web result${r.results.length === 1 ? "" : "s"} for "${query}" (via ${r.provider})`,
      data: r.results,
    };
  },
  // "Research the web" — search + read the top pages INTO memory (learn). The
  // default connector's embedder (if any) is passed so learned pages join the
  // vector index. Egress gated inside webResearch.
  "research-web": async (args) => {
    const query = String(args.query);
    const maxPages = typeof args.maxPages === "number" ? args.maxPages : undefined;
    const conn = getDefaultConnectorInstance();
    const embed = conn?.embed ? conn.embed.bind(conn) : undefined;
    const r = await webResearch(query, { limit: maxPages, embed });
    if (!r.ok) {
      return { summary: `Couldn't research "${query}" — ${r.reason}`, data: r };
    }
    const dup = r.deduped > 0 ? `, ${r.deduped} already known` : "";
    return {
      summary: `Researched "${query}" via ${r.provider} — learned ${r.ingested} new memor${r.ingested === 1 ? "y" : "ies"}${dup} from ${r.results.length} page${r.results.length === 1 ? "" : "s"}`,
      data: { provider: r.provider, ingested: r.ingested, deduped: r.deduped, results: r.results },
    };
  },
  // --- GitHub project discovery ----------------------------------------------
  // "Find popular GitHub repos" — discover only, no persistence. Egress gated
  // inside githubSearch (LOCAL_ONLY + host pin); a blocked search returns a
  // clear reason rather than throwing.
  "github-search": async (args) => {
    const query = String(args.query);
    const minStars = typeof args.minStars === "number" ? args.minStars : undefined;
    const language = typeof args.language === "string" ? args.language : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const r = await githubSearch(query, { minStars, language, limit });
    if (!r.ok) {
      return { summary: `Couldn't search GitHub — ${r.reason}`, data: r };
    }
    return {
      summary: `Found ${r.repos.length} GitHub repo${r.repos.length === 1 ? "" : "s"} for "${query}"`,
      data: r.repos.map((repo) => ({
        fullName: repo.fullName,
        stars: repo.stars,
        url: repo.url,
        language: repo.language,
        description: repo.description.slice(0, 200),
      })),
    };
  },
  // "Learn from popular GitHub repos" — discover + read each README into memory.
  // The default connector's embedder (if any) is passed so learned READMEs join
  // the vector index. Egress gated inside discoverAndLearn.
  "github-learn": async (args) => {
    const query = String(args.query);
    const minStars = typeof args.minStars === "number" ? args.minStars : undefined;
    const language = typeof args.language === "string" ? args.language : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const conn = getDefaultConnectorInstance();
    const embed = conn?.embed ? conn.embed.bind(conn) : undefined;
    const r = await discoverAndLearn(query, { minStars, language, limit, embed });
    if (!r.ok) {
      return { summary: `Couldn't learn from GitHub for "${query}" — ${r.reason}`, data: r };
    }
    if (r.ingested === 0) {
      return {
        summary: r.reason
          ? `Found ${r.repos.length} repos for "${query}" but learned nothing new — ${r.reason}`
          : `Found ${r.repos.length} repos for "${query}" but learned nothing new`,
        data: { repos: r.repos.length, reposLearned: r.reposLearned, ingested: r.ingested, deduped: r.deduped },
      };
    }
    const dup = r.deduped > 0 ? `, ${r.deduped} already known` : "";
    return {
      summary: `Learned from ${r.reposLearned} of ${r.repos.length} GitHub repos for "${query}" — ${r.ingested} new memor${r.ingested === 1 ? "y" : "ies"}${dup}`,
      data: { repos: r.repos.length, reposLearned: r.reposLearned, ingested: r.ingested, deduped: r.deduped },
    };
  },
  // "Add this repo to the brain" — learn ONE specific repository's README. Embeds
  // via resolveEmbedFn (default connector, else local Ollama) so the README joins
  // the vector index even when the default model is remote. Egress + parse failures
  // come back as a clear summary, never a throw (learnRepoRef never throws).
  "github-learn-repo": async (args) => {
    const ref = String(args.repo);
    const r = await learnRepoRef(ref, { embed: resolveEmbedFn() });
    if (!r.ok) {
      return { summary: `Couldn't learn ${r.repo || ref} — ${r.reason ?? "unknown error"}`, data: r };
    }
    if (r.ingested === 0) {
      return {
        summary: `${r.repo} — nothing new learned${r.reason ? ` (${r.reason})` : ""}`,
        data: { repo: r.repo, ingested: r.ingested, deduped: r.deduped },
      };
    }
    const dup = r.deduped > 0 ? `, ${r.deduped} already known` : "";
    return {
      summary: `Learned ${r.repo}${r.stars ? ` (★${r.stars})` : ""} — ${r.ingested} new memor${r.ingested === 1 ? "y" : "ies"}${dup}`,
      data: { repo: r.repo, url: r.url, stars: r.stars, ingested: r.ingested, deduped: r.deduped },
    };
  },
  // --- System actions --------------------------------------------------------
  "system-info": async () => {
    const cpus = os.cpus();
    const info: Record<string, unknown> = {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
      cpuModel: cpus[0]?.model ?? "unknown",
      cpuCount: cpus.length,
      totalMemGB: Number((os.totalmem() / 2 ** 30).toFixed(2)),
      freeMemGB: Number((os.freemem() / 2 ** 30).toFixed(2)),
      loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
      uptimeHours: Number((os.uptime() / 3600).toFixed(1)),
      homedir: os.homedir(),
    };
    let diskNote = "";
    try {
      const statfs = (fs as unknown as { statfs?: (p: string) => Promise<{ blocks: number; bsize: number; bavail: number }> }).statfs;
      if (statfs) {
        const s = await statfs(os.homedir());
        const totalGB = Number(((s.blocks * s.bsize) / 2 ** 30).toFixed(1));
        const freeGB = Number(((s.bavail * s.bsize) / 2 ** 30).toFixed(1));
        info.disk = { totalGB, freeGB };
        diskNote = `, disk ${freeGB}/${totalGB} GB free`;
      }
    } catch {
      /* disk stats are best-effort */
    }
    return {
      summary: `${info.platform}/${info.arch}, ${info.cpuCount} CPUs, ${info.freeMemGB}/${info.totalMemGB} GB RAM free${diskNote}`,
      data: info,
    };
  },
  "list-directory": async (args) => {
    const g = guardFsPath(String(args.path));
    if (!g.ok) throw new Error(g.error);
    const entries = await fs.readdir(g.path, { withFileTypes: true });
    const items = entries.slice(0, 500).map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
    }));
    return {
      summary: `Listed ${items.length} item${items.length === 1 ? "" : "s"} in ${g.path}${entries.length > 500 ? " (truncated to 500)" : ""}`,
      data: items,
    };
  },
  "read-file": async (args) => {
    const g = guardFsPath(String(args.path));
    if (!g.ok) throw new Error(g.error);
    const st = await fs.stat(g.path);
    if (!st.isFile()) throw new Error("not a file");
    if (st.size > MAX_READ_BYTES) throw new Error(`file too large (${st.size} bytes > ${MAX_READ_BYTES})`);
    const text = await fs.readFile(g.path, "utf8");
    return { summary: `Read ${g.path} (${text.length} chars)`, data: { path: g.path, content: text } };
  },
  "write-file": async (args) => {
    const g = guardFsPath(String(args.path));
    if (!g.ok) throw new Error(g.error);
    const content = String(args.content);
    await fs.writeFile(g.path, content, "utf8");
    return { summary: `Wrote ${content.length} chars to ${g.path}`, data: { path: g.path, bytes: Buffer.byteLength(content, "utf8") } };
  },
  // --- Coding mastery (verify-until-correct) ---------------------------------
  // apply-patch: read the file (guarded), apply literal find/replace edits via the
  // PURE applyEdits helper, write it back through the SAME guarded fs path. The
  // patch primitive never touches fs itself — guardFsPath (absolute-only, UNC
  // reject, isExcludedPath, TOCTOU-safe canonicalization) governs both read+write.
  "apply-patch": async (args) => {
    const g = guardFsPath(String(args.path));
    if (!g.ok) throw new Error(g.error);
    const edits = (Array.isArray(args.edits) ? args.edits : []) as PatchEdit[];
    let original: string;
    try {
      const st = await fs.stat(g.path);
      if (!st.isFile()) throw new Error("not a file");
      if (st.size > MAX_READ_BYTES) throw new Error(`file too large to patch (${st.size} bytes > ${MAX_READ_BYTES})`);
      original = await fs.readFile(g.path, "utf8");
    } catch (err) {
      throw new Error(`cannot read ${g.path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const r = applyEdits(original, edits);
    if (!r.ok || r.content === undefined) throw new Error(r.error ?? "patch failed");
    await fs.writeFile(g.path, r.content, "utf8");
    return {
      summary: `Patched ${g.path} (${r.applied} edit${r.applied === 1 ? "" : "s"})`,
      data: { path: g.path, applied: r.applied },
    };
  },
  // run-build / run-tests: run a real build/test command and return its exit code
  // so the agent loop SEES failures and self-corrects. A non-zero exit is NOT a
  // handler failure — the command ran; only spawn failure / timeout throws. The
  // `passed` flag in `data` is what the verify gate reads. ALLOW_SHELL re-checked
  // (defense in depth — the registry already hides these when off).
  "run-build": async (args) => buildOrTest(args, "npm run build"),
  "run-tests": async (args) => buildOrTest(args, "npm test"),
  // --- "Do any task on the laptop" -------------------------------------------
  // The universal "do anything on this PC" tool. ALLOW_SHELL is re-checked here
  // (defense in depth — the registry already hides it when off). A non-zero exit
  // is NOT a handler failure: the command ran, and the agent loop needs to SEE
  // the output + exit code to decide what to do next, so we return success with
  // the real status in the summary. Only a spawn failure / timeout throws.
  "run-command": async (args) => {
    if (!CONFIG.allowShell) throw new Error("shell actions are disabled (set ALLOW_SHELL=true to enable)");
    const command = String(args.command);
    let cwd: string | undefined;
    if (typeof args.cwd === "string" && args.cwd.length > 0) {
      const g = guardFsPath(args.cwd);
      if (!g.ok) throw new Error(`cwd ${g.error}`);
      cwd = g.path;
    }
    const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : CONFIG.shellTimeoutMs;
    const r = await runShellCommand(command, cwd, timeoutMs);
    if (r.timedOut) {
      throw new Error(`command timed out after ${timeoutMs}ms${r.stdout ? `\n${r.stdout}` : ""}`);
    }
    const output = [r.stdout, r.stderr]
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join("\n")
      .slice(0, MAX_SHELL_OUTPUT);
    const head = command.length > 70 ? `${command.slice(0, 70)}…` : command;
    return {
      summary: `$ ${head} → exit ${r.code ?? "?"}${output ? `\n${output.slice(0, 1200)}` : ""}`,
      data: { command, exitCode: r.code, ok: r.code === 0, output },
    };
  },
  "launch-app": async (args) => {
    if (!CONFIG.allowShell) throw new Error("shell actions are disabled (set ALLOW_SHELL=true to enable)");
    const app = String(args.app);
    const extra = typeof args.args === "string" ? args.args.trim() : "";
    const isWin = process.platform === "win32";
    let file: string;
    let spawnArgs: string[];
    if (isWin) {
      const argList = extra ? ` -ArgumentList ${psSingleQuote(extra)}` : "";
      file = "powershell.exe";
      spawnArgs = ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath ${psSingleQuote(app)}${argList}`];
    } else if (process.platform === "darwin") {
      file = "open";
      spawnArgs = extra ? ["-a", app, "--args", ...extra.split(/\s+/)] : ["-a", app];
    } else {
      file = app;
      spawnArgs = extra ? extra.split(/\s+/) : [];
    }
    await new Promise<void>((resolveP, rejectP) => {
      try {
        const child = spawn(file, spawnArgs, { detached: true, stdio: "ignore", windowsHide: false, env: process.env });
        child.on("error", (err) => rejectP(err));
        child.unref();
        // A launch is fire-and-forget: resolve once it's started (or errored).
        setTimeout(() => resolveP(), 200);
      } catch (err) {
        rejectP(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return { summary: `Launched ${app}${extra ? ` ${extra}` : ""}`, data: { app, args: extra } };
  },
  // --- Git actions -------------------------------------------------------------
  "git-clone": async (args) => {
    const url = String(args.url);
    const branch = typeof args.branch === "string" ? args.branch : undefined;
    const r = await cloneRepo(url, branch);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
  },
  "git-list-files": async (args) => {
    const path = String(args.path);
    const r = await listRepoFiles(path);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
  },
  "git-read-file": async (args) => {
    const path = String(args.path);
    const r = await readRepoFile(path);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
  },
  "git-write-file": async (args) => {
    const path = String(args.path);
    const content = String(args.content);
    const r = await writeRepoFile(path, content);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
  },
  "git-status": async (args) => {
    const path = String(args.path);
    const r = await getRepoStatus(path);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
  },
  "git-commit": async (args) => {
    const path = String(args.path);
    const message = String(args.message);
    const push = typeof args.push === "boolean" ? args.push : false;
    const r = await commitRepo(path, message, push);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
  },
  "git-branches": async (args) => {
    const path = String(args.path);
    const r = await listBranches(path);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
  },
  "git-checkout": async (args) => {
    const path = String(args.path);
    const branch = String(args.branch);
    const r = await checkoutBranch(path, branch);
    if (!r.ok) throw new Error(r.error);
    return { summary: r.summary, data: r.data };
  },
};

// os-surface actions: map a validated plan to the Tauri command the client must
// invoke. The server never touches the OS — it only authorises + describes the
// op. `os_open` (src-tauri/src/os_actions.rs) uses the OS default handler, not a
// shell interpreter, so there's no command-injection surface.
function osDirectiveFor(actionId: ActionId, args: Record<string, unknown>): OsDirective {
  switch (actionId) {
    case "open-path":
      return { command: "os_open_path", args: { path: String(args.path) } };
    case "open-url":
      return { command: "os_open_url", args: { url: String(args.url) } };
    default:
      // Unreachable: only os-surface ids reach here (guarded by def.surface).
      throw new Error(`no os directive for ${actionId}`);
  }
}

export async function executeAction(input: ExecuteInput): Promise<ExecuteResult> {
  // (1) TRUST BOUNDARY — everything below is derived from the registry by id.
  // First check static registry, then dynamic registry.
  const isDynamic = isDynamicAction(input.actionId);
  const staticDef = getActionDef(input.actionId);

  if (!isDynamic && !staticDef) {
    return {
      ok: false,
      actionId: input.actionId,
      summary: "",
      error: `not allowlisted: ${input.actionId}`,
      status: 403,
    };
  }

  // Handle dynamic actions (registered skills + MCP-server tools). Both reuse THIS
  // branch's allowlist + zod + confirm/scope gate; an MCP-backed def is dispatched
  // to the MCP hub instead of the sandboxed new Function() handler (the eval
  // sandbox is NEVER relaxed). AUDIT PARITY: every attempt — refusal, success, or
  // failure — is written to action_log here, exactly like the static path below
  // (this branch previously logged nothing, leaving dynamic/MCP calls out of the
  // trail). authorizedVia stays honest: session-scope is audited as confirmed=false.
  if (isDynamic) {
    const dynDef = getDynamicAction(input.actionId);
    if (!dynDef) {
      return { ok: false, actionId: input.actionId, summary: "", error: "dynamic action not found", status: 403 };
    }

    const auditDyn = (
      ok: boolean,
      confirmed: boolean,
      authorizedVia: ActionAuthorization,
      summary: string,
      loggedArgs: Record<string, unknown>,
    ): void => {
      try {
        insertActionLog({ actionId: input.actionId, args: loggedArgs, risk: dynDef.risk, confirmed, authorizedVia, ok, summary });
      } catch (err) {
        surfaceError("action:auditLog", err);
      }
    };

    // Validate args against the dynamic schema.
    const parsed = dynDef.schema.safeParse(input.args ?? {});
    if (!parsed.success) {
      const error = `invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
      auditDyn(false, false, "none", error, {});
      return { ok: false, actionId: input.actionId, summary: "", error, status: 400 };
    }
    const dynArgs = parsed.data as Record<string, unknown>;

    // Confirm gate — a plan-bound confirm token (bound to the RAW minted args)
    // wins; failing that, the agent loop's granted session scope authorises the
    // action when its risk is within the ceiling. The tier comes from the
    // registry, never the caller. A refusal is audited, not silent.
    const needsConfirm = dynDef.risk !== "safe";
    let confirmed = false;
    let authorizedVia: ActionAuthorization = needsConfirm ? "none" : "safe";
    if (needsConfirm) {
      if (input.confirmToken && consumeConfirmToken(input.confirmToken, input.actionId, (input.args ?? {}) as Record<string, unknown>)) {
        confirmed = true;
        authorizedVia = "confirm-token";
      } else if (input.sessionScope?.allow.includes(dynDef.risk)) {
        authorizedVia = "session-scope";
      } else {
        const error = "confirmation required (missing or invalid confirm token)";
        auditDyn(false, false, "none", error, dynArgs);
        return { ok: false, actionId: input.actionId, summary: "", error, status: 403 };
      }
    }

    // Execute: MCP-backed def → hub dispatch; else the sandboxed handler.
    try {
      let result: { summary: string; data?: unknown };
      if (dynDef.mcp) {
        const r = await callMcpTool(dynDef.mcp.server, dynDef.mcp.tool, dynArgs);
        if (!r.ok) throw new Error(r.error ?? "MCP tool failed");
        result = { summary: r.content.slice(0, 2000) || `${dynDef.mcp.tool} ok`, data: r.data };
      } else {
        result = await executeDynamicHandler(input.actionId, dynArgs);
      }
      auditDyn(true, confirmed, authorizedVia, result.summary, dynArgs);
      return { ok: true, actionId: input.actionId, summary: result.summary, data: result.data, status: 200 };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      auditDyn(false, confirmed, authorizedVia, error, dynArgs);
      return { ok: false, actionId: input.actionId, summary: "", error, status: 500 };
    }
  }

  // Static action path (original code)
  const actionId = input.actionId as ActionId;
  const def = staticDef;
  if (!def) {
    return { ok: false, actionId, summary: "", error: "unknown action", status: 403 };
  }

  // Audit any attempt against a KNOWN (allowlisted) action — including refusals
  // — so the trail captures probing, not just successes. (A totally-unknown id
  // is rejected above and not logged, to avoid garbage-id spam.) `authorizedVia`
  // keeps the trail honest: a granted-session-scope run records confirmed=false
  // + authorizedVia="session-scope", never a forged confirm.
  const audit = (
    ok: boolean,
    confirmed: boolean,
    authorizedVia: ActionAuthorization,
    summary: string,
    loggedArgs: Record<string, unknown>,
  ): void => {
    try {
      insertActionLog({ actionId, args: loggedArgs, risk: def.risk, confirmed, authorizedVia, ok, summary });
    } catch (err) {
      surfaceError("action:auditLog", err);
    }
  };

  const validation = validateArgs(actionId, input.args);
  if (!validation.ok || !validation.args) {
    const error = `invalid args: ${validation.error}`;
    audit(false, false, "none", error, {});
    return { ok: false, actionId, summary: "", error, status: 400 };
  }
  const args = validation.args;

  // (2) CONFIRM GATE — confirm-tier requires either a valid, plan-bound,
  // single-use confirm token (a per-plan human approval), OR — for the agent
  // loop — a granted session scope whose ceiling covers this action's risk. The
  // tier comes from the registry, never from the submitted plan. A confirm
  // token always wins; session scope is the coarse, honestly-audited fallback.
  const needsConfirm = def.risk !== "safe";
  let confirmed = false;
  let authorizedVia: ActionAuthorization = needsConfirm ? "none" : "safe";
  if (needsConfirm) {
    if (input.confirmToken && consumeConfirmToken(input.confirmToken, actionId, args)) {
      confirmed = true;
      authorizedVia = "confirm-token";
    } else if (input.sessionScope?.allow.includes(def.risk)) {
      // Coarse, run-scoped grant the user approved up front. NOT a per-plan
      // approval, so confirmed stays false and the audit records the real basis.
      authorizedVia = "session-scope";
    } else {
      const error = "confirmation required (missing or invalid confirm token)";
      audit(false, false, "none", error, args);
      return { ok: false, actionId, summary: "", error, status: 403 };
    }
  }

  // (3) EXECUTE. os-surface actions don't run a server handler — they return a
  // directive for the Tauri client to invoke. The audit below records that the
  // (gated, confirmed) directive was ISSUED, not that the OS op later succeeded.
  let result: ExecuteResult;
  if (def.surface === "os") {
    try {
      const osDirective = osDirectiveFor(actionId, args);
      result = { ok: true, actionId, summary: `${def.title} — dispatched`, osDirective, status: 200 };
    } catch (err) {
      surfaceError(`action:${actionId}`, err);
      result = { ok: false, actionId, summary: "", error: err instanceof Error ? err.message : String(err), status: 500 };
    }
  } else {
    const handler = HANDLERS[actionId];
    if (!handler) {
      result = { ok: false, actionId, summary: "", error: "no handler for server action", status: 500 };
    } else {
      // Embodiment: probe the slice of world state the action touches before
      // and after, so the causal world model learns from OBSERVED outcomes
      // (actions/consequences.ts). Probe faults degrade to null — never block.
      const beforeProbe = await probeState(actionId, args).catch(() => null);
      try {
        const out = await handler(args);
        result = { ok: true, actionId, summary: out.summary, data: out.data, status: 200 };
      } catch (err) {
        surfaceError(`action:${actionId}`, err);
        result = { ok: false, actionId, summary: "", error: err instanceof Error ? err.message : String(err), status: 500 };
      }
      const afterProbe = await probeState(actionId, args).catch(() => null);
      recordActionOutcome({ actionId, ok: result.ok, before: beforeProbe, after: afterProbe });
    }
  }

  // (4) AUDIT the outcome.
  audit(result.ok, confirmed, authorizedVia, result.ok ? result.summary : result.error ?? "", args);
  return result;
}
