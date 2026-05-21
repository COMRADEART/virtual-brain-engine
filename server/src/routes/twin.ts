// Digital Twin HTTP surface. All reads; the one POST (/simulate) is read-only
// by construction — simulationEngine.simulate() never executes anything — so
// it is safe behind the existing global `X-Brain-Local` guard (index.ts).

import { Router } from "express";
import { z } from "zod";
import { openDb } from "../db/sqlite.js";
import {
  getLatestSnapshot,
  getRecentSnapshots,
  getRecentAnomalies,
  insertSimulation,
} from "../twin/repository.js";
import { predictMetrics } from "../twin/predictiveModel.js";
import { simulate, type SimHistory } from "../twin/simulationEngine.js";
import type { TwinView } from "../../../shared/twin.js";

export const twinRouter = Router();

// GET /api/twin — the dashboard's initial state: latest snapshot + recent
// anomalies + live forecasts over recent history.
twinRouter.get("/twin", (_req, res) => {
  const recent = getRecentSnapshots(60);
  const view: TwinView = {
    snapshot: recent[0] ?? getLatestSnapshot(),
    anomalies: getRecentAnomalies(20),
    predictions: predictMetrics(recent),
  };
  res.json(view);
});

twinRouter.get("/twin/snapshots", (req, res) => {
  const limit = Number.parseInt(String(req.query.limit ?? "30"), 10);
  res.json({
    snapshots: getRecentSnapshots(Number.isFinite(limit) ? limit : 30),
  });
});

twinRouter.get("/twin/anomalies", (req, res) => {
  const limit = Number.parseInt(String(req.query.limit ?? "50"), 10);
  res.json({
    anomalies: getRecentAnomalies(Number.isFinite(limit) ? limit : 50),
  });
});

const SimulateBody = z.object({ action: z.string().min(1).max(500) });

// POST /api/twin/simulate — predict the impact of an action WITHOUT running
// it. History (similar past run/failure counts) is a light proxy from
// pipeline_runs; absence degrades to neutral defaults.
twinRouter.post("/twin/simulate", (req, res) => {
  const parsed = SimulateBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "body must be { action: string }" });
  }

  let history: SimHistory = { pastRuns: 0, pastFailures: 0 };
  try {
    const db = openDb();
    const row = db
      .prepare<[], { runs: number; fails: number }>(
        `SELECT COUNT(*) AS runs,
                SUM(CASE WHEN status IN ('error','failed') THEN 1 ELSE 0 END) AS fails
         FROM pipeline_runs`,
      )
      .get();
    history = {
      pastRuns: row?.runs ?? 0,
      pastFailures: row?.fails ?? 0,
    };
  } catch {
    // no history — neutral defaults stand
  }

  const result = simulate(parsed.data.action, getRecentSnapshots(60), history);
  insertSimulation(result);
  res.json(result);
});
