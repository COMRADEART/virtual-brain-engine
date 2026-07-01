import { Router } from "express";
import { speak, validateSpeakText, voiceStatus } from "../voice/voiceClient.js";
import { decideSpeech } from "../voice/speechPolicy.js";
import { CONFIG } from "../config.js";
import type { SpeakRequest, SpeakResponse } from "../../../shared/voice.js";

export const voiceRouter = Router();

// The brain's single "mouth". Every speak request — pet, AskPanel, agent loop —
// passes the governed speech policy here, so the rules (enabled/mode gate,
// sanitize, redact secrets, length cap) hold in ONE place and can't be bypassed,
// even on the browser-TTS fallback path (which only ever receives governed text).
voiceRouter.post("/speak", async (req, res) => {
  const body = (req.body ?? {}) as SpeakRequest;

  // Hard input guard (5000-char ceiling) before the policy.
  const validation = validateSpeakText(body.text);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  const decision = decideSpeech({
    text: validation.text,
    kind: body.kind ?? "manual",
    enabled: CONFIG.voiceEnabled,
    mode: CONFIG.voiceMode,
    maxChars: CONFIG.voiceMaxChars,
    persona: body.persona,
    defaultPreset: CONFIG.voicePreset,
  });

  if (!decision.speak) {
    const out: SpeakResponse = { spoken: false, reason: decision.reason };
    res.json(out);
    return;
  }

  // Prefer the local Bark worker; fall back to the browser's Web Speech API with
  // the SAME governed text. Bark is local, so this path makes no outbound request
  // — LOCAL_ONLY has nothing to gate here. (A remote TTS, if ever added, would
  // have to route through assertEgressAllowed first.)
  const status = await voiceStatus();
  if (status.voice === "ready" || status.voice === "available") {
    const result = await speak({
      text: decision.text,
      voice: body.voice ?? decision.preset,
      preset: body.preset,
    });
    if (result.ok) {
      const out: SpeakResponse = { spoken: true, mode: "audio", ...result.data };
      res.json(out);
      return;
    }
    // Worker errored mid-call — degrade to client TTS rather than failing.
  }

  const out: SpeakResponse = {
    spoken: true,
    mode: "client-tts",
    text: decision.text,
    preset: decision.preset,
  };
  res.json(out);
});

// Cheap readiness probe — does NOT synthesize (reads the worker's /healthz tts
// state). The client uses this to decide whether to even attempt the audio path.
voiceRouter.get("/status", async (_req, res) => {
  res.json(await voiceStatus());
});

export default voiceRouter;
