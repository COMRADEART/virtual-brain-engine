import { Router } from "express";
import { speak, validateSpeakText, voiceStatus, type SpeakRequest } from "../voice/voiceClient.js";

export const voiceRouter = Router();

voiceRouter.post("/speak", async (req, res) => {
  const { text, voice, preset } = req.body as SpeakRequest;

  const validation = validateSpeakText(text);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  const result = await speak({ text: validation.text, voice, preset });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.json(result.data);
});

// Cheap readiness probe — does NOT synthesize (the old version did a full Bark
// load on every status hit and could falsely report "unavailable" on a cold
// worker). Reads the worker's /healthz tts state instead.
voiceRouter.get("/status", async (_req, res) => {
  res.json(await voiceStatus());
});

export default voiceRouter;