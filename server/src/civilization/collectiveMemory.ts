import { ulid } from "ulid";
import type {
  BrainPeer,
  InterBrainMessage,
  MemoryChunk,
  MemorySyncState,
  MemoryConflict,
  PrivacyLevel,
} from "../../../shared/civilization.js";
import { BrainNetwork } from "./brainNetwork.js";

export interface CollectiveMemoryConfig {
  syncIntervalMs: number;
  maxMemoryPerSync: number;
  vectorDimensions: number;
  importanceThreshold: number;
  conflictResolutionStrategy: "local-wins" | "remote-wins" | "newest-wins" | "merge";
  enableSelectiveSync: boolean;
  syncBatchSize: number;
}

const DEFAULT_CONFIG: CollectiveMemoryConfig = {
  syncIntervalMs: 120000,
  maxMemoryPerSync: 100,
  vectorDimensions: 384,
  importanceThreshold: 0.3,
  conflictResolutionStrategy: "merge",
  enableSelectiveSync: true,
  syncBatchSize: 20,
};

export interface MemorySyncEventHandlers {
  onMemoryReceived?: (peerId: string, memories: MemoryChunk[]) => void;
  onMemoryConflict?: (conflict: MemoryConflict) => void;
  onSyncComplete?: (peerId: string, syncedCount: number) => void;
  onSyncError?: (peerId: string, error: Error) => void;
}

export class CollectiveMemorySync {
  private readonly config: CollectiveMemoryConfig;
  private readonly network: BrainNetwork;
  private readonly handlers: MemorySyncEventHandlers;
  private readonly syncStates = new Map<string, MemorySyncState>();
  private readonly localMemory = new Map<string, MemoryChunk>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private pendingRequests = new Map<string, { resolve: (value: MemoryChunk[]) => void; reject: (err: Error) => void }>();

  constructor(
    network: BrainNetwork,
    config: Partial<CollectiveMemoryConfig> = {},
    handlers: MemorySyncEventHandlers = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.network = network;
    this.handlers = handlers;
  }

  start(): void {
    this.syncTimer = setInterval(() => {
      this.performScheduledSync();
    }, this.config.syncIntervalMs);
    this.syncTimer.unref?.();
  }

  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  addLocalMemory(content: string, memoryType: string, tags: string[], importance: number, privacy: PrivacyLevel = "shared"): string {
    const id = `mem-${ulid()}`;
    const memory: MemoryChunk = {
      id,
      content,
      embedding: this.generateMockEmbedding(content),
      memoryType,
      importance,
      privacy,
      sourceBrainId: "self",
      tags,
      createdAt: new Date().toISOString(),
      accessCount: 0,
      lastAccessedAt: new Date().toISOString(),
    };
    this.localMemory.set(id, memory);
    return id;
  }

  getLocalMemory(id: string): MemoryChunk | undefined {
    return this.localMemory.get(id);
  }

  getAllLocalMemories(filter?: { minImportance?: number; privacy?: PrivacyLevel; tags?: string[] }): MemoryChunk[] {
    let results = Array.from(this.localMemory.values());

    if (filter?.minImportance !== undefined) {
      results = results.filter((m) => m.importance >= filter.minImportance!);
    }
    if (filter?.privacy !== undefined) {
      results = results.filter((m) => m.privacy === filter.privacy);
    }
    if (filter?.tags && filter.tags.length > 0) {
      results = results.filter((m) => filter.tags!.some((t) => m.tags.includes(t)));
    }

    return results.sort((a, b) => b.importance - a.importance);
  }

  getSharedMemories(): MemoryChunk[] {
    return this.getAllLocalMemories({ privacy: "shared" });
  }

  getPublicMemories(): MemoryChunk[] {
    return this.getAllLocalMemories({ privacy: "public" });
  }

  async shareMemoryToPeer(peerId: string, memoryId: string): Promise<boolean> {
    const memory = this.localMemory.get(memoryId);
    if (!memory) return false;

    if (memory.privacy === "private") return false;

    const message: InterBrainMessage = {
      id: ulid(),
      type: "memory-share",
      sourceBrainId: "self",
      targetBrainId: peerId,
      payload: { memory },
      timestamp: new Date().toISOString(),
    };

    return this.network.send(peerId, message);
  }

  async shareMemoriesToPeer(peerId: string, memoryIds: string[]): Promise<number> {
    const memories = memoryIds.map((id) => this.localMemory.get(id)).filter(Boolean) as MemoryChunk[];
    if (memories.length === 0) return 0;

    let shared = 0;
    for (const memory of memories) {
      if (memory.privacy !== "private") {
        const message: InterBrainMessage = {
          id: ulid(),
          type: "memory-share",
          sourceBrainId: "self",
          targetBrainId: peerId,
          payload: { memory },
          timestamp: new Date().toISOString(),
        };
        if (this.network.send(peerId, message)) {
          shared++;
        }
      }
    }
    return shared;
  }

  async broadcastMemory(memoryId: string): Promise<number> {
    const memory = this.localMemory.get(memoryId);
    if (!memory || memory.privacy === "private") return 0;

    const message: InterBrainMessage = {
      id: ulid(),
      type: "memory-share",
      sourceBrainId: "self",
      payload: { memory },
      timestamp: new Date().toISOString(),
    };

    let count = 0;
    const peers = this.network.getAllPeers();
    for (const peer of peers) {
      if (this.network.send(peer.id, message)) {
        count++;
      }
    }
    return count;
  }

  async requestMemoryFromPeer(peerId: string, query: string, maxResults: number = 10): Promise<MemoryChunk[]> {
    return new Promise((resolve, reject) => {
      const requestId = ulid();
      const message: InterBrainMessage = {
        id: requestId,
        type: "memory-request",
        sourceBrainId: "self",
        targetBrainId: peerId,
        payload: { query, maxResults },
        timestamp: new Date().toISOString(),
      };

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Memory request timeout for peer ${peerId}`));
      }, 30000);

      this.pendingRequests.set(requestId, {
        resolve: (memories) => {
          clearTimeout(timeout);
          resolve(memories);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      if (!this.network.send(peerId, message)) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(new Error(`Failed to send memory request to peer ${peerId}`));
      }
    });
  }

  handleIncomingMessage(peerId: string, message: InterBrainMessage): void {
    switch (message.type) {
      case "memory-share": {
        const { memory } = message.payload as { memory: MemoryChunk };
        if (memory) {
          this.handleIncomingMemory(peerId, memory);
        }
        break;
      }
      case "memory-request": {
        const { query, maxResults } = message.payload as { query: string; maxResults: number };
        this.handleMemoryRequest(peerId, query, maxResults, message.id);
        break;
      }
      case "memory-response": {
        const { memories, requestId } = message.payload as { memories: MemoryChunk[]; requestId: string };
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          this.pendingRequests.delete(requestId);
          pending.resolve(memories);
        }
        break;
      }
      case "memory-sync": {
        const { memories } = message.payload as { memories: MemoryChunk[] };
        for (const memory of memories) {
          this.handleIncomingMemory(peerId, memory);
        }
        break;
      }
    }
  }

  async fullSyncWithPeer(peerId: string): Promise<number> {
    const state = this.getOrCreateSyncState(peerId);
    const localMemories = this.getSharedMemories();

    const newMemories = localMemories.filter((m) => !state.syncedMemoryIds.has(m.id));
    let synced = 0;

    for (let i = 0; i < newMemories.length; i += this.config.syncBatchSize) {
      const batch = newMemories.slice(i, i + this.config.syncBatchSize);
      const message: InterBrainMessage = {
        id: ulid(),
        type: "memory-sync",
        sourceBrainId: "self",
        targetBrainId: peerId,
        payload: { memories: batch },
        timestamp: new Date().toISOString(),
      };

      if (this.network.send(peerId, message)) {
        for (const mem of batch) {
          state.syncedMemoryIds.add(mem.id);
        }
        synced += batch.length;
      }
    }

    state.lastSyncAt = new Date().toISOString();
    this.handlers.onSyncComplete?.(peerId, synced);
    return synced;
  }

  getSyncState(peerId: string): MemorySyncState | undefined {
    return this.syncStates.get(peerId);
  }

  getAllSyncStates(): MemorySyncState[] {
    return Array.from(this.syncStates.values());
  }

  private handleIncomingMemory(peerId: string, memory: MemoryChunk): void {
    if (memory.privacy === "private") return;

    const existing = this.localMemory.get(memory.id);

    if (existing) {
      const conflict = this.detectConflict(existing, memory);
      if (conflict) {
        this.resolveConflict(conflict);
        this.handlers.onMemoryConflict?.(conflict);
      }
    } else {
      if (memory.importance >= this.config.importanceThreshold || memory.privacy === "public") {
        memory.accessCount = 0;
        memory.lastAccessedAt = new Date().toISOString();
        this.localMemory.set(memory.id, memory);
        this.handlers.onMemoryReceived?.(peerId, [memory]);
      }
    }

    const state = this.getOrCreateSyncState(peerId);
    state.syncedMemoryIds.add(memory.id);
    state.lastSyncAt = new Date().toISOString();
  }

  private handleMemoryRequest(peerId: string, query: string, maxResults: number, requestId: string): void {
    const queryEmbedding = this.generateMockEmbedding(query);
    const localShared = this.getSharedMemories();

    const scored = localShared.map((mem) => ({
      memory: mem,
      score: this.cosineSimilarity(queryEmbedding, mem.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);

    const results = scored.slice(0, maxResults).map((s) => s.memory);

    for (const mem of results) {
      mem.accessCount++;
      mem.lastAccessedAt = new Date().toISOString();
    }

    const response: InterBrainMessage = {
      id: ulid(),
      type: "memory-response",
      sourceBrainId: "self",
      targetBrainId: peerId,
      payload: { memories: results, requestId },
      timestamp: new Date().toISOString(),
    };

    this.network.send(peerId, response);
  }

  private detectConflict(local: MemoryChunk, remote: MemoryChunk): MemoryConflict | null {
    if (local.content !== remote.content && this.editDistance(local.content, remote.content) > 10) {
      return {
        localId: local.id,
        remoteId: remote.id,
        localContent: local.content,
        remoteContent: remote.content,
      };
    }
    return null;
  }

  private resolveConflict(conflict: MemoryConflict): void {
    const local = this.localMemory.get(conflict.localId);
    const remote = this.localMemory.get(conflict.remoteId) ||
      this.localMemory.get(conflict.localId);

    if (!local) return;

    switch (this.config.conflictResolutionStrategy) {
      case "local-wins":
        conflict.resolution = "local";
        break;
      case "remote-wins":
        if (remote) {
          local.content = remote.content;
          local.embedding = remote.embedding;
        }
        conflict.resolution = "remote";
        break;
      case "newest-wins":
        if (remote && remote.createdAt > local.createdAt) {
          local.content = remote.content;
          local.embedding = remote.embedding;
        }
        conflict.resolution = "merged";
        break;
      case "merge":
        const merged = this.mergeContent(local.content, remote?.content ?? local.content);
        local.content = merged;
        conflict.resolution = "merged";
        break;
    }

    conflict.resolvedAt = new Date().toISOString();
  }

  private getOrCreateSyncState(peerId: string): MemorySyncState {
    let state = this.syncStates.get(peerId);
    if (!state) {
      state = {
        brainId: peerId,
        lastSyncAt: new Date().toISOString(),
        syncedMemoryIds: new Set(),
        pendingMemoryIds: [],
        conflicts: [],
      };
      this.syncStates.set(peerId, state);
    }
    return state;
  }

  private async performScheduledSync(): Promise<void> {
    const peers = this.network.getAllPeers();
    for (const peer of peers) {
      if (peer.isConnected) {
        try {
          await this.fullSyncWithPeer(peer.id);
        } catch (err) {
          this.handlers.onSyncError?.(peer.id, err as Error);
        }
      }
    }
  }

  private generateMockEmbedding(content: string): number[] {
    const vec = new Array(this.config.vectorDimensions).fill(0);
    const words = content.toLowerCase().split(/\s+/);
    let idx = 0;
    for (const word of words) {
      for (let i = 0; i < word.length && i < this.config.vectorDimensions; i++) {
        vec[(idx + i) % this.config.vectorDimensions] += word.charCodeAt(i) / 255;
      }
      idx = (idx + 7) % this.config.vectorDimensions;
    }
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map((v) => v / (mag || 1));
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
  }

  private editDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
      }
    }

    return dp[m][n];
  }

  private mergeContent(local: string, remote: string): string {
    const localSentences = local.split(/[.!?]+/).filter((s) => s.trim());
    const remoteSentences = remote.split(/[.!?]+/).filter((s) => s.trim());

    const merged = new Set<string>();
    for (const s of localSentences) merged.add(s.trim());
    for (const s of remoteSentences) merged.add(s.trim());

    return Array.from(merged).join(". ") + ".";
  }
}

let singleton: CollectiveMemorySync | null = null;

export function createCollectiveMemory(
  network: BrainNetwork,
  config?: Partial<CollectiveMemoryConfig>,
  handlers?: MemorySyncEventHandlers,
): CollectiveMemorySync {
  if (!singleton) {
    singleton = new CollectiveMemorySync(network, config, handlers);
  }
  return singleton;
}

export function getCollectiveMemory(): CollectiveMemorySync | null {
  return singleton;
}