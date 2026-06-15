// Runtime application-settings router. Mounted under /api:
//   GET  /api/settings        -> catalog + current effective values.
//   POST /api/settings        -> { patch: { key: value, ... } } -> validate + apply.
//   POST /api/settings/reset  -> restore every editable knob to its .env baseline.
//
// The validation, live-CONFIG mutation, and persistence all live in
// settings/runtimeSettings.ts; this is a thin HTTP shim. POSTs inherit the global
// X-Brain-Local guard.

import { Router } from "express";
import { z } from "zod";
import { getSettingsView, resetSettings, updateSettings } from "../settings/runtimeSettings.js";

export const settingsRouter = Router();

settingsRouter.get("/settings", (_req, res) => {
  res.json(getSettingsView());
});

const patchSchema = z.object({
  patch: z.record(z.union([z.boolean(), z.number(), z.string()])),
});

settingsRouter.post("/settings", (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  res.json(updateSettings(parsed.data.patch));
});

settingsRouter.post("/settings/reset", (_req, res) => {
  res.json({ ok: true, view: resetSettings() });
});
