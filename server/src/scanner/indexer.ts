import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { CONFIG } from "../config.js";
import {
  ensureScanRoot,
  getFile,
  listScanRoots,
  upsertFile,
} from "../db/repositories/scan.js";
import { upsertMemoryPoint } from "../db/repositories/memory.js";
import { getDefaultConnectorInstance } from "../connectors/registry.js";
import { broadcast } from "../ws/brainBus.js";
import { chunkFile } from "./chunker.js";
import { isLikelyBinary, walk } from "./walker.js";

interface ScanState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  processed: number;
  total: number; // running total of files visited (not pre-counted)
  skipped: number;
  current: string | null;
  lastError: string | null;
}

const state: ScanState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  processed: 0,
  total: 0,
  skipped: 0,
  current: null,
  lastError: null,
};

export function scanState(): ScanState {
  return { ...state };
}

function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

export async function runScan(): Promise<void> {
  if (state.running) {
    return;
  }
  const connector = getDefaultConnectorInstance();
  if (!connector?.embed) {
    state.lastError = "Default connector has no embed() -- enable Ollama before scanning.";
    broadcast({ type: "scan", processed: 0, total: 0, done: true, current: state.lastError });
    return;
  }

  // Ensure at least the configured default scan root exists.
  if (listScanRoots().length === 0) {
    ensureScanRoot(CONFIG.defaultScanRoot);
  }
  const roots = listScanRoots().filter((r) => r.enabled);
  if (roots.length === 0) {
    broadcast({ type: "scan", processed: 0, total: 0, done: true, current: "No enabled scan roots" });
    return;
  }

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.processed = 0;
  state.total = 0;
  state.skipped = 0;
  state.lastError = null;
  state.current = null;

  try {
    for (const root of roots) {
      for await (const file of walk(root.path, {
        maxBytes: CONFIG.maxFileBytes,
        maxFiles: CONFIG.maxFilesPerScan,
      })) {
        state.total += 1;
        state.current = file.path;
        if (state.total % 5 === 0) {
          broadcast({
            type: "scan",
            processed: state.processed,
            total: state.total,
            current: file.path,
          });
        }

        let raw: Buffer;
        try {
          raw = await readFile(file.path);
        } catch {
          state.skipped += 1;
          continue;
        }
        if (isLikelyBinary(raw)) {
          state.skipped += 1;
          continue;
        }
        const content = raw.toString("utf8");
        const hash = sha1(content);
        const prior = getFile(file.path);
        if (prior && prior.contentHash === hash) {
          state.skipped += 1;
          continue;
        }

        const ext = extname(file.path).toLowerCase();
        const chunks = chunkFile(content, ext);
        let written = 0;
        for (const chunk of chunks) {
          try {
            const embedding = await connector.embed(chunk.content);
            upsertMemoryPoint({
              sourceType: "chunk",
              filePath: file.path,
              projectName: file.projectName,
              title: `${file.projectName}/${file.path.split(/[/\\]/).pop()}#${chunk.index}`,
              content: chunk.content,
              contentHash: sha1(chunk.content),
              embedding,
              importance: 0.5,
              metadata: { chunkIndex: chunk.index, ext },
            });
            written += 1;
          } catch (err) {
            state.lastError = err instanceof Error ? err.message : String(err);
            // Bail out on the first embedding failure -- almost always means
            // Ollama is down and continuing will spam the log.
            break;
          }
        }

        if (written > 0) {
          upsertFile({
            path: file.path,
            projectName: file.projectName,
            sizeBytes: file.size,
            contentHash: hash,
            scannedAt: new Date().toISOString(),
            chunkCount: written,
          });
          state.processed += 1;
        }
      }
      if (state.lastError) {
        break;
      }
    }
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
    broadcast({
      type: "scan",
      processed: state.processed,
      total: state.total,
      current: state.lastError ?? "done",
      done: true,
    });
  }
}
