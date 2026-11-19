// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupRuntimeRenders, renderWithRuntime, typeInto } from "../review/testRuntime.js";
import { skippedFilesMessage } from "./attachedFiles.js";
import { Composer } from "./Composer.js";

afterEach(async () => {
  await cleanupRuntimeRenders();
});

async function renderComposer(onSubmit = vi.fn(async () => true)) {
  await renderWithRuntime(
    <Composer
      displayName="Droid"
      branch="main"
      disabled={false}
      models={undefined}
      model={undefined}
      modelLocked={false}
      onModelChange={() => undefined}
      permissionMode="full-access"
      projectId="00000000-0000-4000-8000-000000000010"
      onSubmit={onSubmit}
    />,
    () => ({ result: {} }),
  );
  const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
  return { onSubmit, textarea };
}

async function dropFiles(files: File[]) {
  const form = document.querySelector("form") as HTMLFormElement;
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files } });
  await act(async () => {
    form.dispatchEvent(event);
  });
}

describe("skippedFilesMessage", () => {
  it("names every skipped file, grouped by reason", () => {
    expect(skippedFilesMessage([])).toBeUndefined();
    expect(skippedFilesMessage([{ name: "a.exe", reason: "unsupported type" }])).toBe(
      "Skipped a.exe: unsupported type.",
    );
    expect(
      skippedFilesMessage([
        { name: "a.exe", reason: "unsupported type" },
        { name: "big.png", reason: "larger than 10 MB" },
        { name: "b.zip", reason: "unsupported type" },
      ]),
    ).toBe("Skipped a.exe and b.zip: unsupported type. Skipped big.png: larger than 10 MB.");
    const many = ["a", "b", "c", "d", "e"].map((name) => ({ name, reason: "unsupported type" }));
    expect(skippedFilesMessage(many)).toBe("Skipped a, b, c and 2 more: unsupported type.");
  });
});

describe("Composer", () => {
  it("keeps the good files from a mixed drop and names the skipped ones", async () => {
    await renderComposer();
    await dropFiles([
      new File(["x"], "a.exe", { type: "application/octet-stream" }),
      new File(["x"], "shot.png", { type: "image/png" }),
      new File(["x"], "b.zip", { type: "application/zip" }),
    ]);
    expect(document.body.textContent).toContain("Skipped a.exe and b.zip: unsupported type.");
    const attachments = document.querySelector('[aria-label="Attachments"]');
    expect(attachments?.querySelectorAll("li")).toHaveLength(1);
  });

  it("does not send on Enter while an input method is composing", async () => {
    const { onSubmit, textarea } = await renderComposer();
    await typeInto(textarea, "こんにちは");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    });
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
