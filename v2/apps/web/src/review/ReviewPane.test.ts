import { describe, expect, it } from "vitest";

import { patchBody } from "./ReviewPane.js";

describe("patchBody", () => {
  it("starts a patch at its first hunk", () => {
    const patch = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b";
    expect(patchBody(patch)).toEqual(["@@ -1 +1 @@", "-a", "+b"]);
  });

  it("keeps a patch without hunks whole, such as a mode change", () => {
    expect(patchBody("diff --git a/x b/x\nold mode 100644\nnew mode 100755")).toHaveLength(3);
  });
});
