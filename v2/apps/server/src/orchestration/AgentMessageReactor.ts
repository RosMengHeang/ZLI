import type { RuntimeEventEnvelope } from "@zli-v2/contracts";

import type { Engine } from "./Engine.js";

/**
 * Holds delivered project messages on the thread projection.
 * The text is untrusted, so this reactor does not dispatch thread.send
 * and does not call a provider.
 */
export class AgentMessageReactor {
  private readonly unsubscribe: () => void;

  constructor(private readonly engine: Engine) {
    this.unsubscribe = engine.subscribe((envelope) => {
      this.observe(envelope);
    });
  }

  stop(): void {
    this.unsubscribe();
  }

  async waitForIdle(): Promise<void> {
    await this.engine.projection();
  }

  private observe(envelope: RuntimeEventEnvelope): void {
    if (envelope.event.type !== "thread.a2a.delivered") return;
    if (envelope.event.message.role !== "agent") return;
  }
}
