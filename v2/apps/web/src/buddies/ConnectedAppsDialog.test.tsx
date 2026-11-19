import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { KeyAdvice, SCOPED_KEY_PAGE } from "./ConnectedAppsDialog.js";

describe("KeyAdvice", () => {
  it("asks for a scoped project key with only the permissions ZLI uses", () => {
    const html = renderToStaticMarkup(createElement(KeyAdvice, { onOpen: () => undefined }));
    expect(html).toContain("make a scoped one with only Session management, Session tool execution and Connected");
    expect(html).toContain("Scoped keys");
  });

  it("links to Composio's own page on scoped keys", () => {
    const url = new URL(SCOPED_KEY_PAGE);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("docs.composio.dev");
  });
});
