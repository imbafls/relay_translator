/* Launch diagnostic: attach CDP to the packaged app, capture renderer console,
 * press start via control API, print everything the renderer logs. */
import { execFile } from "node:child_process";

const exe = "apps/standalone/release/win-unpacked/Callout Relay.exe";
const child = execFile(exe, ["--remote-debugging-port=9333"], (err) => {
  if (err && !err.killed) console.error("exe exit:", err.message);
});

await new Promise((r) => setTimeout(r, 10000));

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find((t) => t.type === "page" && t.url.includes("index.html")) || list[0];
console.log("attaching to:", page.title, page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
const logs = [];
let id = 0;
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === mid) {
        ws.removeEventListener("message", onMsg);
        resolve(m.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Runtime.consoleAPICalled") {
    const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    logs.push(`[console.${m.params.type}] ${text}`);
    console.log(`[console.${m.params.type}] ${text}`);
  }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    logs.push(`[exception] ${d.text} ${d.exception?.description || ""}`);
    console.log(`[exception] ${d.text} ${d.exception?.description || ""}`);
  }
});

await new Promise((r) => ws.addEventListener("open", r, { once: true }));
await send("Runtime.enable");
await send("Runtime.evaluate", { expression: "1+1" });

// press start through the same control API the Stream Deck uses
const res = await fetch("http://127.0.0.1:47477/start", {
  method: "POST",
  headers: { "x-callout-relay-client": "diag" },
});
console.log("control /start ->", res.status);

await new Promise((r) => setTimeout(r, 12000));

const status = await (await fetch("http://127.0.0.1:47477/status")).json();
console.log("final state:", status.session.state, status.session.error || "");
console.log("viewerUrl:", status.relay.viewerUrl);

const dom = await send("Runtime.evaluate", {
  expression:
    "JSON.stringify({log: document.getElementById('log').innerText, err: document.getElementById('errorBox').textContent, src: document.getElementById('audioSource')?.value})",
  returnByValue: true,
});
console.log("UI LOG:\n" + JSON.parse(dom.result.value).log);
console.log("errorBox:", JSON.parse(dom.result.value).err);

ws.close();
child.kill();
process.exit(0);
