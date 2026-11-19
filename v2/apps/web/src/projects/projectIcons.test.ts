import { describe, expect, it } from "vitest";

import { pickProjectIcon } from "./projectIcons.js";

const files = (...paths: string[]) => paths.map((path) => ({ path, size: 1_200 }));

describe("pickProjectIcon", () => {
  it("finds a web app's favicon, preferring SVG", () => {
    expect(pickProjectIcon(files("src/main.ts", "public/favicon.ico", "public/favicon.svg"))).toBe(
      "public/favicon.svg",
    );
  });

  it("finds app icons in Next, Expo, Tauri and monorepo layouts", () => {
    expect(pickProjectIcon(files("src/app/icon.png", "README.md"))).toBe("src/app/icon.png");
    expect(pickProjectIcon(files("assets/images/icon.png", "app.json"))).toBe("assets/images/icon.png");
    expect(pickProjectIcon(files("src-tauri/icons/icon.png"))).toBe("src-tauri/icons/icon.png");
    expect(pickProjectIcon(files("apps/web/public/favicon.svg", "packages/ui/src/index.ts"))).toBe(
      "apps/web/public/favicon.svg",
    );
  });

  it("prefers a favicon over a logo and skips copies that are not the app's", () => {
    expect(pickProjectIcon(files("public/logo.svg", "public/favicon.png"))).toBe("public/favicon.png");
    expect(pickProjectIcon(files("node_modules/pkg/favicon.svg", "tests/fixtures/icon.png", "docs/logo.png"))).toBe(
      undefined,
    );
  });

  it("skips files too large or too deep to be the app's icon, and plain folders", () => {
    expect(pickProjectIcon([{ path: "public/favicon.png", size: 5_000_000 }])).toBe(undefined);
    expect(pickProjectIcon(files("src/components/ui/icons/logo.svg"))).toBe(undefined);
    expect(pickProjectIcon(files("notes.txt", "photo.png"))).toBe(undefined);
  });
});
