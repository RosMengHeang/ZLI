/**
 * Page scripts for design mode. They run in the guest page through Runtime.evaluate, so they are
 * plain JavaScript source rather than functions that the bundler could rename or wrap.
 */

/** Defines `selectorFor(element)`, which returns a CSS selector that matches only that element. */
export const SELECTOR_FOR_SOURCE = `
      const unique = (selector) => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
      const quote = (value) => '"' + value.replace(/["\\\\]/g, '\\\\$&') + '"';
      const selectorFor = (element) => {
        if (element === document.documentElement) return 'html';
        if (element.id && unique('#' + CSS.escape(element.id))) return '#' + CSS.escape(element.id);
        const tag = element.localName;
        for (const attribute of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label', 'placeholder']) {
          const value = element.getAttribute(attribute);
          if (value && value.length <= 120) {
            const selector = tag + '[' + attribute + '=' + quote(value) + ']';
            if (unique(selector)) return selector;
          }
        }
        const parts = [];
        let node = element;
        while (node && node.nodeType === 1 && node !== document.documentElement) {
          if (node !== element && node.id && unique('#' + CSS.escape(node.id))) { parts.unshift('#' + CSS.escape(node.id)); break; }
          let part = node.localName;
          const parent = node.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((child) => child.localName === node.localName);
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
          }
          parts.unshift(part);
          node = parent;
        }
        return parts.join(' > ');
      };`;

export type DesignRect = { x: number; y: number; width: number; height: number };
export type DesignStrokeTool = "pen" | "rect" | "ellipse" | "arrow";
/** A mark drawn on a region, in page coordinates. Pen strokes list x,y pairs; shapes and arrows list two points. */
export type DesignStroke = { tool: DesignStrokeTool; points: number[] };
export type DesignCssEdit = { property: string; from: string; to: string };
/** Text and style changes previewed on the page, which the agent should make in the source. */
export type DesignEdits = { text?: { from: string; to: string } | undefined; css: DesignCssEdit[] };
/** What the page is waiting for: a pick, a note being written, or a region being drawn. */
export type DesignAnnotateMode = "select" | "note" | "draw";

/** Something the person did in the page while annotating. */
export type DesignPickResult =
  | { kind: "element"; id: string; selector: string }
  | {
      kind: "region";
      id: string;
      /** Page coordinates, so the region stays put when the page scrolls. */
      bounds: DesignRect;
      viewport: { width: number; height: number };
      strokes: DesignStroke[];
      instruction: string;
    }
  /** A saved note. `edits` is left out when the text and CSS editor was not opened, and null when it holds no changes. */
  | { kind: "note"; id: string; instruction: string; edits?: DesignEdits | null | undefined }
  | { kind: "remove"; id: string }
  | { kind: "mode"; mode: DesignAnnotateMode };

/** Live preview of a text or style change, applied while the annotate session runs. */
export type DesignPreview = { text?: string | undefined; styles?: Record<string, string> | undefined };

/** Numbered pins the app asks the page to draw for the annotations it holds. */
export type DesignMark =
  | {
      kind: "element";
      id: string;
      n: number;
      selector: string;
      note?: string | undefined;
      preview?: DesignPreview | undefined;
    }
  | { kind: "region"; id: string; n: number; bounds: DesignRect; strokes: DesignStroke[]; note?: string | undefined };

/** Style properties the note's editor can change, in the CSS spelling the message uses. */
export const DESIGN_EDITABLE_STYLES = ["background-color", "color", "padding", "font-size", "border-radius"] as const;

export const MAX_DESIGN_STROKES = 200;
export const MAX_DESIGN_STROKE_POINTS = 2_000;
export const MAX_DESIGN_INSTRUCTION_CHARS = 4_000;
const MAX_EDIT_TEXT_CHARS = 10_000;
const MAX_EDIT_VALUE_CHARS = 200;
const MAX_ID_CHARS = 100;
const STROKE_TOOLS: readonly string[] = ["pen", "rect", "ellipse", "arrow"];
const MODES: readonly string[] = ["select", "note", "draw"];

const SANS = "system-ui, -apple-system, Segoe UI, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const ANNOTATE_STYLE = [
  ".box { position: fixed; box-sizing: border-box; border: 2px solid #3b82f6; background: rgba(59, 130, 246, 0.12); border-radius: 3px; display: none; }",
  `.label { position: fixed; display: none; max-width: 420px; padding: 3px 7px; overflow: hidden; border-radius: 5px; background: #3b82f6; color: #fff; font: 500 11px/1.4 ${MONO}; white-space: nowrap; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(15, 23, 42, 0.2); }`,
  ".label span { color: #dbeafe; }",
  ".mark { position: fixed; box-sizing: border-box; border: 1.5px solid #3b82f6; border-radius: 3px; }",
  ".mark.is-active { border-width: 2px; background: rgba(59, 130, 246, 0.08); }",
  `.pin { position: fixed; box-sizing: border-box; display: grid; place-items: center; min-width: 22px; height: 22px; padding: 0 6px; border: 2px solid #fff; border-radius: 11px 11px 11px 3px; background: #3b82f6; color: #fff; font: 700 11px/1 ${SANS}; box-shadow: 0 2px 6px rgba(15, 23, 42, 0.3); pointer-events: auto; cursor: pointer; }`,
  ".pin:hover, .pin.is-active { background: #2563eb; }",
  "svg.sketch { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; overflow: visible; }",
  ".dim { fill: rgba(15, 23, 42, 0.16); fill-rule: evenodd; }",
  ".outline { fill: rgba(59, 130, 246, 0.05); stroke: #3b82f6; stroke-width: 1.5; stroke-dasharray: 6 4; }",
  ".draft .outline { fill: none; stroke-width: 2; stroke-dasharray: none; }",
  ".stroke { fill: none; stroke: #ef4444; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }",
  ".tools { position: fixed; display: none; align-items: center; gap: 2px; padding: 4px; border-radius: 10px; background: #fff; box-shadow: 0 6px 20px rgba(15, 23, 42, 0.16), 0 0 0 1px rgba(15, 23, 42, 0.08); pointer-events: auto; cursor: default; }",
  ".tools .sep { width: 1px; height: 18px; margin: 0 3px; background: #e2e8f0; }",
  "button { all: unset; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 7px; color: #64748b; cursor: pointer; }",
  "button:hover { background: #f1f5f9; color: #0f172a; }",
  "button[aria-pressed=true] { background: #eff6ff; color: #2563eb; }",
  "button:disabled { opacity: 0.35; cursor: default; background: none; }",
  "svg.icon { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }",
  `.note { position: fixed; display: none; box-sizing: border-box; width: 300px; padding: 8px; border-radius: 12px; background: #fff; color: #0f172a; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.18), 0 0 0 1px rgba(15, 23, 42, 0.08); font: 13px/1.45 ${SANS}; pointer-events: auto; cursor: default; }`,
  ".note-head, .note-foot { display: flex; align-items: center; gap: 2px; }",
  ".note-foot { min-height: 26px; }",
  ".grow { flex: 1; }",
  `.chip { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 220px; height: 22px; padding: 0 8px 0 3px; border-radius: 6px; background: #eff6ff; color: #2563eb; font: 500 12px/22px ${MONO}; white-space: nowrap; }`,
  `.chip b { display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 3px; box-sizing: border-box; border-radius: 8px; background: #3b82f6; color: #fff; font: 700 10px/1 ${SANS}; }`,
  ".chip span { overflow: hidden; text-overflow: ellipsis; }",
  ".chip i { color: #60a5fa; font-style: normal; }",
  `.note textarea { all: unset; display: block; box-sizing: border-box; width: 100%; min-height: 24px; max-height: 140px; margin: 6px 0 2px; padding: 2px; overflow-y: auto; color: #0f172a; font: 13px/1.45 ${SANS}; white-space: pre-wrap; overflow-wrap: anywhere; cursor: text; }`,
  ".note textarea::placeholder { color: #94a3b8; }",
  ".css { display: none; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 4px 8px; margin: 4px 0; padding: 8px; border-radius: 8px; background: #f8fafc; }",
  ".css.is-open { display: grid; }",
  `.css label { color: #64748b; font: 11px/1.2 ${MONO}; white-space: nowrap; }`,
  ".css label.is-changed { color: #2563eb; }",
  ".field { display: flex; align-items: center; gap: 6px; min-width: 0; height: 24px; padding: 0 6px; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; }",
  ".field:focus-within { border-color: #93c5fd; box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.18); }",
  `.field input { all: unset; min-width: 0; flex: 1; color: #0f172a; font: 11.5px/1.2 ${MONO}; cursor: text; }`,
  ".swatch { width: 12px; height: 12px; flex: 0 0 auto; border-radius: 3px; box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.15); }",
  ".edits { padding-left: 2px; color: #2563eb; font-size: 12px; }",
  "button.save { width: 26px; height: 26px; border-radius: 13px; background: #3b82f6; color: #fff; }",
  "button.save:hover { background: #2563eb; color: #fff; }",
  "button.save:disabled { opacity: 1; background: #e2e8f0; color: #94a3b8; }",
  ":host([data-capture]) .box, :host([data-capture]) .label, :host([data-capture]) .layer, :host([data-capture]) .tools, :host([data-capture]) .note, :host([data-capture]) .dim { display: none !important; }",
].join("\n");

const ICONS: Record<string, Array<[string, Record<string, string>]>> = {
  pen: [
    ["path", { d: "M12 20h9" }],
    ["path", { d: "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" }],
  ],
  ellipse: [["ellipse", { cx: "12", cy: "12", rx: "9", ry: "7" }]],
  rect: [["rect", { x: "4", y: "5", width: "16", height: "14", rx: "2" }]],
  arrow: [
    ["path", { d: "M5 19 19 5" }],
    ["path", { d: "M9 5h10v10" }],
  ],
  undo: [
    ["path", { d: "M9 14 4 9l5-5" }],
    ["path", { d: "M4 9h11a5 5 0 0 1 0 10h-3" }],
  ],
  redo: [
    ["path", { d: "m15 14 5-5-5-5" }],
    ["path", { d: "M20 9H9a5 5 0 0 0 0 10h3" }],
  ],
  clear: [
    ["path", { d: "m7 21-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21" }],
    ["path", { d: "M22 21H7M5 11l9 9" }],
  ],
  sliders: [["path", { d: "M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" }]],
  trash: [["path", { d: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }]],
  save: [["path", { d: "M12 19V5M5 12l7-7 7 7" }]],
};

const TOOL_BUTTONS: Array<[string, string] | "|"> = [
  ["pen", "Draw"],
  ["ellipse", "Ellipse"],
  ["rect", "Rectangle"],
  ["arrow", "Arrow"],
  "|",
  ["undo", "Undo"],
  ["redo", "Redo"],
  ["clear", "Clear drawing"],
];

/**
 * Starts an annotate session in the page, or joins the one already running, and resolves with the
 * next thing the person did: picked an element, saved a region or a note, removed one, or moved to
 * another step. Notes are written in a card next to the selection. The session stays on the page
 * between calls so its pins and sketches stay visible; it resolves null when Escape ends it or it
 * is cancelled. Clicks and drags never reach the page, and events that arrive between calls queue.
 */
export const DESIGN_PICKER_SCRIPT = `(() => {
  if (window.__zliAnnotate) return window.__zliAnnotate.next();
  ${SELECTOR_FOR_SOURCE}
  const svgNS = 'http://www.w3.org/2000/svg';
  const MIN_REGION = 8;
  const DRAG_START = 6;
  const MAX_STROKES = ${MAX_DESIGN_STROKES};
  const MAX_POINTS = ${MAX_DESIGN_STROKE_POINTS};
  const MAX_NOTE = ${MAX_DESIGN_INSTRUCTION_CHARS};
  const EDITABLE = ${JSON.stringify(DESIGN_EDITABLE_STYLES)};
  const ICONS = ${JSON.stringify(ICONS)};
  const TOOL_BUTTONS = ${JSON.stringify(TOOL_BUTTONS)};
  const make = (tag, className) => { const node = document.createElement(tag); if (className) node.className = className; return node; };
  const svg = (tag, attributes) => { const node = document.createElementNS(svgNS, tag); for (const key in attributes) node.setAttribute(key, String(attributes[key])); return node; };
  const icon = (name) => { const node = svg('svg', { class: 'icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' }); for (const [tag, attributes] of ICONS[name]) node.append(svg(tag, attributes)); return node; };
  const iconButton = (name, title, className) => {
    const node = make('button', className);
    node.type = 'button';
    node.title = title;
    node.setAttribute('aria-label', title);
    node.dataset.action = name;
    node.append(icon(name));
    return node;
  };
  const host = document.createElement('zli-design-picker');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = make('style');
  style.textContent = ${JSON.stringify(ANNOTATE_STYLE)};
  const sketch = svg('svg', { class: 'sketch' });
  const dim = svg('path', { class: 'dim' });
  const world = svg('g', {});
  sketch.append(dim, world);
  const layer = make('div', 'layer');
  const box = make('div', 'box');
  const label = make('div', 'label');
  const tools = make('div', 'tools');
  tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', 'Drawing tools');
  const toolButtons = {};
  for (const entry of TOOL_BUTTONS) {
    if (entry === '|') { tools.append(make('span', 'sep')); continue; }
    const button = iconButton(entry[0], entry[1]);
    toolButtons[entry[0]] = button;
    tools.append(button);
  }
  const card = make('div', 'note');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Annotation note');
  const head = make('div', 'note-head');
  const chip = make('span', 'chip');
  const cssButton = iconButton('sliders', 'Edit text and CSS');
  const removeButton = iconButton('trash', 'Remove');
  head.append(chip, make('span', 'grow'), cssButton, removeButton);
  const input = make('textarea');
  input.rows = 1;
  input.maxLength = MAX_NOTE;
  input.placeholder = 'Describe the change';
  input.setAttribute('aria-label', 'Describe the change');
  const css = make('div', 'css');
  const foot = make('div', 'note-foot');
  const editsLabel = make('span', 'edits');
  const saveButton = iconButton('save', 'Save note', 'save');
  foot.append(editsLabel, make('span', 'grow'), saveButton);
  card.append(head, input, css, foot);
  shadow.append(style, sketch, layer, box, label, tools, card);
  const cursor = document.createElement('style');
  cursor.textContent = '* { cursor: crosshair !important; touch-action: none !important; }';
  (document.head || document.documentElement).append(cursor);
  document.documentElement.append(host);

  const queue = [];
  let waiter = null;
  let marks = Array.isArray(window.__zliAnnotateMarks) ? window.__zliAnnotateMarks : [];
  delete window.__zliAnnotateMarks;
  let committed = null;
  let draft = null;
  let note = null;
  let mode = 'select';
  let tool = 'pen';
  let lastEdit = 'text';
  let press = null;
  let hovered = null;
  let pointed = null;
  const lineage = [];
  let capturing = null;
  let refocus = null;
  let frame = 0;
  const previews = new Map();
  /** Previews saved in a note that the app has not sent back in its marks yet. */
  const held = new Map();
  const pins = new Map();
  const emit = (event) => {
    if (waiter) { const resolve = waiter; waiter = null; resolve(event); } else queue.push(event);
  };
  const setMode = () => {
    const next = draft ? 'draw' : note ? 'note' : 'select';
    if (next !== mode) { mode = next; emit({ kind: 'mode', mode }); }
  };
  const newId = (prefix) => prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const offsetX = () => (window.visualViewport ? visualViewport.pageLeft : scrollX);
  const offsetY = () => (window.visualViewport ? visualViewport.pageTop : scrollY);
  const find = (selector) => { try { return document.querySelector(selector); } catch { return null; } };
  const markFor = (id) => marks.find((mark) => mark.id === id);
  const describe = (element) => {
    let name = element.localName;
    if (element.id) name += '#' + element.id;
    else if (typeof element.className === 'string' && element.className.trim()) name += '.' + element.className.trim().split(/\\s+/).slice(0, 2).join('.');
    return name;
  };
  const place = (node, left, top, width, height) => {
    node.style.left = left + 'px';
    node.style.top = top + 'px';
    if (width !== undefined) { node.style.width = width + 'px'; node.style.height = height + 'px'; }
  };
  const showHover = (element) => {
    const rect = element.getBoundingClientRect();
    box.style.display = 'block';
    place(box, rect.left, rect.top, rect.width, rect.height);
    label.replaceChildren(describe(element) + ' ');
    const size = make('span');
    size.textContent = Math.round(rect.width) + ' × ' + Math.round(rect.height);
    label.append(size);
    label.style.display = 'block';
    const above = rect.top - 24;
    place(label, Math.max(0, Math.min(rect.left, innerWidth - 200)), above >= 0 ? above : Math.min(rect.bottom + 4, innerHeight - 22));
  };
  const hideHover = () => { hovered = null; pointed = null; lineage.length = 0; box.style.display = 'none'; label.style.display = 'none'; };

  const textOnly = (element) => element.childNodes.length > 0 && Array.from(element.childNodes).every((node) => node.nodeType === 3);
  const restore = (element, saved) => {
    if (saved.style === null) element.removeAttribute('style'); else element.setAttribute('style', saved.style);
    if (saved.texts) saved.texts.forEach((value, index) => { if (element.childNodes[index]) element.childNodes[index].data = value; });
  };
  const apply = (element, change) => {
    let saved = previews.get(element);
    if (!saved && !change) return;
    if (!saved) {
      saved = { style: element.getAttribute('style'), texts: textOnly(element) ? Array.from(element.childNodes, (node) => node.data) : null, change: null };
      previews.set(element, saved);
    }
    restore(element, saved);
    if (!change) { previews.delete(element); return; }
    saved.change = change;
    if (typeof change.text === 'string' && saved.texts) {
      element.childNodes[0].data = change.text;
      for (let index = 1; index < element.childNodes.length; index += 1) element.childNodes[index].data = '';
    }
    const styles = change.styles && typeof change.styles === 'object' ? change.styles : {};
    for (const key of EDITABLE) if (typeof styles[key] === 'string' && styles[key].trim()) element.style.setProperty(key, styles[key].trim(), 'important');
  };
  /** The element's text and styles as the page has them, without any preview. */
  const originals = (element) => {
    const saved = previews.get(element);
    if (saved) restore(element, saved);
    const computed = getComputedStyle(element);
    const styles = {};
    for (const key of EDITABLE) styles[key] = computed.getPropertyValue(key).trim();
    const text = textOnly(element) ? element.textContent : null;
    if (saved && saved.change) apply(element, saved.change);
    return { text, styles };
  };
  const syncPreviews = () => {
    const wanted = new Map();
    for (const mark of marks) {
      if (mark.kind !== 'element' || !mark.preview) continue;
      const element = find(mark.selector);
      if (element) wanted.set(element, mark.preview);
    }
    for (const entry of held.values()) { if (entry.change) wanted.set(entry.element, entry.change); else wanted.delete(entry.element); }
    const editing = note && note.base ? note.element : null;
    for (const element of Array.from(previews.keys())) if (!wanted.has(element) && element !== editing) apply(element, null);
    for (const [element, change] of wanted) {
      if (element === editing) continue;
      const saved = previews.get(element);
      if (!saved || JSON.stringify(saved.change) !== JSON.stringify(change)) apply(element, change);
    }
  };

  const diff = () => {
    if (!note || !note.base) return null;
    const changes = [];
    for (const key of EDITABLE) {
      const to = (note.fields.styles[key] || '').trim();
      const from = note.base.styles[key] || '';
      if (to && to !== from) changes.push({ property: key, from, to });
    }
    const text = note.base.text !== null && note.fields.text !== note.base.text ? { from: note.base.text, to: note.fields.text } : null;
    if (!changes.length && !text) return null;
    return text ? { css: changes, text } : { css: changes };
  };
  const previewOf = (edits) => (edits ? { ...(edits.text ? { text: edits.text.to } : {}), styles: Object.fromEntries(edits.css.map((edit) => [edit.property, edit.to])) } : null);
  const editCount = () => {
    if (!note) return 0;
    if (note.base) { const edits = diff(); return edits ? edits.css.length + (edits.text ? 1 : 0) : 0; }
    const preview = note.preview;
    return preview ? (typeof preview.text === 'string' ? 1 : 0) + Object.keys(preview.styles || {}).length : 0;
  };
  const hasContent = () => !!note && (input.value.trim() !== '' || editCount() > 0 || (note.isNew && note.kind === 'region' && note.region.strokes.length > 0));

  const drawStroke = (stroke) => {
    const p = stroke.points;
    if (stroke.tool === 'pen') {
      let d = 'M' + p[0] + ' ' + p[1];
      for (let index = 2; index + 1 < p.length; index += 2) d += 'L' + p[index] + ' ' + p[index + 1];
      if (p.length === 2) d += 'l0.01 0';
      return svg('path', { class: 'stroke', d });
    }
    if (stroke.tool === 'arrow') {
      const angle = Math.atan2(p[3] - p[1], p[2] - p[0]);
      const size = Math.min(16, Math.hypot(p[2] - p[0], p[3] - p[1]) * 0.5 + 4);
      const wing = (turn) => (p[2] - size * Math.cos(angle + turn)) + ' ' + (p[3] - size * Math.sin(angle + turn));
      return svg('path', { class: 'stroke', d: 'M' + p[0] + ' ' + p[1] + 'L' + p[2] + ' ' + p[3] + 'M' + wing(-0.5) + 'L' + p[2] + ' ' + p[3] + 'L' + wing(0.5) });
    }
    const left = Math.min(p[0], p[2]);
    const top = Math.min(p[1], p[3]);
    const width = Math.abs(p[2] - p[0]);
    const height = Math.abs(p[3] - p[1]);
    if (stroke.tool === 'rect') return svg('rect', { class: 'stroke', x: left, y: top, width, height, rx: 2 });
    return svg('ellipse', { class: 'stroke', cx: left + width / 2, cy: top + height / 2, rx: width / 2, ry: height / 2 });
  };
  const drawRegion = (region, className, outline) => {
    const group = svg('g', { class: className });
    if (outline) group.append(svg('rect', { class: 'outline', x: region.bounds.x, y: region.bounds.y, width: region.bounds.width, height: region.bounds.height, rx: 3 }));
    for (const stroke of region.strokes) group.append(drawStroke(stroke));
    if (press && press.stroke && region === draft) group.append(drawStroke(press.stroke));
    return group;
  };
  const pinFor = (mark, right, top) => {
    let node = pins.get(mark.id);
    if (!node) {
      node = make('div', 'pin');
      node.dataset.id = mark.id;
      node.setAttribute('role', 'button');
      pins.set(mark.id, node);
    }
    node.textContent = String(mark.n);
    node.setAttribute('aria-label', 'Annotation ' + mark.n);
    node.title = mark.note || 'Add a note';
    node.classList.toggle('is-active', !!note && note.id === mark.id);
    place(node, Math.max(2, Math.min(right - 11, innerWidth - 26)), Math.max(2, Math.min(top - 11, innerHeight - 26)));
    return node;
  };
  const outlineFor = (rect, active) => {
    const node = make('div', active ? 'mark is-active' : 'mark');
    place(node, rect.left, rect.top, rect.width, rect.height);
    return node;
  };
  const anchorRect = () => {
    if (note.kind === 'element') return note.element.getBoundingClientRect();
    const bounds = note.region.bounds;
    const left = bounds.x - offsetX();
    const top = bounds.y - offsetY();
    return { left, top, right: left + bounds.width, bottom: top + bounds.height, width: bounds.width, height: bounds.height };
  };
  const placeTools = () => {
    if (!draft) { tools.style.display = 'none'; return; }
    tools.style.display = 'flex';
    toolButtons.undo.disabled = draft.strokes.length === 0;
    toolButtons.redo.disabled = draft.redo.length === 0;
    toolButtons.clear.disabled = draft.strokes.length === 0;
    for (const name of ['pen', 'ellipse', 'rect', 'arrow']) toolButtons[name].setAttribute('aria-pressed', String(tool === name));
    const width = tools.offsetWidth || 260;
    const height = tools.offsetHeight || 34;
    const left = draft.bounds.x - offsetX() + (draft.bounds.width - width) / 2;
    const bottom = draft.bounds.y + draft.bounds.height - offsetY();
    const top = bottom + 8 + height <= innerHeight ? bottom + 8 : Math.max(4, draft.bounds.y - offsetY() - height - 8);
    place(tools, Math.max(4, Math.min(left, innerWidth - width - 4)), Math.max(4, Math.min(top, innerHeight - height - 4)));
  };
  const placeNote = () => {
    if (!note) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    const width = Math.min(300, innerWidth - 8);
    card.style.width = width + 'px';
    const height = card.offsetHeight || 96;
    const rect = anchorRect();
    let left = rect.left;
    let top;
    if (note.kind === 'region') {
      if (rect.right + 10 + width <= innerWidth - 4) { left = rect.right + 10; top = rect.top; }
      else if (rect.left - 10 - width >= 4) { left = rect.left - 10 - width; top = rect.top; }
      else top = rect.bottom + (draft ? 52 : 10);
    } else if (rect.bottom + 8 + height <= innerHeight - 4) top = rect.bottom + 8;
    else if (rect.top - 8 - height >= 4) top = rect.top - 8 - height;
    else { left = rect.left + 8; top = rect.top + 8; }
    place(card, Math.max(4, Math.min(left, innerWidth - width - 4)), Math.max(4, Math.min(top, innerHeight - height - 4)));
  };
  const render = () => {
    frame = 0;
    world.setAttribute('transform', 'translate(' + -offsetX() + ' ' + -offsetY() + ')');
    if (capturing) {
      world.replaceChildren(drawRegion(capturing, 'region', false));
      return;
    }
    const groups = [];
    const outlines = [];
    const shown = [];
    for (const mark of marks) {
      if (mark.kind === 'region') {
        if (draft && draft.id === mark.id) continue;
        groups.push(drawRegion(mark, 'region', true));
        shown.push(pinFor(mark, mark.bounds.x + mark.bounds.width - offsetX(), mark.bounds.y - offsetY()));
        continue;
      }
      const element = find(mark.selector);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      outlines.push(outlineFor(rect, !!note && note.element === element));
      shown.push(pinFor(mark, rect.right, rect.top));
    }
    if (note && note.kind === 'element' && !markFor(note.id)) outlines.push(outlineFor(note.element.getBoundingClientRect(), true));
    if (committed && !markFor(committed.id)) groups.push(drawRegion(committed, 'region', true));
    if (draft) groups.push(drawRegion(draft, 'region draft', true));
    if (press && press.mode === 'region' && press.region) groups.push(drawRegion(press.region, 'region draft', true));
    const dimmed = draft || (press && press.mode === 'region' && press.region);
    if (dimmed) {
      const bounds = dimmed.bounds;
      const x = bounds.x - offsetX();
      const y = bounds.y - offsetY();
      dim.setAttribute('d', 'M0 0H' + innerWidth + 'V' + innerHeight + 'H0Z M' + x + ' ' + y + 'h' + bounds.width + 'v' + bounds.height + 'h' + -bounds.width + 'Z');
      dim.style.display = '';
    } else dim.style.display = 'none';
    for (const [id, node] of pins) if (!shown.includes(node)) pins.delete(id);
    world.replaceChildren(...groups);
    layer.replaceChildren(...outlines, ...shown);
    if (hovered && !draft && !press && !note) showHover(hovered);
    placeTools();
    placeNote();
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };

  const chipFor = () => {
    const number = make('b');
    number.textContent = String(note.n);
    const name = make('span');
    const size = make('i');
    if (note.kind === 'element') {
      name.textContent = describe(note.element);
      const rect = note.element.getBoundingClientRect();
      size.textContent = Math.round(rect.width) + ' × ' + Math.round(rect.height);
    } else {
      name.textContent = 'Region';
      size.textContent = Math.round(note.region.bounds.width) + ' × ' + Math.round(note.region.bounds.height);
    }
    chip.replaceChildren(number, name, size);
  };
  const updateNote = () => {
    if (!note) return;
    input.style.height = 'auto';
    input.style.height = Math.min(140, input.scrollHeight) + 'px';
    const count = editCount();
    editsLabel.textContent = count ? count + (count === 1 ? ' edit' : ' edits') : '';
    saveButton.disabled = !hasContent();
  };
  const openCss = () => {
    if (!note || note.kind !== 'element') return;
    if (!note.base) {
      note.base = originals(note.element);
      const preview = note.preview || {};
      note.fields = { text: typeof preview.text === 'string' ? preview.text : note.base.text, styles: { ...note.base.styles, ...(preview.styles || {}) } };
    }
    const rows = note.base.text === null ? [] : [['text', 'Text']];
    for (const key of EDITABLE) rows.push([key, key]);
    const nodes = [];
    for (const [key, name] of rows) {
      const caption = make('label');
      caption.textContent = name;
      const field = make('div', 'field');
      const value = make('input');
      value.spellcheck = false;
      value.setAttribute('aria-label', name);
      value.value = key === 'text' ? note.fields.text : note.fields.styles[key] || '';
      const from = key === 'text' ? note.base.text : note.base.styles[key] || '';
      const swatch = key.endsWith('color') ? make('span', 'swatch') : null;
      if (swatch) field.append(swatch);
      field.append(value);
      const refresh = () => {
        const current = key === 'text' ? value.value : value.value.trim();
        const changed = key === 'text' ? current !== from : current !== '' && current !== from;
        caption.classList.toggle('is-changed', changed);
        caption.title = changed ? 'was ' + (from || 'unset') : '';
        if (swatch) swatch.style.background = current || from;
      };
      value.addEventListener('input', () => {
        if (!note || !note.base) return;
        if (key === 'text') note.fields.text = value.value; else note.fields.styles[key] = value.value;
        apply(note.element, previewOf(diff()));
        refresh();
        updateNote();
        schedule();
      });
      refresh();
      nodes.push(caption, field);
    }
    css.replaceChildren(...nodes);
    css.classList.add('is-open');
    cssButton.setAttribute('aria-pressed', 'true');
    schedule();
  };
  const closeCss = () => { css.classList.remove('is-open'); cssButton.setAttribute('aria-pressed', 'false'); schedule(); };
  const openNote = (next) => {
    note = next;
    input.value = next.text || '';
    lastEdit = 'text';
    css.replaceChildren();
    closeCss();
    cssButton.style.display = next.kind === 'element' ? '' : 'none';
    hideHover();
    chipFor();
    if (next.kind === 'element' && next.preview) openCss();
    card.style.display = 'block';
    updateNote();
    setMode();
    render();
    input.focus({ preventScroll: true });
  };
  const closeNote = () => {
    note = null;
    card.style.display = 'none';
    css.replaceChildren();
    closeCss();
    if (shadow.activeElement) shadow.activeElement.blur();
    setMode();
    syncPreviews();
    schedule();
  };
  const saveNote = () => {
    if (!note || !hasContent()) return;
    const current = note;
    const instruction = input.value.trim().slice(0, MAX_NOTE);
    if (current.kind === 'region' && current.isNew) {
      const region = draft;
      draft = null;
      committed = { id: region.id, bounds: region.bounds, strokes: region.strokes };
      emit({ kind: 'region', id: region.id, bounds: region.bounds, viewport: { width: innerWidth, height: innerHeight }, strokes: region.strokes, instruction });
    } else {
      const event = { kind: 'note', id: current.id, instruction };
      if (current.base) {
        event.edits = diff();
        held.set(current.id, { element: current.element, change: previewOf(event.edits) });
      }
      emit(event);
    }
    closeNote();
  };
  const cancelNote = () => {
    if (!note) return;
    const current = note;
    if (current.kind === 'region' && current.isNew) draft = null;
    if (current.kind === 'element' && current.base) apply(current.element, current.preview || null);
    if (current.kind === 'element' && current.isNew) emit({ kind: 'remove', id: current.id });
    closeNote();
  };
  const removeNote = () => {
    if (!note) return;
    const current = note;
    if (current.kind === 'region' && current.isNew) { draft = null; closeNote(); return; }
    if (current.kind === 'element' && current.base) apply(current.element, null);
    held.delete(current.id);
    marks = marks.filter((mark) => mark.id !== current.id);
    emit({ kind: 'remove', id: current.id });
    closeNote();
  };
  /** Clicking away keeps a note that says something and drops one that is still empty. */
  const dismiss = () => { if (hasContent()) saveNote(); else cancelNote(); };
  const openMark = (mark) => {
    if (note && note.id === mark.id) return;
    if (note) dismiss();
    if (mark.kind === 'element') {
      const element = find(mark.selector);
      if (!element) return;
      openNote({ id: mark.id, kind: 'element', isNew: false, n: mark.n, element, text: mark.note || '', preview: mark.preview || null });
      return;
    }
    openNote({ id: mark.id, kind: 'region', isNew: false, n: mark.n, region: { id: mark.id, bounds: mark.bounds, strokes: mark.strokes || [] }, text: mark.note || '' });
  };
  const pickElement = (element) => {
    const existing = marks.find((mark) => mark.kind === 'element' && find(mark.selector) === element);
    if (existing) { openMark(existing); return; }
    const id = newId('element');
    emit({ kind: 'element', id, selector: selectorFor(element) });
    openNote({ id, kind: 'element', isNew: true, n: marks.length + 1, element, text: '', preview: null });
  };

  const pagePoint = (event) => [Math.round(event.clientX + offsetX()), Math.round(event.clientY + offsetY())];
  const clampTo = (bounds, point) => [
    Math.max(bounds.x, Math.min(point[0], bounds.x + bounds.width)),
    Math.max(bounds.y, Math.min(point[1], bounds.y + bounds.height)),
  ];
  const inside = (bounds, point) => point[0] >= bounds.x && point[0] <= bounds.x + bounds.width && point[1] >= bounds.y && point[1] <= bounds.y + bounds.height;
  const targetAt = (event) => {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    return element && element !== host && element.nodeType === 1 ? element : null;
  };
  const ours = (event) => event.target === host;
  const block = (event) => {
    if (ours(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onDown = (event) => {
    if (ours(event)) return;
    block(event);
    if (event.button !== 0) return;
    const point = pagePoint(event);
    if (draft) {
      if (!inside(draft.bounds, point)) { dismiss(); press = { mode: 'ignore' }; return; }
      if (draft.strokes.length >= MAX_STROKES) { press = { mode: 'ignore' }; return; }
      press = { mode: 'stroke', stroke: { tool, points: tool === 'pen' ? point : [...point, ...point] } };
      schedule();
      return;
    }
    if (note) { dismiss(); press = { mode: 'ignore' }; return; }
    press = { mode: 'pending', start: point, clientX: event.clientX, clientY: event.clientY, target: hovered || targetAt(event) };
  };
  const onMove = (event) => {
    if (ours(event)) return;
    block(event);
    if (!press) {
      if (note) return;
      const element = targetAt(event);
      if (element && element !== pointed) { pointed = element; lineage.length = 0; hovered = element; showHover(element); }
      return;
    }
    const point = pagePoint(event);
    if (press.mode === 'pending' && Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) >= DRAG_START) {
      press.mode = 'region';
      hideHover();
    }
    if (press.mode === 'region') {
      const bounds = { x: Math.min(press.start[0], point[0]), y: Math.min(press.start[1], point[1]), width: Math.abs(point[0] - press.start[0]), height: Math.abs(point[1] - press.start[1]) };
      press.region = { bounds, strokes: [] };
      schedule();
      return;
    }
    if (press.mode === 'stroke' && draft) {
      const clamped = clampTo(draft.bounds, point);
      if (press.stroke.tool === 'pen') {
        if (press.stroke.points.length < MAX_POINTS) press.stroke.points.push(clamped[0], clamped[1]);
      } else {
        press.stroke.points[2] = clamped[0];
        press.stroke.points[3] = clamped[1];
      }
      schedule();
    }
  };
  const onUp = (event) => {
    if (ours(event)) return;
    block(event);
    const current = press;
    press = null;
    if (!current || event.button !== 0) return;
    if (current.mode === 'pending') {
      const element = current.target || targetAt(event);
      if (element) pickElement(element);
      return;
    }
    if (current.mode === 'region') {
      const region = current.region;
      if (region && region.bounds.width >= MIN_REGION && region.bounds.height >= MIN_REGION) {
        draft = { id: newId('region'), bounds: region.bounds, strokes: [], redo: [] };
        tool = 'pen';
        openNote({ id: draft.id, kind: 'region', isNew: true, n: marks.length + 1, region: draft, text: '' });
      }
      schedule();
      return;
    }
    if (current.mode === 'stroke' && draft) {
      const p = current.stroke.points;
      const sized = current.stroke.tool === 'pen' || Math.abs(p[2] - p[0]) >= 3 || Math.abs(p[3] - p[1]) >= 3;
      if (sized) { draft.strokes.push(current.stroke); draft.redo = []; lastEdit = 'stroke'; }
      updateNote();
      schedule();
    }
  };
  const onCancel = () => { press = null; schedule(); };
  const undo = () => { if (draft && draft.strokes.length) { draft.redo.push(draft.strokes.pop()); updateNote(); schedule(); } };
  const redo = () => { if (draft && draft.redo.length) { draft.strokes.push(draft.redo.pop()); updateNote(); schedule(); } };
  /** Arrow Up and Down move the highlight to the parent or back toward the element under the pointer. */
  const adjust = (up) => {
    if (up) {
      const parent = hovered.parentElement;
      if (!parent || parent === document.documentElement) return;
      lineage.push(hovered);
      hovered = parent;
    } else if (lineage.length) hovered = lineage.pop();
    else {
      const child = hovered.firstElementChild;
      if (!child) return;
      hovered = child;
    }
    showHover(hovered);
  };
  const onKey = (event) => {
    if (ours(event)) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (event.key === 'Escape') { block(event); if (note) cancelNote(); else stop(); return; }
    if (draft && mod && key === 'z') { block(event); (event.shiftKey ? redo : undo)(); return; }
    if (draft && mod && key === 'y') { block(event); redo(); return; }
    if (note && event.key === 'Enter') { block(event); saveNote(); return; }
    if (!note && hovered && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { block(event); adjust(event.key === 'ArrowUp'); }
  };
  const stopEvent = (event) => { event.stopPropagation(); };
  const contained = ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'wheel', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'focusin', 'focusout', 'paste', 'copy', 'cut'];
  for (const part of [tools, card, layer]) for (const type of contained) part.addEventListener(type, stopEvent);
  for (const part of [tools, layer]) part.addEventListener('pointerdown', (event) => event.preventDefault());
  tools.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button || button.disabled) return;
    const name = button.dataset.action;
    if (name === 'pen' || name === 'ellipse' || name === 'rect' || name === 'arrow') tool = name;
    else if (name === 'undo') undo();
    else if (name === 'redo') redo();
    else if (name === 'clear' && draft) { draft.redo = []; draft.strokes = []; updateNote(); }
    schedule();
  });
  layer.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('.pin') : null;
    const mark = target ? markFor(target.dataset.id) : null;
    if (mark && !draft) openMark(mark);
  });
  card.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape') { event.preventDefault(); cancelNote(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); saveNote(); return; }
    if (draft && mod && event.key.toLowerCase() === 'z' && lastEdit === 'stroke') { event.preventDefault(); (event.shiftKey ? redo : undo)(); }
  });
  input.addEventListener('input', () => { lastEdit = 'text'; updateNote(); schedule(); });
  cssButton.addEventListener('click', () => {
    if (css.classList.contains('is-open')) closeCss(); else openCss();
    updateNote();
  });
  removeButton.addEventListener('click', removeNote);
  saveButton.addEventListener('click', saveNote);
  const listeners = [
    ['pointermove', onMove], ['pointerdown', onDown], ['pointerup', onUp], ['pointercancel', onCancel],
    ['mousemove', block], ['mouseover', block], ['mouseout', block], ['mousedown', block], ['mouseup', block],
    ['click', block], ['dblclick', block], ['auxclick', block], ['contextmenu', block],
    ['touchstart', block], ['touchmove', block], ['touchend', block],
    ['keydown', onKey], ['keyup', (event) => { if (event.key === 'Escape' || event.key === 'Enter') block(event); }],
    ['scroll', schedule], ['resize', schedule],
  ];
  for (const [type, listener] of listeners) window.addEventListener(type, listener, { capture: true, passive: false });
  const timer = setInterval(schedule, 500);
  const stop = () => {
    for (const [type, listener] of listeners) window.removeEventListener(type, listener, { capture: true });
    clearInterval(timer);
    if (frame) cancelAnimationFrame(frame);
    for (const [element, saved] of previews) restore(element, saved);
    previews.clear();
    host.remove();
    cursor.remove();
    if (window.__zliAnnotate === session) delete window.__zliAnnotate;
    queue.length = 0;
    if (waiter) { const resolve = waiter; waiter = null; resolve(null); }
  };
  const session = {
    next: () => {
      if (queue.length) return Promise.resolve(queue.shift());
      if (waiter) { const previous = waiter; waiter = null; previous(null); }
      return new Promise((resolve) => { waiter = resolve; });
    },
    mark: (next, drop) => {
      marks = Array.isArray(next) ? next : [];
      const dropped = Array.isArray(drop) ? drop : [];
      committed = null;
      for (const id of Array.from(held.keys())) if (markFor(id) || dropped.includes(id)) held.delete(id);
      if (note && dropped.includes(note.id)) {
        if (note.kind === 'element' && note.base) apply(note.element, null);
        if (note.kind === 'region' && note.isNew) draft = null;
        closeNote();
      }
      syncPreviews();
      render();
      return true;
    },
    capture: (region) => {
      capturing = region ? { bounds: region.bounds, strokes: Array.isArray(region.strokes) ? region.strokes : [] } : { bounds: { x: 0, y: 0, width: 0, height: 0 }, strokes: [] };
      refocus = shadow.activeElement;
      host.setAttribute('data-capture', '');
      render();
      return new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(true); } };
        requestAnimationFrame(() => requestAnimationFrame(finish));
        setTimeout(finish, 150);
      });
    },
    release: () => {
      capturing = null;
      host.removeAttribute('data-capture');
      render();
      if (refocus && note && refocus.isConnected) refocus.focus({ preventScroll: true });
      refocus = null;
      return true;
    },
    stop,
  };
  window.__zliAnnotate = session;
  syncPreviews();
  render();
  return session.next();
})()`;

export const CANCEL_DESIGN_PICKER_SCRIPT = "(() => { window.__zliAnnotate?.stop(); return true; })()";

/** Marks that arrive before the session starts are kept for it. `drop` closes notes the app turned down. */
export function designMarkScript(marks: readonly DesignMark[], drop: readonly string[] = []): string {
  return `(() => { const marks = ${JSON.stringify(marks)}; if (window.__zliAnnotate) window.__zliAnnotate.mark(marks, ${JSON.stringify(drop)}); else window.__zliAnnotateMarks = marks; return true; })()`;
}

/** Hides the overlay for a screenshot, leaving only the given region's sketch when there is one. */
export function designCaptureScript(region: { bounds: DesignRect; strokes: DesignStroke[] } | null): string {
  return `(() => (window.__zliAnnotate ? window.__zliAnnotate.capture(${JSON.stringify(region)}) : true))()`;
}

export const DESIGN_RELEASE_SCRIPT = "(() => { window.__zliAnnotate?.release(); return true; })()";

/** Reads what the annotate script resolved with; null when the session ended or the value is unusable. */
export function parseDesignPickResult(value: unknown): DesignPickResult | null {
  if (!isRecord(value)) return null;
  if (value.kind === "mode")
    return typeof value.mode === "string" && MODES.includes(value.mode)
      ? { kind: "mode", mode: value.mode as DesignAnnotateMode }
      : null;
  const id = parseId(value.id);
  if (!id) return null;
  if (value.kind === "region") {
    const bounds = parseRect(value.bounds);
    if (!bounds) return null;
    const viewport = isRecord(value.viewport) ? value.viewport : {};
    return {
      kind: "region",
      id,
      bounds,
      viewport: {
        width: finite(viewport.width) ? Math.round(viewport.width) : 0,
        height: finite(viewport.height) ? Math.round(viewport.height) : 0,
      },
      strokes: parseStrokes(value.strokes),
      instruction: parseInstruction(value.instruction),
    };
  }
  if (value.kind === "note") {
    const note: Extract<DesignPickResult, { kind: "note" }> = {
      kind: "note",
      id,
      instruction: parseInstruction(value.instruction),
    };
    if (value.edits === null) return { ...note, edits: null };
    const edits = parseDesignEdits(value.edits);
    return edits ? { ...note, edits } : note;
  }
  if (value.kind === "remove") return { kind: "remove", id };
  if (value.kind === "element" && typeof value.selector === "string" && value.selector)
    return { kind: "element", id, selector: value.selector };
  return null;
}

export function parseDesignEdits(value: unknown): DesignEdits | undefined {
  if (!isRecord(value) || !Array.isArray(value.css)) return undefined;
  const allowed: readonly string[] = DESIGN_EDITABLE_STYLES;
  const css: DesignCssEdit[] = [];
  for (const edit of value.css) {
    if (!isRecord(edit) || typeof edit.property !== "string" || !allowed.includes(edit.property)) continue;
    if (typeof edit.from !== "string" || typeof edit.to !== "string" || !edit.to.trim()) continue;
    if (css.some((existing) => existing.property === edit.property)) continue;
    css.push({
      property: edit.property,
      from: edit.from.slice(0, MAX_EDIT_VALUE_CHARS),
      to: edit.to.trim().slice(0, MAX_EDIT_VALUE_CHARS),
    });
  }
  const text =
    isRecord(value.text) && typeof value.text.from === "string" && typeof value.text.to === "string"
      ? { from: value.text.from.slice(0, MAX_EDIT_TEXT_CHARS), to: value.text.to.slice(0, MAX_EDIT_TEXT_CHARS) }
      : undefined;
  if (css.length === 0 && !text) return undefined;
  return text ? { css, text } : { css };
}

export function parseStrokes(value: unknown): DesignStroke[] {
  if (!Array.isArray(value)) return [];
  const strokes: DesignStroke[] = [];
  for (const stroke of value.slice(0, MAX_DESIGN_STROKES)) {
    if (!isRecord(stroke) || typeof stroke.tool !== "string" || !STROKE_TOOLS.includes(stroke.tool)) continue;
    if (!Array.isArray(stroke.points)) continue;
    const points = stroke.points.slice(0, MAX_DESIGN_STROKE_POINTS).filter(finite).map(Math.round);
    const needed = stroke.tool === "pen" ? 2 : 4;
    if (points.length < needed || points.length % 2 !== 0) continue;
    strokes.push({
      tool: stroke.tool as DesignStrokeTool,
      points: stroke.tool === "pen" ? points : points.slice(0, 4),
    });
  }
  return strokes;
}

function parseId(value: unknown): string | undefined {
  return typeof value === "string" && value && value.length <= MAX_ID_CHARS ? value : undefined;
}

function parseInstruction(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_DESIGN_INSTRUCTION_CHARS) : "";
}

function parseRect(value: unknown): DesignRect | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || width <= 0 || height <= 0) return undefined;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
