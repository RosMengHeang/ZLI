import assert from "node:assert/strict";
import test from "node:test";

test("accepts web addresses and rejects executable schemes", async () => {
  const { normalizeBrowserInput } = await import("../src/lib/browserNavigation.ts");
  assert.equal(normalizeBrowserInput("github.com/openai"), "https://github.com/openai");
  assert.equal(normalizeBrowserInput("localhost:3000"), "http://localhost:3000/");
  for (const value of [" ", "javascript:alert(1)", "file:///C:/secret", "data:text/html,test", "https://"]) assert.equal(normalizeBrowserInput(value), null);
});
test("new navigation after Back removes forward entries", async () => {
  const { pushBrowserHistory } = await import("../src/lib/browserNavigation.ts");
  assert.deepEqual(pushBrowserHistory(["a", "b"], 0, "c"), { history: ["a", "c"], index: 1 });
});

test("Back and Reload issue fresh requests after an in-page navigation", async () => {
  const { nextBrowserRequest } = await import("../src/lib/browserNavigation.ts");
  let request = { url: "https://a.example/", sequence: 0 };
  const observedUrl = "https://b.example/";

  request = nextBrowserRequest("https://a.example/", request.sequence);
  assert.deepEqual(request, { url: "https://a.example/", sequence: 1 });

  request = nextBrowserRequest(observedUrl, request.sequence);
  assert.deepEqual(request, { url: observedUrl, sequence: 2 });
});
