// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupRuntimeRenders, renderWithRuntime } from "../review/testRuntime.js";
import { typingHeldCount } from "./huddles.js";
import { HuddleHeldPill, HuddleMenuButton, TileHuddleChip } from "./TileHuddle.js";
import {
  buttonNamed,
  click,
  coderId,
  helperId,
  huddle,
  huddleId,
  huddleProjection,
  otherHuddleId,
} from "./testHuddles.js";

afterEach(async () => {
  await cleanupRuntimeRenders();
});

const accept = () => ({ result: {} });
const items = () => [...document.querySelectorAll('[role="menu"] button')];

describe("Add to huddle", () => {
  it("lists live huddles, checked where the agent is a member, and joins or leaves", async () => {
    const projection = huddleProjection({
      huddles: [huddle(), huddle({ huddleId: otherHuddleId, name: "Docs", members: [] } as never)],
    });
    const commands = await renderWithRuntime(
      <HuddleMenuButton
        projection={projection}
        agentId={helperId}
        agentLabel="Helper"
        onOpen={vi.fn()}
        onError={vi.fn()}
      />,
      accept,
    );
    await click(buttonNamed("Add to huddle"));
    const [release, docs] = items();
    expect(release?.getAttribute("role")).toBe("menuitemcheckbox");
    expect(release?.getAttribute("aria-checked")).toBe("true");
    expect(docs?.getAttribute("aria-checked")).toBe("false");
    await click(docs);
    expect(commands).toContainEqual({ type: "huddle.join", huddleId: otherHuddleId, agentId: helperId });

    await click(buttonNamed("Add to huddle"));
    await click(items()[0]);
    expect(commands).toContainEqual({ type: "huddle.leave", huddleId, agentId: helperId });
  });

  it("starts a new huddle with the agent and opens it", async () => {
    const onOpen = vi.fn();
    const commands = await renderWithRuntime(
      <HuddleMenuButton
        projection={huddleProjection()}
        agentId={helperId}
        agentLabel="Helper"
        onOpen={onOpen}
        onError={vi.fn()}
      />,
      accept,
    );
    await click(buttonNamed("Add to huddle"));
    await click(items().find((item) => item.textContent === "New huddle with this agent"));
    const created = commands.find((command) => command.type === "huddle.create");
    expect(created).toMatchObject({ name: "Huddle with Helper", members: [helperId] });
    expect(onOpen).toHaveBeenCalledWith(created?.huddleId);
  });

  it("passes a refused join back to the tile", async () => {
    const onError = vi.fn();
    const projection = huddleProjection({ huddles: [huddle({ members: [] })] });
    await renderWithRuntime(
      <HuddleMenuButton
        projection={projection}
        agentId={helperId}
        agentLabel="Helper"
        onOpen={vi.fn()}
        onError={onError}
      />,
      () => ({ error: "Plain shells cannot join a huddle." }),
    );
    await click(buttonNamed("Add to huddle"));
    await click(items()[0]);
    expect(onError).toHaveBeenLastCalledWith("Plain shells cannot join a huddle.");
  });
});

describe("Tile huddle chip", () => {
  it("names the huddle, or counts several, and opens the first", async () => {
    const onOpen = vi.fn();
    await renderWithRuntime(<TileHuddleChip huddles={[huddle()]} onOpen={onOpen} />, accept);
    expect(document.querySelector(".tile-huddle")?.textContent).toBe("Release check");
    await click(document.querySelector(".tile-huddle"));
    expect(onOpen).toHaveBeenCalledWith(huddleId);
    await cleanupRuntimeRenders();
    await renderWithRuntime(
      <TileHuddleChip
        huddles={[huddle(), huddle({ huddleId: otherHuddleId, name: "Docs" } as never)]}
        onOpen={onOpen}
      />,
      accept,
    );
    expect(document.querySelector(".tile-huddle")?.textContent).toBe("2 huddles");
  });
});

describe("Held terminal messages", () => {
  it("counts messages held for typing and types them in on request", async () => {
    const count = typingHeldCount(huddleProjection(), coderId);
    expect(count).toBe(1);
    const commands = await renderWithRuntime(
      <HuddleHeldPill count={count} agentId={coderId} onError={vi.fn()} />,
      accept,
    );
    expect(document.body.textContent).toContain("1 huddle message is waiting for you to press Enter");
    await click(buttonNamed("Type now"));
    expect(commands).toContainEqual({ type: "huddle.release", agentId: coderId });
  });

  it("shows nothing when no message is held", async () => {
    await renderWithRuntime(<HuddleHeldPill count={0} agentId={coderId} onError={vi.fn()} />, accept);
    expect(document.querySelector(".huddle-held-pill")).toBeNull();
  });
});
