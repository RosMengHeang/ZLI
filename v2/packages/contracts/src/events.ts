import { z } from "zod";

import { EventId, WorkspaceId } from "./ids.js";
import { ProjectProjection } from "./projections.js";

export const RuntimeEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runtime.ready") }),
  z.object({ type: z.literal("project.registered"), project: ProjectProjection }),
]);
export type RuntimeEvent = z.infer<typeof RuntimeEvent>;

export const RuntimeEventEnvelope = z.object({
  protocolVersion: z.literal(1),
  sequence: z.number().int().positive(),
  eventId: EventId,
  workspaceId: WorkspaceId.optional(),
  occurredAt: z.string().datetime({ offset: true }),
  event: RuntimeEvent,
});
export type RuntimeEventEnvelope = z.infer<typeof RuntimeEventEnvelope>;
