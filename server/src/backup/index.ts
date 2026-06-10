// Scheduled SQLite backup — the brain's memory is one un-replicated file
// (data/brain.sqlite); a disk fault or bad migration is total amnesia. This
// module snapshots it with `VACUUM INTO` (a consistent, compacted copy that is
// safe under WAL while the server is live) on boot + a daily interval, and
// prunes old snapshots so the backup dir is bounded.
//
// Design rules (mirror memory/consolidationEngine.ts):
//   - EVERY entry point is failure-isolated: a backup fault logs and returns,
//     it can never break boot or /api/ask.
//   - Pure-ish helpers (`backupFileName`, `pruneBackups`) take explicit args so
//     the selfcheck drives them against a temp dir with no clock dependency.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb } from "../db/sqlite.js";
import { CONFIG } from "../config.js";

export interface BackupInfo {
  file: string;
  path: string;
  bytes: number;
  mtime: string;
}

export interface BackupResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  pruned: number;
  error?: string;
}

const BACKUP_PREFIX = "brain-";
const BACKUP_SUFFIX = ".sqlite";

export function defaultBackupDir(): string {
  return resolve(CONFIG.dataDir, "backups");
}

/** Timestamped, lexically-sortable snapshot name: brain-20260609-143000.sqlite */
export function backupFileName(at: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${BACKUP_PREFIX}${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}${BACKUP_SUFFIX}`
  );
}

function isBackupFile(name: string): boolean {
  return name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX);
}

/** List snapshots in `dir`, newest first. Missing dir → empty list. */
export function listBackups(dir = defaultBackupDir()): BackupInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(isBackupFile)
    .map((file) => {
      const path = join(dir, file);
      const st = statSync(path);
      return { file, path, bytes: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.file < b.file ? 1 : -1));
}

/** Delete all but the newest `keep` snapshots. Returns how many were removed. */
export function pruneBackups(dir: string, keep: number): number {
  const all = listBackups(dir);
  const excess = all.slice(Math.max(0, keep));
  let pruned = 0;
  for (const b of excess) {
    try {
      unlinkSync(b.path);
      pruned += 1;
    } catch (err) {
      console.warn(`[backup] prune failed for ${b.file}:`, err);
    }
  }
  return pruned;
}

/**
 * Take one snapshot now. `VACUUM INTO` writes a consistent copy even with the
 * server live (it runs inside its own read transaction), and compacts as a
 * bonus. Never throws — failures land in the result.
 */
export function runBackup(opts: { dir?: string; keep?: number; at?: Date } = {}): BackupResult {
  const dir = opts.dir ?? defaultBackupDir();
  const keep = opts.keep ?? CONFIG.backupKeep;
  try {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, backupFileName(opts.at ?? new Date()));
    // Same-second re-run would collide; VACUUM INTO refuses to overwrite.
    if (existsSync(target)) {
      return { ok: true, path: target, bytes: statSync(target).size, pruned: 0 };
    }
    openDb().prepare("VACUUM INTO ?").run(target);
    const bytes = statSync(target).size;
    const pruned = pruneBackups(dir, keep);
    console.log(`[backup] snapshot ${target} (${bytes} bytes, pruned ${pruned})`);
    return { ok: true, path: target, bytes, pruned };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[backup] snapshot failed:", error);
    return { ok: false, pruned: 0, error };
  }
}

/**
 * Boot seam: snapshot now unless a sufficiently fresh one exists, then keep a
 * daily-interval timer. Returns the handle so index.ts can clear it on shutdown.
 */
export function scheduleBackups(): NodeJS.Timeout | null {
  if (!CONFIG.backupEnabled) return null;
  const intervalMs = Math.max(1, CONFIG.backupIntervalHours) * 60 * 60 * 1000;
  const newest = listBackups()[0];
  const fresh = newest && Date.now() - Date.parse(newest.mtime) < intervalMs;
  if (!fresh) runBackup();
  const handle = setInterval(() => runBackup(), intervalMs);
  handle.unref();
  return handle;
}
