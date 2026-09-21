import {
  RuntimeEventEnvelope,
  RuntimeProjection,
  type RuntimeEventEnvelope as RuntimeEventEnvelopeValue,
  type RuntimeProjection as RuntimeProjectionValue,
} from "@zli-v2/contracts";

export type ProjectionListener = (projection: RuntimeProjectionValue) => void;
export type EventApplication = "applied" | "duplicate" | "gap";

export class ProjectionStore {
  #projection: RuntimeProjectionValue | undefined;
  readonly #listeners = new Set<ProjectionListener>();

  current(): RuntimeProjectionValue | undefined {
    return this.#projection;
  }

  replace(input: unknown): RuntimeProjectionValue {
    this.#projection = RuntimeProjection.parse(input);
    this.#publish();
    return this.#projection;
  }

  apply(input: unknown): EventApplication {
    const envelope: RuntimeEventEnvelopeValue = RuntimeEventEnvelope.parse(input);
    const current = this.#projection;
    if (current === undefined) return "gap";
    if (envelope.sequence <= current.lastSequence) return "duplicate";
    if (envelope.sequence !== current.lastSequence + 1) return "gap";

    const event = envelope.event;
    switch (event.type) {
      case "runtime.ready":
        this.#projection = { ...current, lastSequence: envelope.sequence };
        break;
      case "project.registered": {
        const projects = current.projects.filter(
          (project) => project.projectId !== event.project.projectId,
        );
        this.#projection = {
          ...current,
          projects: [...projects, event.project],
          lastSequence: envelope.sequence,
        };
        break;
      }
    }

    this.#publish();
    return "applied";
  }

  subscribe(listener: ProjectionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #publish(): void {
    if (this.#projection === undefined) return;
    for (const listener of this.#listeners) listener(this.#projection);
  }
}
