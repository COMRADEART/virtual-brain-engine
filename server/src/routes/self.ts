import { Router } from "express";
import { getSelfConsciousness } from "../core/selfConsciousness.js";
import type { SelfAwarenessLevel } from "../../../shared/selfConsciousness.js";

const router = Router();

router.get("/state", (_req, res) => {
  try {
    const sc = getSelfConsciousness();
    res.json(sc.snapshot());
  } catch {
    res.status(503).json({ error: "Self-consciousness not yet initialized" });
  }
});

router.get("/model", (_req, res) => {
  try {
    const sc = getSelfConsciousness();
    res.json(sc.getSelfModel());
  } catch {
    res.status(503).json({ error: "Self-consciousness not yet initialized" });
  }
});

router.get("/affect", (_req, res) => {
  try {
    const sc = getSelfConsciousness();
    res.json(sc.getSelfAffect());
  } catch {
    res.status(503).json({ error: "Self-consciousness not yet initialized" });
  }
});

router.get("/observations", (_req, res) => {
  try {
    const sc = getSelfConsciousness();
    res.json(sc.getRecentObservations());
  } catch {
    res.status(503).json({ error: "Self-consciousness not yet initialized" });
  }
});

router.get("/monologues", (_req, res) => {
  try {
    const sc = getSelfConsciousness();
    res.json(sc.getRecentMonologues());
  } catch {
    res.status(503).json({ error: "Self-consciousness not yet initialized" });
  }
});

router.get("/questions", (_req, res) => {
  try {
    const sc = getSelfConsciousness();
    res.json(sc.getOpenQuestions());
  } catch {
    res.status(503).json({ error: "Self-consciousness not yet initialized" });
  }
});

router.post("/judge", (req, res) => {
  try {
    const sc = getSelfConsciousness();
    const { question, answer, confidence, basedOnMemories } = req.body as {
      question: string;
      answer: string;
      confidence: number;
      basedOnMemories: number;
    };
    if (!question || !answer) {
      res.status(400).json({ error: "question and answer are required" });
      return;
    }
    const judgment = sc.judge(
      question,
      answer,
      confidence ?? 0.5,
      basedOnMemories ?? 0,
    );
    res.json(judgment);
  } catch {
    res.status(503).json({ error: "Self-consciousness not yet initialized" });
  }
});

router.post("/predict", (req, res) => {
  try {
    const sc = getSelfConsciousness();
    const { horizon, prediction, reasoning } = req.body as {
      horizon: "immediate" | "short" | "medium" | "long";
      prediction: string;
      reasoning: string;
    };
    if (!prediction || !reasoning) {
      res.status(400).json({ error: "prediction and reasoning are required" });
      return;
    }
    const pred = sc.predictSelf(
      horizon ?? "short",
      prediction,
      reasoning,
    );
    res.json(pred);
  } catch {
    res.status(503).json({ error: "Self-consciousness not yet initialized" });
  }
});

router.post("/predict/verify", (req, res) => {
  try {
    const sc = getSelfConsciousness();
    const { id, actualOutcome, wasCorrect } = req.body as {
      id: string;
      actualOutcome: string;
      wasCorrect: boolean;
    };
    if (!id || actualOutcome === undefined || wasCorrect === undefined) {
      res.status(400).json({ error: "id, actualOutcome, and wasCorrect are required" });
      return;
    }
    sc.verifyPrediction(id, actualOutcome, wasCorrect);
    res.json({ ok: true });
  } catch {
    res.status(503).json({ error: "Self-consciousness not yet initialized" });
  }
});

router.patch("/awareness-level", (req, res) => {
  try {
    const sc = getSelfConsciousness();
    const { level } = req.body as { level: SelfAwarenessLevel };
    const validLevels: SelfAwarenessLevel[] = ["none", "monitoring", "reflexive", "narrative"];
    if (!level || !validLevels.includes(level)) {
      res.status(400).json({ error: `level must be one of: ${validLevels.join(", ")}` });
      return;
    }
    sc.setAwarenessLevel(level);
    res.json({ ok: true, level });
  } catch {
    res.status(503).json({ error: "Self-consciousness not yet initialized" });
  }
});

export default router;