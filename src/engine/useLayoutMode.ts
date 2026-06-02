import { useCallback, useEffect } from "react";
import { useLocalStorage } from "./useApiCall";

export type LayoutMode = "compact" | "focus" | "full" | "dashboard";
export const LAYOUT_MODES: LayoutMode[] = ["compact", "focus", "full", "dashboard"];

export const LAYOUT_LABELS: Record<LayoutMode, string> = {
  compact: "Compact",
  focus: "Focus",
  full: "Full",
  dashboard: "Dashboard",
};

/**
 * Dashboard is the default landing experience (telemetry + 3D brain + activity
 * widgets). Compact = minimal chrome. Focus = big chat + brain preview.
 * Full = the original scientific control surface.
 * The mode is mirrored onto <html data-layout> so CSS can react.
 * A persisted choice always wins over the default, so returning users keep
 * whatever mode they last selected.
 */
export function useLayoutMode(): {
  mode: LayoutMode;
  setMode: (m: LayoutMode) => void;
  cycle: () => void;
} {
  const [mode, setMode] = useLocalStorage<LayoutMode>("brain-layout", "dashboard");

  useEffect(() => {
    document.documentElement.setAttribute("data-layout", mode);
  }, [mode]);

  const cycle = useCallback(() => {
    setMode((m) => LAYOUT_MODES[(LAYOUT_MODES.indexOf(m) + 1) % LAYOUT_MODES.length]);
  }, [setMode]);

  return { mode, setMode, cycle };
}
