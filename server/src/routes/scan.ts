import { Router } from "express";
import { z } from "zod";
import {
  deleteScanRoot,
  ensureScanRoot,
  listScanRoots,
  setScanRootEnabled,
} from "../db/repositories/scan.js";
import { runScan, scanState } from "../scanner/indexer.js";

export const scanRouter = Router();

scanRouter.get("/scan/roots", (_req, res) => {
  res.json({ roots: listScanRoots(), state: scanState() });
});

const rootInput = z.object({ path: z.string().min(1) });
scanRouter.post("/scan/roots", (req, res) => {
  const parsed = rootInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const root = ensureScanRoot(parsed.data.path);
  res.json({ root });
});

scanRouter.delete("/scan/roots/:id", (req, res) => {
  deleteScanRoot(req.params.id);
  res.json({ ok: true });
});

scanRouter.post("/scan/roots/:id/toggle", (req, res) => {
  const enabled = req.body?.enabled !== false;
  setScanRootEnabled(req.params.id, enabled);
  res.json({ ok: true });
});

scanRouter.post("/scan/run", async (_req, res) => {
  // Kick off async; respond immediately. Progress streams over WS.
  void runScan().catch((err) => {
    console.error("[scan] run failed:", err);
  });
  res.json({ ok: true, state: scanState() });
});

scanRouter.get("/scan/state", (_req, res) => {
  res.json({ state: scanState() });
});
