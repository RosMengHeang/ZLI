import { describe, expect, it } from "vitest";

import { centerOf, formatUiTree, parseBounds, parseUiAutomatorDump } from "./uiTree.js";

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]"><node index="0" text="Sign in" resource-id="com.example:id/title" class="android.widget.TextView" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[48,200][1032,280]" /><node index="1" text="" resource-id="com.example:id/email" class="android.widget.EditText" package="com.example" content-desc="Email" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[48,320][1032,440]" /><node index="2" text="" resource-id="" class="android.widget.LinearLayout" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[48,480][1032,600]"><node index="0" text="Remember me &amp; stay" resource-id="" class="android.widget.CheckBox" package="com.example" content-desc="" checkable="true" checked="true" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[48,480][540,600]" /></node><node index="3" text="CONTINUE" resource-id="com.example:id/go" class="android.widget.Button" package="com.example" content-desc="" checkable="false" checked="false" clickable="true" enabled="false" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[48,640][1032,760]" /><node index="4" text="" resource-id="" class="android.view.View" package="com.example" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][0,0]" /></node></hierarchy>`;

describe("uiautomator tree", () => {
  it("keeps elements worth acting on and gives them refs in document order", () => {
    const tree = parseUiAutomatorDump(DUMP);
    expect(tree.nodes.map((node) => [node.ref, node.role, node.text ?? node.label])).toEqual([
      ["e1", "text", "Sign in"],
      ["e2", "textfield", "Email"],
      ["e3", "checkbox", "Remember me & stay"],
      ["e4", "button", "CONTINUE"],
    ]);
    expect(tree.nodes[1]).toMatchObject({ id: "com.example:id/email", focused: true, clickable: true });
    expect(tree.nodes[2]).toMatchObject({ checked: true });
    expect(tree.nodes[3]).toMatchObject({ enabled: false });
    expect(centerOf(tree.nodes[3] as (typeof tree.nodes)[number])).toEqual({ x: 540, y: 700 });
  });

  it("formats one line per element, indented by depth", () => {
    expect(formatUiTree(parseUiAutomatorDump(DUMP))).toBe(
      [
        '[e1] text "Sign in" id=com.example:id/title @48,200 984x80',
        '[e2] textfield label="Email" id=com.example:id/email focused @48,320 984x120',
        '  [e3] checkbox "Remember me & stay" checked @48,480 492x120',
        '[e4] button "CONTINUE" id=com.example:id/go disabled @48,640 984x120',
      ].join("\n"),
    );
  });

  it("parses bounds", () => {
    expect(parseBounds("[10,20][110,220]")).toEqual({ x: 10, y: 20, width: 100, height: 200 });
    expect(parseBounds("nope")).toBeUndefined();
  });
});
