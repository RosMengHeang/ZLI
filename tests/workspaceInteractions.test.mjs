import assert from "node:assert/strict";
import test from "node:test";

import { visiblePaneTree } from "../src/stores/paneTree.ts";
import { filterCommandItems } from "../src/lib/commandPalette.ts";
import {
  changesShellLayout,
  utilityShellLayout,
  visibleUtilityPanes,
} from "../src/lib/chromePresentation.ts";

const tree = {
  type: "split",
  id: "root",
  direction: "horizontal",
  sizes: [50, 50],
  first: { type: "leaf", id: "claude-pane", terminalId: "claude-terminal" },
  second: { type: "leaf", id: "codex-pane", terminalId: "codex-terminal" },
};

test("focus mode exposes one existing pane without rebuilding its terminal node", () => {
  assert.equal(visiblePaneTree(tree, "codex-pane"), tree.second);
  assert.equal(visiblePaneTree(tree, null), tree);
  assert.equal(visiblePaneTree(tree, "missing-pane"), tree);
});

test("changes uses a restrained right-side inspector", () => {
  assert.deepEqual(changesShellLayout(), {
    side: "right",
    defaultSize: "400px",
    minSize: "340px",
    maxSize: "480px",
  });
});

test("open utility tools share one right-side stack", () => {
  assert.deepEqual(
    visibleUtilityPanes({ browserOpen: true, taxChatOpen: true, changesOpen: true }),
    ["browser", "taxchat", "changes"],
  );
  assert.deepEqual(utilityShellLayout(["browser", "taxchat"]), {
    side: "right",
    defaultSize: "40%",
    minSize: "360px",
    maxSize: "52%",
  });
  assert.deepEqual(utilityShellLayout(["changes"]), changesShellLayout());
});

test("command palette searches labels and keywords", () => {
  const items = [
    { id: "browser", label: "Open browser", keywords: ["preview", "web"] },
    { id: "agent", label: "Add agent", keywords: ["claude", "codex"] },
  ];
  assert.deepEqual(filterCommandItems(items, "preview").map((item) => item.id), ["browser"]);
  assert.deepEqual(filterCommandItems(items, "CODEX").map((item) => item.id), ["agent"]);
  assert.equal(filterCommandItems(items, "").length, 2);
});
