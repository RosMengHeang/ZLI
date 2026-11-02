import { describe, expect, it, vi } from "vitest";

import { createTestDevHost } from "../testHost.js";
import { baseName, createDirectory, DIRECTORY_TIMEOUT_MS } from "./directory.js";
import { checkUrl, type DirectoryAnswer, directoryFetch, libraryUrl } from "./testDirectory.js";

const canned: Record<string, DirectoryAnswer> = {
  [checkUrl("react-native-reanimated", "react-native-vision-camera", "react-native-fs", "left-pad")]: {
    body: {
      "react-native-reanimated": { newArchitecture: "supported" },
      "react-native-vision-camera": { newArchitecture: "new-arch-only" },
      "react-native-fs": { newArchitecture: "untested", unmaintained: true },
    },
  },
  [libraryUrl("react-native-reanimated")]: {
    body: { expoGo: true, github: { configPlugin: false }, npm: { latestRelease: "4.2.1" } },
  },
  [libraryUrl("react-native-vision-camera")]: {
    body: { "react-native-vision-camera": { expoGo: false, github: { configPlugin: true } } },
  },
  [libraryUrl("react-native-fs")]: { body: { github: { isArchived: true } } },
};

describe("React Native Directory lookups", () => {
  it("reads New Architecture support, maintenance, Expo Go, and config plugins", async () => {
    const { fetch } = directoryFetch(canned);
    const directory = createDirectory(createTestDevHost({ fetch }));
    const result = await directory.lookup([
      "react-native-reanimated@4.2.1",
      "react-native-vision-camera",
      "react-native-fs",
      "left-pad",
    ]);
    expect(Object.fromEntries(result)).toEqual({
      "react-native-reanimated": {
        found: true,
        newArchitecture: "supported",
        expoGo: true,
        configPlugin: false,
        latest: "4.2.1",
      },
      "react-native-vision-camera": {
        found: true,
        newArchitecture: "new-arch-only",
        expoGo: false,
        configPlugin: true,
      },
      "react-native-fs": { found: true, newArchitecture: "untested", unmaintained: true, archived: true },
      "left-pad": { found: false },
    });
  });

  it("caches answers for an hour", async () => {
    const { fetch, urls } = directoryFetch(canned);
    const directory = createDirectory(createTestDevHost({ fetch }));
    const names = ["react-native-reanimated", "react-native-vision-camera", "react-native-fs", "left-pad"];
    await directory.lookup(names);
    const asked = urls.length;
    await directory.lookup(names);
    expect(urls).toHaveLength(asked);
  });

  it("asks for details of only the first five listed packages", async () => {
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    const { fetch, urls } = directoryFetch({
      [checkUrl(...names)]: { body: Object.fromEntries(names.map((name) => [name, { newArchitecture: true }])) },
    });
    const result = await createDirectory(createTestDevHost({ fetch })).lookup(names);
    expect(urls.filter((url) => url.includes("/library?"))).toHaveLength(5);
    expect(result.get("g")).toEqual({ found: true, newArchitecture: "supported" });
  });

  it("leaves every package unchecked when the directory answers 500, sends junk, or does not answer", async () => {
    const names = ["react-native-fs"];
    for (const answer of [{ status: 500, body: "oops" }, { body: "<html>not json</html>" }, { body: [1, 2] }]) {
      const { fetch } = directoryFetch({ [checkUrl(...names)]: answer });
      const result = await createDirectory(createTestDevHost({ fetch })).lookup(names);
      expect(result.get("react-native-fs")).toBeUndefined();
      expect(result.has("react-native-fs")).toBe(true);
    }
    vi.useFakeTimers();
    try {
      const { fetch } = directoryFetch({ [checkUrl(...names)]: "hang" });
      const pending = createDirectory(createTestDevHost({ fetch })).lookup(names);
      await vi.advanceTimersByTimeAsync(DIRECTORY_TIMEOUT_MS);
      expect((await pending).get("react-native-fs")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a listed package when its details cannot be read", async () => {
    const { fetch } = directoryFetch({
      [checkUrl("react-native-mmkv")]: { body: { "react-native-mmkv": { newArchitecture: "supported" } } },
    });
    const result = await createDirectory(createTestDevHost({ fetch })).lookup(["react-native-mmkv"]);
    expect(result.get("react-native-mmkv")).toEqual({ found: true, newArchitecture: "supported" });
  });

  it("strips versions from package names, scoped or not", () => {
    expect(baseName("@shopify/flash-list@2.0.0")).toBe("@shopify/flash-list");
    expect(baseName("@shopify/flash-list")).toBe("@shopify/flash-list");
    expect(baseName("react-native-mmkv@^3")).toBe("react-native-mmkv");
  });

  it("does not find a package the directory never listed, even one named constructor", async () => {
    const { fetch } = directoryFetch({ [checkUrl("constructor")]: { body: {} } });
    const result = await createDirectory(createTestDevHost({ fetch })).lookup(["constructor"]);
    expect(result.get("constructor")).toEqual({ found: false });
  });

  it("asks again for entries whose detail lookup did not happen", async () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const { fetch, urls } = directoryFetch({
      [checkUrl(...names)]: { body: Object.fromEntries(names.map((name) => [name, { newArchitecture: true }])) },
      [checkUrl("f")]: { body: { f: { newArchitecture: true } } },
      [libraryUrl("f")]: { body: { expoGo: false } },
    });
    const directory = createDirectory(createTestDevHost({ fetch }));
    const first = await directory.lookup(names);
    expect(first.get("f")).toEqual({ found: true, newArchitecture: "supported" });
    const asked = [...urls];
    expect(asked.filter((url) => url === libraryUrl("a"))).toHaveLength(1);

    const second = await directory.lookup(["f"]);
    expect(second.get("f")).toEqual({ found: true, newArchitecture: "supported", expoGo: false });
    expect(urls.slice(asked.length)).toEqual([checkUrl("f"), libraryUrl("f")]);

    const third = await directory.lookup(["f"]);
    expect(third.get("f")).toEqual(second.get("f"));
    expect(urls.slice(asked.length)).toEqual([checkUrl("f"), libraryUrl("f")]);
  });
});
