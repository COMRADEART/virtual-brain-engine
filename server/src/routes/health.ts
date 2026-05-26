import { Router } from "express";
import { isVectorAvailable, openDb } from "../db/sqlite.js";
import { listConnectors } from "../db/repositories/connectors.js";
import { countMemoryPoints } from "../db/repositories/memory.js";
import { getDiagnosticCounts } from "../util/diagnostics.js";
import { probeWorker } from "../perception/workerClient.js";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  let dbStatus: "ok" | "error" = "ok";
  let memoryCount = 0;
  try {
    memoryCount = countMemoryPoints();
    openDb();
  } catch (err) {
    dbStatus = "error";
  }
  const connectorList = listConnectors();
  const connectors = connectorList.map((c) => ({
    id: c.id,
    kind: c.kind,
    state: c.state,
    enabled: c.enabled,
    isDefault: c.isDefault,
    isLocal: c.isLocal,
    baseUrl: c.baseUrl,
  }));
  const anyRemoteEnabled = connectorList.some((c) => c.enabled && !c.isLocal);
  // Phase 3 — perception sidecar status. 200ms probe; "down" is normal when
  // the Python worker isn't running. The UI shows this in /api/perceive/status
  // already; surfacing it on /health too keeps the dashboard's existing
  // connector/diagnostics surface single-source.
  const perception = await probeWorker();
  res.json({
    db: dbStatus,
    vector: isVectorAvailable() ? "ok" : "unavailable",
    memoryCount,
    connectors,
    locality: anyRemoteEnabled ? "remote" : "local",
    // Per-source counts of previously-swallowed errors (empty when healthy).
    diagnostics: getDiagnosticCounts(),
    perception,
  });
});
