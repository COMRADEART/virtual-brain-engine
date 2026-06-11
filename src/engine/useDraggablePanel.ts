import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalStorage } from "./useApiCall";

interface PanelOffset {
  x: number;
  y: number;
}

const ZERO: PanelOffset = { x: 0, y: 0 };

/**
 * Makes a floating panel repositionable without touching its CSS anchor:
 * the drag offset is applied as a `transform: translate(...)` on top of the
 * panel's existing absolute position, and persisted per `storageKey` so the
 * arrangement survives reloads. Attach `onPointerDown` to the panel's header
 * (drag handle); double-click the handle to snap back to the default spot.
 *
 * Interactive children (buttons, inputs) inside the handle are ignored so
 * collapse/close buttons keep working.
 */
export function useDraggablePanel(storageKey: string): {
  style: React.CSSProperties;
  handleProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onDoubleClick: () => void;
    style: React.CSSProperties;
  };
  reset: () => void;
} {
  const [offset, setOffset] = useLocalStorage<PanelOffset>(`brain-panel-pos:${storageKey}`, ZERO);
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Don't hijack clicks on buttons/inputs living inside the header.
      if ((e.target as HTMLElement).closest("button, input, select, a, textarea")) return;
      if (e.button !== 0) return;
      dragState.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
      setDragging(true);
      e.preventDefault();
    },
    [offset.x, offset.y],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent): void => {
      const state = dragState.current;
      if (!state) return;
      // Clamp so a panel can't be flung entirely off-screen.
      const x = Math.max(-window.innerWidth + 80, Math.min(window.innerWidth - 80, state.baseX + e.clientX - state.startX));
      const y = Math.max(-window.innerHeight + 60, Math.min(window.innerHeight - 60, state.baseY + e.clientY - state.startY));
      setOffset({ x, y });
    };
    const onUp = (): void => {
      dragState.current = null;
      setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, setOffset]);

  const reset = useCallback(() => setOffset(ZERO), [setOffset]);

  const style: React.CSSProperties =
    offset.x !== 0 || offset.y !== 0 || dragging
      ? { transform: `translate(${offset.x}px, ${offset.y}px)`, transition: dragging ? "none" : undefined }
      : {};

  return {
    style,
    handleProps: {
      onPointerDown,
      onDoubleClick: reset,
      style: { cursor: dragging ? "grabbing" : "grab", touchAction: "none" },
    },
    reset,
  };
}
