// @vitest-environment jsdom

import { language } from "@codemirror/language";
import { runScopeHandlers } from "@codemirror/view";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { type CodeEditorHandle, createCodeEditor, languageLabel, loadLanguage } from "./codeEditor.js";

beforeAll(() => {
  // jsdom has no layout engine; CodeMirror measures ranges while scrolling and drawing selections.
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  const rects = Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects = () => rects;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
});

const editors: CodeEditorHandle[] = [];

function mount(options: Partial<Parameters<typeof createCodeEditor>[0]> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createCodeEditor({ parent, doc: "", path: "file.ts", lineSeparator: "\n", ...options });
  editors.push(editor);
  return { editor, parent };
}

function keydown(key: string, init: KeyboardEventInit = {}) {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

describe("createCodeEditor", () => {
  it("round-trips CRLF documents exactly", () => {
    const doc = "const a = 1;\r\nconst b = 2;\r\n\r\nexport { a, b };\r\n";
    const { editor } = mount({ doc, lineSeparator: "\r\n" });
    expect(editor.view.state.doc.lines).toBe(5);
    expect(editor.getDoc()).toBe(doc);

    editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: "// end" } });
    expect(editor.getDoc()).toBe(`${doc}// end`);
  });

  it("keeps LF documents with LF separators", () => {
    const doc = "a\nb\n";
    const { editor } = mount({ doc });
    editor.view.dispatch({ changes: { from: 1, insert: "x" } });
    expect(editor.getDoc()).toBe("ax\nb\n");
  });

  it("reports user edits but not setDoc replacements", () => {
    const onChange = vi.fn();
    const { editor } = mount({ doc: "hello", onChange });

    editor.setDoc("hello world");
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.getDoc()).toBe("hello world");

    editor.view.dispatch({ changes: { from: 0, insert: "> " }, userEvent: "input.type" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("> hello world");
  });

  it("applies setDoc to CRLF documents by line, whatever the incoming line endings", () => {
    const { editor } = mount({ doc: "# Title\r\nEdited\r\n", lineSeparator: "\r\n" });
    editor.setDoc("# Changed by an agent\n");
    expect(editor.getDoc()).toBe("# Changed by an agent\r\n");
    editor.setDoc("# Changed by an agent\r\nmore\r\n");
    expect(editor.getDoc()).toBe("# Changed by an agent\r\nmore\r\n");
    expect(editor.view.state.doc.lines).toBe(3);
  });

  it("keeps the cursor when setDoc changes text after it", () => {
    const { editor } = mount({ doc: "one\ntwo\nthree" });
    editor.view.dispatch({ selection: { anchor: 2 } });
    editor.setDoc("one\ntwo\nthree\nfour");
    expect(editor.view.state.selection.main.head).toBe(2);
  });

  it("calls onSave for Mod-s", () => {
    const onSave = vi.fn();
    const { editor } = mount({ onSave });
    // jsdom reports a non-Mac platform, so Mod resolves to Ctrl.
    expect(runScopeHandlers(editor.view, keydown("s", { ctrlKey: true }), "editor")).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("toggles read-only mode", () => {
    const { editor } = mount({ readOnly: true });
    expect(editor.view.state.readOnly).toBe(true);
    editor.setReadOnly(false);
    expect(editor.view.state.readOnly).toBe(false);
    editor.setReadOnly(true);
    expect(editor.view.state.readOnly).toBe(true);
  });

  it("reveals a 1-based line and column", () => {
    const { editor } = mount({ doc: "first\nsecond\nthird", lineSeparator: "\n" });
    editor.revealLine(2, 3);
    expect(editor.view.state.selection.main.head).toBe(8);
    editor.revealLine(99, 99);
    expect(editor.view.state.selection.main.head).toBe(editor.view.state.doc.length);
  });

  it("opens the search panel", () => {
    const { editor, parent } = mount({ doc: "needle" });
    editor.openSearch();
    expect(parent.querySelector(".cm-search")).not.toBeNull();
  });

  it("loads the language for its path", async () => {
    const { editor } = mount({ doc: "const x: number = 1;", path: "a.ts" });
    await editor.ready;
    expect(editor.view.state.facet(language)?.name).toBe("typescript");
    await editor.setPath("notes.txt");
    expect(editor.view.state.facet(language)).toBeNull();
  });

  it("removes its DOM on destroy", () => {
    const { editor, parent } = mount({ doc: "x" });
    expect(parent.querySelector(".cm-editor")).not.toBeNull();
    editor.destroy();
    expect(parent.querySelector(".cm-editor")).toBeNull();
    editor.destroy();
  });
});

describe("languageLabel", () => {
  it.each([
    ["src/App.tsx", "TypeScript JSX"],
    ["index.ts", "TypeScript"],
    ["lib/util.mjs", "JavaScript"],
    ["view.jsx", "JavaScript JSX"],
    ["tsconfig.json", "JSON"],
    ["styles.scss", "SCSS"],
    ["index.html", "HTML"],
    ["App.vue", "Vue"],
    ["README.md", "Markdown"],
    ["main.py", "Python"],
    ["ci.yml", "YAML"],
    ["lib.rs", "Rust"],
    ["query.sql", "SQL"],
    ["build.sh", "Shell"],
    ["C:\\repo\\setup.ps1", "PowerShell"],
    ["Cargo.toml", "TOML"],
    ["Dockerfile", "Dockerfile"],
    ["main.go", "Go"],
    ["Main.java", "Java"],
    ["App.kt", "Kotlin"],
    ["main.c", "C"],
    ["main.hpp", "C++"],
    ["Program.cs", "C#"],
    ["app.rb", "Ruby"],
    ["init.lua", "Lua"],
    ["View.swift", "Swift"],
    ["icon.svg", "XML"],
    ["settings.ini", "Properties"],
    [".env.local", "Properties"],
    ["LICENSE", "Plain text"],
    ["notes.txt", "Plain text"],
  ])("%s -> %s", (path, label) => {
    expect(languageLabel(path)).toBe(label);
  });

  it("loads every mapped language", async () => {
    const paths = ["a.ts", "a.json", "a.css", "a.html", "a.md", "a.py", "a.yml", "a.rs", "a.sql", "a.sh", "a.ps1"];
    paths.push("a.toml", "Dockerfile", "a.go", "a.java", "a.cpp", "a.rb", "a.lua", "a.swift", "a.xml", "a.ini");
    for (const path of paths) {
      await expect(loadLanguage(path)).resolves.toBeTruthy();
    }
  });
});
