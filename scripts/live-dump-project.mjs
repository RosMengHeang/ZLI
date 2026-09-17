/** Dump active ZLI project path from WebView2 localStorage / DOM. */
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
const result = await send("Runtime.evaluate", {
  expression: `(() => {
    const keys = Object.keys(localStorage).filter((k) => /zli:|taxzy:/.test(k));
    const prefs = {};
    for (const k of keys) {
      try { prefs[k] = JSON.parse(localStorage.getItem(k)); }
      catch { prefs[k] = localStorage.getItem(k); }
    }
    return {
      prefs,
      body: document.body.innerText.slice(0, 1200),
    };
  })()`,
  returnByValue: true,
});
console.log(JSON.stringify(result.result?.value, null, 2));
ws.close();
