import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// UI preferences — the customization layer behind the Settings panel.
//
// Module-level store (same pattern as the theme store in useApiCall.ts) so
// every consumer shares one source of truth. Preferences are persisted to
// localStorage and applied to <html> as inline CSS custom properties +
// data attributes; styles.css reacts to those, so applying a preference is
// a pure DOM write with no React re-render fan-out.
//
// The accent system relies on styles.css being fully tokenized: overriding
// --accent / --accent-rgb / --accent-hi inline restyles the whole app. The
// default ("violet") removes the inline overrides entirely so the stock
// per-theme values in styles.css (incl. the deeper light-theme violet) win.
// ---------------------------------------------------------------------------

export interface AccentPreset {
  id: string;
  label: string;
  /** Per-theme values — light themes want deeper hues for contrast. */
  dark: { accent: string; hi: string };
  light: { accent: string; hi: string };
}

export const ACCENT_PRESETS: AccentPreset[] = [
  {
    id: "violet",
    label: "Violet",
    dark: { accent: "#7c5cff", hi: "#9d7bff" },
    light: { accent: "#6438ff", hi: "#7c5cff" },
  },
  {
    id: "indigo",
    label: "Indigo",
    dark: { accent: "#6577ff", hi: "#8b98ff" },
    light: { accent: "#4253e8", hi: "#6577ff" },
  },
  {
    id: "teal",
    label: "Teal",
    dark: { accent: "#2dd4bf", hi: "#5eead4" },
    light: { accent: "#0d9488", hi: "#14b8a6" },
  },
  {
    id: "jade",
    label: "Jade",
    dark: { accent: "#34d399", hi: "#6ee7b7" },
    light: { accent: "#059669", hi: "#10b981" },
  },
  {
    id: "ember",
    label: "Ember",
    dark: { accent: "#fb923c", hi: "#fdba74" },
    light: { accent: "#ea580c", hi: "#f97316" },
  },
  {
    id: "rose",
    label: "Rose",
    dark: { accent: "#fb7185", hi: "#fda4af" },
    light: { accent: "#e11d48", hi: "#f43f5e" },
  },
];

export type UiDensity = "comfortable" | "compact";
export type UiGlass = "clear" | "standard" | "frosted";
export type UiMotion = "full" | "reduced";

export interface UiPrefs {
  /** Accent preset id, or "custom" to use customAccent. */
  accentId: string;
  /** Hex color used when accentId === "custom". */
  customAccent: string;
  density: UiDensity;
  /** Multiplier applied to the type scale (0.92 / 1 / 1.08). */
  uiScale: number;
  glass: UiGlass;
  motion: UiMotion;
  /** UnrealBloomPass strength (visible on presets with bloom enabled). */
  bloomStrength: number;
  /**
   * Target size of the GPU neuron FIELD — the point cloud rendered alongside the
   * interactive graph (see NeuronField.ts). 1,000,000 by default: a real million
   * neurons on GPU-capable hardware. Capped down automatically on software/weak
   * renderers (BrainScene.effectiveFieldCount); 0 turns the field off.
   */
  neuronFieldCount: number;
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  accentId: "violet",
  customAccent: "#7c5cff",
  density: "comfortable",
  uiScale: 1,
  glass: "standard",
  motion: "full",
  bloomStrength: 0.45,
  neuronFieldCount: 1_000_000,
};

const STORAGE_KEY = "brain-ui-prefs";

export function hexToRgbTriple(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Lighten a hex color toward white by `amount` (0..1) — used for the hover/hi variant of custom accents. */
export function lightenHex(hex: string, amount: number): string {
  const rgb = hexToRgbTriple(hex);
  if (!rgb) return hex;
  const out = rgb.map((c) => Math.round(c + (255 - c) * amount));
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function readStoredPrefs(): UiPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return { ...DEFAULT_UI_PREFS, ...parsed };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

let currentPrefs: UiPrefs = readStoredPrefs();
const listeners = new Set<(p: UiPrefs) => void>();

function resolveAccent(prefs: UiPrefs, theme: string): { accent: string; hi: string } | null {
  if (prefs.accentId === "violet") return null; // stock CSS wins
  if (prefs.accentId === "custom") {
    const hex = hexToRgbTriple(prefs.customAccent) ? prefs.customAccent : DEFAULT_UI_PREFS.customAccent;
    return { accent: hex, hi: lightenHex(hex, 0.22) };
  }
  const preset = ACCENT_PRESETS.find((p) => p.id === prefs.accentId);
  if (!preset) return null;
  return theme === "light" ? preset.light : preset.dark;
}

function applyPrefsToDom(prefs: UiPrefs): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const theme = root.getAttribute("data-theme") ?? "dark";

  const accent = resolveAccent(prefs, theme);
  if (accent) {
    const rgb = hexToRgbTriple(accent.accent);
    root.style.setProperty("--accent", accent.accent);
    root.style.setProperty("--accent-hi", accent.hi);
    if (rgb) root.style.setProperty("--accent-rgb", rgb.join(", "));
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-hi");
    root.style.removeProperty("--accent-rgb");
  }

  root.setAttribute("data-density", prefs.density);
  root.setAttribute("data-glass", prefs.glass);
  root.setAttribute("data-motion", prefs.motion);
  if (prefs.uiScale !== 1) {
    root.style.setProperty("--ui-scale", String(prefs.uiScale));
  } else {
    root.style.removeProperty("--ui-scale");
  }
}

function persistPrefs(prefs: UiPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {}
}

export function getUiPrefs(): UiPrefs {
  return currentPrefs;
}

export function updateUiPrefs(partial: Partial<UiPrefs>): void {
  currentPrefs = { ...currentPrefs, ...partial };
  persistPrefs(currentPrefs);
  applyPrefsToDom(currentPrefs);
  listeners.forEach((l) => l(currentPrefs));
}

export function resetUiPrefs(): void {
  currentPrefs = { ...DEFAULT_UI_PREFS };
  persistPrefs(currentPrefs);
  applyPrefsToDom(currentPrefs);
  listeners.forEach((l) => l(currentPrefs));
}

// Apply once at module load (mirrors the theme store) and re-resolve the
// accent whenever the theme attribute flips — preset accents have per-theme
// values, and a MutationObserver keeps this module decoupled from the theme
// store's internals.
if (typeof document !== "undefined") {
  applyPrefsToDom(currentPrefs);
  const observer = new MutationObserver(() => applyPrefsToDom(currentPrefs));
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

export function useUiPrefs(): {
  prefs: UiPrefs;
  update: (partial: Partial<UiPrefs>) => void;
  reset: () => void;
} {
  const [prefs, setPrefs] = useState<UiPrefs>(currentPrefs);

  useEffect(() => {
    listeners.add(setPrefs);
    setPrefs(currentPrefs);
    return () => {
      listeners.delete(setPrefs);
    };
  }, []);

  const update = useCallback((partial: Partial<UiPrefs>) => updateUiPrefs(partial), []);
  const reset = useCallback(() => resetUiPrefs(), []);

  return { prefs, update, reset };
}
