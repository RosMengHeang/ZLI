import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  StreamLanguage,
  type StreamParser,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorSelection, EditorState, type Extension, Text } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export type CodeEditorOptions = {
  parent: HTMLElement;
  doc: string;
  path: string;
  lineSeparator: "\n" | "\r\n";
  readOnly?: boolean;
  onChange?: (doc: string) => void;
  onSave?: () => void;
};

export type CodeEditorHandle = {
  readonly view: EditorView;
  /** Resolves once the language for the current path has been loaded and applied. */
  readonly ready: Promise<void>;
  getDoc(): string;
  setDoc(doc: string): void;
  setPath(path: string): Promise<void>;
  revealLine(line: number, column?: number): void;
  focus(): void;
  setReadOnly(readOnly: boolean): void;
  openSearch(): void;
  destroy(): void;
};

type LanguageEntry = { label: string; load: () => Promise<Extension> };

const legacy = async <T>(load: () => Promise<StreamParser<T>>) => StreamLanguage.define(await load());

const javascript = (config: { jsx?: boolean; typescript?: boolean }) => async () =>
  (await import("@codemirror/lang-javascript")).javascript(config);

const LANGUAGES = {
  typescript: { label: "TypeScript", load: javascript({ typescript: true }) },
  tsx: { label: "TypeScript JSX", load: javascript({ typescript: true, jsx: true }) },
  javascript: { label: "JavaScript", load: javascript({}) },
  jsx: { label: "JavaScript JSX", load: javascript({ jsx: true }) },
  json: { label: "JSON", load: async () => (await import("@codemirror/lang-json")).json() },
  css: { label: "CSS", load: async () => (await import("@codemirror/lang-css")).css() },
  scss: { label: "SCSS", load: async () => (await import("@codemirror/lang-css")).css() },
  less: { label: "Less", load: async () => (await import("@codemirror/lang-css")).css() },
  html: { label: "HTML", load: async () => (await import("@codemirror/lang-html")).html() },
  vue: { label: "Vue", load: async () => (await import("@codemirror/lang-html")).html() },
  svelte: { label: "Svelte", load: async () => (await import("@codemirror/lang-html")).html() },
  markdown: { label: "Markdown", load: async () => (await import("@codemirror/lang-markdown")).markdown() },
  python: { label: "Python", load: async () => (await import("@codemirror/lang-python")).python() },
  yaml: { label: "YAML", load: async () => (await import("@codemirror/lang-yaml")).yaml() },
  rust: { label: "Rust", load: async () => (await import("@codemirror/lang-rust")).rust() },
  sql: { label: "SQL", load: async () => (await import("@codemirror/lang-sql")).sql() },
  shell: {
    label: "Shell",
    load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell),
  },
  powershell: {
    label: "PowerShell",
    load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/powershell")).powerShell),
  },
  toml: { label: "TOML", load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml) },
  dockerfile: {
    label: "Dockerfile",
    load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile),
  },
  go: { label: "Go", load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/go")).go) },
  java: { label: "Java", load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).java) },
  kotlin: {
    label: "Kotlin",
    load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).kotlin),
  },
  c: { label: "C", load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).c) },
  cpp: { label: "C++", load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).cpp) },
  csharp: {
    label: "C#",
    load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).csharp),
  },
  ruby: { label: "Ruby", load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/ruby")).ruby) },
  lua: { label: "Lua", load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/lua")).lua) },
  swift: {
    label: "Swift",
    load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/swift")).swift),
  },
  xml: { label: "XML", load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/xml")).xml) },
  properties: {
    label: "Properties",
    load: () => legacy(async () => (await import("@codemirror/legacy-modes/mode/properties")).properties),
  },
} satisfies Record<string, LanguageEntry>;

type LanguageId = keyof typeof LANGUAGES;

const BY_EXTENSION: Record<string, LanguageId> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  json5: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "vue",
  svelte: "svelte",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  py: "python",
  pyw: "python",
  yml: "yaml",
  yaml: "yaml",
  rs: "rust",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  toml: "toml",
  dockerfile: "dockerfile",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  rb: "ruby",
  lua: "lua",
  swift: "swift",
  xml: "xml",
  svg: "xml",
  csproj: "xml",
  plist: "xml",
  ini: "properties",
  cfg: "properties",
  conf: "properties",
  env: "properties",
  properties: "properties",
  editorconfig: "properties",
};

const BY_FILENAME: Record<string, LanguageId> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".zshrc": "shell",
  ".profile": "shell",
  ".env": "properties",
  ".gitconfig": "properties",
  ".npmrc": "properties",
  gemfile: "ruby",
  rakefile: "ruby",
};

function languageId(path: string): LanguageId | null {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const byName = BY_FILENAME[name];
  if (byName) return byName;
  if (name.startsWith(".env.")) return "properties";
  if (name.startsWith("dockerfile.")) return "dockerfile";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

export function languageLabel(path: string): string {
  const id = languageId(path);
  return id ? LANGUAGES[id].label : "Plain text";
}

/** Loads the language extension for a path; resolves to an empty extension for plain text. */
export async function loadLanguage(path: string): Promise<Extension> {
  const id = languageId(path);
  return id ? LANGUAGES[id].load() : [];
}

const zliTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--zli-canvas)",
      color: "var(--zli-text)",
      fontSize: "12.5px",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--zli-mono)", lineHeight: "1.55" },
    ".cm-content": { padding: "6px 0", caretColor: "var(--zli-text)" },
    ".cm-line": { padding: "0 12px 0 6px" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--zli-text)", borderLeftWidth: "1.5px" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "oklch(.571 .21 264 / .28)" },
    ".cm-selectionBackground": { backgroundColor: "oklch(.571 .21 264 / .18)" },
    ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, .035)" },
    ".cm-selectionMatch": { backgroundColor: "rgba(255, 255, 255, .07)" },
    "&.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(255, 255, 255, .08)",
      outline: "1px solid rgba(255, 255, 255, .14)",
    },
    "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "var(--zli-red-soft)" },
    ".cm-gutters": {
      backgroundColor: "var(--zli-canvas)",
      color: "var(--zli-dim)",
      borderRight: "1px solid var(--zli-border)",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", minWidth: "36px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--zli-muted)" },
    ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", color: "var(--zli-dim)", cursor: "pointer" },
    ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--zli-text)" },
    ".cm-foldPlaceholder": {
      margin: "0 3px",
      padding: "0 5px",
      border: "1px solid var(--zli-border-strong)",
      borderRadius: "var(--zli-radius-xs)",
      backgroundColor: "var(--zli-raised)",
      color: "var(--zli-muted)",
    },
    ".cm-searchMatch": {
      backgroundColor: "var(--zli-amber-soft)",
      outline: "1px solid rgba(224, 176, 90, .35)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(224, 176, 90, .3)" },
    ".cm-panels": {
      backgroundColor: "var(--zli-raised)",
      color: "var(--zli-text)",
      fontFamily: "inherit",
    },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--zli-border-strong)" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--zli-border-strong)" },
    ".cm-panel.cm-search": {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: "6px",
      padding: "8px 34px 8px 10px",
      fontSize: "12px",
    },
    ".cm-panel.cm-search br": { flexBasis: "100%", height: 0, content: '""' },
    ".cm-panel.cm-search label": {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      color: "var(--zli-muted)",
      fontSize: "11.5px",
    },
    ".cm-panel.cm-search input[type=checkbox]": { margin: 0, accentColor: "var(--zli-accent)" },
    ".cm-textfield": {
      height: "26px",
      margin: 0,
      padding: "0 8px",
      border: "1px solid var(--zli-border-strong)",
      borderRadius: "var(--zli-radius-sm)",
      outline: "none",
      backgroundColor: "var(--zli-canvas)",
      color: "var(--zli-text)",
      fontSize: "12px",
    },
    ".cm-textfield:focus": {
      borderColor: "var(--zli-accent-line)",
      boxShadow: "0 0 0 3px var(--zli-accent-soft)",
    },
    ".cm-button": {
      height: "26px",
      margin: 0,
      padding: "0 9px",
      border: "1px solid var(--zli-border-strong)",
      borderRadius: "var(--zli-radius-sm)",
      backgroundImage: "none",
      backgroundColor: "var(--zli-surface)",
      color: "var(--zli-text)",
      fontSize: "12px",
      cursor: "pointer",
    },
    ".cm-button:hover": { backgroundColor: "var(--zli-overlay)", borderColor: "rgba(255, 255, 255, .18)" },
    ".cm-button:active": { backgroundImage: "none", backgroundColor: "var(--zli-active)" },
    ".cm-panel.cm-search [name=close]": {
      top: "6px",
      right: "8px",
      width: "22px",
      height: "22px",
      borderRadius: "var(--zli-radius-xs)",
      color: "var(--zli-muted)",
      fontSize: "16px",
      lineHeight: "20px",
      cursor: "pointer",
    },
    ".cm-panel.cm-search [name=close]:hover": { backgroundColor: "var(--zli-hover)", color: "var(--zli-text)" },
    ".cm-tooltip": {
      border: "1px solid var(--zli-border-strong)",
      borderRadius: "var(--zli-radius-md)",
      backgroundColor: "var(--zli-raised)",
      color: "var(--zli-text)",
      boxShadow: "var(--zli-shadow-pop)",
    },
    ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--zli-mono)", fontSize: "12px" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--zli-accent-soft)",
      color: "var(--zli-text)",
    },
  },
  { dark: true },
);

const zliHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: "#b3a6dc" },
  { tag: [t.definitionKeyword, t.self, t.null], color: "#b3a6dc" },
  { tag: [t.string, t.special(t.string), t.character], color: "#a3c49a" },
  { tag: [t.regexp, t.escape], color: "#d3a283" },
  { tag: [t.number, t.bool, t.atom, t.constant(t.name), t.unit], color: "#d8b67e" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "#6a6a6a" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "#8fb0e3" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "#80bfb8" },
  { tag: [t.tagName, t.angleBracket], color: "#80bfb8" },
  { tag: [t.attributeName, t.propertyName, t.labelName], color: "#a9bad6" },
  { tag: [t.definition(t.variableName), t.variableName], color: "#dcdcdc" },
  { tag: [t.operator, t.derefOperator], color: "#a3a3a3" },
  { tag: [t.punctuation, t.separator, t.bracket], color: "#8a8a8a" },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: "#8a8a8a" },
  { tag: t.heading, color: "#e6e6e6", fontWeight: "600" },
  { tag: [t.link, t.url], color: "#8fb0e3", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.inserted], color: "#a3c49a" },
  { tag: [t.deleted], color: "#de8f8f" },
  { tag: t.invalid, color: "#ec7272" },
]);

const external = Annotation.define<boolean>();

function readOnlyExtension(readOnly: boolean): Extension {
  return EditorState.readOnly.of(readOnly);
}

export function createCodeEditor(options: CodeEditorOptions): CodeEditorHandle {
  const language = new Compartment();
  const readOnlyConfig = new Compartment();
  let currentPath = options.path;
  let destroyed = false;

  const saveKeymap = keymap.of([
    {
      key: "Mod-s",
      preventDefault: true,
      run: () => {
        options.onSave?.();
        return true;
      },
    },
  ]);

  const state = EditorState.create({
    doc: options.doc,
    extensions: [
      EditorState.lineSeparator.of(options.lineSeparator),
      EditorState.tabSize.of(2),
      indentUnit.of("  "),
      EditorState.allowMultipleSelections.of(true),
      readOnlyConfig.of(readOnlyExtension(options.readOnly ?? false)),
      language.of([]),
      lineNumbers(),
      foldGutter(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ activateOnTyping: false }),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      syntaxHighlighting(zliHighlight, { fallback: true }),
      zliTheme,
      EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
      saveKeymap,
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || !options.onChange) return;
        if (update.transactions.every((tr) => !tr.docChanged || tr.annotation(external))) return;
        options.onChange(update.state.sliceDoc());
      }),
    ],
  });

  const view = new EditorView({ state, parent: options.parent });

  const applyLanguage = async (path: string) => {
    let extension: Extension = [];
    try {
      extension = await loadLanguage(path);
    } catch {
      // A failed chunk load leaves the file editable as plain text.
    }
    if (destroyed || path !== currentPath) return;
    view.dispatch({ effects: language.reconfigure(extension) });
  };

  const handle: CodeEditorHandle = {
    view,
    ready: applyLanguage(currentPath),
    getDoc: () => view.state.sliceDoc(),
    setDoc(text) {
      // Diff in CodeMirror's own coordinates, where every line break is one position whatever the separator.
      const lines = text.split(/\r\n?|\n/u);
      const doc = lines.join("\n");
      const current = view.state.doc.toString();
      if (doc === current) return;
      // Replacing only the differing middle keeps the cursor and scroll anchored for small external changes.
      let start = 0;
      const max = Math.min(doc.length, current.length);
      while (start < max && doc.charCodeAt(start) === current.charCodeAt(start)) start++;
      let endCurrent = current.length;
      let endDoc = doc.length;
      while (
        endCurrent > start &&
        endDoc > start &&
        doc.charCodeAt(endDoc - 1) === current.charCodeAt(endCurrent - 1)
      ) {
        endCurrent--;
        endDoc--;
      }
      view.dispatch({
        changes: { from: start, to: endCurrent, insert: Text.of(doc.slice(start, endDoc).split("\n")) },
        annotations: [external.of(true)],
      });
    },
    setPath(path) {
      currentPath = path;
      return applyLanguage(path);
    },
    revealLine(line, column = 1) {
      const doc = view.state.doc;
      const target = doc.line(Math.min(Math.max(1, Math.floor(line)), doc.lines));
      const pos = target.from + Math.min(Math.max(0, Math.floor(column) - 1), target.length);
      view.dispatch({
        selection: EditorSelection.cursor(pos),
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
      view.focus();
    },
    focus: () => view.focus(),
    setReadOnly(readOnly) {
      view.dispatch({ effects: readOnlyConfig.reconfigure(readOnlyExtension(readOnly)) });
    },
    openSearch() {
      openSearchPanel(view);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      view.destroy();
    },
  };
  return handle;
}
