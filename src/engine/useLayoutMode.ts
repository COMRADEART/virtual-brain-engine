import { useCallback, useEffect } from "react";
import { useLocalStorage } from "./useApiCall";

export type LayoutMode = "compact" | "focus" | "full";
export const LAYOUT_MODES: LayoutMode[] = ["compact", "focus", "full"];

export const LAYOUT_LABELS: Record<LayoutMode, string> = {
  compact: "Compact",
  focus: "Focus",
  full: "Full",
};

/**
 * Compact is the daily-driver default (minimal chrome). Focus = big chat +
 * brain preview. Full = the original scientific control surface.
 * The mode is mirrored onto <html data-layout> so CSS can react.
 */
export function useLayoutMode(): {
  mode: LayoutMode;
  setMode: (m: LayoutMode) => void;
  cycle: () => void;
} {
  const [mode, setMode] = useLocalStorage<LayoutMode>("brain-layout", "compact");

  useEffect(() => {
    document.documentElement.setAttribute("data-layout", mode);
  }, [mode]);

  const cycle = useCallback(() => {
    setMode((m) => LAYOUT_MODES[(LAYOUT_MODES.indexOf(m) + 1) % LAYOUT_MODES.length]);
  }, [setMode]);

  return { mode, setMode, cycle };
}
