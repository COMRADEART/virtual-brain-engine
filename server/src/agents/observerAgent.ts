// ObserverAgent — the SENSORY SYSTEM.
//
// Watches the configured scan roots with chokidar (already a server dep, so
// zero new packages) and turns raw filesystem noise into two bus events:
//   - file-changed       one debounced add/change/unlink
//   - activity-observed   an aggregated burst, emitted after a quiet period
//
// Decision (plan §"Explicit sub-decisions"): this is SERVER-SIDE chokidar, NOT
// a bridge to the Rust src-tauri/file_watcher.rs. CLAUDE.md guarantees "the web
// app runs without Tauri", so the agent layer must not depend on the Tauri
// renderer being present. The Rust watcher stays for the Tauri project-stats
// UI; the two are intentionally independent.

import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { resolve, sep } from "node:path";
import type { Agent, AgentContext } from "./Agent.js";
import { CONFIG } from "../config.js";
import { ensureScanRoot, listScanRoots } from "../db/repositories/scan.js";

// Mirrors server/src/scanner/walker.ts so the agent and the on-demand scanner
// agree on what is noise. Kept local to avoid exporting walker internals.
const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", ".next",
  ".nuxt", "target", "venv", ".venv", "__pycache__", ".cache", ".turbo",
  ".pytest_cache", ".mypy_cache", ".idea", ".vscode", "coverage",
  ".parcel-cache",
]);
const WHITELIST_EXT = new Set([
  ".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py",
  ".java", ".go", ".rs", ".rb", ".php", ".html", ".htm", ".css", ".scss",
  ".yml", ".yaml", ".toml", ".ini", ".sql", ".sh", ".ps1",
]);

const QUIET_MS = 4000; // burst window: 4s of silence closes an activity batch
const MAX_INDIVIDUAL_EMITS = 40; // cap per-file events per window (avoid WS flood)

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

function isIgnoredPath(path: string): boolean {
  const parts = path.split(/[/\\]/);
  for (const part of parts) {
    if (IGNORE_DIRS.has(part)) return true;
  }
  // Only filter by extension when it looks like a file (has a dot in the last
  // segment). Directories pass through so chokidar can descend.
  const last = parts[parts.length - 1] ?? "";
  if (last.includes(".")) {
    return !WHITELIST_EXT.has(extOf(last));
  }
  return false;
}

function projectNameFor(roots: string[], path: string): string {
  const abs = resolve(path);
  for (const root of roots) {
    if (abs.startsWith(root)) {
      const rel = abs.slice(root.length).replace(/^[/\\]+/, "");
      const first = rel.split(/[/\\]/)[0];
      return first || root.split(sep).filter(Boolean).pop() || "(root)";
    }
  }
  return "(unknown)";
}

export class ObserverAgent implements Agent {
  private ctx: AgentContext | null = null;
  private watcher: FSWatcher | null = null;
  private roots: string[] = [];
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private buffer = new Map<string, Set<string>>(); // project -> changed paths
  private emittedThisWindow = 0;

  name(): string {
    return "observer";
  }

  capabilities(): string[] {
    return ["fs-watch", "project-detection", "activity-aggregation"];
  }

  init(ctx: AgentContext): void {
    this.ctx = ctx;

    let scanRoots = listScanRoots().filter((r) => r.enabled);
    if (scanRoots.length === 0) {
      ensureScanRoot(CONFIG.defaultScanRoot);
      scanRoots = listScanRoots().filter((r) => r.enabled);
    }
    this.roots = scanRoots.map((r) => resolve(r.path));
    if (this.roots.length === 0) {
      ctx.log("no scan roots configured; observer idle");
      return;
    }

    this.watcher = chokidarWatch(this.roots, {
      ignoreInitial: true,
      persistent: true,
      ignored: (p: string) => isIgnoredPath(p),
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.watcher
      .on("add", (p) => this.onChange(p, "add"))
      .on("change", (p) => this.onChange(p, "change"))
      .on("unlink", (p) => this.onChange(p, "unlink"))
      .on("error", (err) =>
        ctx.log(`watch error: ${err instanceof Error ? err.message : String(err)}`),
      );

    ctx.log(`watching ${this.roots.length} root(s): ${this.roots.join(", ")}`);
  }

  private onChange(path: string, change: "add" | "change" | "unlink"): void {
    if (!this.ctx) return;
    const project = projectNameFor(this.roots, path);

    if (this.emittedThisWindow < MAX_INDIVIDUAL_EMITS) {
      this.emittedThisWindow += 1;
      this.ctx.bus.emit({
        kind: "file-changed",
        path,
        change,
        projectName: project,
        at: new Date().toISOString(),
      });
    }

    let set = this.buffer.get(project);
    if (!set) {
      set = new Set<string>();
      this.buffer.set(project, set);
    }
    set.add(path);

    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.flushBurst(), QUIET_MS);
  }

  private flushBurst(): void {
    if (!this.ctx) return;
    for (const [project, files] of this.buffer) {
      this.ctx.bus.emit({
        kind: "activity-observed",
        projectName: project,
        files: [...files],
        at: new Date().toISOString(),
      });
    }
    this.buffer.clear();
    this.emittedThisWindow = 0;
    this.quietTimer = null;
  }

  // Observer is purely reactive (chokidar-driven); the proactive loop is a no-op.
  handleEvent(): void {}
  think(): void {}
  act(): void {}

  async shutdown(): Promise<void> {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
