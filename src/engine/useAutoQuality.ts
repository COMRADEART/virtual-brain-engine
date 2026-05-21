import { useEffect, useRef } from "react";
import {
  createAutoState,
  stepAutoQuality,
  tierIdAt,
} from "./adaptiveQuality";
import { DEFAULT_AUTO_TIER, type PerfPresetId } from "./performancePresets";

/**
 * When `enabled` (Auto mode), runs a single rAF frame counter, evaluates the
 * hysteresis controller once per second, and calls `onTier` only when the
 * chosen tier actually changes — so React re-renders at most on a tier flip,
 * never per frame. Disabling tears the rAF loop down entirely (no cost when
 * the user is on a fixed preset).
 */
export function useAutoQuality(
  enabled: boolean,
  onTier: (tier: PerfPresetId) => void,
  onFps?: (fps: number) => void,
): void {
  const onTierRef = useRef(onTier);
  const onFpsRef = useRef(onFps);
  useEffect(() => {
    onTierRef.current = onTier;
  }, [onTier]);
  useEffect(() => {
    onFpsRef.current = onFps;
  }, [onFps]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    let state = createAutoState(DEFAULT_AUTO_TIER);
    onTierRef.current(tierIdAt(state.tierIndex));

    const tick = () => {
      frames += 1;
      const now = performance.now();
      const dt = now - last;
      if (dt >= 1000) {
        const fps = (frames * 1000) / dt;
        if (onFpsRef.current) {
          onFpsRef.current(fps);
        }
        const prevTier = state.tierIndex;
        state = stepAutoQuality(state, fps, dt);
        if (state.tierIndex !== prevTier) {
          onTierRef.current(tierIdAt(state.tierIndex));
        }
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);
}
