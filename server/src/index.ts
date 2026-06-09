import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { CONFIG } from "./config.js";
import { openDb } from "./db/sqlite.js";
import { cleanupUsageLog } from "./db/repositories/modelUsage.js";
import { runDedupAudit, mergePair } from "./memory/dedupAudit.js";
import {
  ensureDefaultConnector,
  ensureRemoteProviderConnectors,
  probeAllConnectors,
  reconcileDiscovered,
} from "./connectors/registry.js";
import { ensureScanRoot } from "./db/repositories/scan.js";
import { checkEmbeddingDimMismatch } from "./db/repositories/memory.js";
import { attachBrainBus } from "./ws/brainBus.js";
import { scheduleDecayTick } from "./memory/consolidationEngine.js";
import { startBrainCore } from "./agents/brainCore.js";
import { healthRouter } from "./routes/health.js";
import { memoryRouter } from "./routes/memory.js";
import { scanRouter } from "./routes/scan.js";
import { connectorsRouter } from "./routes/connectors.js";
import { askRouter } from "./routes/ask.js";
import { agentRouter } from "./routes/agent.js";
import { feedbackRouter } from "./routes/feedback.js";
import { learningRouter } from "./routes/learning.js";
import { actionsRouter } from "./routes/actions.js";
import { skillsRouter } from "./routes/skills.js";
import { repoRouter } from "./routes/repo.js";
import { tasksRouter } from "./routes/tasks.js";
import { ingestRouter } from "./routes/ingest.js";
import { webRouter } from "./routes/web.js";
import { githubRouter } from "./routes/github.js";
import { modelsRouter } from "./routes/models.js";
import { conversationsRouter } from "./routes/conversations.js";
import { brainRouter } from "./routes/brain.js";
import { twinRouter } from "./routes/twin.js";
import { swarmRouter } from "./routes/swarm.js";
import { imaginationRouter } from "./routes/imagination.js";
import { evolutionRouter } from "./routes/evolution.js";
import { organismRouter } from "./routes/organism.js";
import { visionRouter } from "./vision/index.js";
import { perceptionRouter } from "./perception/index.js";
import { civilizationRouter, civilization, createLocalDescriptor } from "./routes/civilization.js";
import { phase2Router } from "./routes/phase2.js";
import { voiceRouter } from "./routes/voice.js";
import selfRouter from "./routes/self.js";

async function main(): Promise<void> {
  openDb();

  const dimCheck = checkEmbeddingDimMismatch();
  if (!dimCheck.valid) {
    console.warn(
      `[server] WARNING: Embedding dimension mismatch detected!`,
      `Expected ${dimCheck.expectedDim}, found dims: ${dimCheck.actualDims.join(", ")}.`,
      `Memory search may fail. Update EMBEDDING_DIM to match your embedding model.`,
    );
  } else if (dimCheck.memoryCount > 0) {
    console.info(`[server] Vector DB OK: ${dimCheck.memoryCount} memories, ${dimCheck.expectedDim}d embeddings.`);
  }

  ensureDefaultConnector();
  // Seed free-tier remote providers (NVIDIA/Gemini) as disabled, selectable
  // connectors — only when their API key is present in the env. No key, no row.
  ensureRemoteProviderConnectors();
  ensureScanRoot(CONFIG.defaultScanRoot);
  const decayHandles = scheduleDecayTick();

  // Usage log retention: clean up old rows on boot and every 24 hours.
  const { usageDeleted, routingDeleted } = cleanupUsageLog(CONFIG.usageLogRetentionDays);
  if (usageDeleted + routingDeleted > 0) {
    console.log(`[retention] cleaned ${usageDeleted} usage + ${routingDeleted} routing rows older than ${CONFIG.usageLogRetentionDays}d`);
  }
  const retentionInterval = setInterval(() => {
    cleanupUsageLog(CONFIG.usageLogRetentionDays);
  }, 24 * 60 * 60 * 1000);

  // Memory dedup audit: run on boot + daily. AUDIT-ONLY by default — the audit
  // scans for near-duplicate candidates and logs the count, but only DELETES
  // (merges) them when DEDUP_AUTO_MERGE is explicitly enabled. Auto-merge is
  // irreversible, and at the default 0.92 threshold many distinct-but-related
  // memories score as near-duplicates, so deleting on boot is opt-in.
  const runDedup = () => {
    try {
      const result = runDedupAudit({
        similarityThreshold: CONFIG.dedupSimilarityThreshold,
        maxPairsPerRun: CONFIG.dedupMaxPairs,
      });
      if (result.duplicatesFound === 0) return;
      if (CONFIG.dedupAutoMerge) {
        for (const p of result.pairs) mergePair(p.keep, p.delete);
        console.log(`[dedup] merged ${result.duplicatesFound} duplicates from ${result.scanned} memories`);
      } else {
        console.log(
          `[dedup] ${result.duplicatesFound} near-duplicate candidate(s) from ${result.scanned} memories — ` +
            `auto-merge disabled (set DEDUP_AUTO_MERGE=true to merge; review the threshold first)`,
        );
      }
    } catch (err) {
      console.error("[dedup] audit failed:", err);
    }
  };
  runDedup(); // run on boot
  const dedupInterval = setInterval(runDedup, 24 * 60 * 60 * 1000);

  // Auto-detect any of the 7 supported local LLM runtimes and reconcile them
  // into the connector table. Then keep probing all known connectors so
  // /api/health reflects reality. Both run in the background -- they never
  // block startup.
  void reconcileDiscovered().then(() => probeAllConnectors());
  const reconcileInterval = setInterval(() => {
    void reconcileDiscovered().then(() => probeAllConnectors());
  }, 60_000);

  const app = express();
  // Explicit origin allowlist. The Vite dev origin is the configured default;
  // the Tauri renderer uses tauri://localhost (mac/linux) or
  // http://tauri.localhost (windows) -- both whitelisted so the bundled app
  // can reach /api/* without proxying through Rust. Extra origins via
  // ALLOWED_ORIGIN env var.
  app.use(
    cors({
      origin: [
        CONFIG.allowedOrigin,
        "http://127.0.0.1:4173", // Vite preview (production build) — used by render verification
        "http://localhost:4173",
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
      ],
      credentials: false,
    }),
  );
  app.use("/api", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    if (req.get("X-Brain-Local") !== "1") {
      return res.status(403).json({ error: "missing X-Brain-Local header" });
    }
    next();
  });
  // Body parser. /api/perceive/* installs its OWN json() with a 20mb cap (see
  // perception/index.ts) because audio + image base64 payloads routinely
  // exceed this floor; we must let that route bypass the global parser, or
  // its inner json() is a no-op (body-parser is idempotent). Path-aware shim
  // keeps the 1mb safety floor explicit at this call site instead of hiding
  // it inside reorder gymnastics.
  const globalBodyParser = express.json({ limit: "1mb" });
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/perceive/")) return next();
    return globalBodyParser(req, res, next);
  });
  app.use("/api", healthRouter);
  app.use("/api", memoryRouter);
  app.use("/api", scanRouter);
  app.use("/api", connectorsRouter);
  app.use("/api", askRouter);
  app.use("/api", agentRouter);
  app.use("/api", feedbackRouter);
  app.use("/api", learningRouter);
  app.use("/api", actionsRouter);
  app.use("/api", skillsRouter);
  app.use("/api", repoRouter);
  app.use("/api", tasksRouter);
  app.use("/api", ingestRouter);
  app.use("/api", webRouter);
  app.use("/api", githubRouter);
  app.use("/api", modelsRouter);
  app.use("/api", conversationsRouter);
  app.use("/api", brainRouter);
  app.use("/api", twinRouter);
  app.use("/api", swarmRouter);
  app.use("/api", imaginationRouter);
  app.use("/api", evolutionRouter);
  app.use("/api", organismRouter);
  app.use("/api", visionRouter);
  app.use("/api", perceptionRouter);
  app.use("/api", voiceRouter);
  app.use("/api", phase2Router);
  app.use("/api", civilizationRouter);
  app.use("/api", selfRouter);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[server] error:", message);
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  });

  const server = createServer(app);
  attachBrainBus(server);

  // COMPUTER BRAIN agentic layer (observer + summary + scheduler). Never
  // blocks startup if an agent's init misbehaves — the runtime isolates that.
  const brain = await startBrainCore().catch((err) => {
    console.error("[server] brain core failed to start:", err);
    return null;
  });

  // Own-model auto-train: fire-and-forget; the training runs in the Python
  // worker background thread so it never blocks server boot. Failures are
  // caught and logged so a misbehaving trainer can't crash the server.
  if (CONFIG.autoStartOwnModel) {
    import("./learning/autoStart.js")
      .then(({ checkAndStartOwnModelTraining }) =>
        void checkAndStartOwnModelTraining().catch((err) =>
          console.warn("[server] own-model auto-train failed:", err),
        ),
      )
      .catch((err) => console.warn("[server] auto-train module load failed:", err));
  }

  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`[server] http://${CONFIG.host}:${CONFIG.port} (ws /ws/brain)`);
    if (CONFIG.civilizationEnabled) {
      void civilization
        .start(createLocalDescriptor())
        .catch((err) => console.error("[server] civilization failed to start:", err));
    }
  });

  const shutdown = (): void => {
    clearInterval(reconcileInterval);
    clearInterval(decayHandles.spreadingActivation);
    clearInterval(decayHandles.decayTick);
    void brain?.shutdown();
    if (civilization.isRunning()) {
      void civilization.stop();
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
