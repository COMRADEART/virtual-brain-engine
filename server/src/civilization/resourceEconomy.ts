import { ulid } from "ulid";
import type {
  ResourceType,
  ResourceOffer,
  ResourceRequest,
  ResourceAllocation,
  ResourceBalance,
  ResourceCondition,
} from "../../../shared/civilization.js";
import { BrainNetwork } from "./brainNetwork.js";

export interface ResourceEconomyConfig {
  enableBidirectional: boolean;
  settlementIntervalMs: number;
  basePrice: Record<ResourceType, number>;
  priceDecayRate: number;
  maxOfferDurationMs: number;
  fairnessThreshold: number;
  emergencyReservePercentage: number;
}

const DEFAULT_CONFIG: ResourceEconomyConfig = {
  enableBidirectional: true,
  settlementIntervalMs: 60000,
  basePrice: {
    compute: 1.0,
    memory: 0.8,
    gpu: 2.5,
    simulation: 1.5,
    knowledge: 1.2,
    skill: 1.0,
  },
  priceDecayRate: 0.01,
  maxOfferDurationMs: 3600000,
  fairnessThreshold: 0.3,
  emergencyReservePercentage: 0.1,
};

export interface ResourceMarketEventHandlers {
  onAllocationCreated?: (allocation: ResourceAllocation) => void;
  onAllocationCompleted?: (allocation: ResourceAllocation) => void;
  onPriceChanged?: (resourceType: ResourceType, newPrice: number) => void;
  onBalanceSettled?: (balances: Map<string, number>) => void;
}

export class ResourceEconomy {
  private readonly config: ResourceEconomyConfig;
  private readonly network: BrainNetwork;
  private readonly handlers: ResourceMarketEventHandlers;
  private readonly offers = new Map<string, ResourceOffer>();
  private readonly requests = new Map<string, ResourceRequest>();
  private readonly allocations = new Map<string, ResourceAllocation>();
  private readonly balances = new Map<string, ResourceBalance>();
  private readonly prices = new Map<ResourceType, number>();
  private settlementTimer: ReturnType<typeof setInterval> | null = null;
  private priceUpdateTimer: ReturnType<typeof setInterval> | null = null;
  private myBrainId: string = "self";

  constructor(
    network: BrainNetwork,
    config: Partial<ResourceEconomyConfig> = {},
    handlers: ResourceMarketEventHandlers = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.network = network;
    this.handlers = handlers;

    for (const rt of Object.keys(this.config.basePrice) as ResourceType[]) {
      this.prices.set(rt, this.config.basePrice[rt]);
    }
  }

  setMyBrainId(brainId: string): void {
    this.myBrainId = brainId;
  }

  start(): void {
    this.settlementTimer = setInterval(() => {
      this.settleBalances();
    }, this.config.settlementIntervalMs);
    this.settlementTimer.unref?.();

    this.priceUpdateTimer = setInterval(() => {
      this.updatePrices();
    }, this.config.settlementIntervalMs / 2);
    this.priceUpdateTimer.unref?.();
  }

  stop(): void {
    if (this.settlementTimer) {
      clearInterval(this.settlementTimer);
      this.settlementTimer = null;
    }
    if (this.priceUpdateTimer) {
      clearInterval(this.priceUpdateTimer);
      this.priceUpdateTimer = null;
    }
  }

  createOffer(
    resourceType: ResourceType,
    amount: number,
    unit: string,
    conditions?: ResourceCondition[],
  ): ResourceOffer {
    const offer: ResourceOffer = {
      id: `offer-${ulid()}`,
      resourceType,
      amount,
      unit,
      availableUntil: new Date(Date.now() + this.config.maxOfferDurationMs).toISOString(),
      conditions,
    };

    this.offers.set(offer.id, offer);

    const message = {
      id: ulid(),
      type: "resource-offer" as const,
      sourceBrainId: this.myBrainId,
      payload: { offer },
      timestamp: new Date().toISOString(),
    };
    this.network.broadcast(message);

    return offer;
  }

  createRequest(
    resourceType: ResourceType,
    amount: number,
    unit: string,
    urgency: ResourceRequest["urgency"],
  ): ResourceRequest {
    const request: ResourceRequest = {
      id: `request-${ulid()}`,
      resourceType,
      amount,
      unit,
      urgency,
    };

    this.requests.set(request.id, request);

    const message = {
      id: ulid(),
      type: "resource-request" as const,
      sourceBrainId: this.myBrainId,
      payload: { request },
      timestamp: new Date().toISOString(),
    };
    this.network.broadcast(message);

    return request;
  }

  async allocate(offerId: string, requestId: string): Promise<ResourceAllocation | null> {
    const offer = this.offers.get(offerId);
    const request = this.requests.get(requestId);

    if (!offer || !request) return null;

    if (offer.resourceType !== request.resourceType) return null;

    if (offer.amount < request.amount) return null;

    if (offer.conditions) {
      for (const condition of offer.conditions) {
        if (!this.evaluateCondition(condition)) {
          return null;
        }
      }
    }

    const allocation: ResourceAllocation = {
      id: `alloc-${ulid()}`,
      offerId,
      requestId,
      amount: request.amount,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    this.allocations.set(allocation.id, allocation);

    offer.amount -= request.amount;
    if (offer.amount <= 0) {
      this.offers.delete(offerId);
    }

    this.handlers.onAllocationCreated?.(allocation);

    const message = {
      id: ulid(),
      type: "resource-allocation" as const,
      sourceBrainId: this.myBrainId,
      payload: { allocation },
      timestamp: new Date().toISOString(),
    };
    this.network.broadcast(message);

    return allocation;
  }

  completeAllocation(allocationId: string): void {
    const allocation = this.allocations.get(allocationId);
    if (!allocation || allocation.status !== "pending") return;

    allocation.status = "completed";
    allocation.completedAt = new Date().toISOString();

    const offer = this.offers.get(allocation.offerId);
    const request = this.requests.get(allocation.requestId);

    if (offer && this.config.enableBidirectional) {
      const price = this.prices.get(offer.resourceType) ?? 1;
      const cost = allocation.amount * price;

      this.updateBalance(this.myBrainId, cost);
    }

    this.handlers.onAllocationCompleted?.(allocation);
  }

  cancelAllocation(allocationId: string): void {
    const allocation = this.allocations.get(allocationId);
    if (!allocation) return;

    allocation.status = "cancelled";

    const offer = this.offers.get(allocation.offerId);
    if (offer) {
      offer.amount += allocation.amount;
    }
  }

  getOffer(offerId: string): ResourceOffer | undefined {
    return this.offers.get(offerId);
  }

  getRequest(requestId: string): ResourceRequest | undefined {
    return this.requests.get(requestId);
  }

  getAllocation(allocationId: string): ResourceAllocation | undefined {
    return this.allocations.get(allocationId);
  }

  getActiveOffers(resourceType?: ResourceType): ResourceOffer[] {
    let results = Array.from(this.offers.values()).filter((o) => {
      if (o.availableUntil && new Date(o.availableUntil).getTime() < Date.now()) {
        return false;
      }
      return o.amount > 0;
    });

    if (resourceType) {
      results = results.filter((o) => o.resourceType === resourceType);
    }

    return results.sort((a, b) => b.amount - a.amount);
  }

  getActiveRequests(resourceType?: ResourceType): ResourceRequest[] {
    let results = Array.from(this.requests.values());

    if (resourceType) {
      results = results.filter((r) => r.resourceType === resourceType);
    }

    return results.sort((a, b) => {
      const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
    });
  }

  getPrice(resourceType: ResourceType): number {
    return this.prices.get(resourceType) ?? this.config.basePrice[resourceType];
  }

  getAllPrices(): Record<ResourceType, number> {
    const result: Partial<Record<ResourceType, number>> = {};
    for (const rt of Object.keys(this.config.basePrice) as ResourceType[]) {
      result[rt] = this.prices.get(rt) ?? this.config.basePrice[rt];
    }
    return result as Record<ResourceType, number>;
  }

  getBalance(brainId: string): ResourceBalance | undefined {
    return this.balances.get(brainId);
  }

  getAllBalances(): ResourceBalance[] {
    return Array.from(this.balances.values());
  }

  handleIncomingMessage(payload: unknown): void {
    const msg = payload as { offer?: ResourceOffer; request?: ResourceRequest; allocation?: ResourceAllocation };
    if (msg.offer) {
      this.offers.set(msg.offer.id, msg.offer);
    }
    if (msg.request) {
      this.requests.set(msg.request.id, msg.request);
    }
    if (msg.allocation) {
      const existing = this.allocations.get(msg.allocation.id);
      if (!existing) {
        this.allocations.set(msg.allocation.id, msg.allocation);
        this.handlers.onAllocationCreated?.(msg.allocation);
      }
    }
  }

  private updateBalance(brainId: string, delta: number): void {
    let balance = this.balances.get(brainId);
    if (!balance) {
      balance = {
        brainId,
        giveBalance: 0,
        receiveBalance: 0,
        totalGiven: 0,
        totalReceived: 0,
        lastSettledAt: new Date().toISOString(),
      };
      this.balances.set(brainId, balance);
    }

    if (delta > 0) {
      balance.giveBalance += delta;
      balance.totalGiven += delta;
    } else {
      balance.receiveBalance += Math.abs(delta);
      balance.totalReceived += Math.abs(delta);
    }
  }

  private settleBalances(): void {
    const settlements = new Map<string, number>();

    for (const balance of this.balances.values()) {
      const net = balance.giveBalance - balance.receiveBalance;

      if (Math.abs(net) > this.config.fairnessThreshold) {
        if (net > 0) {
          settlements.set(balance.brainId, -net * 0.1);
        } else {
          settlements.set(balance.brainId, Math.abs(net) * 0.1);
        }

        balance.giveBalance = 0;
        balance.receiveBalance = 0;
        balance.lastSettledAt = new Date().toISOString();
      }
    }

    for (const [brainId, amount] of settlements) {
      if (amount !== 0) {
        this.updateBalance(brainId, amount);
      }
    }

    if (settlements.size > 0) {
      this.handlers.onBalanceSettled?.(settlements);
    }
  }

  private updatePrices(): void {
    for (const rt of Object.keys(this.config.basePrice) as ResourceType[]) {
      const currentPrice = this.prices.get(rt) ?? this.config.basePrice[rt];
      const activeOffers = this.getActiveOffers(rt);
      const activeRequests = this.getActiveRequests(rt);

      if (activeRequests.length === 0) {
        const newPrice = currentPrice * (1 - this.config.priceDecayRate);
        this.prices.set(rt, Math.max(this.config.basePrice[rt] * 0.5, newPrice));
      } else if (activeOffers.length === 0) {
        const newPrice = currentPrice * (1 + this.config.priceDecayRate);
        this.prices.set(rt, Math.min(this.config.basePrice[rt] * 2, newPrice));
      }

      const newPrice = this.prices.get(rt)!;
      if (newPrice !== currentPrice) {
        this.handlers.onPriceChanged?.(rt, newPrice);
      }
    }
  }

  private evaluateCondition(condition: ResourceCondition): boolean {
    switch (condition.type) {
      case "min-trust":
        return true;
      case "time-window":
        return true;
      default:
        return true;
    }
  }
}

let singleton: ResourceEconomy | null = null;

export function createResourceEconomy(
  network: BrainNetwork,
  config?: Partial<ResourceEconomyConfig>,
  handlers?: ResourceMarketEventHandlers,
): ResourceEconomy {
  if (!singleton) {
    singleton = new ResourceEconomy(network, config, handlers);
  }
  return singleton;
}

export function getResourceEconomy(): ResourceEconomy | null {
  return singleton;
}