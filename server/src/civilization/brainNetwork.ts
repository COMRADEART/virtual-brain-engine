import { createServer, type Server, type ServerOpts, Socket } from "node:net";
import { ulid } from "ulid";
import {
  CIVILIZATION_PROTOCOL_VERSION,
  CIVILIZATION_DEFAULT_PORT,
  type BrainDescriptor,
  type InterBrainMessage,
  type BrainPeer,
  type PeerConnection,
  type HealthStatus,
} from "../../../shared/civilization.js";

export interface BrainNetworkConfig {
  port: number;
  maxPeers: number;
  heartbeatIntervalMs: number;
  connectionTimeoutMs: number;
  maxMessageSize: number;
  enableLogging: boolean;
}

const DEFAULT_CONFIG: BrainNetworkConfig = {
  port: CIVILIZATION_DEFAULT_PORT,
  maxPeers: 64,
  heartbeatIntervalMs: 5000,
  connectionTimeoutMs: 30000,
  maxMessageSize: 1024 * 1024,
  enableLogging: true,
};

export interface NetworkEventHandlers {
  onPeerConnected?: (peer: BrainPeer) => void;
  onPeerDisconnected?: (peerId: string, reason: string) => void;
  onMessageReceived?: (peerId: string, message: InterBrainMessage) => void;
  onError?: (peerId: string | null, error: Error) => void;
}

interface ConnectedPeer {
  socket: Socket;
  peerId: string;
  descriptor?: BrainDescriptor;
  lastHeartbeat: number;
  bytesReceived: number;
  bytesSent: number;
  messageCount: number;
  isWriter: boolean;
  writeQueue: string[];
}

export class BrainNetwork {
  private readonly config: BrainNetworkConfig;
  private readonly handlers: NetworkEventHandlers;
  private server: Server | null = null;
  private readonly peers = new Map<string, ConnectedPeer>();
  private readonly pendingConnections = new Map<string, { socket: Socket; connectTime: number }>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private localDescriptor: BrainDescriptor | null = null;

  constructor(config: Partial<BrainNetworkConfig> = {}, handlers: NetworkEventHandlers = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.handlers = handlers;
  }

  async start(localDescriptor: BrainDescriptor): Promise<void> {
    if (this.running) return;
    this.localDescriptor = localDescriptor;

    await new Promise<void>((resolve, reject) => {
      this.server = createServer((socket) => {
        this.handleIncomingConnection(socket);
      });

      this.server.on("error", (err) => {
        if (this.config.enableLogging) {
          console.error("[BrainNetwork] Server error:", err);
        }
        this.handlers.onError?.(null, err);
        reject(err);
      });

      this.server.listen(this.config.port, "0.0.0.0", () => {
        if (this.config.enableLogging) {
          console.log(`[BrainNetwork] Listening on port ${this.config.port}`);
        }
        resolve();
      });
    });

    this.running = true;
    this.startHeartbeat();
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    this.stopHeartbeat();

    const disconnectPromises: Promise<void>[] = [];
    for (const [peerId, peer] of this.peers) {
      disconnectPromises.push(this.disconnectPeer(peerId, "server_shutdown"));
    }
    await Promise.all(disconnectPromises);

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    if (this.config.enableLogging) {
      console.log("[BrainNetwork] Stopped");
    }
  }

  async connect(remoteAddress: string, remotePort: number, descriptor: BrainDescriptor): Promise<BrainPeer> {
    return new Promise((resolve, reject) => {
      const socket = createSocketConnection(remoteAddress, remotePort);

      const connectTimeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to ${remoteAddress}:${remotePort}`));
      }, this.config.connectionTimeoutMs);

      socket.on("connect", () => {
        clearTimeout(connectTimeout);
        const peerId = descriptor.id;
        this.pendingConnections.set(peerId, { socket, connectTime: Date.now() });

        const handshake = this.buildHandshake();
        this.sendRaw(socket, handshake);

        const peer: BrainPeer = {
          id: peerId,
          descriptor,
          connection: {
            type: "tcp",
            address: remoteAddress,
            port: remotePort,
            establishedAt: new Date().toISOString(),
            messageCount: 0,
            bytesTransferred: 0,
          },
          lastHeartbeat: new Date().toISOString(),
          latencyMs: Date.now() - this.pendingConnections.get(peerId)!.connectTime,
          isConnected: true,
        };

        socket.once("data", (data) => {
          const response = this.parseMessage(data.toString());
          if (response?.type === "handshake-ack") {
            this.completeConnection(peerId, socket, descriptor);
            this.pendingConnections.delete(peerId);
            resolve(peer);
          } else {
            socket.destroy();
            this.pendingConnections.delete(peerId);
            reject(new Error("Invalid handshake response"));
          }
        });

        socket.on("error", (err) => {
          clearTimeout(connectTimeout);
          this.pendingConnections.delete(peerId);
          this.handlers.onError?.(peerId, err);
          reject(err);
        });
      });

      socket.on("error", (err) => {
        clearTimeout(connectTimeout);
        this.pendingConnections.delete(descriptor.id);
        this.handlers.onError?.(descriptor.id, err);
        reject(err);
      });
    });
  }

  async disconnect(peerId: string): Promise<void> {
    await this.disconnectPeer(peerId, "manual_disconnect");
  }

  broadcast(message: InterBrainMessage): void {
    const serialized = this.serializeMessage({ ...message, type: message.type });
    for (const [peerId, peer] of this.peers) {
      if (peer.isWriter) {
        this.sendRaw(peer.socket, serialized);
      }
    }
  }

  send(peerId: string, message: InterBrainMessage): boolean {
    const peer = this.peers.get(peerId);
    if (!peer) {
      if (this.config.enableLogging) {
        console.warn(`[BrainNetwork] Unknown peer: ${peerId}`);
      }
      return false;
    }
    this.sendRaw(peer.socket, this.serializeMessage(message));
    return true;
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  getPeerIds(): string[] {
    return Array.from(this.peers.keys());
  }

  getPeer(peerId: string): BrainPeer | undefined {
    const peer = this.peers.get(peerId);
    if (!peer) return undefined;
    return this.buildBrainPeer(peer);
  }

  getAllPeers(): BrainPeer[] {
    return Array.from(this.peers.values()).map((p) => this.buildBrainPeer(p));
  }

  isRunning(): boolean {
    return this.running;
  }

  private handleIncomingConnection(socket: Socket): void {
    const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    if (this.peers.size >= this.config.maxPeers) {
      if (this.config.enableLogging) {
        console.warn(`[BrainNetwork] Rejected connection from ${remoteAddress}: max peers reached`);
      }
      socket.destroy();
      return;
    }

    if (this.config.enableLogging) {
      console.log(`[BrainNetwork] Incoming connection from ${remoteAddress}`);
    }

    let buffer = "";
    const timeout = setTimeout(() => {
      if (this.config.enableLogging) {
        console.warn(`[BrainNetwork] Connection timeout from ${remoteAddress}`);
      }
      socket.destroy();
    }, this.config.connectionTimeoutMs);

    socket.on("data", (data) => {
      clearTimeout(timeout);
      buffer += data.toString();

      while (buffer.includes("\n")) {
        const newlineIndex = buffer.indexOf("\n");
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (!line.trim()) continue;

        try {
          const message = this.parseMessage(line);
          if (!message) continue;

          this.handleMessage(socket, remoteAddress, message);
        } catch (err) {
          if (this.config.enableLogging) {
            console.error("[BrainNetwork] Failed to parse message:", err);
          }
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      if (this.config.enableLogging) {
        console.error(`[BrainNetwork] Socket error from ${remoteAddress}:`, err);
      }
    });

    socket.on("close", () => {
      clearTimeout(timeout);
    });
  }

  private handleMessage(socket: Socket, remoteAddress: string, message: InterBrainMessage): void {
    switch (message.type) {
      case "handshake": {
        const descriptor = message.payload as BrainDescriptor;
        if (message.payload && typeof descriptor === "object" && descriptor.id) {
          const peerId = descriptor.id;
          const existingPeer = this.peers.get(peerId);
          if (existingPeer) {
            existingPeer.socket.write(this.serializeMessage({
              type: "handshake-ack",
              id: ulid(),
              sourceBrainId: this.localDescriptor?.id ?? "unknown",
              targetBrainId: peerId,
              payload: { status: "already_connected", descriptor: this.localDescriptor },
              timestamp: new Date().toISOString(),
            }) + "\n");
            return;
          }

          this.completeConnection(peerId, socket, descriptor);
          const ack = this.serializeMessage({
            type: "handshake-ack",
            id: ulid(),
            sourceBrainId: this.localDescriptor?.id ?? "unknown",
            targetBrainId: peerId,
            payload: { status: "accepted", descriptor: this.localDescriptor },
            timestamp: new Date().toISOString(),
          });
          this.sendRaw(socket, ack);
        }
        break;
      }
      case "heartbeat": {
        const peerEntry = this.findPeerBySocket(socket);
        if (peerEntry) {
          peerEntry.lastHeartbeat = Date.now();
          const payload = message.payload as { resources?: unknown; health?: HealthStatus };
          if (payload?.health) {
            const peer = this.peers.get(peerEntry.peerId);
            if (peer?.descriptor) {
              peer.descriptor.health = payload.health;
            }
          }
        }
        break;
      }
      default: {
        const peerEntry = this.findPeerBySocket(socket);
        if (peerEntry) {
          this.handlers.onMessageReceived?.(peerEntry.peerId, message);
        }
      }
    }
  }

  private completeConnection(peerId: string, socket: Socket, descriptor: BrainDescriptor): void {
    const peer: ConnectedPeer = {
      socket,
      peerId,
      descriptor,
      lastHeartbeat: Date.now(),
      bytesReceived: 0,
      bytesSent: 0,
      messageCount: 0,
      isWriter: false,
      writeQueue: [],
    };

    this.peers.set(peerId, peer);
    this.setupSocketHandlers(peer);

    const brainPeer = this.buildBrainPeer(peer);
    this.handlers.onPeerConnected?.(brainPeer);

    if (this.config.enableLogging) {
      console.log(`[BrainNetwork] Peer connected: ${peerId} (${descriptor.name})`);
    }
  }

  private setupSocketHandlers(peer: ConnectedPeer): void {
    let buffer = "";

    peer.socket.on("data", (data) => {
      peer.bytesReceived += data.length;
      buffer += data.toString();

      while (buffer.includes("\n")) {
        const newlineIndex = buffer.indexOf("\n");
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (!line.trim()) continue;

        try {
          const message = this.parseMessage(line);
          if (!message) continue;

          peer.messageCount++;
          this.handleMessage(peer.socket, `${peer.socket.remoteAddress}:${peer.socket.remotePort}`, message);
        } catch (err) {
          if (this.config.enableLogging) {
            console.error(`[BrainNetwork] Parse error for peer ${peer.peerId}:`, err);
          }
        }
      }
    });

    peer.socket.on("close", () => {
      this.peers.delete(peer.peerId);
      this.handlers.onPeerDisconnected?.(peer.peerId, "connection_closed");
      if (this.config.enableLogging) {
        console.log(`[BrainNetwork] Peer disconnected: ${peer.peerId}`);
      }
    });

    peer.socket.on("error", (err) => {
      this.handlers.onError?.(peer.peerId, err);
      if (this.config.enableLogging) {
        console.error(`[BrainNetwork] Peer error ${peer.peerId}:`, err);
      }
    });
  }

  private async disconnectPeer(peerId: string, reason: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    return new Promise((resolve) => {
      peer.socket.end(() => {
        this.peers.delete(peerId);
        this.handlers.onPeerDisconnected?.(peerId, reason);
        resolve();
      });
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const staleThreshold = this.config.heartbeatIntervalMs * 3;

      for (const [peerId, peer] of this.peers) {
        if (now - peer.lastHeartbeat > staleThreshold) {
          if (this.config.enableLogging) {
            console.warn(`[BrainNetwork] Peer ${peerId} heartbeat stale, disconnecting`);
          }
          this.disconnectPeer(peerId, "heartbeat_timeout").catch(() => {});
        } else {
          const heartbeat: InterBrainMessage = {
            id: ulid(),
            type: "heartbeat",
            sourceBrainId: this.localDescriptor?.id ?? "unknown",
            targetBrainId: peerId,
            payload: {
              timestamp: now,
              resources: this.localDescriptor?.resourceUsage,
              health: this.localDescriptor?.health ?? "healthy",
            },
            timestamp: new Date().toISOString(),
          };
          this.sendRaw(peer.socket, this.serializeMessage(heartbeat));
        }
      }
    }, this.config.heartbeatIntervalMs);

    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private buildHandshake(): string {
    const message: InterBrainMessage = {
      id: ulid(),
      type: "handshake",
      sourceBrainId: this.localDescriptor?.id ?? "unknown",
      payload: this.localDescriptor,
      timestamp: new Date().toISOString(),
    };
    return this.serializeMessage(message);
  }

  private sendRaw(socket: Socket, data: string): void {
    try {
      socket.write(data + "\n");
    } catch (err) {
      if (this.config.enableLogging) {
        console.error("[BrainNetwork] Send error:", err);
      }
    }
  }

  private serializeMessage(message: InterBrainMessage): string {
    return JSON.stringify(message);
  }

  private parseMessage(data: string): InterBrainMessage | null {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && parsed.type && parsed.id && parsed.sourceBrainId) {
        return parsed as InterBrainMessage;
      }
      return null;
    } catch {
      return null;
    }
  }

  private findPeerBySocket(socket: Socket): ConnectedPeer | undefined {
    for (const peer of this.peers.values()) {
      if (peer.socket === socket) {
        return peer;
      }
    }
    return undefined;
  }

  private buildBrainPeer(peer: ConnectedPeer): BrainPeer {
    return {
      id: peer.peerId,
      descriptor: peer.descriptor!,
      connection: {
        type: "tcp",
        address: peer.socket.remoteAddress ?? "unknown",
        port: peer.socket.remotePort ?? 0,
        establishedAt: new Date().toISOString(),
        messageCount: peer.messageCount,
        bytesTransferred: peer.bytesSent + peer.bytesReceived,
      },
      lastHeartbeat: new Date(peer.lastHeartbeat).toISOString(),
      latencyMs: 0,
      isConnected: true,
    };
  }
}

function createSocketConnection(address: string, port: number): Socket {
  return new Socket().connect(port, address);
}

let singleton: BrainNetwork | null = null;

export function createBrainNetwork(
  config?: Partial<BrainNetworkConfig>,
  handlers?: NetworkEventHandlers,
): BrainNetwork {
  if (!singleton) {
    singleton = new BrainNetwork(config, handlers);
  }
  return singleton;
}

export function getBrainNetwork(): BrainNetwork | null {
  return singleton;
}