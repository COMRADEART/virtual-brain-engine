import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { CONFIG } from "./config.js";
import { openDb } from "./db/sqlite.js";
import {
  ensureDefaultConnector,
  probeAllConnectors,
  reconcileDiscovered,
} from "./connectors/registry.js";
import { ensureScanRoot } from "./db/repositories/scan.js";
import { attachBrainBus } from "./ws/brainBus.js";
import { healthRouter } from "./routes/health.js";
import { memoryRouter } from "./routes/memory.js";
import { scanRouter } from "./routes/scan.js";
import { connectorsRouter } from "./routes/connectors.js";
import { askRouter } from "./routes/ask.js";
import { conversationsRouter } from "./routes/conversations.js";

async function main(): Promise<void> {
  openDb();
  ensureDefaultConnector();
  ensureScanRoot(CONFIG.defaultScanRoot);

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
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
      ],
      credentials: false,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    if (req.get("X-Brain-Local") !== "1") {
      return res.status(403).json({ error: "missing X-Brain-Local header" });
    }
    next();
  });
  app.use("/api", healthRouter);
  app.use("/api", memoryRouter);
  app.use("/api", scanRouter);
  app.use("/api", connectorsRouter);
  app.use("/api", askRouter);
  app.use("/api", conversationsRouter);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[server] error:", message);
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  });

  const server = createServer(app);
  attachBrainBus(server);
  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`[server] http://${CONFIG.host}:${CONFIG.port} (ws /ws/brain)`);
  });

  const shutdown = (): void => {
    clearInterval(reconcileInterval);
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
