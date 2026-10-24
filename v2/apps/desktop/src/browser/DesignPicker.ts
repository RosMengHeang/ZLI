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

const PICKER_STYLE = [
  ".box { position: fixed; box-sizing: border-box; border: 2px solid #3b82f6; background: rgba(59, 130, 246, 0.14); border-radius: 2px; display: none; }",
  ".label { position: fixed; display: none; max-width: 420px; padding: 3px 6px; overflow: hidden; border-radius: 4px; background: #1e293b; color: #f8fafc; font: 500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: nowrap; text-overflow: ellipsis; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); }",
  ".label span { color: #93c5fd; }",
].join("\n");

/**
 * Highlights the element under the pointer and resolves with the selector of the one clicked, or
 * null when Escape is pressed or the pick is cancelled. The page never sees the click.
 */
export const DESIGN_PICKER_SCRIPT = `(() => {
  if (window.__zliDesignPicker) window.__zliDesignPicker.cancel();
  ${SELECTOR_FOR_SOURCE}
  return new Promise((resolve) => {
    const host = document.createElement('zli-design-picker');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(PICKER_STYLE)};
    const box = document.createElement('div');
    box.className = 'box';
    const label = document.createElement('div');
    label.className = 'label';
    shadow.append(style, box, label);
    const cursor = document.createElement('style');
    cursor.textContent = '* { cursor: crosshair !important; }';
    (document.head || document.documentElement).append(cursor);
    document.documentElement.append(host);
    let current = null;
    const describe = (element) => {
      let name = element.localName;
      if (element.id) name += '#' + element.id;
      else if (typeof element.className === 'string' && element.className.trim()) name += '.' + element.className.trim().split(/\\s+/).slice(0, 2).join('.');
      return name;
    };
    const show = (element) => {
      const rect = element.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
      label.replaceChildren(describe(element) + ' ');
      const size = document.createElement('span');
      size.textContent = Math.round(rect.width) + ' × ' + Math.round(rect.height);
      label.append(size);
      label.style.display = 'block';
      const above = rect.top - 24;
      label.style.left = Math.max(0, Math.min(rect.left, innerWidth - 200)) + 'px';
      label.style.top = (above >= 0 ? above : Math.min(rect.bottom + 4, innerHeight - 22)) + 'px';
    };
    const targetAt = (event) => {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      return element && element !== host && element.nodeType === 1 ? element : null;
    };
    const onMove = (event) => {
      const element = targetAt(event);
      if (element && element !== current) {
        current = element;
        show(element);
      }
    };
    const block = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onClick = (event) => {
      block(event);
      const element = targetAt(event) || current;
      finish(element ? { selector: selectorFor(element) } : null);
    };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      block(event);
      finish(null);
    };
    const onScroll = () => { if (current) show(current); };
    const listeners = [
      ['pointermove', onMove], ['mousemove', onMove], ['mouseover', block], ['mouseout', block],
      ['pointerdown', block], ['mousedown', block], ['pointerup', block], ['mouseup', block],
      ['click', onClick], ['dblclick', block], ['auxclick', block], ['contextmenu', block],
      ['keydown', onKey], ['keyup', block], ['scroll', onScroll],
    ];
    for (const [type, listener] of listeners) window.addEventListener(type, listener, true);
    const finish = (result) => {
      for (const [type, listener] of listeners) window.removeEventListener(type, listener, true);
      host.remove();
      cursor.remove();
      if (window.__zliDesignPicker === picker) delete window.__zliDesignPicker;
      resolve(result);
    };
    const picker = { cancel: () => finish(null) };
    window.__zliDesignPicker = picker;
  });
})()`;

export const CANCEL_DESIGN_PICKER_SCRIPT = "(() => { window.__zliDesignPicker?.cancel(); return true; })()";
