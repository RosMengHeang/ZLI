// @vitest-environment jsdom

import type { BuddyProjection } from "@zli-v2/contracts";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { typeInput } from "../huddle/testHuddles.js";
import { cleanupRuntimeRenders, renderWithRuntime } from "../review/testRuntime.js";
import { PersonalityField } from "./BuddyAutonomy.js";
import { useRun } from "./useRun.js";

afterEach(async () => {
  await cleanupRuntimeRenders();
});

const at = "2026-11-15T09:00:00.000Z";
const buddy = (extra: Partial<BuddyProjection> = {}): BuddyProjection => ({
  buddyId: "b1",
  name: "Builder",
  color: "jade",
  role: "buddy",
  order: 0,
  engine: { mode: "auto" },
  permissionMode: "full-access",
  maxActiveJobs: 2,
  handoffs: [],
  memory: [],
  pendingMemory: [],
  createdAt: at,
  updatedAt: at,
  ...extra,
});

function Field({ value }: { value: BuddyProjection }) {
  const run = useRun(() => undefined);
  return <PersonalityField buddy={value} run={run} />;
}

async function edit(selector: string, text: string) {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`No ${selector}`);
  await act(async () => input.focus());
  await typeInput(input, text);
  await act(async () => input.blur());
}

describe("PersonalityField", () => {
  it("saves a sample reply through the buddy update", async () => {
    const commands = await renderWithRuntime(<Field value={buddy()} />, () => ({ result: {} }));
    await edit("#sample-b1", "  Fixed. It was the cache.  ");
    expect(commands.at(-1)).toEqual({
      type: "buddy.update",
      buddyId: "b1",
      changes: { sampleReply: "Fixed. It was the cache." },
    });
  });

  it("edits a voice written in the person's own words", async () => {
    const commands = await renderWithRuntime(<Field value={buddy({ personality: "patient" })} />, () => ({
      result: {},
    }));
    await edit('[aria-label="Personality in your words"]', "patient and a bit nerdy");
    expect(commands.at(-1)).toEqual({
      type: "buddy.update",
      buddyId: "b1",
      changes: { personality: "patient and a bit nerdy" },
    });
  });
});
