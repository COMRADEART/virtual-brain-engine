import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { subscribeToasts, type ToastItem } from "../engine/toastBus";

const TOAST_TTL_MS: Record<ToastItem["kind"], number> = {
  success: 3500,
  info: 4000,
  error: 6500,
};

const TOAST_ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
} as const;

/** Single global toast stack. Mount once at the App root (all layouts). */
export function ToastHost(): JSX.Element | null {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const unsubscribe = subscribeToasts((item) => {
      setToasts((current) => [...current.slice(-3), item]);
      const timer = setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== item.id));
        timers.current.delete(item.id);
      }, TOAST_TTL_MS[item.kind]);
      timers.current.set(item.id, timer);
    });
    const pending = timers.current;
    return () => {
      unsubscribe();
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  if (toasts.length === 0) return null;

  const dismiss = (id: number): void => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((t) => t.id !== id));
  };

  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((item) => {
        const Icon = TOAST_ICONS[item.kind];
        return (
          <div key={item.id} className={`toast toast-${item.kind}`}>
            <Icon size={14} aria-hidden="true" />
            <span className="toast-message">{item.message}</span>
            <button
              type="button"
              className="toast-close"
              onClick={() => dismiss(item.id)}
              aria-label="Dismiss notification"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
