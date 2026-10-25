// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ConnectorLogo, hasConnectorLogo, logoFill } from "./connectorLogos.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

async function render(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(element);
  });
  return container;
}

describe("logoFill", () => {
  it("lets near-black and near-white brands follow the text color", () => {
    expect(logoFill("000000")).toBe("currentColor");
    expect(logoFill("#181717")).toBe("currentColor");
    expect(logoFill("FFFFFF")).toBe("currentColor");
    expect(logoFill("F5F5F5")).toBe("currentColor");
  });

  it("keeps ordinary brand colors", () => {
    expect(logoFill("635BFF")).toBe("#635BFF");
    expect(logoFill("#0052CC")).toBe("#0052CC");
    expect(logoFill("FC6D26")).toBe("#FC6D26");
  });

  it("falls back to the text color for malformed input", () => {
    expect(logoFill("nope")).toBe("currentColor");
  });
});

describe("hasConnectorLogo", () => {
  it("knows which connectors have a vendored mark", () => {
    expect(hasConnectorLogo("github")).toBe(true);
    expect(hasConnectorLogo("chrome-devtools")).toBe(true);
    expect(hasConnectorLogo("sequential-thinking")).toBe(true);
    expect(hasConnectorLogo("monday")).toBe(false);
    expect(hasConnectorLogo("context7")).toBe(false);
    expect(hasConnectorLogo("toString")).toBe(false);
  });
});

describe("ConnectorLogo", () => {
  it("draws the brand path for a known connector", async () => {
    const container = await render(<ConnectorLogo id="stripe" title="Stripe" size={40} />);
    const tile = container.querySelector<HTMLElement>(".connector-logo");
    expect(tile?.style.width).toBe("40px");
    const path = tile?.querySelector("svg path");
    expect(path?.getAttribute("d")).toMatch(/^M/);
    expect(path?.getAttribute("fill")).toBe("#635BFF");
  });

  it("uses currentColor for a black brand mark", async () => {
    const container = await render(<ConnectorLogo id="vercel" title="Vercel" />);
    expect(container.querySelector("svg path")?.getAttribute("fill")).toBe("currentColor");
  });

  it("shows the first letter when no logo exists", async () => {
    const container = await render(<ConnectorLogo id="monday" title="monday.com" />);
    const tile = container.querySelector<HTMLElement>(".connector-logo");
    expect(tile?.querySelector("svg")).toBeNull();
    expect(tile?.textContent).toBe("M");
    expect(tile?.style.background).not.toBe("");
  });
});
