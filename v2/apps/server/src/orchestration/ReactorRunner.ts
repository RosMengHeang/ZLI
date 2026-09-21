import type { RuntimeEventEnvelope, RuntimeProjection } from "@zli-v2/contracts";

export type ReactorContext = {
  events: readonly RuntimeEventEnvelope[];
  projection: RuntimeProjection;
};

export type Reactor = (context: ReactorContext) => void | Promise<void>;

export type NamedReactor = {
  name: string;
  run: Reactor;
};

export class ReactorRunner {
  constructor(private readonly reactors: readonly NamedReactor[]) {}

  async run(context: ReactorContext): Promise<ReadonlyArray<{ name: string; error: unknown }>> {
    const failures: Array<{ name: string; error: unknown }> = [];
    for (const reactor of this.reactors) {
      try {
        await reactor.run(context);
      } catch (error) {
        failures.push({ name: reactor.name, error });
      }
    }
    return failures;
  }
}
