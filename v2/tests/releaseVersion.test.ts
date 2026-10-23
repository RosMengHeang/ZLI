import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  isDocsPath,
  latestReleaseTag,
  nextVersion,
  parseReleaseTag,
  releaseDecision,
  writePackageVersions,
} from "../scripts/release-version.mjs";

describe("next release version", () => {
  test("starts at v0.1.0 when there is no tag", () => {
    expect(nextVersion([])).toBe("0.1.0");
    expect(nextVersion([], "minor")).toBe("0.1.0");
    expect(nextVersion([], "major")).toBe("1.0.0");
  });

  test("bumps the patch, minor, or major part of the latest tag", () => {
    const tags = ["v0.1.0", "v0.1.1", "v0.2.3"];
    expect(nextVersion(tags)).toBe("0.2.4");
    expect(nextVersion(tags, "patch")).toBe("0.2.4");
    expect(nextVersion(tags, "minor")).toBe("0.3.0");
    expect(nextVersion(tags, "major")).toBe("1.0.0");
  });

  test("picks the highest tag by number, not by text or list order", () => {
    expect(latestReleaseTag(["v0.10.0", "v0.9.9", "v0.2.0"])?.tag).toBe("v0.10.0");
    expect(nextVersion(["v1.0.9", "v1.0.10", "v1.0.2"])).toBe("1.0.11");
  });

  test("ignores tags that are not plain vX.Y.Z", () => {
    expect(parseReleaseTag("v1.2")).toBeUndefined();
    expect(parseReleaseTag("1.2.3")).toBeUndefined();
    expect(parseReleaseTag("v1.2.3-beta.1")).toBeUndefined();
    expect(parseReleaseTag("v01.2.3")).toBeUndefined();
    expect(nextVersion(["nightly", "v9.0.0-rc.1", "v2", "release-5", "v0.3.1"])).toBe("0.3.2");
    expect(nextVersion(["nightly", "v9.0.0-rc.1"])).toBe("0.1.0");
  });

  test("rejects an unknown bump", () => {
    expect(() => nextVersion(["v1.0.0"], "huge")).toThrow(/Unknown bump/u);
  });
});

describe("release skip rules", () => {
  test("treats Markdown files and docs folders as documentation", () => {
    expect(isDocsPath("README.md")).toBe(true);
    expect(isDocsPath("v2/README.md")).toBe(true);
    expect(isDocsPath("docs/release.png")).toBe(true);
    expect(isDocsPath("v2/docs/guide.txt")).toBe(true);
    expect(isDocsPath("v2/apps/desktop/src/main.ts")).toBe(false);
    expect(isDocsPath("documentation.ts")).toBe(false);
  });

  test("skips a push that only changes documentation", () => {
    expect(releaseDecision({ eventName: "push", changedFiles: ["README.md", "docs/a.png"] })).toMatchObject({
      skip: true,
    });
    expect(releaseDecision({ eventName: "push", changedFiles: ["README.md", "v2/package.json"] })).toMatchObject({
      skip: false,
    });
  });

  test("releases when there is no earlier release to compare with", () => {
    expect(releaseDecision({ eventName: "push", changedFiles: undefined }).skip).toBe(false);
    expect(releaseDecision({ eventName: "push", changedFiles: [] }).skip).toBe(false);
  });

  test("skips a push whose head commit says [skip release]", () => {
    expect(
      releaseDecision({
        eventName: "push",
        headMessage: "Merge pull request #30\n\nTidy the workflow [skip release]",
        changedFiles: ["v2/apps/desktop/src/main.ts"],
      }),
    ).toMatchObject({ skip: true });
  });

  test("skips a push whose commit is already released", () => {
    expect(
      releaseDecision({ eventName: "push", changedFiles: ["v2/apps/desktop/src/main.ts"], releasedAs: "v0.3.0" }),
    ).toMatchObject({ skip: true, reason: "this commit is already released as v0.3.0" });
  });

  test("never skips a manual run", () => {
    expect(
      releaseDecision({ eventName: "workflow_dispatch", headMessage: "[skip release]", changedFiles: ["README.md"] }),
    ).toMatchObject({ skip: false });
  });
});

test("writes the version into package.json files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zli-v2-release-"));
  const file = path.join(root, "package.json");
  await writeFile(file, `${JSON.stringify({ name: "zli-v2", version: "0.0.0", private: true }, null, 2)}\n`, "utf8");

  await writePackageVersions([file], "0.4.2");

  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ name: "zli-v2", version: "0.4.2", private: true });
  await expect(writePackageVersions([file], "next")).rejects.toThrow(/not a release version/u);
});
