/** Click the Browser toolbar button in ZLI WebView2. */
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((p) => (p.url || "").includes("localhost:1420"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
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
const clicked = await send("Runtime.evaluate", {
  expression: `(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => /^Browser$/i.test((b.textContent || '').trim()) || (b.getAttribute('aria-label') || '').includes('Browser'));
    if (!btn) return { ok: false, labels: Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || b.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 40) };
    btn.click();
    return { ok: true, text: (btn.textContent || '').trim() };
  })()`,
  returnByValue: true,
});
console.log(JSON.stringify(clicked.result?.value, null, 2));
ws.close();
