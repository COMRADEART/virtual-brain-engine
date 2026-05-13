// Singleton WebSocket client for /ws/brain. The pipeline broadcasts the same
// PipelineEvent stream we get over SSE on /api/ask, so the brain animates even
// in a second tab that didn't originate the request.

import type { BrainBusMessage, PipelineEvent } from "../../shared/pipeline";

type Listener = (message: BrainBusMessage) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
// Start optimistic (1s) but ramp toward 30s if the server is gone, so the
// console isn't spammed with a failure log every second. Resets to 1s after a
// successful connect.
const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 30_000;
let backoffMs = MIN_BACKOFF;
let reconnectTimer: number | null = null;
let lastConnected = false;
// We log the first connection failure, then go silent until either:
//  (a) we successfully reconnect (so a future drop will be logged again), or
//  (b) at most one reminder is printed every 60s so the user knows we're still trying.
let haveLoggedFailure = false;
let lastReminderAt = 0;
let url = computeUrl();
const connectionListeners = new Set<(ok: boolean) => void>();

function computeUrl(): string {
  const envBase = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_BRAIN_BUS_URL;
  if (envBase) {
    return envBase;
  }
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//127.0.0.1:8787/ws/brain`;
  }
  return "ws://127.0.0.1:8787/ws/brain";
}

function emit(message: BrainBusMessage): void {
  for (const listener of listeners) {
    try {
      listener(message);
    } catch (err) {
      console.warn("[brainBus] listener threw", err);
    }
  }
}

function setConnected(ok: boolean): void {
  if (ok === lastConnected) {
    return;
  }
  lastConnected = ok;
  for (const cb of connectionListeners) {
    try {
      cb(ok);
    } catch {
      // ignore
    }
  }
}

function noteFailure(): void {
  const now = Date.now();
  if (!haveLoggedFailure) {
    haveLoggedFailure = true;
    lastReminderAt = now;
    console.info(
      `[brainBus] backend ${url} not reachable yet — will keep retrying quietly. ` +
        "Start it with `npm run dev:server` (or `npm run dev:all`).",
    );
    return;
  }
  if (now - lastReminderAt > 60_000) {
    lastReminderAt = now;
    console.info(`[brainBus] still waiting for ${url} (backoff ${(backoffMs / 1000).toFixed(0)}s)`);
  }
}

function connect(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    socket = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  socket.addEventListener("open", () => {
    backoffMs = MIN_BACKOFF;
    haveLoggedFailure = false;
    setConnected(true);
  });
  socket.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data as string) as BrainBusMessage;
      emit(data);
    } catch (err) {
      console.warn("[brainBus] parse failure", err);
    }
  });
  socket.addEventListener("close", () => {
    socket = null;
    setConnected(false);
    noteFailure();
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    setConnected(false);
    try {
      socket?.close();
    } catch {
      // ignore
    }
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) {
    return;
  }
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
    connect();
  }, backoffMs);
}

export function subscribeBrainBus(listener: Listener): () => void {
  if (!socket && reconnectTimer === null && typeof window !== "undefined") {
    connect();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeConnection(cb: (ok: boolean) => void): () => void {
  connectionListeners.add(cb);
  cb(lastConnected);
  return () => {
    connectionListeners.delete(cb);
  };
}

export function brainBusUrl(): string {
  return url;
}

export function isBrainBusConnected(): boolean {
  return lastConnected;
}

// Exposed for the verification path described in the plan:
//   window.__brainBus.emit({step:"memory",...})
// The dev helper publishes through the local listener set ONLY; it does not
// round-trip through the server. Useful for confirming the flashLogicalRegion
// wiring without a backend.
declare global {
  // eslint-disable-next-line no-var, @typescript-eslint/consistent-type-definitions
  var __brainBus:
    | {
        emit(payload: Partial<PipelineEvent>): void;
        url: string;
      }
    | undefined;
}

if (typeof window !== "undefined") {
  window.__brainBus = {
    emit(payload: Partial<PipelineEvent>) {
      emit({
        type: "pipeline",
        conversationId: payload.conversationId ?? "dev",
        runId: payload.runId ?? "dev",
        step: payload.step ?? "memory",
        status: payload.status ?? "start",
        logicalRegions: payload.logicalRegions ?? ["memory-core"],
        detail: payload.detail,
        citations: payload.citations,
        tokensDelta: payload.tokensDelta,
        finalAnswer: payload.finalAnswer,
        timestamp: payload.timestamp ?? new Date().toISOString(),
      });
    },
    url,
  };
}
