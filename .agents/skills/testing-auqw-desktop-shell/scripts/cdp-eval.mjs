// Minimal CDP probe: evaluate an expression in the auqw renderer.
// Usage: node /tmp/cdp-eval.mjs '<expression>'
const expr = process.argv[2] ?? 'typeof window.auqw';
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page' && /index\.html$/.test(t.url));
if (!page) {
  console.log('NO PAGE TARGET', JSON.stringify(targets.map((t) => [t.type, t.url])));
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
const done = new Promise((resolve) => {
  ws.onopen = () => ws.send(JSON.stringify({
    id: 1, method: 'Runtime.evaluate',
    params: { expression: expr, awaitPromise: true, returnByValue: true },
  }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === 1) resolve(m);
  };
});
const res = await done;
console.log(JSON.stringify(res.result ?? res, null, 1));
ws.close();
process.exit(0);
