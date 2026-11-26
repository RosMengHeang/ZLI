import { DurableObject } from "cloudflare:workers";

import { addFrames, type DailyCount, utcDay } from "./RelayRoom.js";

const KEY = "frames";

/*
 * One instance for the whole relay (see RoomObject's counter). Rooms report what they forwarded in batches and ask for
 * the total when a phone connects, so it sees a few calls per session rather than one per frame.
 */
export class RelayCounter extends DurableObject {
  /** Adds a room's batch and returns the day's total. */
  async add(frames: number): Promise<number> {
    const kv = this.ctx.storage.kv;
    const next = addFrames(readCount(kv.get(KEY)), utcDay(Date.now()), frames);
    kv.put(KEY, next);
    return next.count;
  }

  async total(): Promise<number> {
    const current = readCount(this.ctx.storage.kv.get(KEY));
    return current?.day === utcDay(Date.now()) ? current.count : 0;
  }
}

function readCount(value: unknown): DailyCount | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { day, count } = value as Record<string, unknown>;
  return typeof day === "string" && typeof count === "number" ? { day, count } : undefined;
}
