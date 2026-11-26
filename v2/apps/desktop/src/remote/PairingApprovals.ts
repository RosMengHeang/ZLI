import { type RandomBytes, toBase64Url } from "@zli-v2/remote-protocol";

import { PAIRING_APPROVAL_WAIT_MS, type PairingApprovalRequest } from "./MobileGateway.js";

export type PendingApproval = { id: string; deviceName: string; expiresAt: number };

/**
 * The one relay pairing waiting for the person at the desktop to allow it. Settings answers it by id, so an answer
 * meant for one request never allows another. A second request while one waits is refused, so the prompt the person
 * is reading cannot be swapped under them.
 */
export class PairingApprovals {
  #pending: { request: PendingApproval; finish: (allow: boolean) => void } | undefined;

  constructor(private readonly options: { random: RandomBytes; onChange: () => void; now?: () => number }) {}

  ask(request: PairingApprovalRequest): Promise<boolean> {
    const { signal } = request;
    if (this.#pending || signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const id = toBase64Url(this.options.random(16));
      const onAbort = () => finish(false);
      const finish = (allow: boolean) => {
        if (this.#pending?.request.id !== id) return;
        this.#pending = undefined;
        signal.removeEventListener("abort", onAbort);
        resolve(allow);
        this.options.onChange();
      };
      this.#pending = {
        request: {
          id,
          deviceName: request.deviceName,
          expiresAt: (this.options.now?.() ?? Date.now()) + PAIRING_APPROVAL_WAIT_MS,
        },
        finish,
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.options.onChange();
    });
  }

  current(): PendingApproval | undefined {
    return this.#pending ? { ...this.#pending.request } : undefined;
  }

  /** Answers the waiting request. Only `true` allows it. False when `id` is not the request waiting now. */
  respond(id: unknown, allow: unknown): boolean {
    const pending = this.#pending;
    if (!pending || typeof id !== "string" || id !== pending.request.id) return false;
    pending.finish(allow === true);
    return true;
  }

  deny(): void {
    this.#pending?.finish(false);
  }
}
