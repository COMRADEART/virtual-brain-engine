# Digital Twin System — Technical Specification

## 1. Concept & Vision

The **Digital Twin** is the Computer Brain's continuously-updated internal model
of the machine it runs on. Where **memory is the past** and **world state is the
present**, the Digital Twin is **predicted reality**: a periodically-captured,
queryable snapshot of system + project + cognitive state, plus the pure reasoning
cores that turn a history of snapshots into predictions, simulations, and anomaly
alerts.

It is **not** a new system. It is the next layer on the already-decided stack:

- TypeScript on the existing Express server (`server/src/`). **No Rust rewrite** —
  the `computer-brain/` Rust crates remain scaffolding (per the
  `compactness-ml-roadmap` decision).
- It plugs into the existing **agentic layer**: `core/eventBus.ts`,
  `core/safety.ts` + `agent_audit`, `agents/` runtime, and the
  `brainCore.ts` → WS bridge.
- It is gated by a new pure offline self-check, mirroring
  `agents:selfcheck` / `ranker:selfcheck`.

**Core philosophy**: local-first, zero new dependencies, honest about what it
cannot see.

---

## 2. The os-only honesty contract

The telemetry source is **Node's built-in `os` + `node:fs` + `node:process`
only** (an explicit project decision — no `systeminformation` dependency, no
Tauri bridge, so the web app still runs without the desktop shell).

That buys these metrics for real:

| Layer | Available from Node builtins |
|-------|------------------------------|
| Hardware | CPU utilisation (sampled `os.cpus()` time deltas), total/free RAM, load average (`[0,0,0]` on Windows — handled), system uptime, core count + model, disk used/total for the data dir's filesystem (`fs.statfs`), the brain's own process RSS/heap/cpu |
| Software | Node/V8/platform/arch/release versions, configured connectors + their probed state, the brain's own running agents |
| Workflow | `pipeline_runs` (active/recent), `agent_audit` (recent gated actions), `memory_sequence_patterns` (recurring patterns) |
| Cognitive | active conversation recency (`conversations`/`messages`), recent memory access (`memory_access_log`), agent activity, consolidation thresholds |
| Project | `scan_roots` + `files` (detected projects, languages by extension, recent activity by `scanned_at`) |

And it **cannot** see these under the os-only contract. They are modelled as
`null` **in the types** (not `0`, not optional-with-default) and rendered as
`—` in the dashboard, so a user never sees a fabricated "0°C GPU":

- GPU model / utilisation / temperature
- CPU / battery temperature, battery charge
- Per-process list, open windows, terminal sessions
- Live network throughput (only interface names/addresses are available)
- Installed (vs configured) applications

This is a deliberate, documented trade-off chosen at scoping. A future
`systeminformation` connector could fill the `null`s without changing the shape.

---

## 3. Architecture

```
                       Node os / fs / process  +  SQLite (existing tables)
                                     |
                          server/src/twin/collectors.ts        (pure-ish, per layer)
                                     |
   SystemSensorAgent.think()  --is a capture due?--  act() (safety-gated, audited)
                                     |
                          server/src/twin/snapshotEngine.ts
                          (build TwinSnapshot, persist, prune,
                           keep prev CPU reading for next delta)
                                     |
            +------------------------+------------------------+
            |                        |                        |
   predictiveModel.ts        anomalyDetector.ts        simulationEngine.ts
   (pure: trend + history)   (pure: z-score/EWMA)      (pure: risk, no exec)
            |                        |                        |
            +-----------+------------+------------+-----------+
                        |                         |
            getEventBus().emit("twin-snapshot" | "twin-anomaly")
                        |
              brainCore.ts toWireMessage  ->  broadcast()  ->  /ws/brain
                        |
   GET /api/twin , /api/twin/snapshots , /api/twin/anomalies
   POST /api/twin/simulate (read-only)
                        |
              src/components/DigitalTwinPanel.tsx  (full-mode overlay)
```

The **SystemSensorAgent owns the cadence** (its `think()` returns whether a
capture interval has elapsed; `act()` performs the capture). There is **no
separate `scheduleSnapshotTick`** — routing cadence through the agent gets
safety-gating + `agent_audit` for free and matches `ObserverAgent` /
`SchedulerAgent`. (`scheduleDecayTick` predates the agentic layer; new code does
not follow it.)

---

## 4. Data model

### 4.1 Shared types (`shared/twin.ts`, zero runtime deps)

```typescript
// Every metric the os-only contract cannot supply is `number | null`.
export interface HardwareState {
  cpuPct: number;            // 0-100, derived from os.cpus() time deltas
  cores: number;
  cpuModel: string;
  loadAvg1: number | null;   // null on Windows (os.loadavg() === [0,0,0])
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number | null;   // fs.statfs on data dir; null if unsupported
  diskTotalBytes: number | null;
  uptimeSec: number;
  procRssBytes: number;      // the brain's own footprint
  gpuTempC: number | null;       // always null under os-only
  cpuTempC: number | null;       // always null under os-only
  batteryPct: number | null;     // always null under os-only
}

export interface SoftwareState {
  nodeVersion: string;
  platform: string;
  arch: string;
  osRelease: string;
  connectors: Array<{ id: string; kind: string; state: string; isDefault: boolean }>;
  agents: Array<{ name: string; capabilities: string[] }>;
}

export interface WorkflowState {
  activeRuns: number;
  recentRuns: Array<{ id: string; status: string; startedAt: string }>;
  recentActions: Array<{ agent: string; action: string; at: string }>;
  recurringPatterns: number;       // count from memory_sequence_patterns
}

export interface CognitiveTwinState {
  activeConversationId: string | null;
  lastMessageAt: string | null;
  recentMemoryAccess: number;      // memory_access_log in the last window
  agentActivity: Array<{ agent: string; state: string; at: string }>;
  focus: number;                   // 0-1 heuristic from access concentration
}

export interface ProjectTwinState {
  projects: Array<{
    name: string;
    fileCount: number;
    languages: string[];           // top extensions
    lastActivityAt: string | null;
  }>;
}

export interface TwinSnapshot {
  id: string;                      // ULID
  capturedAt: string;              // ISO
  healthScore: number;             // 0-1 composite
  hardware: HardwareState;
  software: SoftwareState;
  workflow: WorkflowState;
  cognitive: CognitiveTwinState;
  project: ProjectTwinState;
}

export interface TwinAnomaly {
  id: string;
  detectedAt: string;
  kind: "cpu-spike" | "mem-pressure" | "disk-pressure"
      | "workflow-failure-spike" | "automation-loop";
  severity: "info" | "warn" | "critical";
  metric: string;
  value: number;
  baseline: number;
  detail: string;
}

export interface TwinPrediction {
  metric: "cpuPct" | "memUsedBytes" | "diskUsedBytes" | "workflow-failure";
  horizonMin: number;
  predicted: number;
  confidence: number;              // 0-1
  reason: string;
}

export interface SimulationResult {
  action: string;
  predictedImpact: string;
  riskScore: number;               // 0-1
  estimatedRuntimeMs: number;
  conflicts: string[];
  rollbackRecommendation: string;
}
```

### 4.2 Schema — 4 tables, not the spec's 9 (decision)

The original prompt asked for nine tables (`system_snapshots`,
`hardware_state`, `software_state`, `workflow_state`, `cognitive_state`,
`project_state`, `anomaly_logs`, `predictive_models`, `simulation_results`).

**Decision: collapse the six per-layer state tables into one
`system_snapshots` row with a `layers_json` blob.** Rationale: every read in
this system is *whole-snapshot* ("latest", "recent N") and all trend math runs
in JS over recent snapshots, never as cross-snapshot SQL aggregation on a single
layer. Per-layer tables would add schema + join cost they never repay. The
per-layer split only wins if we later need `AVG(cpuPct) GROUP BY hour` in SQL —
if that day comes, a derived rollup table is the right fix, not six normalised
tables now. `predictive_models` becomes `twin_predictions` (we log predictions +
later-observed actuals, which is more useful than storing model blobs).

All statements are idempotent (`IF NOT EXISTS`), appended to
`server/src/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS system_snapshots (
  id           TEXT PRIMARY KEY,
  captured_at  TEXT NOT NULL,
  health_score REAL NOT NULL,
  layers_json  TEXT NOT NULL          -- HardwareState+Software+Workflow+Cognitive+Project
);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON system_snapshots(captured_at DESC);

CREATE TABLE IF NOT EXISTS anomaly_logs (
  id           TEXT PRIMARY KEY,
  detected_at  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  severity     TEXT NOT NULL,
  metric       TEXT NOT NULL,
  value        REAL NOT NULL,
  baseline     REAL NOT NULL,
  detail       TEXT,
  snapshot_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_anomaly_time ON anomaly_logs(detected_at DESC);

CREATE TABLE IF NOT EXISTS twin_predictions (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  metric       TEXT NOT NULL,
  horizon_min  INTEGER NOT NULL,
  predicted    REAL NOT NULL,
  confidence   REAL NOT NULL,
  actual       REAL,                  -- backfilled when the horizon elapses
  reason       TEXT
);
CREATE INDEX IF NOT EXISTS idx_pred_time ON twin_predictions(created_at DESC);

CREATE TABLE IF NOT EXISTS simulation_results (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  action       TEXT NOT NULL,
  risk_score   REAL NOT NULL,
  result_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sim_time ON simulation_results(created_at DESC);
```

Snapshot retention is capped (default keep last 500) and pruned inside the
snapshot engine after each capture.

---

## 5. Reasoning cores (pure, deterministic, self-checkable)

- **predictiveModel.ts** — least-squares linear trend over the last N snapshots'
  `cpuPct` / `memUsedBytes` / `diskUsedBytes`; workflow-failure likelihood from
  the ratio of failed runs in `agent_audit` / `pipeline_runs` history. Returns
  `TwinPrediction[]` with a confidence that shrinks as variance grows. No I/O —
  takes snapshots as an argument.
- **simulationEngine.ts** — `simulate(action, recentSnapshots, history)` →
  `SimulationResult`. Heuristic, history-driven, **never executes anything**:
  estimates resource headroom from current vs trend, risk from prior failures of
  similar actions, and emits a rollback recommendation. `POST /api/twin/simulate`
  is therefore inherently safe (read-only).
- **anomalyDetector.ts** — rolling mean + std over recent snapshots; flags a
  metric when `|value − mean| > k·std` (z-score), a workflow-failure spike when
  the recent failure ratio jumps, and an "automation-loop" when one agent/action
  pair repeats more than a threshold inside a short window (the
  "dangerous automation loop" guard). Returns `TwinAnomaly[]`.

All three are imported by `twin-selfcheck.ts` and exercised with synthetic
arrays — no DB, no native modules, no live `os` dependence (the CPU-delta math
is a pure function fed fabricated `os.cpus()`-shaped readings).

---

## 6. Eventing & API

- New `BrainEvent` kinds: `twin-snapshot` (payload: id, capturedAt,
  healthScore, summary), `twin-anomaly` (the `TwinAnomaly`). Added to
  `core/eventBus.ts` **and** the exhaustive `toWireMessage` switch in
  `brainCore.ts` (the switch has no `default`; omitting a case fails
  `tsc`). Mapped onto two new `BrainBusMessage` variants in
  `shared/pipeline.ts`.
- Routes (mounted under `/api` in `index.ts`; non-GET requires the existing
  `X-Brain-Local: 1` header):
  - `GET /api/twin` — latest snapshot + recent anomalies + live predictions
  - `GET /api/twin/snapshots?limit=N` — recent snapshots
  - `GET /api/twin/anomalies?limit=N` — recent anomaly log
  - `POST /api/twin/simulate` `{ action }` — `SimulationResult` (no execution)

---

## 7. Dashboard

`src/components/DigitalTwinPanel.tsx`, rendered as an overlay in the **`full`**
layout alongside `UnifiedPanel`/`PipelineOverlay` (consistent with every other
overlay in the app; compact/focus stay minimal by design). Collapsible. It pulls
`GET /api/twin` on mount and live-updates from `brainBus` `twin-snapshot` /
`twin-anomaly` messages. Sections: hardware gauges, AI-model/software status,
workflow + recurring patterns, cognitive state, project health, and a live
anomaly feed. `null` metrics render as `—`.

**Hard gate constraints (from `scripts/verify-canvas.mjs` &
`scripts/smoke-actions.mjs`):**

- `verify:canvas` reads the `<canvas>` backing store directly, so a DOM overlay
  cannot blank it — but a thrown exception fails it. The panel must never throw;
  fetch failures degrade silently (like the other panels and the `:8787` WS).
- `smoke-actions` fails on **any** non-filtered console error, picks action
  buttons by exact `textContent`, and grabs the **last `<input type=range>`** as
  the density slider. Therefore the panel: contains **no `<input type=range>`**;
  has **no `<button>`** whose trimmed text equals an action label
  (`Lift hand`, `See object`, `Hear sound`, `Remember event`, `Fear response`,
  `Speak`, `Read text`) or `L Memory`; uses a private `.twin-*` CSS namespace
  (never `.active-route`, `.readout`, `.region-row`, `.action-readout`); logs no
  console errors.
- Tauri-free: no `import("@tauri-apps/api/...")` anywhere in its module graph
  (the os-only contract means it never needs Tauri anyway).

---

## 8. Phases

0. **Spec** (this document) — stop-and-check artifact.
1. **Types + schema + bus wiring** — `shared/twin.ts`, `shared/pipeline.ts`
   variants, `eventBus.ts` + `brainCore.ts` cases, 4 schema tables.
2. **Collectors + snapshot engine + SystemSensorAgent** — agent owns cadence.
3. **Reasoning cores** — predictive / simulation / anomaly (pure).
4. **API + `twin:selfcheck` gate** — routes + offline deterministic check.
5. **Dashboard** — `DigitalTwinPanel.tsx` + `apiClient` + `App.tsx` wiring.
6. **Gates** — `typecheck`, `twin:selfcheck`, `build`, `test:all`; update memory.

## 9. Quality gates

- `npm --prefix server run typecheck` — strict, no implicit any.
- `npm --prefix server run twin:selfcheck` — new, pure, offline; asserts CPU%
  math, prediction-trend monotonicity, simulation risk ordering, anomaly
  z-score firing.
- `npm run build` — frontend `tsc` + `vite build`.
- `npm run test:all` — boots Vite, runs `verify:canvas` + `test:actions`.

## 10. Known limitations (by design)

- os-only telemetry: GPU/temps/battery/per-process/windows/terminals/live-network
  are `null`. Documented in §2; surfaced honestly as `—`.
- Dashboard is `full`-layout only (matches existing overlays). Surfacing it in
  compact/focus is a deliberate non-goal of this pass; trivially addable later.
- Simulation/prediction are heuristic, not learned models. The
  `twin_predictions.actual` column is the seam for a future accuracy-learning
  loop (out of scope here, like the deferred permission allowlist).
