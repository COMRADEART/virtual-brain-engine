import { Router } from "express";
import { isVectorAvailable, openDb } from "../db/sqlite.js";
import { listConnectors } from "../db/repositories/connectors.js";
import { countMemoryPoints } from "../db/repositories/memory.js";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
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
  res.json({
    db: dbStatus,
    vector: isVectorAvailable() ? "ok" : "unavailable",
    memoryCount,
    connectors,
    locality: anyRemoteEnabled ? "remote" : "local",
  });
});
