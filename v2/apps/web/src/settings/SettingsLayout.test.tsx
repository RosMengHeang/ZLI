// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsGroup, SettingsPageHeader, SettingsRow } from "./SettingsLayout.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container;
}

describe("Settings primitives", () => {
  it("titles a page with a line under it", () => {
    const container = render(<SettingsPageHeader title="General">What new agents start with.</SettingsPageHeader>);
    expect(container.querySelector("h3.settings-page-title")?.textContent).toBe("General");
    expect(container.querySelector(".settings-page-note")?.textContent).toBe("What new agents start with.");
  });

  it("puts a row's label and description on the left and its control on the right", () => {
    const container = render(
      <SettingsRow label="Tree position" description="Where the file tree sits." htmlFor="tree">
        <select id="tree" />
      </SettingsRow>,
    );
    const label = container.querySelector("label.setting-label");
    expect(label?.textContent).toBe("Tree position");
    expect(label?.getAttribute("for")).toBe("tree");
    expect(container.querySelector(".setting-copy .setting-description")?.textContent).toBe(
      "Where the file tree sits.",
    );
    expect(container.querySelector(".setting-control > select")).not.toBeNull();
  });

  it("names a group by its title and puts its rows on one surface", () => {
    const container = render(
      <SettingsGroup title="Chats" description="How chats behave." actions={<button type="button">Reset</button>}>
        <SettingsRow label="One">
          <input />
        </SettingsRow>
        <SettingsRow label="Two">
          <input />
        </SettingsRow>
      </SettingsGroup>,
    );
    const section = container.querySelector("section.settings-group");
    const title = container.querySelector(".settings-group-title");
    expect(section?.getAttribute("aria-labelledby")).toBe(title?.id);
    expect(title?.textContent).toBe("Chats");
    expect(container.querySelector(".settings-group-note")?.textContent).toBe("How chats behave.");
    expect(container.querySelector(".settings-group-actions button")?.textContent).toBe("Reset");
    expect(container.querySelectorAll(".setting-list > .setting-row")).toHaveLength(2);
  });

  it("leaves a bare group's list as given, and takes a fuller accessible name when asked", () => {
    const container = render(
      <SettingsGroup title="Codex" label="Codex accounts" bare>
        <ul className="mcp-rows">
          <li>Usual login</li>
        </ul>
      </SettingsGroup>,
    );
    const section = container.querySelector("section.settings-group");
    expect(section?.getAttribute("aria-label")).toBe("Codex accounts");
    expect(section?.hasAttribute("aria-labelledby")).toBe(false);
    expect(container.querySelector(".setting-list")).toBeNull();
    expect(container.querySelector(".settings-group-body > ul.mcp-rows")).not.toBeNull();
  });

  it("marks the group that removes things", () => {
    const container = render(
      <SettingsGroup title="Remove project" tone="danger">
        <SettingsRow label="Remove repo">
          <button type="button">Remove repo</button>
        </SettingsRow>
      </SettingsGroup>,
    );
    expect(container.querySelector("section.settings-group")?.classList.contains("is-danger")).toBe(true);
  });
});
