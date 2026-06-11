import { useCallback, useState, useEffect } from "react";
import { ApiError } from "./apiClient";

type Theme = "dark" | "light";
/** "auto" follows the OS via prefers-color-scheme. */
export type ThemeMode = Theme | "auto";

interface UseApiState<T> {
  data: T | null;
  error: string | null;
  busy: boolean;
}

// Module-level theme store so EVERY useTheme() consumer (StatusBar, ShortcutsModal,
// …) shares one source of truth — toggling in one place updates all the others and
// the <html data-theme> attribute, with no divergence between instances.
// The MODE ("brain-theme-mode": dark | light | auto) is the user's choice; the
// resolved THEME is mirrored to the legacy "brain-theme" key so the index.html
// pre-React flash script keeps working unchanged for explicit modes.
function systemTheme(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function readStoredMode(): ThemeMode {
  try {
    const mode = window.localStorage.getItem("brain-theme-mode");
    if (mode === "light" || mode === "dark" || mode === "auto") return mode;
    // Back-compat: fall back to the legacy resolved-theme key.
    const stored = window.localStorage.getItem("brain-theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {}
  return "dark";
}

function resolveTheme(mode: ThemeMode): Theme {
  return mode === "auto" ? systemTheme() : mode;
}

let currentMode: ThemeMode = readStoredMode();
let currentTheme: Theme = resolveTheme(currentMode);
const themeListeners = new Set<(t: Theme) => void>();
const modeListeners = new Set<(m: ThemeMode) => void>();

function applyThemeMode(nextMode: ThemeMode): void {
  currentMode = nextMode;
  currentTheme = resolveTheme(nextMode);
  try {
    document.documentElement.setAttribute("data-theme", currentTheme);
  } catch {}
  try {
    window.localStorage.setItem("brain-theme-mode", nextMode);
    window.localStorage.setItem("brain-theme", currentTheme);
  } catch {}
  themeListeners.forEach((listener) => listener(currentTheme));
  modeListeners.forEach((listener) => listener(nextMode));
}

// Apply once at module load so the attribute is set even before any component that
// uses the hook mounts (the index.html inline script handles the pre-React flash).
// In auto mode, follow live OS theme changes.
if (typeof document !== "undefined") {
  document.documentElement.setAttribute("data-theme", currentTheme);
  try {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if (currentMode === "auto") applyThemeMode("auto");
    });
  } catch {}
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    themeListeners.add(setTheme);
    setTheme(currentTheme);
    return () => {
      themeListeners.delete(setTheme);
    };
  }, []);

  const toggle = useCallback(() => {
    // Toggling from the status bar always lands on an explicit mode.
    applyThemeMode(currentTheme === "dark" ? "light" : "dark");
  }, []);

  return [theme, toggle];
}

/** Settings-panel surface: the persisted mode (dark / light / auto) + setter. */
export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(currentMode);

  useEffect(() => {
    modeListeners.add(setMode);
    setMode(currentMode);
    return () => {
      modeListeners.delete(setMode);
    };
  }, []);

  const set = useCallback((next: ThemeMode) => applyThemeMode(next), []);
  return [mode, set];
}

function useApiCall<T, Args extends unknown[]>(
  fn: (...args: Args) => Promise<T>,
): UseApiState<T> & { call: (...args: Args) => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const call = useCallback(
    async (...args: Args) => {
      setBusy(true);
      setError(null);
      try {
        const result = await fn(...args);
        setData(result);
      } catch (err) {
        if (err instanceof ApiError) {
          setError(err.message || `Server error ${err.status}`);
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError(String(err));
        }
      } finally {
        setBusy(false);
      }
    },
    [fn],
  );

  return { data, error, busy, call };
}

export function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? (JSON.parse(item) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  // Memoized + functional-updater-safe: consumers (e.g. keyboard handlers bound
  // once in an effect) can call this without capturing a stale value.
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStoredValue((prev) => {
        const next = value instanceof Function ? (value as (p: T) => T)(prev) : value;
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch (error) {
          console.warn(`Failed to save ${key} to localStorage:`, error);
        }
        return next;
      });
    },
    [key],
  );

  return [storedValue, setValue];
}