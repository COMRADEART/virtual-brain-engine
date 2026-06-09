import { Router } from "express";
import { isVectorAvailable, openDb } from "../db/sqlite.js";
import { listConnectors } from "../db/repositories/connectors.js";
import { countMemoryPoints } from "../db/repositories/memory.js";
import { getDiagnosticCounts } from "../util/diagnostics.js";
import { probeWorker } from "../perception/workerClient.js";
import { computeLocality } from "../util/locality.js";

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
    locality: computeLocality(connectorList),
    // Voice locality: STT runs LOCALLY via the faster-whisper worker (the
    // cloud-backed Web Speech path was removed), so we report the local worker's
    // STT availability — the badge can show "voice: local" truthfully, and a
    // missing worker reads as "unavailable", never a silent remote egress.
    voice: { stt: perception.models.whisper },
    // Per-source counts of previously-swallowed errors (empty when healthy).
    diagnostics: getDiagnosticCounts(),
    perception,
  });
});
