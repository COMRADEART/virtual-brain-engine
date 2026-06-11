// ---------------------------------------------------------------------------
// Tiny toast bus — fire-and-forget user feedback (success / error / info).
// Module-level singleton like brainBus: emitters anywhere in the app call
// toast(...) and the single <ToastHost /> mounted in App renders the stack.
// ---------------------------------------------------------------------------

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

type ToastListener = (toast: ToastItem) => void;

let nextId = 1;
const listeners = new Set<ToastListener>();

export function subscribeToasts(listener: ToastListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function toast(kind: ToastKind, message: string): void {
  const item: ToastItem = { id: nextId++, kind, message };
  listeners.forEach((l) => l(item));
}

export const toastSuccess = (message: string): void => toast("success", message);
export const toastError = (message: string): void => toast("error", message);
export const toastInfo = (message: string): void => toast("info", message);
