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
export type DesignStrokeTool = "pen" | "rect" | "ellipse";
/** A mark drawn on a region, in page coordinates. Pen strokes list x,y pairs; shapes list two corners. */
export type DesignStroke = { tool: DesignStrokeTool; points: number[] };

/** What the person did in the page while annotating: clicked an element or drew a region. */
export type DesignPickResult =
  | { kind: "element"; selector: string }
  | {
      kind: "region";
      id: string;
      /** Page coordinates, so the region stays put when the page scrolls. */
      bounds: DesignRect;
      viewport: { width: number; height: number };
      strokes: DesignStroke[];
    };

/** Numbered markers the app asks the page to draw for the annotations it holds. */
export type DesignMark =
  | { kind: "element"; id: string; n: number; selector: string }
  | { kind: "region"; id: string; n: number; bounds: DesignRect; strokes: DesignStroke[] };

/** Live preview of a text or style change; `null` puts the element back the way it was. */
export type DesignPreview = { text?: string | undefined; styles?: Record<string, string> | undefined } | null;

/** Style properties the live preview may change, in the CSS spelling the message uses. */
export const DESIGN_EDITABLE_STYLES = ["background-color", "color", "padding", "font-size", "border-radius"] as const;

export const MAX_DESIGN_STROKES = 200;
export const MAX_DESIGN_STROKE_POINTS = 2_000;
const STROKE_TOOLS: readonly string[] = ["pen", "rect", "ellipse"];

const ANNOTATE_STYLE = [
  ".box { position: fixed; box-sizing: border-box; border: 2px solid #3b82f6; background: rgba(59, 130, 246, 0.14); border-radius: 2px; display: none; }",
  ".label { position: fixed; display: none; max-width: 420px; padding: 3px 6px; overflow: hidden; border-radius: 4px; background: #1e293b; color: #f8fafc; font: 500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: nowrap; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); }",
  ".label span { color: #93c5fd; }",
  ".mark { position: fixed; box-sizing: border-box; border: 2px solid #3b82f6; border-radius: 2px; }",
  ".badge { position: fixed; box-sizing: border-box; min-width: 20px; height: 20px; padding: 0 6px; border: 2px solid #fff; border-radius: 10px; background: #3b82f6; color: #fff; font: 700 11px/16px system-ui, -apple-system, Segoe UI, sans-serif; text-align: center; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35); }",
  ".badge.is-region { background: #ef4444; }",
  "svg.sketch { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; overflow: visible; }",
  ".outline { fill: rgba(239, 68, 68, 0.06); stroke: #ef4444; stroke-width: 1.5; stroke-dasharray: 6 4; }",
  ".draft .outline { fill: rgba(239, 68, 68, 0.1); stroke-dasharray: none; }",
  ".stroke { fill: none; stroke: #ef4444; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }",
  ".tools { position: fixed; display: none; align-items: center; gap: 2px; padding: 3px; border-radius: 8px; background: #1e293b; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35); pointer-events: auto; cursor: default; }",
  ".tools button { all: unset; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 6px; color: #e2e8f0; cursor: pointer; }",
  ".tools button:hover { background: #334155; }",
  ".tools button[aria-pressed=true] { background: #3b82f6; color: #fff; }",
  ".tools button.done { background: #3b82f6; color: #fff; }",
  ".tools button:disabled { opacity: 0.4; cursor: default; background: none; }",
  ".tools .sep { width: 1px; height: 18px; margin: 0 3px; background: #475569; }",
  ".tools svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }",
  ":host([data-capture]) .box, :host([data-capture]) .label, :host([data-capture]) .layer, :host([data-capture]) .tools { display: none !important; }",
].join("\n");

const TOOL_ICONS: Record<string, Array<[string, Record<string, string>]>> = {
  pen: [
    ["path", { d: "M12 20h9" }],
    ["path", { d: "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" }],
  ],
  rect: [["rect", { x: "4", y: "5", width: "16", height: "14", rx: "2" }]],
  ellipse: [["ellipse", { cx: "12", cy: "12", rx: "9", ry: "7" }]],
  undo: [
    ["path", { d: "M9 14 4 9l5-5" }],
    ["path", { d: "M4 9h11a5 5 0 0 1 0 10h-3" }],
  ],
  redo: [
    ["path", { d: "m15 14 5-5-5-5" }],
    ["path", { d: "M20 9H9a5 5 0 0 0 0 10h3" }],
  ],
  clear: [["path", { d: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }]],
  discard: [["path", { d: "M18 6 6 18M6 6l12 12" }]],
  done: [["path", { d: "M20 6 9 17l-5-5" }]],
};

const TOOL_BUTTONS: Array<[string, string] | "|"> = [
  ["pen", "Pencil"],
  ["rect", "Rectangle"],
  ["ellipse", "Ellipse"],
  "|",
  ["undo", "Undo"],
  ["redo", "Redo"],
  ["clear", "Clear drawing"],
  "|",
  ["discard", "Delete region"],
  ["done", "Done"],
];

/**
 * Starts an annotate session in the page, or joins the one already running, and resolves with the
 * next element clicked or region drawn. The session stays on the page between calls so its
 * numbered markers and sketches stay visible; it resolves null when Escape ends it or it is
 * cancelled. Clicks and drags never reach the page, and events that arrive between calls queue.
 */
export const DESIGN_PICKER_SCRIPT = `(() => {
  if (window.__zliAnnotate) return window.__zliAnnotate.next();
  ${SELECTOR_FOR_SOURCE}
  const svgNS = 'http://www.w3.org/2000/svg';
  const MIN_REGION = 8;
  const DRAG_START = 6;
  const MAX_STROKES = ${MAX_DESIGN_STROKES};
  const MAX_POINTS = ${MAX_DESIGN_STROKE_POINTS};
  const EDITABLE = ${JSON.stringify(DESIGN_EDITABLE_STYLES)};
  const ICONS = ${JSON.stringify(TOOL_ICONS)};
  const BUTTONS = ${JSON.stringify(TOOL_BUTTONS)};
  const make = (tag, className) => { const node = document.createElement(tag); if (className) node.className = className; return node; };
  const svg = (tag, attributes) => { const node = document.createElementNS(svgNS, tag); for (const key in attributes) node.setAttribute(key, String(attributes[key])); return node; };
  const host = document.createElement('zli-design-picker');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = make('style');
  style.textContent = ${JSON.stringify(ANNOTATE_STYLE)};
  const sketch = svg('svg', { class: 'sketch' });
  const world = svg('g', {});
  sketch.append(world);
  const layer = make('div', 'layer');
  const box = make('div', 'box');
  const label = make('div', 'label');
  const tools = make('div', 'tools');
  tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', 'Region drawing tools');
  const buttons = {};
  for (const entry of BUTTONS) {
    if (entry === '|') { tools.append(make('span', 'sep')); continue; }
    const [name, title] = entry;
    const button = make('button', name === 'done' ? 'done' : '');
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.dataset.tool = name;
    const icon = svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    for (const [tag, attributes] of ICONS[name]) icon.append(svg(tag, attributes));
    button.append(icon);
    buttons[name] = button;
    tools.append(button);
  }
  shadow.append(style, sketch, layer, box, label, tools);
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
  let tool = 'pen';
  let press = null;
  let hovered = null;
  let capturing = null;
  let frame = 0;
  const previews = new Map();
  const emit = (event) => {
    if (waiter) { const resolve = waiter; waiter = null; resolve(event); } else queue.push(event);
  };
  const offsetX = () => (window.visualViewport ? visualViewport.pageLeft : scrollX);
  const offsetY = () => (window.visualViewport ? visualViewport.pageTop : scrollY);
  const find = (selector) => { try { return document.querySelector(selector); } catch { return null; } };
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
  const hideHover = () => { hovered = null; box.style.display = 'none'; label.style.display = 'none'; };
  const drawStroke = (stroke) => {
    const p = stroke.points;
    if (stroke.tool === 'pen') {
      let d = 'M' + p[0] + ' ' + p[1];
      for (let index = 2; index + 1 < p.length; index += 2) d += 'L' + p[index] + ' ' + p[index + 1];
      if (p.length === 2) d += 'l0.01 0';
      return svg('path', { class: 'stroke', d });
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
  const badge = (n, left, top, region) => {
    const node = make('div', region ? 'badge is-region' : 'badge');
    node.textContent = String(n);
    place(node, Math.max(2, Math.min(left - 10, innerWidth - 24)), Math.max(2, Math.min(top - 10, innerHeight - 24)));
    return node;
  };
  const placeTools = () => {
    if (!draft) { tools.style.display = 'none'; return; }
    tools.style.display = 'flex';
    buttons.undo.disabled = draft.strokes.length === 0;
    buttons.redo.disabled = draft.redo.length === 0;
    buttons.clear.disabled = draft.strokes.length === 0;
    for (const name of ['pen', 'rect', 'ellipse']) buttons[name].setAttribute('aria-pressed', String(tool === name));
    const width = tools.offsetWidth || 280;
    const height = tools.offsetHeight || 32;
    const right = draft.bounds.x + draft.bounds.width - offsetX();
    const bottom = draft.bounds.y + draft.bounds.height - offsetY();
    const top = bottom + 8 + height <= innerHeight ? bottom + 8 : Math.max(4, draft.bounds.y - offsetY() - height - 8);
    place(tools, Math.max(4, Math.min(right - width, innerWidth - width - 4)), Math.max(4, Math.min(top, innerHeight - height - 4)));
  };
  const render = () => {
    frame = 0;
    world.setAttribute('transform', 'translate(' + -offsetX() + ' ' + -offsetY() + ')');
    if (capturing) {
      world.replaceChildren(drawRegion(capturing, 'region', false));
      return;
    }
    const groups = [];
    const nodes = [];
    for (const mark of marks) {
      if (mark.kind === 'region') {
        groups.push(drawRegion(mark, 'region', true));
        nodes.push(badge(mark.n, mark.bounds.x - offsetX(), mark.bounds.y - offsetY(), true));
        continue;
      }
      const element = find(mark.selector);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      const outline = make('div', 'mark');
      place(outline, rect.left, rect.top, rect.width, rect.height);
      nodes.push(outline, badge(mark.n, rect.left, rect.top, false));
    }
    if (committed && !marks.some((mark) => mark.id === committed.id)) groups.push(drawRegion(committed, 'region', true));
    if (draft) groups.push(drawRegion(draft, 'region draft', true));
    if (press && press.mode === 'region' && press.region) groups.push(drawRegion(press.region, 'region draft', true));
    world.replaceChildren(...groups);
    layer.replaceChildren(...nodes);
    if (hovered && !draft && !press) showHover(hovered);
    placeTools();
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
  const pagePoint = (event) => [Math.round(event.clientX + offsetX()), Math.round(event.clientY + offsetY())];
  const clampTo = (bounds, point) => [
    Math.max(bounds.x, Math.min(point[0], bounds.x + bounds.width)),
    Math.max(bounds.y, Math.min(point[1], bounds.y + bounds.height)),
  ];
  const inside = (bounds, point) => point[0] >= bounds.x && point[0] <= bounds.x + bounds.width && point[1] >= bounds.y && point[1] <= bounds.y + bounds.height;
  const regionId = () => 'region-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const commitDraft = () => {
    if (!draft) return;
    const region = draft;
    draft = null;
    committed = { id: region.id, bounds: region.bounds, strokes: region.strokes };
    emit({ kind: 'region', id: region.id, bounds: region.bounds, viewport: { width: innerWidth, height: innerHeight }, strokes: region.strokes });
    schedule();
  };
  const discardDraft = () => { draft = null; schedule(); };
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
      if (!inside(draft.bounds, point)) { commitDraft(); press = { mode: 'ignore' }; return; }
      if (draft.strokes.length >= MAX_STROKES) { press = { mode: 'ignore' }; return; }
      press = { mode: 'stroke', stroke: { tool, points: tool === 'pen' ? point : [...point, ...point] } };
      schedule();
      return;
    }
    press = { mode: 'pending', start: point, clientX: event.clientX, clientY: event.clientY, target: targetAt(event) || hovered };
  };
  const onMove = (event) => {
    if (ours(event)) return;
    block(event);
    if (!press) {
      if (draft) return;
      const element = targetAt(event);
      if (element && element !== hovered) { hovered = element; showHover(element); }
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
      if (element) emit({ kind: 'element', selector: selectorFor(element) });
      return;
    }
    if (current.mode === 'region') {
      const region = current.region;
      if (region && region.bounds.width >= MIN_REGION && region.bounds.height >= MIN_REGION) {
        draft = { id: regionId(), bounds: region.bounds, strokes: [], redo: [] };
        tool = 'pen';
      }
      schedule();
      return;
    }
    if (current.mode === 'stroke' && draft) {
      const p = current.stroke.points;
      const sized = current.stroke.tool === 'pen' || Math.abs(p[2] - p[0]) >= 3 || Math.abs(p[3] - p[1]) >= 3;
      if (sized) { draft.strokes.push(current.stroke); draft.redo = []; }
      schedule();
    }
  };
  const onCancel = () => { press = null; schedule(); };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      block(event);
      if (draft) discardDraft(); else stop();
      return;
    }
    if (!draft) return;
    if (event.key === 'Enter') { block(event); commitDraft(); return; }
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'z') { block(event); (event.shiftKey ? redo : undo)(); return; }
    if (mod && event.key.toLowerCase() === 'y') { block(event); redo(); }
  };
  const undo = () => { if (draft && draft.strokes.length) { draft.redo.push(draft.strokes.pop()); schedule(); } };
  const redo = () => { if (draft && draft.redo.length) { draft.strokes.push(draft.redo.pop()); schedule(); } };
  const stopEvent = (event) => { event.stopPropagation(); };
  tools.addEventListener('pointerdown', (event) => { event.preventDefault(); event.stopPropagation(); });
  for (const type of ['pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove', 'dblclick', 'contextmenu', 'touchstart', 'touchend']) tools.addEventListener(type, stopEvent);
  tools.addEventListener('click', (event) => {
    event.stopPropagation();
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button || button.disabled) return;
    const name = button.dataset.tool;
    if (name === 'pen' || name === 'rect' || name === 'ellipse') tool = name;
    else if (name === 'undo') undo();
    else if (name === 'redo') redo();
    else if (name === 'clear' && draft) { draft.redo = []; draft.strokes = []; }
    else if (name === 'discard') discardDraft();
    else if (name === 'done') commitDraft();
    schedule();
  });
  const listeners = [
    ['pointermove', onMove], ['pointerdown', onDown], ['pointerup', onUp], ['pointercancel', onCancel],
    ['mousemove', block], ['mouseover', block], ['mouseout', block], ['mousedown', block], ['mouseup', block],
    ['click', block], ['dblclick', block], ['auxclick', block], ['contextmenu', block],
    ['touchstart', block], ['touchmove', block], ['touchend', block],
    ['keydown', onKey], ['keyup', (event) => { if (event.key === 'Escape') block(event); }],
    ['scroll', schedule], ['resize', schedule],
  ];
  for (const [type, listener] of listeners) window.addEventListener(type, listener, { capture: true, passive: false });
  const timer = setInterval(schedule, 500);
  const restore = (element, saved) => {
    if (saved.style === null) element.removeAttribute('style'); else element.setAttribute('style', saved.style);
    if (saved.texts) saved.texts.forEach((value, index) => { if (element.childNodes[index]) element.childNodes[index].data = value; });
  };
  const textNodes = (element) => element.childNodes.length > 0 && Array.from(element.childNodes).every((node) => node.nodeType === 3);
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
    mark: (next) => { marks = Array.isArray(next) ? next : []; committed = null; render(); return true; },
    capture: (region) => {
      capturing = region ? { bounds: region.bounds, strokes: Array.isArray(region.strokes) ? region.strokes : [] } : { bounds: { x: 0, y: 0, width: 0, height: 0 }, strokes: [] };
      host.setAttribute('data-capture', '');
      render();
      return new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(true); } };
        requestAnimationFrame(() => requestAnimationFrame(finish));
        setTimeout(finish, 150);
      });
    },
    release: () => { capturing = null; host.removeAttribute('data-capture'); render(); return true; },
    editable: (selector) => {
      const element = find(selector);
      if (!element) return null;
      const saved = previews.get(element);
      if (saved) restore(element, saved);
      const computed = getComputedStyle(element);
      const styles = {};
      for (const key of EDITABLE) styles[key] = computed.getPropertyValue(key);
      const text = textNodes(element) ? element.textContent : null;
      if (saved) session.preview(selector, saved.change);
      return { text, styles };
    },
    preview: (selector, change) => {
      const element = find(selector);
      if (!element) return false;
      let saved = previews.get(element);
      if (!saved) {
        saved = { style: element.getAttribute('style'), texts: textNodes(element) ? Array.from(element.childNodes, (node) => node.data) : null, change: null };
        previews.set(element, saved);
      }
      restore(element, saved);
      if (!change) { previews.delete(element); schedule(); return true; }
      saved.change = change;
      if (typeof change.text === 'string' && saved.texts) {
        element.childNodes[0].data = change.text;
        for (let index = 1; index < element.childNodes.length; index += 1) element.childNodes[index].data = '';
      }
      const styles = change.styles && typeof change.styles === 'object' ? change.styles : {};
      for (const key of EDITABLE) if (typeof styles[key] === 'string' && styles[key].trim()) element.style.setProperty(key, styles[key].trim(), 'important');
      schedule();
      return true;
    },
    stop,
  };
  window.__zliAnnotate = session;
  render();
  return session.next();
})()`;

export const CANCEL_DESIGN_PICKER_SCRIPT = "(() => { window.__zliAnnotate?.stop(); return true; })()";

/** Marks that arrive before the session starts are kept for it. */
export function designMarkScript(marks: readonly DesignMark[]): string {
  return `(() => { const marks = ${JSON.stringify(marks)}; if (window.__zliAnnotate) window.__zliAnnotate.mark(marks); else window.__zliAnnotateMarks = marks; return true; })()`;
}

/** Hides the overlay for a screenshot, leaving only the given region's sketch when there is one. */
export function designCaptureScript(region: { bounds: DesignRect; strokes: DesignStroke[] } | null): string {
  return `(() => (window.__zliAnnotate ? window.__zliAnnotate.capture(${JSON.stringify(region)}) : true))()`;
}

export const DESIGN_RELEASE_SCRIPT = "(() => { window.__zliAnnotate?.release(); return true; })()";

/** The element's own text, when it holds nothing but text, and the style values the preview can change. */
export function designEditableScript(selector: string): string {
  return `(() => {
    if (window.__zliAnnotate) return window.__zliAnnotate.editable(${JSON.stringify(selector)});
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const computed = getComputedStyle(element);
    const styles = {};
    for (const key of ${JSON.stringify(DESIGN_EDITABLE_STYLES)}) styles[key] = computed.getPropertyValue(key);
    const textOnly = element.childNodes.length > 0 && Array.from(element.childNodes).every((node) => node.nodeType === 3);
    return { text: textOnly ? element.textContent : null, styles };
  })()`;
}

export function designPreviewScript(selector: string, preview: DesignPreview): string {
  return `(() => (window.__zliAnnotate ? window.__zliAnnotate.preview(${JSON.stringify(selector)}, ${JSON.stringify(preview)}) : false))()`;
}

/** Reads what the annotate script resolved with; null when the session ended or the value is unusable. */
export function parseDesignPickResult(value: unknown): DesignPickResult | null {
  if (!isRecord(value)) return null;
  if (value.kind === "region") {
    const bounds = parseRect(value.bounds);
    if (typeof value.id !== "string" || !value.id || value.id.length > 100 || !bounds) return null;
    const viewport = isRecord(value.viewport) ? value.viewport : {};
    return {
      kind: "region",
      id: value.id,
      bounds,
      viewport: {
        width: finite(viewport.width) ? Math.round(viewport.width) : 0,
        height: finite(viewport.height) ? Math.round(viewport.height) : 0,
      },
      strokes: parseStrokes(value.strokes),
    };
  }
  return typeof value.selector === "string" && value.selector ? { kind: "element", selector: value.selector } : null;
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
