import assert from "node:assert/strict";
import test from "node:test";

test("selecting the active project toggles its folder while another project opens", async () => {
  const presentation = await import("../src/lib/sidebarPresentation.ts").catch(() => ({}));
  assert.equal(typeof presentation.projectExpansionAfterSelection, "function");
  assert.equal(presentation.projectExpansionAfterSelection({ active: true, expanded: true }), false);
  assert.equal(presentation.projectExpansionAfterSelection({ active: true, expanded: false }), true);
  assert.equal(presentation.projectExpansionAfterSelection({ active: false, expanded: false }), true);
  assert.equal(presentation.projectExpansionAfterSelection({ active: false, expanded: true }), true);
});

test("project hover details contain only real workspace metadata", async () => {
  const presentation = await import("../src/lib/sidebarPresentation.ts").catch(() => ({}));
  assert.equal(typeof presentation.projectHoverDetails, "function");
  assert.deepEqual(
    presentation.projectHoverDetails({
      name: "Taxzy_CLI",
      agentCount: 2,
      branch: "main",
      path: "D:\\Taxzy_CLI",
    }),
    {
      name: "Taxzy_CLI",
      agentLabel: "2 agents",
      branch: "main",
      path: "D:\\Taxzy_CLI",
    },
  );
});
