// persistence — durable storage of the cognitive BrainSnapshot in IndexedDB
// =========================================================================
//
// "Effective IQ grows over time" only holds if the learning survives a reload, so
// the learned state (connectome weights, value function, hyperparameters, IQ
// history, EWC importance) is written to IndexedDB — not localStorage, because the
// weight/importance vectors are multi-megabyte Float32Arrays that localStorage
// (string-only) can't hold efficiently, and IndexedDB stores typed arrays via
// structured clone natively.
//
// All reads/writes are async and happen OFF the render loop. A snapshot is keyed
// by density+seed so it is only ever restored onto an identical topology (the
// HybridCognitiveCore enforces the version/seed gate on apply).

import type { BrainSnapshot } from "../../../shared/brainSnapshot";

const DB_NAME = "vbe-cognition";
const STORE = "snapshots";
const DB_VERSION = 1;

/** IndexedDB is unavailable in SSR / some test runners — degrade to no-op. */
export function isPersistenceAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function keyFor(density: number, seed: number): string {
  return `${density.toFixed(4)}:${seed}`;
}

/** Load the snapshot for an exact density+seed topology, or null if none. */
export async function loadSnapshot(density: number, seed: number): Promise<BrainSnapshot | null> {
  if (!isPersistenceAvailable()) return null;
  const db = await openDb();
  try {
    return await new Promise<BrainSnapshot | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(keyFor(density, seed));
      req.onsuccess = () => resolve((req.result as BrainSnapshot | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Persist a snapshot (keyed by its own density+seed). */
export async function saveSnapshot(snap: BrainSnapshot): Promise<void> {
  if (!isPersistenceAvailable()) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(snap, keyFor(snap.density, snap.graphSeed));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
