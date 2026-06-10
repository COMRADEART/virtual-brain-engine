import { useEffect, useRef } from "react";
import { apiClient } from "./apiClient";

type Invoke = (cmd: string, args?: unknown) => Promise<unknown>;

function tauriInvoke(): Invoke | null {
  if (typeof window === "undefined") return null;
  const internals = (window as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__;
  return internals?.invoke ? internals.invoke.bind(internals) : null;
}

const POLL_MS = 8000;
const CONSENT_REFRESH_MS = 30000;

// Phase 2b — ambient clipboard ingestion. SELF-GATING on two levels:
//   1. No-op entirely outside Tauri (web/dev has no OS clipboard access).
//   2. Does NOT read the clipboard at all unless the "clipboard" ingest source
//      is consented (polled from /api/ingest/status) — consent gates the READ
//      here, not just the STORE server-side.
// New text is pushed to /api/ingest/push, where redaction + dedup + audit run.
export function useClipboardCollector(): void {
  const enabled = useRef(false);
  const lastText = useRef<string | null>(null);

  useEffect(() => {
    const invoke = tauriInvoke();
    if (!invoke) {
      return;
    }
    let stopped = false;

    const refreshConsent = async (): Promise<void> => {
      try {
        const status = await apiClient.ingestStatus();
        enabled.current = status.sources.some((s) => s.id === "clipboard" && s.enabled);
      } catch {
        enabled.current = false;
      }
    };

    const poll = async (): Promise<void> => {
      if (stopped || !enabled.current) {
        return;
      }
      try {
        const text = (await invoke("collect_clipboard")) as string | null;
        if (text && text !== lastText.current) {
          lastText.current = text;
          await apiClient.ingestPush("clipboard", [{ text }]);
        }
      } catch {
        /* best effort — collector must never disrupt the app */
      }
    };

    void refreshConsent();
    const consentTimer = window.setInterval(() => void refreshConsent(), CONSENT_REFRESH_MS);
    const pollTimer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(consentTimer);
      window.clearInterval(pollTimer);
    };
  }, []);
}
