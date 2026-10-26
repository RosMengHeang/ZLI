import type { OpenInApp } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { openInMenuItems, primaryApp } from "./OpenInButton.js";

const apps: OpenInApp[] = [
  { id: "files", name: "Finder", kind: "files" },
  { id: "terminal", name: "Terminal", kind: "terminal" },
  { id: "cursor", name: "Cursor", kind: "editor", icon: "data:image/png;base64,AAAA" },
  { id: "codex", name: "Codex", kind: "agent" },
];

describe("Open in", () => {
  it("opens the app picked last, else the first editor, else the first app", () => {
    expect(primaryApp(apps, "codex")?.id).toBe("codex");
    expect(primaryApp(apps, "gone")?.id).toBe("cursor");
    expect(primaryApp(apps, undefined)?.id).toBe("cursor");
    expect(primaryApp(apps.slice(0, 2), undefined)?.id).toBe("files");
    expect(primaryApp([], undefined)).toBeUndefined();
  });

  it("groups the menu by kind and uses the app's own icon when there is one", () => {
    const items = openInMenuItems(apps, () => undefined);
    expect(items.map((item) => ("separator" in item ? "-" : item.label))).toEqual([
      "Cursor",
      "-",
      "Codex",
      "-",
      "Terminal",
      "-",
      "Finder",
    ]);
    const cursor = items[0];
    expect(cursor && !("separator" in cursor) && cursor.image).toBe("data:image/png;base64,AAAA");
    const codex = items[2];
    expect(codex && !("separator" in codex) && codex.icon).toBe("bot");
  });
});
