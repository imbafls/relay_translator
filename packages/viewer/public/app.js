/* Relay viewer: token from /watch/<token>, WS to same origin.
 * Screens: live (3d/3j) · display settings (3e) · ended (3f) · OBS overlay (?obs=1, 3g).
 * Display settings are per-device (localStorage). */
(() => {
  "use strict";

  const token = (location.pathname.match(/\/watch\/([A-Za-z0-9_-]+)/) || [])[1] || "";
  const params = new URLSearchParams(location.search);
  const obs = params.get("obs") === "1";
  const settingsInObs = params.get("settings") === "1";
  if (obs) document.body.classList.add("obs");

  const $ = (id) => document.getElementById(id);
  const linesEl = $("lines");

  // ---------------------------------------------------------------------------
  // display settings
  // ---------------------------------------------------------------------------

  const FONT_STACKS = {
    relay: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    verdana: "Verdana, Geneva, Tahoma, sans-serif",
    georgia: 'Georgia, "Times New Roman", serif',
    mono: '"Martian Mono", Consolas, "Cascadia Mono", monospace',
    impact: 'Impact, "Arial Black", "Franklin Gothic Bold", sans-serif',
  };
  const FONT_NAMES = { relay: "RELAY", system: "SYSTEM", verdana: "VERDANA", georgia: "GEORGIA", mono: "MONO", impact: "IMPACT" };

  const DARK = { fg: "#efeae0", accent: "#e0a43a", bg: "#131313", shadow: false };
  const THEMES = {
    dark: DARK,
    light: { fg: "#131313", accent: "#b8801f", bg: "#f0eee9", shadow: false },
    "obs-black": { fg: "#ffffff", accent: "#e0a43a", bg: "#000000", shadow: true },
    "obs-clear": { fg: "#ffffff", accent: "#e0a43a", bg: "#000000", shadow: true },
  };
  const DEFAULT_STYLE = {
    theme: obs ? "obs-clear" : "dark",
    font: "relay",
    size: 18,
    showSource: true,
    showTranslation: true,
    timestamps: true,
    shadow: obs,
    align: "left",
    lines: 8,
    fg: obs ? "#ffffff" : DARK.fg,
    accent: DARK.accent,
    bg: obs ? "#000000" : DARK.bg,
  };
  const STYLE_KEY = "relay-style-v2";
  let style = loadStyle();

  function loadStyle() {
    try {
      const raw = localStorage.getItem(STYLE_KEY);
      if (!raw) return { ...DEFAULT_STYLE };
      const parsed = JSON.parse(raw);
      const merged = { ...DEFAULT_STYLE };
      for (const k of Object.keys(DEFAULT_STYLE)) if (parsed[k] !== undefined) merged[k] = parsed[k];
      merged.size = Math.min(40, Math.max(14, Number(merged.size) || 18));
      merged.lines = Math.min(15, Math.max(3, Number(merged.lines) || 8));
      if (!FONT_STACKS[merged.font]) merged.font = "relay";
      return merged;
    } catch {
      return { ...DEFAULT_STYLE };
    }
  }
  function saveStyle() {
    try {
      localStorage.setItem(STYLE_KEY, JSON.stringify(style));
    } catch {
      /* private mode etc. */
    }
  }

  let serverTranslates = true;

  function applyStyle() {
    const root = document.documentElement.style;
    const body = document.body;
    root.setProperty("--cap-font", FONT_STACKS[style.font] || FONT_STACKS.relay);
    root.setProperty("--size", `${style.size}px`);
    root.setProperty("--fg", style.fg);
    root.setProperty("--accent", style.accent);
    root.setProperty("--bgc", obs && style.theme === "obs-clear" ? "transparent" : style.bg);
    root.setProperty("--shadow", style.shadow ? "0 2px 6px rgba(0,0,0,.7)" : "none");
    body.classList.toggle("light", style.theme === "light");
    body.classList.toggle("obs-black", obs && style.theme === "obs-black");
    body.classList.toggle("no-src", !style.showSource);
    body.classList.toggle("no-tgt", !serverTranslates || !style.showTranslation);
    body.classList.toggle("no-ts", !style.timestamps);
    body.classList.toggle("center", style.align === "center");
    trimRows();
  }

  function themeMatches(name) {
    const t = THEMES[name];
    return style.theme === name && style.fg === t.fg && style.bg === t.bg;
  }

  function syncDisplayUI() {
    for (const b of $("themeBar").querySelectorAll("button")) b.classList.toggle("active", themeMatches(b.dataset.theme));
    $("setSize").value = style.size;
    $("sizeVal").textContent = String(style.size);
    $("setShowSource").checked = !!style.showSource;
    $("setShowTranslation").checked = !!style.showTranslation;
    $("setTimestamps").checked = !!style.timestamps;
    $("setShadow").checked = !!style.shadow;
    $("setFont").value = style.font;
    $("fontVal").textContent = FONT_NAMES[style.font] || "RELAY";
    $("setAlign").value = style.align;
    $("alignVal").textContent = style.align.toUpperCase();
    $("setLines").value = String(style.lines);
    $("linesVal").textContent = String(style.lines);
    $("setFg").value = style.fg;
    $("setAccent").value = style.accent;
    $("setBg").value = style.bg;
    $("swFg").style.background = style.fg;
    $("swAccent").style.background = style.accent;
    $("swBg").style.background = style.bg;
    renderPreview();
  }

  function update(patch) {
    Object.assign(style, patch);
    applyStyle();
    saveStyle();
    syncDisplayUI();
  }

  function initDisplayUI() {
    const sel = $("setLines");
    for (let n = 3; n <= 15; n++) {
      const o = document.createElement("option");
      o.value = String(n);
      o.textContent = String(n);
      sel.appendChild(o);
    }
    $("openDisplay").addEventListener("click", () => showScreen("display"));
    $("closeDisplay").addEventListener("click", () => showScreen("live"));
    for (const b of $("themeBar").querySelectorAll("button")) {
      b.addEventListener("click", () => update({ theme: b.dataset.theme, ...THEMES[b.dataset.theme] }));
    }
    $("setSize").addEventListener("input", () => update({ size: Number($("setSize").value) }));
    $("setShowSource").addEventListener("change", () => update({ showSource: $("setShowSource").checked }));
    $("setShowTranslation").addEventListener("change", () => update({ showTranslation: $("setShowTranslation").checked }));
    $("setTimestamps").addEventListener("change", () => update({ timestamps: $("setTimestamps").checked }));
    $("setShadow").addEventListener("change", () => update({ shadow: $("setShadow").checked }));
    $("setFont").addEventListener("change", () => update({ font: $("setFont").value }));
    $("setAlign").addEventListener("change", () => update({ align: $("setAlign").value }));
    $("setLines").addEventListener("change", () => update({ lines: Number($("setLines").value) }));
    $("setFg").addEventListener("input", () => update({ fg: $("setFg").value }));
    $("setAccent").addEventListener("input", () => update({ accent: $("setAccent").value }));
    $("setBg").addEventListener("input", () => update({ bg: $("setBg").value }));
    $("resetStyle").addEventListener("click", () => update({ ...DEFAULT_STYLE }));
    syncDisplayUI();
    if (obs && !settingsInObs) $("openDisplay").hidden = true;
  }

  function renderPreview() {
    const box = $("previewRow");
    const latest = linesEl.querySelector(".row.latest");
    box.innerHTML = "";
    if (latest) {
      box.appendChild(latest.cloneNode(true));
      return;
    }
    const row = makeRowEl("45:21", "He's one shot, behind the box", "Nó còn một viên, sau cái hộp");
    row.classList.add("latest", "has-tgt");
    box.appendChild(row);
  }

  // ---------------------------------------------------------------------------
  // screens + clock
  // ---------------------------------------------------------------------------

  function showScreen(name) {
    for (const id of ["live", "display", "ended"]) $(id).hidden = id !== name;
    if (name === "display") syncDisplayUI();
  }

  let liveSince = null;
  let isLive = false;
  function pad(n) {
    return n < 10 ? `0${n}` : String(n);
  }
  function tick() {
    let ms = 0;
    if (isLive && liveSince) ms = Date.now() - liveSince;
    const s = Math.max(0, Math.floor(ms / 1000));
    $("hudClock").textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }
  setInterval(tick, 1000);

  function setHud(state, text) {
    $("hudState").dataset.state = state;
    $("hudText").textContent = text;
  }

  // ---------------------------------------------------------------------------
  // rows
  // ---------------------------------------------------------------------------

  const rows = new Map();
  let interim = null;

  function stamp() {
    const d = new Date();
    return `${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function makeRowEl(ts, src, tgt) {
    const row = document.createElement("div");
    row.className = "row";
    const t = document.createElement("span");
    t.className = "ts";
    t.textContent = ts;
    const body = document.createElement("div");
    const s = document.createElement("div");
    s.className = "src";
    s.textContent = src;
    const g = document.createElement("div");
    g.className = "tgt" + (tgt ? "" : " pending");
    g.textContent = tgt || "…";
    body.append(s, g);
    row.append(t, body);
    return row;
  }

  function trimRows() {
    const finals = [...linesEl.querySelectorAll(".row:not(.interim)")];
    while (finals.length > style.lines) {
      const el = finals.shift();
      for (const [id, r] of rows) if (r === el) rows.delete(id);
      el.remove();
    }
  }

  function markLatest() {
    let latestId = -1;
    for (const id of rows.keys()) if (id > latestId) latestId = id;
    for (const [id, el] of rows) el.classList.toggle("latest", id === latestId);
  }

  function showPartial(msg) {
    if (!msg.source || rows.has(msg.id)) return;
    if (!interim) {
      interim = makeRowEl(stamp(), "", "");
      interim.classList.add("interim");
      interim.querySelector(".tgt").remove();
      linesEl.appendChild(interim);
    }
    interim.dataset.id = msg.id;
    const src = interim.querySelector(".src");
    src.textContent = msg.source;
    const c = document.createElement("span");
    c.className = "cursor";
    src.appendChild(c);
  }

  function showSubtitle(msg) {
    let el = rows.get(msg.id);
    if (!el) {
      if (interim) {
        interim.remove();
        interim = null;
      }
      el = makeRowEl(stamp(), msg.source, msg.target);
      rows.set(msg.id, el);
      linesEl.appendChild(el);
    }
    el.querySelector(".src").textContent = msg.source;
    if (msg.target != null) {
      const g = el.querySelector(".tgt");
      g.textContent = msg.target;
      g.classList.remove("pending");
      el.classList.add("has-tgt");
    }
    if (msg.latency) {
      const total = (msg.latency.stt || 0) + (msg.latency.translate || 0);
      if (total > 0) el.title = `${(total / 1000).toFixed(1)}s behind`;
    }
    markLatest();
    trimRows();
    if (!$("display").hidden) renderPreview();
  }

  // ---------------------------------------------------------------------------
  // connection
  // ---------------------------------------------------------------------------

  let ws = null;
  let closedByKick = false;

  function langsLabel(msg) {
    const src = (msg.languages && msg.languages.source ? msg.languages.source : "").toUpperCase();
    const tgt = (msg.languages && msg.languages.target ? msg.languages.target : "").toUpperCase();
    return msg.translates === false ? src : `${src} → ${tgt}`;
  }

  function applyLive(live, since) {
    isLive = !!live;
    if (live) liveSince = since || liveSince || Date.now();
    setHud(live ? "on" : "off", live ? "ON AIR" : "OFF AIR");
    tick();
  }

  function connect() {
    if (closedByKick) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    setHud("off", "CONNECTING");
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws/viewer?token=${encodeURIComponent(token)}`);
    } catch {
      setHud("warn", "BAD LINK");
      return;
    }
    ws.onopen = () => setHud("off", "OFF AIR");
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "hello":
          serverTranslates = msg.translates !== false;
          applyStyle();
          $("hudLangs").textContent = langsLabel(msg);
          applyLive(msg.live, msg.since);
          break;
        case "status":
          applyLive(msg.live, msg.since);
          if (!msg.live && interim) {
            interim.remove();
            interim = null;
          }
          break;
        case "partial":
          showPartial(msg);
          break;
        case "subtitle":
          showSubtitle(msg);
          break;
        case "kicked": {
          closedByKick = true;
          const d = new Date();
          $("endedAt").textContent = `ENDED ${pad(d.getHours())}:${pad(d.getMinutes())}`;
          const n = rows.size;
          $("savedCount").textContent = `${n} LINE${n === 1 ? "" : "S"} SAVED`;
          showScreen("ended");
          try {
            ws.close();
          } catch {
            /* noop */
          }
          break;
        }
        default:
          break;
      }
    };
    ws.onclose = () => {
      if (closedByKick) return;
      setHud("warn", "RECONNECTING");
      setTimeout(connect, 2000);
    };
    ws.onerror = () => {};
  }

  $("tryAgain").addEventListener("click", () => location.reload());

  applyStyle();
  initDisplayUI();
  tick();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ws && ws.readyState > WebSocket.OPEN) {
      closedByKick = false;
      connect();
    }
  });

  connect();
})();
