// Digital Twin collectors — turn Node `os`/`fs`/`process` builtins + the
// existing SQLite tables into the five typed layers of a TwinSnapshot.
//
// Honesty contract (DIGITAL_TWIN_SPEC.md §2): metrics the os-only source
// cannot supply are `null`, never fabricated. DB collectors NEVER throw — they
// degrade to safe empty defaults, mirroring the memory/* modules.

import os from "node:os";
import { statfsSync } from "node:fs";
import { openDb } from "../db/sqlite.js";
import { type CpuSample, computeCpuPct } from "./cpuMath.js";
import type {
  HardwareState,
  SoftwareState,
  WorkflowState,
  CognitiveTwinState,
  ProjectTwinState,
} from "../../../shared/twin.js";

// Re-export so existing importers (snapshotEngine) keep `from "./collectors.js"`.
export type { CpuSample } from "./cpuMath.js";

// --- Hardware -------------------------------------------------------------

export function readCpuSample(): CpuSample[] {
  return os.cpus().map((c) => ({
    user: c.times.user,
    nice: c.times.nice,
    sys: c.times.sys,
    idle: c.times.idle,
    irq: c.times.irq,
  }));
}

export function collectHardware(prevCpu: CpuSample[] | null): {
  hardware: HardwareState;
  cpuSample: CpuSample[];
} {
  const cpuSample = readCpuSample();
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load = os.loadavg();
  // os.loadavg() is [0,0,0] on Windows — report null rather than a fake 0.
  const loadAvg1 = os.platform() === "win32" && load[0] === 0 ? null : load[0];

  let diskUsedBytes: number | null = null;
  let diskTotalBytes: number | null = null;
  try {
    const fsStat = statfsSync(process.cwd());
    const total = fsStat.blocks * fsStat.bsize;
    const free = fsStat.bfree * fsStat.bsize;
    if (Number.isFinite(total) && total > 0) {
      diskTotalBytes = total;
      diskUsedBytes = Math.max(0, total - free);
    }
  } catch {
    // statfs unsupported on this platform/path — stays null (honest).
  }

  return {
    cpuSample,
    hardware: {
      cpuPct: computeCpuPct(prevCpu, cpuSample),
      cores: cpus.length,
      cpuModel: cpus[0]?.model.trim() ?? "unknown",
      loadAvg1,
      memUsedBytes: totalMem - freeMem,
      memTotalBytes: totalMem,
      diskUsedBytes,
      diskTotalBytes,
      uptimeSec: Math.round(os.uptime()),
      procRssBytes: process.memoryUsage().rss,
      gpuTempC: null, // unavailable under the os-only contract
      cpuTempC: null, // unavailable under the os-only contract
      batteryPct: null, // unavailable under the os-only contract
    },
  };
}

// --- Software -------------------------------------------------------------

export function collectSoftware(): SoftwareState {
  const base: SoftwareState = {
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    osRelease: os.release(),
    connectors: [],
    agents: [],
  };
  try {
    const db = openDb();
    base.connectors = db
      .prepare<[], { id: string; kind: string; state: string; is_default: number }>(
        `SELECT id, kind, state, is_default FROM connectors WHERE enabled = 1`,
      )
      .all()
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        state: r.state,
        isDefault: r.is_default === 1,
      }));
    // Observed agents = agents that have been audited. Capabilities are not
    // recorded in the DB, so we report [] rather than guess. NOTE: the very
    // first snapshot (captured in SystemSensorAgent.init(), before any agent
    // has called permitAndAudit) may see []; it self-corrects within one cycle.
    base.agents = db
      .prepare<[], { agent: string }>(
        `SELECT DISTINCT agent FROM agent_audit ORDER BY agent`,
      )
      .all()
      .map((r) => ({ name: r.agent, capabilities: [] as string[] }));
  } catch {
    // DB unavailable — return process/os facts only.
  }
  return base;
}

// --- Workflow -------------------------------------------------------------

export function collectWorkflow(): WorkflowState {
  const out: WorkflowState = {
    activeRuns: 0,
    recentRuns: [],
    recentActions: [],
    recurringPatterns: 0,
  };
  try {
    const db = openDb();
    out.activeRuns =
      db
        .prepare<[], { c: number }>(
          `SELECT COUNT(*) AS c FROM pipeline_runs WHERE status = 'pending'`,
        )
        .get()?.c ?? 0;
    out.recentRuns = db
      .prepare<[], { id: string; status: string; started_at: string }>(
        `SELECT id, status, started_at FROM pipeline_runs
         ORDER BY started_at DESC LIMIT 5`,
      )
      .all()
      .map((r) => ({ id: r.id, status: r.status, startedAt: r.started_at }));
    out.recentActions = db
      .prepare<[], { agent: string; action: string; created_at: string }>(
        `SELECT agent, action, created_at FROM agent_audit
         ORDER BY created_at DESC LIMIT 8`,
      )
      .all()
      .map((r) => ({ agent: r.agent, action: r.action, at: r.created_at }));
    out.recurringPatterns =
      db
        .prepare<[], { c: number }>(
          `SELECT COUNT(*) AS c FROM memory_sequence_patterns WHERE confidence > 0.3`,
        )
        .get()?.c ?? 0;
  } catch {
    // tables absent on a fresh DB — defaults stand.
  }
  return out;
}

// --- Cognitive ------------------------------------------------------------

export function collectCognitive(): CognitiveTwinState {
  const out: CognitiveTwinState = {
    activeConversationId: null,
    lastMessageAt: null,
    recentMemoryAccess: 0,
    agentActivity: [],
    focus: 0,
  };
  try {
    const db = openDb();
    const conv = db
      .prepare<[], { id: string; updated_at: string }>(
        `SELECT id, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 1`,
      )
      .get();
    out.activeConversationId = conv?.id ?? null;
    out.lastMessageAt =
      db
        .prepare<[], { m: string | null }>(
          `SELECT MAX(created_at) AS m FROM messages`,
        )
        .get()?.m ?? null;
    out.recentMemoryAccess =
      db
        .prepare<[], { c: number }>(
          `SELECT COUNT(*) AS c FROM memory_access_log
           WHERE datetime(accessed_at) > datetime('now', '-1 hour')`,
        )
        .get()?.c ?? 0;
    out.agentActivity = db
      .prepare<[], { agent: string; action: string; created_at: string }>(
        `SELECT agent, action, created_at FROM agent_audit
         ORDER BY created_at DESC LIMIT 5`,
      )
      .all()
      .map((r) => ({ agent: r.agent, state: r.action, at: r.created_at }));
    // Focus heuristic: access concentration. Many accesses in the last hour =
    // engaged/focused; saturates at 50. Cheap, honest, bounded 0-1.
    out.focus = Math.max(0, Math.min(1, out.recentMemoryAccess / 50));
  } catch {
    // defaults stand
  }
  return out;
}

// --- Project --------------------------------------------------------------

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > slash && i >= 0 ? p.slice(i + 1).toLowerCase() : "";
}

export function collectProject(): ProjectTwinState {
  const out: ProjectTwinState = { projects: [] };
  try {
    const db = openDb();
    const rows = db
      .prepare<[], { project_name: string | null; path: string; scanned_at: string }>(
        `SELECT project_name, path, scanned_at FROM files`,
      )
      .all();
    const byProject = new Map<
      string,
      { count: number; exts: Map<string, number>; last: string }
    >();
    for (const r of rows) {
      const name = r.project_name ?? "(unknown)";
      const entry =
        byProject.get(name) ?? { count: 0, exts: new Map<string, number>(), last: "" };
      entry.count += 1;
      const ext = extOf(r.path);
      if (ext) entry.exts.set(ext, (entry.exts.get(ext) ?? 0) + 1);
      if (r.scanned_at > entry.last) entry.last = r.scanned_at;
      byProject.set(name, entry);
    }
    out.projects = [...byProject.entries()]
      .map(([name, e]) => ({
        name,
        fileCount: e.count,
        languages: [...e.exts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([ext]) => ext),
        lastActivityAt: e.last || null,
      }))
      .sort((a, b) => b.fileCount - a.fileCount)
      .slice(0, 12);
  } catch {
    // files table absent — empty project list (honest).
  }
  return out;
}
