// Backup selfcheck — hermetic (throwaway DB via BRAIN_DB_PATH, no LLM, no
// network). Mirrors the temp-DB pattern of dedup-selfcheck.ts.
//
// Run: npm --prefix server run backup:selfcheck
//
// Why this exists: the brain is one SQLite file; the backup module is the
// disaster-recovery floor. A backup that silently writes a corrupt/empty file
// is WORSE than none (false confidence), so the core assert is a full
// round-trip: snapshot → open the snapshot as a fresh DB → the data is there.
//
// Asserts:
//   (A) backupFileName is timestamped and lexically sortable.
//   (B) runBackup creates a snapshot; the snapshot is a VALID SQLite DB that
//       contains the same memory_points rows (restore round-trip).
//   (C) listBackups returns newest-first.
//   (D) pruneBackups keeps exactly the newest K.
//   (E) runBackup NEVER throws — an unwritable target yields ok:false.
//   (F) the /api/memory export+backup routes are mounted BEFORE /memory/:id
//       (else the param route swallows them).

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// Throwaway DB BEFORE importing anything that opens it.
const tmp = mkdtempSync(join(tmpdir(), "brain-backup-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { openDb } = await import("../src/db/sqlite.js");
const { backupFileName, listBackups, pruneBackups, runBackup } = await import("../src/backup/index.js");
const Database = (await import("better-sqlite3")).default;

const db = openDb();
const now = "2026-06-09T00:00:00.000Z";
db.prepare(
  `INSERT INTO memory_points (id, source_type, content, content_hash, importance, created_at, updated_at)
   VALUES ('bk-1', 'manual', 'backup survives the round trip', 'hash-bk-1', 0.5, ?, ?)`,
).run(now, now);

// (A) name format + sortability.
const n1 = backupFileName(new Date(2026, 5, 9, 14, 30, 0));
const n2 = backupFileName(new Date(2026, 5, 10, 9, 0, 0));
check("backup name is timestamped", n1 === "brain-20260609-143000.sqlite", n1);
check("backup names sort lexically by time", n2 > n1, `${n1} < ${n2}`);

// (B) snapshot + restore round-trip.
const dir = join(tmp, "backups");
const res = runBackup({ dir, keep: 10 });
check("runBackup succeeds", res.ok && !!res.path, res.error ?? "");
check("snapshot is non-empty", (res.bytes ?? 0) > 0, `bytes=${res.bytes}`);
let restoredRows = -1;
try {
  const restored = new Database(res.path!, { readonly: true });
  restoredRows = (restored.prepare("SELECT COUNT(*) AS n FROM memory_points").get() as { n: number }).n;
  restored.close();
} catch (err) {
  check("snapshot opens as a valid SQLite DB", false, err instanceof Error ? err.message : String(err));
}
check("restore round-trip: memory_points present in snapshot", restoredRows === 1, `rows=${restoredRows}`);

// (C) + (D) listing order and retention pruning.
mkdirSync(dir, { recursive: true });
for (const name of ["brain-20260101-000000.sqlite", "brain-20260102-000000.sqlite", "brain-20260103-000000.sqlite"]) {
  writeFileSync(join(dir, name), "x");
}
const listed = listBackups(dir);
check("listBackups returns newest-first", listed.length >= 4 && listed[listed.length - 1].file === "brain-20260101-000000.sqlite",
  listed.map((b) => b.file).join(","));
const pruned = pruneBackups(dir, 2);
const after = listBackups(dir);
check("pruneBackups keeps exactly the newest K", after.length === 2 && pruned === listed.length - 2,
  `kept=${after.map((b) => b.file).join(",")}`);
check("pruned set is the oldest", after.every((b) => b.file > "brain-20260102-000000.sqlite"));

// (E) failure isolation: a target dir containing a NUL byte cannot be created.
const bad = runBackup({ dir: join(tmp, "nope\0dir"), keep: 1 });
check("runBackup never throws (unwritable target → ok:false)", bad.ok === false && typeof bad.error === "string");

// (F) route mount order: export/backups before /memory/:id.
const { memoryRouter } = await import("../src/routes/memory.js");
type Layer = { route?: { path?: string } };
const paths = ((memoryRouter as unknown as { stack: Layer[] }).stack)
  .map((l) => l.route?.path)
  .filter((p): p is string => typeof p === "string");
const idIdx = paths.indexOf("/memory/:id");
const exportIdx = paths.indexOf("/memory/export");
const backupsIdx = paths.indexOf("/memory/backups");
check("/memory/export mounted before /memory/:id", exportIdx !== -1 && idIdx !== -1 && exportIdx < idIdx,
  `export@${exportIdx} :id@${idIdx}`);
check("/memory/backups mounted before /memory/:id", backupsIdx !== -1 && backupsIdx < idIdx, `backups@${backupsIdx}`);

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
