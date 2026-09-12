import assert from "node:assert/strict";
import test from "node:test";

test("inactive project nacks an open request instead of dropping it", async () => {
  const { resolveBrowserOpenRequest } = await import("../src/lib/browser/openRequest.ts");
  assert.deepEqual(
    resolveBrowserOpenRequest(
      { requestId: "open-1", projectId: "D:/other", url: "https://example.com/" },
      { path: "D:/active", repositoryRoot: "D:/active" },
    ),
    { kind: "inactive", requestId: "open-1" },
  );
  assert.deepEqual(
    resolveBrowserOpenRequest(
      { requestId: "open-2", projectId: "D:/active", url: "https://example.com/" },
      null,
    ),
    { kind: "inactive", requestId: "open-2" },
  );
});

test("active project accepts an open request by path or repository root", async () => {
  const { resolveBrowserOpenRequest } = await import("../src/lib/browser/openRequest.ts");
  const active = { path: "D:/work/app", repositoryRoot: "D:/repos/app" };
  assert.deepEqual(
    resolveBrowserOpenRequest(
      { requestId: "open-3", projectId: "D:/work/app", url: "https://example.com/a" },
      active,
    ),
    { kind: "open", requestId: "open-3", url: "https://example.com/a" },
  );
  assert.deepEqual(
    resolveBrowserOpenRequest(
      { requestId: "open-4", projectId: "D:/repos/app", url: "https://example.com/b" },
      active,
    ),
    { kind: "open", requestId: "open-4", url: "https://example.com/b" },
  );
});
