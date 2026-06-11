import { useCallback, useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Rebindable keyboard shortcuts. Single printable keys only — the structural
// chords (Space, 1-7, F11, Ctrl+K, ?) stay fixed so the muscle-memory core of
// the app can't be broken from the Settings panel. Same module-level store
// pattern as uiPrefs so the App keydown handler and the Settings editor stay
// in sync without prop threading.
// ---------------------------------------------------------------------------

export type ShortcutAction =
  | "overview"
  | "inside"
  | "resetCamera"
  | "toggleShell"
  | "toggleAnatomy"
  | "cyclePreset"
  | "cycleLayout"
  | "toggleEmergent"
  | "screenshot"
  | "openSettings";

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  overview: "Overview camera",
  inside: "Inside camera",
  resetCamera: "Reset camera",
  toggleShell: "Toggle shell transparency",
  toggleAnatomy: "Toggle anatomy cloud",
  cyclePreset: "Cycle performance preset",
  cycleLayout: "Cycle layout",
  toggleEmergent: "Toggle emergent controls",
  screenshot: "Take screenshot",
  openSettings: "Open settings",
};

export const DEFAULT_KEYMAP: Record<ShortcutAction, string> = {
  overview: "o",
  inside: "i",
  resetCamera: "r",
  toggleShell: "x",
  toggleAnatomy: "a",
  cyclePreset: "p",
  cycleLayout: "l",
  toggleEmergent: "e",
  screenshot: "s",
  openSettings: ",",
};

/** Keys owned by fixed, non-rebindable shortcuts. */
const RESERVED_KEYS = new Set([" ", "1", "2", "3", "4", "5", "6", "7", "?"]);

const STORAGE_KEY = "brain-keymap";

function readStoredKeymap(): Record<ShortcutAction, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_KEYMAP };
    const parsed = JSON.parse(raw) as Partial<Record<ShortcutAction, string>>;
    return { ...DEFAULT_KEYMAP, ...parsed };
  } catch {
    return { ...DEFAULT_KEYMAP };
  }
}

let currentKeymap: Record<ShortcutAction, string> = readStoredKeymap();
const listeners = new Set<(k: Record<ShortcutAction, string>) => void>();

function persist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentKeymap));
  } catch {}
}

export function getKeymap(): Record<ShortcutAction, string> {
  return currentKeymap;
}

/** Find the action bound to a (lowercased) key, if any. */
export function actionForKey(key: string): ShortcutAction | null {
  const lower = key.toLowerCase();
  for (const action of Object.keys(currentKeymap) as ShortcutAction[]) {
    if (currentKeymap[action] === lower) return action;
  }
  return null;
}

/**
 * Rebind an action. Returns an error string when the key is reserved or
 * already taken by another action; null on success.
 */
export function setBinding(action: ShortcutAction, key: string): string | null {
  const lower = key.toLowerCase();
  if (lower.length !== 1 || RESERVED_KEYS.has(lower)) {
    return "That key is reserved";
  }
  const holder = actionForKey(lower);
  if (holder && holder !== action) {
    return `Already used by "${SHORTCUT_LABELS[holder]}"`;
  }
  currentKeymap = { ...currentKeymap, [action]: lower };
  persist();
  listeners.forEach((l) => l(currentKeymap));
  return null;
}

export function resetKeymap(): void {
  currentKeymap = { ...DEFAULT_KEYMAP };
  persist();
  listeners.forEach((l) => l(currentKeymap));
}

export function useKeymap(): Record<ShortcutAction, string> {
  const [keymap, setKeymap] = useState(currentKeymap);
  useEffect(() => {
    listeners.add(setKeymap);
    setKeymap(currentKeymap);
    return () => {
      listeners.delete(setKeymap);
    };
  }, []);
  return keymap;
}

export function useKeymapEditor(): {
  keymap: Record<ShortcutAction, string>;
  rebind: (action: ShortcutAction, key: string) => string | null;
  reset: () => void;
} {
  const keymap = useKeymap();
  const rebind = useCallback((action: ShortcutAction, key: string) => setBinding(action, key), []);
  const reset = useCallback(() => resetKeymap(), []);
  return { keymap, rebind, reset };
}
