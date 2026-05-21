import { useCallback, useState, useEffect } from "react";
import { ApiError } from "./apiClient";

type Theme = "dark" | "light";

interface UseApiState<T> {
  data: T | null;
  error: string | null;
  busy: boolean;
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = window.localStorage.getItem("brain-theme");
      if (stored === "light" || stored === "dark") return stored;
    } catch {}
    return "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem("brain-theme", theme);
    } catch {}
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  return [theme, toggle];
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