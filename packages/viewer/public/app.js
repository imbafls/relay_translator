/* Callout Relay viewer: token from /watch/<token>, WS to same origin.
 * Display settings (font/colors/etc.) are per-device, saved in localStorage. */
(() => {
  "use strict";

  const token = (location.pathname.match(/\/watch\/([A-Za-z0-9_-]+)/) || [])[1] || "";
  const obs = new URLSearchParams(location.search).get("obs") === "1";
  const allowSettings = new URLSearchParams(location.search).get("settings") === "1";
  if (obs) document.body.classList.add("obs");
  if (obs && allowSettings) document.body.classList.add("gear-on");

  const $ = (id) => document.getElementById(id);
  const dot = $("dot");
  const statusText = $("statusText");
  const langsEl = $("langs");
  const lines = $("lines");
  const kicked = $("kicked");
  const kickedReason = $("kickedReason");

  // ---------------------------------------------------------------------------
  // display settings
  // ---------------------------------------------------------------------------

  const FONT_STACKS = {
    system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    verdana: "Verdana, Geneva, Tahoma, sans-serif",
    georgia: 'Georgia, "Times New Roman", serif',
    mono: 'Consolas, "Cascadia Mono", "Courier New", monospace',
    print: '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive',
    impact: 'Impact, "Arial Black", "Franklin Gothic Bold", sans-serif',
  };

  const DEFAULT_STYLE = {
    font: "system",
    size: 21,
    showSource: true,
    srcSize: 14,
    fg: "#e8eaf0",
    accent: "#46e0a0",
    bg: "#161b26",
    bgOp: 3,
    shadow: false,
    align: "left",
    lines: 8,
  };

  const STYLE_KEY = "callout-style-v1";
  let style = loadStyle();
  let maxPairs = style.lines;

  function loadStyle() {
    try {
      const raw = localStorage.getItem(STYLE_KEY);
      if (!raw) return { ...DEFAULT_STYLE };
      const parsed = JSON.parse(raw);
      const merged = { ...DEFAULT_STYLE };
      for (const k of Object.keys(DEFAULT_STYLE)) {
        if (parsed[k] !== undefined) merged[k] = parsed[k];
      }
      // sanity clamps
      merged.size = Math.min(72, Math.max(16, Number(merged.size) || 21));
      merged.srcSize = Math.min(40, Math.max(10, Number(merged.srcSize) || 14));
      merged.lines = Math.min(15, Math.max(3, Number(merged.lines) || 8));
      merged.bgOp = Math.min(100, Math.max(0, Number(merged.bgOp) || 0));
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

  function hexToRgba(hex, opPct) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return `rgba(255,255,255,${opPct / 100})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opPct / 100})`;
  }

  function applyStyle() {
    const root = document.documentElement;
    const body = document.body;
    root.style.setProperty("--font-main", FONT_STACKS[style.font] || FONT_STACKS.system);
    root.style.setProperty("--target-size", `${style.size}px`);
    root.style.setProperty("--source-size", `${style.srcSize}px`);
    root.style.setProperty("--pair-accent", style.accent);
    root.style.setProperty("--pair-bg", hexToRgba(style.bg, style.bgOp));
    body.classList.toggle("no-source", !style.showSource);
    body.classList.toggle("shadow", !!style.shadow);
    body.classList.toggle("center-align", style.align === "center");
    maxPairs = style.lines;
    trimLines();
  }

  const PRESETS = {
    dark: { ...DEFAULT_STYLE },
    light: {
      ...DEFAULT_STYLE,
      fg: "#10131a",
      accent: "#0a7d4d",
      bg: "#ffffff",
      bgOp: 85,
      shadow: false,
    },
    "obs-black": {
      ...DEFAULT_STYLE,
      size: 30,
      fg: "#ffffff",
      bg: "#000000",
      bgOp: 55,
      shadow: true,
    },
    "obs-clear": {
      ...DEFAULT_STYLE,
      size: 30,
      fg: "#ffffff",
      bg: "#000000",
      bgOp: 0,
      shadow: true,
    },
  };

  function initSettingsUI() {
    const gear = $("gear");
    const panel = $("settingsPanel");
    if (!gear || !panel) return;

    gear.addEventListener("click", () => panel.classList.toggle("hidden"));
    $("closeSettings").addEventListener("click", () => panel.classList.add("hidden"));

    const syncUI = () => {
      $("setFont").value = style.font;
      $("setSize").value = style.size;
      $("setSizeVal").textContent = `${style.size}px`;
      $("setShowSource").checked = !!style.showSource;
      $("setSrcSize").value = style.srcSize;
      $("setSrcSizeVal").textContent = `${style.srcSize}px`;
      $("setFg").value = style.fg;
      $("setAccent").value = style.accent;
      $("setBg").value = style.bg;
      $("setBgOp").value = style.bgOp;
      $("setBgOpVal").textContent = `${style.bgOp}%`;
      $("setShadow").checked = !!style.shadow;
      $("setAlign").value = style.align;
      $("setLines").value = style.lines;
      $("setLinesVal").textContent = String(style.lines);
    };

    const update = (patch) => {
      Object.assign(style, patch);
      applyStyle();
      saveStyle();
      syncUI();
    };

    $("setFont").addEventListener("change", () => update({ font: $("setFont").value }));
    $("setSize").addEventListener("input", () => update({ size: Number($("setSize").value) }));
    $("setShowSource").addEventListener("change", () => update({ showSource: $("setShowSource").checked }));
    $("setSrcSize").addEventListener("input", () => update({ srcSize: Number($("setSrcSize").value) }));
    $("setFg").addEventListener("input", () => update({ fg: $("setFg").value }));
    $("setAccent").addEventListener("input", () => update({ accent: $("setAccent").value }));
    $("setBg").addEventListener("input", () => update({ bg: $("setBg").value }));
    $("setBgOp").addEventListener("input", () => update({ bgOp: Number($("setBgOp").value) }));
    $("setShadow").addEventListener("change", () => update({ shadow: $("setShadow").checked }));
    $("setAlign").addEventListener("change", () => update({ align: $("setAlign").value }));
    $("setLines").addEventListener("input", () => update({ lines: Number($("setLines").value) }));

    for (const btn of panel.querySelectorAll("[data-preset]")) {
      btn.addEventListener("click", () => {
        Object.assign(style, PRESETS[btn.dataset.preset] || {});
        applyStyle();
        saveStyle();
        syncUI();
      });
    }

    $("resetStyle").addEventListener("click", () => {
      Object.assign(style, DEFAULT_STYLE);
      applyStyle();
      saveStyle();
      syncUI();
    });

    syncUI();
  }

  // ---------------------------------------------------------------------------
  // connection + subtitles
  // ---------------------------------------------------------------------------

  let ws = null;
  let closedByKick = false;

  function setStatus(cls, text) {
    dot.className = "dot " + cls;
    statusText.textContent = text;
  }

  function trimLines() {
    while (lines.children.length > maxPairs) lines.firstChild.remove();
  }

  function clearPending() {
    const pending = lines.querySelector(".pair.pending");
    if (pending) pending.remove();
  }

  function makePair(source) {
    clearPending();
    const pair = document.createElement("div");
    pair.className = "pair pending";

    const src = document.createElement("div");
    src.className = "source";
    src.textContent = source;

    const tgt = document.createElement("div");
    tgt.className = "target";

    pair.append(src, tgt);
    lines.appendChild(pair);
    trimLines();
    lines.scrollTop = lines.scrollHeight;
    return pair;
  }

  function showPartial(id, source) {
    let pending = lines.querySelector(".pair.pending");
    if (!pending) pending = makePair(source);
    pending.querySelector(".source").textContent = source;
  }

  function showSubtitle(msg) {
    let pair = null;
    for (const el of lines.children) {
      if (Number(el.dataset.id) === msg.id) { pair = el; break; }
    }
    if (!pair) pair = makePair(msg.source);
    pair.dataset.id = msg.id;
    pair.classList.remove("pending");
    pair.querySelector(".source").textContent = msg.source;
    if (msg.target != null) pair.querySelector(".target").textContent = msg.target;
    lines.scrollTop = lines.scrollHeight;
  }

  function connect() {
    if (closedByKick) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    setStatus("warn", "connecting…");
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws/viewer?token=${encodeURIComponent(token)}`);
    } catch {
      setStatus("warn", "bad link");
      return;
    }

    ws.onopen = () => setStatus("off", "waiting for stream…");

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case "hello":
          langsEl.textContent = `${msg.languages.source} → ${msg.languages.target}`;
          setStatus(msg.live ? "on" : "off", msg.live ? "live" : "waiting for stream…");
          break;
        case "status":
          setStatus(msg.live ? "on" : "off", msg.live ? "live" : (msg.message || "idle"));
          break;
        case "partial":
          showPartial(msg.id, msg.source);
          break;
        case "subtitle":
          showSubtitle(msg);
          break;
        case "kicked":
          closedByKick = true;
          kickedReason.textContent = msg.reason || "";
          kicked.classList.remove("hidden");
          try { ws.close(); } catch {}
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      if (closedByKick) return;
      setStatus("warn", "disconnected — retrying…");
      setTimeout(connect, 2000);
    };
    ws.onerror = () => {};
  }

  applyStyle();
  initSettingsUI();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ws && ws.readyState > WebSocket.OPEN) connect();
  });

  connect();
})();
