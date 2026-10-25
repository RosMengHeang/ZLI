/**
 * Counts connection attempts per network address over a sliding window. A phone reconnects a few
 * times a minute at most, so anything past the limit is a script guessing.
 */
export class AttemptLimiter {
  readonly #attempts = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an attempt and says whether it is within the limit. */
  allow(key: string): boolean {
    const now = this.now();
    const recent = (this.#attempts.get(key) ?? []).filter((at) => at > now - this.windowMs);
    recent.push(now);
    this.#attempts.set(key, recent);
    if (this.#attempts.size > 1_000) this.#prune(now);
    return recent.length <= this.limit;
  }

  #prune(now: number): void {
    for (const [key, attempts] of this.#attempts) {
      if (attempts.every((at) => at <= now - this.windowMs)) this.#attempts.delete(key);
    }
  }
}
