import type { OpenInApp } from "@zli-v2/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppMark, openInMenuItems, primaryApp } from "./OpenInButton.js";
import { APP_LOGOS } from "./openInLogos.js";

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

  it("groups the menu by kind", () => {
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
  });

  it("shows the system icon first, then the bundled logo, then a generic icon", () => {
    const mark = (app: OpenInApp) => renderToStaticMarkup(createElement(AppMark, { app }));
    expect(mark({ id: "vscode", name: "VS Code", kind: "editor", icon: "data:image/png;base64,AAAA" })).toContain(
      'src="data:image/png;base64,AAAA"',
    );
    expect(mark({ id: "vscode", name: "VS Code", kind: "editor" })).toContain('src="data:image/svg+xml');
    // Near-black logos follow the text color so they stay visible on the dark theme.
    expect(mark({ id: "cursor", name: "Cursor", kind: "editor" })).toContain("app-mark is-mono");
    expect(mark({ id: "files", name: "Files", kind: "files" })).toContain("<svg");
  });

  it("bundles a logo for every editor and agent app ZLI looks for", () => {
    for (const id of [
      "vscode",
      "cursor",
      "windsurf",
      "zed",
      "sublime",
      "intellij",
      "webstorm",
      "pycharm",
      "xcode",
      "codex",
      "claude",
    ]) {
      expect(APP_LOGOS[id]?.svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="[\d. ]+">/u);
    }
  });
});
