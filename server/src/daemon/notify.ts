// Daemon → desktop notification. When a daemon fires, the runner broadcasts
// a `daemon-fired` bus event; the Tauri shell subscribes and shows a
// system notification (see src-tauri/src/lib.rs). The Node side just emits
// the bus event — both the Mind panel and the Tauri shell listen there.

import { broadcast } from "../ws/brainBus.js";
import { surfaceError } from "../util/diagnostics.js";
import type { DaemonRecord } from "./registry.js";

export interface NotifyArgs {
  title: string;
  body: string;
}

/** Send a desktop notification via the bus (the Tauri shell + the panel
 *  both listen). Failure-isolated: a missing bus or no subscribers never
 *  throws back to the runner. */
export function notifyDaemon(d: DaemonRecord, args: NotifyArgs): void {
  try {
    broadcast({
      type: "daemon-fired",
      daemonId: d.id,
      daemonTitle: d.title,
      actionId: d.action.id,
      ok: true,
      error: null,
      at: new Date().toISOString(),
    });
    void args; // title/body passed separately if a future surface needs it
  } catch (err) {
    surfaceError("daemon.notify", err);
  }
}
