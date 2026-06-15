// Runtime application-settings selfcheck. HERMETIC: throwaway DB via BRAIN_DB_PATH
// (set BEFORE importing config-dependent modules), no network. Baseline-AGNOSTIC:
// the repo .env is loaded by config.ts, so we capture each knob's effective value
// at runtime and assert relative to it — never hardcode an expected default.
//
// Run: npm --prefix server run settings:selfcheck
//
// Asserts:
//   Catalog   — non-empty, groups derived, danger flags present, value mirrors CONFIG.
//   Apply     — a boolean/enum/number patch mutates the LIVE CONFIG immediately.
//   Validate  — numbers clamp to bounds; bad enum / bad boolean / unknown key are
//               rejected WITHOUT mutating CONFIG; a partial patch applies the good keys.
//   Restart   — a requiresRestart key is surfaced in restartRequired.
//   Persist   — overrides survive a simulated reboot (applyPersistedSettings re-applies).
//   Reset     — every knob returns to its captured baseline + overrides are cleared.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-settingscheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const { openDb } = await import("../src/db/sqlite.js");
const { CONFIG } = await import("../src/config.js");
const rs = await import("../src/settings/runtimeSettings.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb();

// Capture baselines BEFORE any mutation (these equal the .env/default state).
const baseFast = CONFIG.fastMode;
const baseMode = CONFIG.webSearchMode;
const baseTokens = CONFIG.fastModeMaxTokens;
const baseSleep = CONFIG.sleepCycle;
// Pick an enum value that differs from the baseline so the assertion is real.
const altMode = baseMode === "always" ? "smart" : "always";

// --- Catalog / view ---------------------------------------------------------
{
  const view = rs.getSettingsView();
  check("catalog is non-empty", view.settings.length > 10, `n=${view.settings.length}`);
  check("groups are derived", view.groups.length >= 5, `groups=${view.groups.length}`);
  const fast = view.settings.find((s) => s.key === "fastMode");
  check("a view value mirrors live CONFIG", fast?.value === CONFIG.fastMode);
  const local = view.settings.find((s) => s.key === "localOnly");
  check("localOnly is danger-flagged", local?.danger === true);
  const shell = view.settings.find((s) => s.key === "allowShell");
  check("allowShell is danger-flagged", shell?.danger === true);
  const sleep = view.settings.find((s) => s.key === "sleepCycle");
  check("sleepCycle is requiresRestart", sleep?.requiresRestart === true);
}

// --- Apply: boolean / enum --------------------------------------------------
{
  const r = rs.updateSettings({ fastMode: !baseFast });
  check("boolean patch applies to live CONFIG", r.applied.includes("fastMode") && CONFIG.fastMode === !baseFast);
  const e = rs.updateSettings({ webSearchMode: altMode });
  check("enum patch applies to live CONFIG", CONFIG.webSearchMode === altMode && e.applied.includes("webSearchMode"));
}

// --- Validate: number clamping ----------------------------------------------
{
  rs.updateSettings({ fastModeMaxTokens: 9_999_999 });
  check("number clamps to max", CONFIG.fastModeMaxTokens === 4096, `got ${CONFIG.fastModeMaxTokens}`);
  rs.updateSettings({ fastModeMaxTokens: -100 });
  check("number clamps to min", CONFIG.fastModeMaxTokens === 128, `got ${CONFIG.fastModeMaxTokens}`);
}

// --- Validate: rejections (no mutation) -------------------------------------
{
  const before = CONFIG.webSearchMode;
  const r = rs.updateSettings({ webSearchMode: "totally-bogus" });
  check("bad enum is rejected", Boolean(r.errors.webSearchMode) && CONFIG.webSearchMode === before);

  const u = rs.updateSettings({ notARealSetting: 1 });
  check("unknown key is rejected", Boolean(u.errors.notARealSetting) && u.applied.length === 0);

  const b = rs.updateSettings({ fastMode: "maybe" });
  check("bad boolean is rejected", Boolean(b.errors.fastMode));

  // Partial patch: one good + one bad → good applies, bad is reported.
  const p = rs.updateSettings({ hebbianRetrieval: false, alsoBogus: true });
  check("partial patch applies good keys", p.applied.includes("hebbianRetrieval") && CONFIG.hebbianRetrieval === false && Boolean(p.errors.alsoBogus));
}

// --- Restart flag -----------------------------------------------------------
{
  const r = rs.updateSettings({ sleepCycle: !baseSleep });
  check("requiresRestart key surfaced", r.restartRequired.includes("sleepCycle") && r.applied.includes("sleepCycle"));
}

// --- Persistence survives a simulated reboot --------------------------------
{
  // Pretend a fresh boot: config.ts re-seeds the env baseline, THEN
  // applyPersistedSettings overlays the saved overrides.
  CONFIG.fastMode = baseFast;
  CONFIG.webSearchMode = baseMode;
  rs.applyPersistedSettings();
  check("persisted boolean override rehydrates", CONFIG.fastMode === !baseFast);
  check("persisted enum override rehydrates", CONFIG.webSearchMode === altMode);
}

// --- Reset restores baselines + clears overrides ----------------------------
{
  rs.resetSettings();
  check("reset restores fastMode baseline", CONFIG.fastMode === baseFast);
  check("reset restores webSearchMode baseline", CONFIG.webSearchMode === baseMode);
  check("reset restores fastModeMaxTokens baseline", CONFIG.fastModeMaxTokens === baseTokens);
  check("reset restores sleepCycle baseline", CONFIG.sleepCycle === baseSleep);
  // After reset the overrides row is "{}" — applyPersistedSettings is a no-op.
  CONFIG.fastMode = baseFast;
  rs.applyPersistedSettings();
  check("no overrides remain after reset", CONFIG.fastMode === baseFast);
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
