// @vitest-environment jsdom

import { CommandId, type ThreadCheckpoint } from "@zli-v2/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FileLinks } from "../files/FileIndex.js";
import { findFileReferences, indexBasenames, parseFileReference } from "../files/filePaths.js";
import type { ZliBridge } from "../runtime/bridge.js";
import { RuntimeProvider } from "../runtime/RuntimeProvider.js";
import { ChatImageScope } from "./ChatImage.js";
import { Markdown } from "./Markdown.js";
import { TurnChanges } from "./TurnChanges.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const worktreeId = "00000000-0000-4000-8000-000000000011";
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function links(): FileLinks {
  const files = new Set(["logo.png", "assets/chart.png", "src/app.ts"]);
  const basenames = indexBasenames(files);
  return {
    find: (text) => findFileReferences(text, "C:/repo", files, basenames),
    resolve: (text) => parseFileReference(text, "C:/repo", files, basenames),
    open: vi.fn(),
    touch: () => undefined,
  };
}

async function render(node: ReactNode) {
  const commands: Record<string, unknown>[] = [];
  const bridge = {
    runtime: {
      dispatch: async (request: { command: Record<string, unknown> }) => {
        commands.push(request.command);
        const path = String(request.command.path ?? "");
        return {
          commandId: CommandId.parse("00000000-0000-4000-8000-000000000099"),
          accepted: true as const,
          result:
            request.command.type === "files.readData"
              ? { path, size: 68, version: "v1", mimeType: "image/png", dataBase64: PIXEL }
              : { path, binary: false, patch: "@@ -1 +1 @@\n-a\n+b\n", truncated: false },
        };
      },
      getProjection: async () => undefined,
      onProjection: () => () => undefined,
    },
  } as unknown as ZliBridge;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <RuntimeProvider bridge={bridge}>
        <ChatImageScope value={worktreeId}>{node}</ChatImageScope>
      </RuntimeProvider>,
    );
  });
  await act(async () => undefined);
  return { container, commands };
}

describe("images in replies", () => {
  it("shows Markdown images and named image files, and leaves web images unloaded", async () => {
    const { container, commands } = await render(
      <Markdown
        text={
          "Here is the logo:\n\n![ZLI logo](logo.png)\n\nThe chart is in assets/chart.png. ![remote](https://example.com/a.png)"
        }
        links={links()}
        showImages
      />,
    );
    const images = [...container.querySelectorAll<HTMLImageElement>(".chat-image img")];
    expect(images.map((image) => image.alt)).toEqual(["ZLI logo", "chart.png"]);
    expect(images[0]?.src).toBe(`data:image/png;base64,${PIXEL}`);
    expect(commands.map((command) => command.path)).toEqual(["logo.png", "assets/chart.png"]);
    expect(container.querySelector(".md-link")?.textContent).toBe("remote");
  });

  it("opens an image full size and closes it with Escape", async () => {
    const { container } = await render(<Markdown text="![ZLI logo](logo.png)" links={links()} />);
    await act(async () => container.querySelector<HTMLButtonElement>(".chat-image")?.click());
    const viewer = document.querySelector<HTMLElement>('.image-lightbox[role="dialog"]');
    expect(viewer?.getAttribute("aria-label")).toBe("logo.png");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector(".image-lightbox")).toBeNull();
  });
});

describe("TurnChanges", () => {
  const checkpoint = {
    checkpointId: "00000000-0000-4000-8000-000000000777",
    worktreeId,
    turnId: "t1",
    files: [
      { path: "docs/NOTES.md", kind: "added", additions: 4, deletions: 0, binary: false },
      { path: "logo.png", kind: "added", additions: 0, deletions: 0, binary: true },
      { path: "src/app.ts", kind: "modified", additions: 1, deletions: 1, binary: false },
    ],
    fileCount: 3,
    additions: 5,
    deletions: 1,
  } as unknown as ThreadCheckpoint;

  it("opens Markdown in the Files panel, images full size, and other files as a diff", async () => {
    const onOpenFile = vi.fn();
    const { container, commands } = await render(
      <TurnChanges
        checkpoint={checkpoint}
        displayName="Codex"
        branch="main"
        restoreBlocked={undefined}
        onOpenFile={onOpenFile}
      />,
    );
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".turn-file")];
    await act(async () => rows[0]?.click());
    expect(onOpenFile).toHaveBeenCalledWith("docs/NOTES.md");
    expect(rows[0]?.hasAttribute("aria-expanded")).toBe(false);

    await act(async () => rows[1]?.click());
    await act(async () => undefined);
    expect(document.querySelector(".image-lightbox img")?.getAttribute("src")).toBe(`data:image/png;base64,${PIXEL}`);
    await act(async () => document.querySelector<HTMLButtonElement>(".image-lightbox-scrim")?.click());
    expect(document.querySelector(".image-lightbox")).toBeNull();

    await act(async () => rows[2]?.click());
    expect(commands.at(-1)).toMatchObject({ type: "checkpoint.diff", path: "src/app.ts" });
    expect(rows[2]?.getAttribute("aria-expanded")).toBe("true");
  });
});
