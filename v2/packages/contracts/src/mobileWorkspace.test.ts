import { describe, expect, it } from "vitest";

import {
  EMULATOR_BAND,
  emulatorPortFor,
  fnv1a32,
  METRO_BAND,
  MetroOwner,
  metroOpenUrl,
  metroPortFor,
  type PortWorktree,
} from "./mobileWorkspace.js";

const tree = (worktreeId: string, extra: Partial<PortWorktree> = {}): PortWorktree => ({
  worktreeId,
  status: "ready",
  kind: "worktree",
  ...extra,
});

/** Ids whose hash lands on the same slot of a band of this size. */
function sameSlot(size: number, count: number, start = 0): string[] {
  const bySlot = new Map<number, string[]>();
  for (let index = start; ; index += 1) {
    const id = `wt-${index}`;
    const slot = fnv1a32(id) % size;
    const ids = [...(bySlot.get(slot) ?? []), id];
    if (ids.length === count) return ids;
    bySlot.set(slot, ids);
  }
}

describe("metroPortFor", () => {
  it("keeps 8081 for the project's own checkout and gives worktrees a port in the band", () => {
    const worktrees = [tree("main", { kind: "checkout" }), tree("wt-a"), tree("wt-b")];
    expect(metroPortFor("main", worktrees)).toBe(8081);
    for (const id of ["wt-a", "wt-b"]) {
      const port = metroPortFor(id, worktrees);
      expect(port).toBeGreaterThanOrEqual(METRO_BAND.first);
      expect(port).toBeLessThan(METRO_BAND.first + METRO_BAND.size);
    }
    expect(metroPortFor("wt-a", worktrees)).not.toBe(metroPortFor("wt-b", worktrees));
  });

  it("keeps a worktree's port when a later worktree is added", () => {
    const before = [tree("wt-a"), tree("wt-b")];
    const ports = before.map((entry) => metroPortFor(entry.worktreeId, before));
    const after = [...before, ...sameSlot(METRO_BAND.size, 3).map((id) => tree(id))];
    expect(before.map((entry) => metroPortFor(entry.worktreeId, after))).toEqual(ports);
  });

  it("moves a later worktree past a port an earlier one holds", () => {
    const [first, second, third] = sameSlot(METRO_BAND.size, 3) as [string, string, string];
    const worktrees = [tree(first), tree(second), tree(third)];
    const base = METRO_BAND.first + (fnv1a32(first) % METRO_BAND.size);
    expect(metroPortFor(first, worktrees)).toBe(base);
    expect(metroPortFor(second, worktrees)).not.toBe(base);
    expect(new Set(worktrees.map((entry) => metroPortFor(entry.worktreeId, worktrees))).size).toBe(3);
  });

  it("wraps around past the end of the band", () => {
    const last = METRO_BAND.size - 1;
    const ids: string[] = [];
    for (let index = 0; ids.length < 2; index += 1)
      if (fnv1a32(`wt-${index}`) % METRO_BAND.size === last) ids.push(`wt-${index}`);
    const worktrees = ids.map((id) => tree(id));
    expect(metroPortFor(ids[0] as string, worktrees)).toBe(METRO_BAND.first + last);
    expect(metroPortFor(ids[1] as string, worktrees)).toBe(METRO_BAND.first);
  });

  it("ignores cancelled worktrees", () => {
    const [first, second] = sameSlot(METRO_BAND.size, 2) as [string, string];
    const port = metroPortFor(second, [tree(second)]);
    expect(metroPortFor(second, [tree(first, { status: "cancelled" }), tree(second)])).toBe(port);
  });

  it("falls back to the bare hash once every port in the band is given out", () => {
    const worktrees = Array.from({ length: METRO_BAND.size + 1 }, (_, index) => tree(`wt-${index}`));
    const ports = worktrees.slice(0, METRO_BAND.size).map((entry) => metroPortFor(entry.worktreeId, worktrees));
    expect(new Set(ports).size).toBe(METRO_BAND.size);
    const extra = `wt-${METRO_BAND.size}`;
    expect(metroPortFor(extra, worktrees)).toBe(METRO_BAND.first + (fnv1a32(extra) % METRO_BAND.size));
  });
});

describe("emulatorPortFor", () => {
  it("gives worktrees even console ports from 5556 and the checkout none", () => {
    const worktrees = [tree("main", { kind: "checkout" }), tree("wt-a")];
    expect(emulatorPortFor("main", worktrees)).toBeUndefined();
    const port = emulatorPortFor("wt-a", worktrees) as number;
    expect(port % 2).toBe(0);
    expect(port).toBeGreaterThanOrEqual(5556);
    expect(port).toBeLessThanOrEqual(5584);
  });

  it("answers undefined once the band is used up", () => {
    const worktrees = Array.from({ length: EMULATOR_BAND.size + 1 }, (_, index) => tree(`wt-${index}`));
    const ports = worktrees.map((entry) => emulatorPortFor(entry.worktreeId, worktrees));
    expect(new Set(ports.slice(0, EMULATOR_BAND.size)).size).toBe(EMULATOR_BAND.size);
    expect(ports.at(-1)).toBeUndefined();
    expect(emulatorPortFor("unknown", worktrees)).toBeUndefined();
  });
});

describe("metroOpenUrl and MetroOwner", () => {
  it("opens a development build through its scheme and Expo Go otherwise", () => {
    expect(metroOpenUrl(8142, { devClient: true, scheme: "myapp" })).toBe(
      "myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8142",
    );
    expect(metroOpenUrl(8142, { devClient: false, scheme: "myapp" })).toBe("exp://localhost:8142");
    expect(metroOpenUrl(8142, { devClient: true })).toBe("exp://localhost:8142");
  });

  it("parses each owner state", () => {
    expect(MetroOwner.parse({ state: "other-worktree", pid: 1, worktreeId: "wt", branch: "feat" }).state).toBe(
      "other-worktree",
    );
    expect(() => MetroOwner.parse({ state: "this-worktree" })).toThrow();
  });
});
