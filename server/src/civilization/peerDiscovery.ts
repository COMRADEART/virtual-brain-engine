import { createSocket, type Socket } from "node:dgram";
import { createServer, type Server as TcpServer, type Socket as TcpSocket } from "node:net";
import { ulid } from "ulid";
import {
  CIVILIZATION_BROADCAST_PORT,
  type BrainDescriptor,
  type BrainPeer,
  type InterBrainMessage,
} from "../../../shared/civilization.js";
import { BrainNetwork, type NetworkEventHandlers } from "./brainNetwork.js";

export interface PeerDiscoveryConfig {
  enabled: boolean;
  mDNSServiceName: string;
  broadcastIntervalMs: number;
  peerTimeoutMs: number;
  bootstrapNodes: BootstrapNode[];
  enableMdns: boolean;
  enableBroadcast: boolean;
  enableLogging?: boolean;
}

export interface BootstrapNode {
  address: string;
  port: number;
  brainId: string;
}

export interface PeerFilter {
  capability?: string;
  minTrust?: number;
  maxLatency?: number;
  health?: "healthy" | "degraded";
  cultureType?: string;
}

const DEFAULT_CONFIG: PeerDiscoveryConfig = {
  enabled: true,
  mDNSServiceName: "_brainbrain._tcp.local",
  broadcastIntervalMs: 10000,
  peerTimeoutMs: 60000,
  bootstrapNodes: [],
  enableMdns: false,
  enableBroadcast: true,
};

interface DiscoveredPeer {
  descriptor: BrainDescriptor;
  address: string;
  port: number;
  lastSeen: number;
  latency?: number;
}

export class PeerDiscovery {
  private readonly config: PeerDiscoveryConfig;
  private readonly network: BrainNetwork;
  private udpSocket: ReturnType<typeof createSocket> | null = null;
  private tcpServer: TcpServer | null = null;
  private readonly discoveredPeers = new Map<string, DiscoveredPeer>();
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private localDescriptor: BrainDescriptor | null = null;
  private readonly eventHandlers: NetworkEventHandlers;

  constructor(
    network: BrainNetwork,
    config: Partial<PeerDiscoveryConfig> = {},
    eventHandlers: NetworkEventHandlers = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.network = network;
    this.eventHandlers = eventHandlers;
  }

  async start(localDescriptor: BrainDescriptor): Promise<void> {
    if (this.running || !this.config.enabled) return;
    this.localDescriptor = localDescriptor;

    if (this.config.enableBroadcast) {
      await this.startBroadcastListener();
    }

    this.startBroadcastTimer();
    this.startCleanupTimer();

    if (this.config.bootstrapNodes.length > 0) {
      await this.bootstrapFromKnownNodes();
    }

    this.running = true;
    console.log("[PeerDiscovery] Started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.stopBroadcastTimer();
    this.stopCleanupTimer();

    if (this.udpSocket) {
      this.udpSocket.close();
      this.udpSocket = null;
    }

    if (this.tcpServer) {
      await new Promise<void>((resolve) => {
        this.tcpServer!.close(() => resolve());
      });
      this.tcpServer = null;
    }

    this.discoveredPeers.clear();
    console.log("[PeerDiscovery] Stopped");
  }

  announce(): void {
    if (!this.localDescriptor || !this.config.enableBroadcast) return;

    this.broadcastDiscoveryMessage({
      type: "discovery-announce",
      id: ulid(),
      sourceBrainId: this.localDescriptor.id,
      payload: {
        descriptor: this.localDescriptor,
        address: "dynamic",
      },
      timestamp: new Date().toISOString(),
    });
  }

  async findPeers(filter?: PeerFilter): Promise<BrainPeer[]> {
    const now = Date.now();
    const allPeers = this.network.getAllPeers();
    const discovered = Array.from(this.discoveredPeers.values());

    const networkPeers = allPeers.map((p) => ({
      descriptor: p.descriptor,
      address: p.connection.address,
      port: p.connection.port,
      lastSeen: new Date(p.lastHeartbeat).getTime(),
      latency: p.latencyMs,
    }));

    const combined = [...networkPeers, ...discovered];
    const uniquePeers = new Map<string, typeof combined[0]>();

    for (const peer of combined) {
      const existing = uniquePeers.get(peer.descriptor.id);
      if (!existing || peer.lastSeen > existing.lastSeen) {
        uniquePeers.set(peer.descriptor.id, peer);
      }
    }

    let results = Array.from(uniquePeers.values());

    if (filter) {
      if (filter.capability) {
        results = results.filter((p) => p.descriptor.capabilities.includes(filter.capability!));
      }
      if (filter.minTrust !== undefined) {
        results = results.filter((p) => (p.descriptor.trust ?? 0) >= filter.minTrust!);
      }
      if (filter.maxLatency !== undefined) {
        results = results.filter((p) => (p.latency ?? 0) <= filter.maxLatency!);
      }
      if (filter.health) {
        results = results.filter((p) => p.descriptor.health === filter.health);
      }
      if (filter.cultureType) {
        results = results.filter((p) => p.descriptor.cultureType === filter.cultureType);
      }
    }

    return results.map((p) => ({
      id: p.descriptor.id,
      descriptor: p.descriptor,
      connection: {
        type: "tcp",
        address: p.address,
        port: p.port,
        establishedAt: new Date(p.lastSeen).toISOString(),
        messageCount: 0,
        bytesTransferred: 0,
      },
      lastHeartbeat: new Date(p.lastSeen).toISOString(),
      latencyMs: p.latency ?? 0,
      isConnected: this.network.getPeer(p.descriptor.id)?.isConnected ?? false,
    }));
  }

  onPeerFound(handler: (peer: BrainPeer) => void): () => void {
    const wrapped = (peer: BrainPeer) => {
      if (!this.discoveredPeers.has(peer.id)) {
        handler(peer);
      }
    };
    this.eventHandlers.onPeerConnected = wrapped;
    return () => {
      if (this.eventHandlers.onPeerConnected === wrapped) {
        this.eventHandlers.onPeerConnected = undefined;
      }
    };
  }

  onPeerLost(handler: (peerId: string) => void): () => void {
    const wrapped = (peerId: string) => {
      if (this.discoveredPeers.has(peerId)) {
        this.discoveredPeers.delete(peerId);
        handler(peerId);
      }
    };
    this.eventHandlers.onPeerDisconnected = wrapped;
    return () => {
      if (this.eventHandlers.onPeerDisconnected === wrapped) {
        this.eventHandlers.onPeerDisconnected = undefined;
      }
    };
  }

  private async startBroadcastListener(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.udpSocket = createSocket({ type: "udp4", reuseAddr: true });

      this.udpSocket.on("error", (err) => {
        console.error("[PeerDiscovery] UDP error:", err);
      });

      this.udpSocket.on("message", (msg, rinfo) => {
        try {
          const message = JSON.parse(msg.toString()) as InterBrainMessage;
          this.handleDiscoveryMessage(message, rinfo.address, rinfo.port);
        } catch {
          // Ignore malformed broadcasts
        }
      });

      this.udpSocket.bind(CIVILIZATION_BROADCAST_PORT, "0.0.0.0", () => {
        this.udpSocket!.setBroadcast(true);
        if (this.config.enableLogging !== false) {
          console.log(`[PeerDiscovery] UDP listener on port ${CIVILIZATION_BROADCAST_PORT}`);
        }
        resolve();
      });
    });
  }

  private startBroadcastTimer(): void {
    this.broadcastTimer = setInterval(() => {
      this.announce();
    }, this.config.broadcastIntervalMs);
    this.broadcastTimer.unref?.();
  }

  private stopBroadcastTimer(): void {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      const timeout = this.config.peerTimeoutMs;

      for (const [peerId, peer] of this.discoveredPeers) {
        if (now - peer.lastSeen > timeout) {
          this.discoveredPeers.delete(peerId);
        }
      }
    }, this.config.peerTimeoutMs / 2);
    this.cleanupTimer.unref?.();
  }

  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private async bootstrapFromKnownNodes(): Promise<void> {
    console.log(`[PeerDiscovery] Bootstrapping from ${this.config.bootstrapNodes.length} known nodes`);

    for (const node of this.config.bootstrapNodes) {
      try {
        await this.network.connect(node.address, node.port, {
          id: node.brainId,
          name: "bootstrap",
          version: CIVILIZATION_BROADCAST_PORT.toString(),
          capabilities: [],
          resources: {
            computeUnits: 0,
            memoryMB: 0,
            gpuUnits: 0,
            simulationBudget: 0,
            networkBandwidthMbps: 0,
          },
          resourceUsage: {
            cpu: 0,
            ram: 0,
            gpu: 0,
            batteryImpact: 0,
            thermalLoad: 0,
            latencyMs: 0,
            activeTasks: 0,
          },
          publicKey: "",
          health: "offline",
          announcedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        });
      } catch (err) {
        console.warn(`[PeerDiscovery] Failed to connect to bootstrap node ${node.address}:${node.port}:`, err);
      }
    }
  }

  private broadcastDiscoveryMessage(message: InterBrainMessage): void {
    if (!this.udpSocket) return;

    try {
      const data = JSON.stringify(message);
      this.udpSocket.send(data, CIVILIZATION_BROADCAST_PORT, "255.255.255.255");
    } catch (err) {
      console.error("[PeerDiscovery] Broadcast error:", err);
    }
  }

  private handleDiscoveryMessage(message: InterBrainMessage, address: string, port: number): void {
    if (!this.localDescriptor || message.sourceBrainId === this.localDescriptor.id) {
      return;
    }

    if (message.type === "discovery-announce") {
      const payload = message.payload as { descriptor: BrainDescriptor; address?: string };
      if (payload.descriptor) {
        this.discoveredPeers.set(payload.descriptor.id, {
          descriptor: payload.descriptor,
          address: address,
          port: payload.address === "dynamic" ? this.config.bootstrapNodes[0]?.port ?? CIVILIZATION_BROADCAST_PORT : CIVILIZATION_BROADCAST_PORT,
          lastSeen: Date.now(),
        });

        this.eventHandlers.onPeerConnected?.({
          id: payload.descriptor.id,
          descriptor: payload.descriptor,
          connection: {
            type: "mDNS",
            address,
            port,
            establishedAt: new Date().toISOString(),
            messageCount: 0,
            bytesTransferred: 0,
          },
          lastHeartbeat: new Date().toISOString(),
          latencyMs: 0,
          isConnected: this.network.getPeer(payload.descriptor.id)?.isConnected ?? false,
        });
      }
    } else if (message.type === "discovery-query") {
      const payload = message.payload as { queryCapabilities?: string[] };
      if (payload.queryCapabilities && this.localDescriptor) {
        const hasCapability = payload.queryCapabilities.some((cap) =>
          this.localDescriptor!.capabilities.includes(cap)
        );
        if (hasCapability) {
          this.broadcastDiscoveryMessage({
            type: "discovery-response",
            id: ulid(),
            sourceBrainId: this.localDescriptor.id,
            targetBrainId: message.sourceBrainId,
            payload: { descriptor: this.localDescriptor },
            timestamp: new Date().toISOString(),
          });
        }
      }
    } else if (message.type === "discovery-response") {
      const payload = message.payload as { descriptor: BrainDescriptor };
      if (payload.descriptor && !this.discoveredPeers.has(payload.descriptor.id)) {
        this.discoveredPeers.set(payload.descriptor.id, {
          descriptor: payload.descriptor,
          address,
          port,
          lastSeen: Date.now(),
        });
      }
    }
  }
}

let singleton: PeerDiscovery | null = null;

export function createPeerDiscovery(
  network: BrainNetwork,
  config?: Partial<PeerDiscoveryConfig>,
  handlers?: NetworkEventHandlers,
): PeerDiscovery {
  if (!singleton) {
    singleton = new PeerDiscovery(network, config, handlers);
  }
  return singleton;
}

export function getPeerDiscovery(): PeerDiscovery | null {
  return singleton;
}