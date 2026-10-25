import type { MobileLease } from "@zli-v2/contracts";

export const DEFAULT_AGENT_LEASE_MS = 5 * 60_000;

export type LeaseOwner = { readonly ownerId: string; readonly ownerLabel: string; readonly kind: "agent" | "person" };

export class DeviceBusyError extends Error {
  constructor(
    message: string,
    readonly lease: MobileLease,
  ) {
    super(message);
    this.name = "DeviceBusyError";
  }
}

/**
 * Devices are shared, so each one has at most one driver at a time. An agent's lease lasts while it keeps
 * acting and lapses after a quiet period, so an agent that stopped does not hold a device forever.
 * A person can take over at any time; their lease outranks agents and lasts until they release it.
 */
export class DeviceLeases {
  readonly #leases = new Map<string, MobileLease>();
  readonly #now: () => number;
  readonly #agentLeaseMs: number;
  readonly #onChange: (() => void) | undefined;

  constructor(options: { now?: () => number; agentLeaseMs?: number; onChange?: () => void } = {}) {
    this.#now = options.now ?? Date.now;
    this.#agentLeaseMs = options.agentLeaseMs ?? DEFAULT_AGENT_LEASE_MS;
    this.#onChange = options.onChange;
  }

  get(deviceId: string): MobileLease | null {
    const lease = this.#leases.get(deviceId);
    if (!lease) return null;
    if (lease.expiresAt !== undefined && Date.parse(lease.expiresAt) <= this.#now()) {
      this.#leases.delete(deviceId);
      this.#onChange?.();
      return null;
    }
    return lease;
  }

  /** Takes or renews the lease for an agent, or throws when someone else holds the device. */
  acquire(deviceId: string, owner: LeaseOwner): MobileLease {
    const current = this.get(deviceId);
    if (current && current.ownerId !== owner.ownerId) {
      if (current.kind === "person")
        throw new DeviceBusyError(
          "The person took over this device in the Mobile panel. Ask them to hand it back before driving it again.",
          current,
        );
      if (owner.kind === "agent")
        throw new DeviceBusyError(
          `${current.ownerLabel || "Another agent"} is using this device until ${current.expiresAt ?? "it releases it"}. Pick another device, boot a new one, or wait.`,
          current,
        );
    }
    const now = this.#now();
    const lease: MobileLease = {
      ownerId: owner.ownerId,
      ownerLabel: owner.ownerLabel,
      kind: owner.kind,
      acquiredAt: current?.ownerId === owner.ownerId ? current.acquiredAt : new Date(now).toISOString(),
      ...(owner.kind === "agent" ? { expiresAt: new Date(now + this.#agentLeaseMs).toISOString() } : {}),
    };
    const changed = current?.ownerId !== owner.ownerId;
    this.#leases.set(deviceId, lease);
    if (changed) this.#onChange?.();
    return lease;
  }

  /** Releases the lease when `ownerId` holds it, or unconditionally without one. Returns whether it was held. */
  release(deviceId: string, ownerId?: string): boolean {
    const current = this.get(deviceId);
    if (!current || (ownerId !== undefined && current.ownerId !== ownerId)) return false;
    this.#leases.delete(deviceId);
    this.#onChange?.();
    return true;
  }

  /** Every device an owner holds. */
  heldBy(ownerId: string): string[] {
    return [...this.#leases.keys()].filter((deviceId) => this.get(deviceId)?.ownerId === ownerId);
  }
}
