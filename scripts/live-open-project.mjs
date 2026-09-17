/**
 * Drive ZLI WebView2 via CDP: open D:\\Taxzy_CLI through the setup path form.
 * Usage: node scripts/live-open-project.mjs [wsUrl]
 */
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((p) => p.title === "ZLI" || (p.url || "").includes("localhost:1420"));
if (!page?.webSocketDebuggerUrl) {
  console.error("No ZLI CDP page", list);
  process.exit(1);
}
const wsUrl = process.argv[2] || page.webSocketDebuggerUrl;
const projectPath = process.argv[3] || "D:\\Taxzy_CLI";

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});

await send("Runtime.enable");
await send("DOM.enable");

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

const before = await evaluate(`({
  href: location.href,
  buttons: Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim().slice(0, 80)),
  hasProject: !!document.querySelector('[aria-labelledby="project-title"]')
})`);
console.log("before", JSON.stringify(before, null, 2));

const clickedManual = await evaluate(`(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => /Enter path manually/i.test(b.textContent || ''));
  if (!btn) return false;
  btn.click();
  return true;
})()`);
console.log("clickedManual", clickedManual);

await new Promise((r) => setTimeout(r, 400));

const filled = await evaluate(`(() => {
  const input = document.querySelector('input[placeholder*="Projects"], input.font-mono, form.setup-path-form input, label input');
  if (!input) return { ok: false, reason: 'no-input' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(projectPath)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: input.value };
})()`);
console.log("filled", filled);

const submitted = await evaluate(`(() => {
  const form = document.querySelector('form.setup-path-form');
  if (form) {
    form.requestSubmit();
    return 'form-submit';
  }
  const btn = Array.from(document.querySelectorAll('button')).find((b) => /Open path/i.test(b.textContent || ''));
  if (btn) {
    btn.click();
    return 'button-click';
  }
  return 'none';
})()`);
console.log("submitted", submitted);

for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const state = await evaluate(`({
    title: document.title,
    h1: document.querySelector('h1')?.textContent?.trim() || null,
    bodySnippet: document.body?.innerText?.slice(0, 400) || '',
    pathShown: Array.from(document.querySelectorAll('p')).map((p) => p.textContent.trim()).find((t) => /Taxzy_CLI|\\\\/.test(t)) || null
  })`);
  console.log("poll", i, JSON.stringify(state));
  if (state.pathShown || /Configure agents|Taxzy_CLI|agents/i.test(state.bodySnippet || "")) {
    break;
  }
}

ws.close();
console.log("done");
