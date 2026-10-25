import { type RandomBytes, toBase64Url } from "@zli-v2/remote-protocol";

export const PAIRING_TTL_MS = 5 * 60_000;
const MAX_FAILED_PROOFS = 5;

export type PendingPairing = { pairingId: string; secret: Uint8Array; expiresAt: number };

/**
 * The one pairing code that is open at a time. A code works for one phone only and expires after five
 * minutes. Wrong proofs against it are counted, and a code that collects too many is withdrawn.
 */
export class PairingWindow {
  #pending: (PendingPairing & { failures: number }) | undefined;

  constructor(
    private readonly random: RandomBytes,
    private readonly now: () => number = Date.now,
  ) {}

  open(): PendingPairing {
    const pending = {
      pairingId: toBase64Url(this.random(16)),
      secret: this.random(32),
      expiresAt: this.now() + PAIRING_TTL_MS,
      failures: 0,
    };
    this.#pending = pending;
    return { pairingId: pending.pairingId, secret: pending.secret, expiresAt: pending.expiresAt };
  }

  current(): PendingPairing | undefined {
    const pending = this.#live();
    return pending ? { pairingId: pending.pairingId, secret: pending.secret, expiresAt: pending.expiresAt } : undefined;
  }

  /** The secret for a pairing id, while the code is open and unexpired. */
  secretFor(pairingId: string): Uint8Array | undefined {
    const pending = this.#live();
    return pending?.pairingId === pairingId ? pending.secret : undefined;
  }

  /** Marks the code used. Returns false when it was already used, withdrawn, or expired. */
  consume(pairingId: string): boolean {
    const pending = this.#live();
    if (pending?.pairingId !== pairingId) return false;
    this.#pending = undefined;
    return true;
  }

  recordFailure(pairingId: string): void {
    const pending = this.#live();
    if (pending?.pairingId !== pairingId) return;
    pending.failures += 1;
    if (pending.failures >= MAX_FAILED_PROOFS) this.#pending = undefined;
  }

  close(): void {
    this.#pending = undefined;
  }

  #live() {
    if (this.#pending && this.#pending.expiresAt <= this.now()) this.#pending = undefined;
    return this.#pending;
  }
}
