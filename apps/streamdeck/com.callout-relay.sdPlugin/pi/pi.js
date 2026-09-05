/* Stream Deck property inspector - talks straight to the desktop app's
   control API on 127.0.0.1:47477 (status, config, link rotate, SSE). */
(() => {
  "use strict";

  const API = "http://127.0.0.1:47477";
  const CLIENT_HEADER = "x-callout-relay-client";

  const STT_MODELS = [
    ["deepgram-nova-3", "Nova-3"],
    ["deepgram-nova-3-multi", "Nova-3 Multi"],
    ["deepgram-nova-2", "Nova-2"],
  ];
  /**
   * Local models are listed only once the desktop app has them downloaded, so
   * this has to name every one the catalogue offers - a model missing here
   * cannot be picked from the Stream Deck even when it is installed, because
   * the downloaded check filters against this list. Kept in step with
   * STT_MODELS in @callout-relay/shared; a test fails if they drift.
   */
  const LOCAL_MODELS = [
    ["local-zipformer-en-20m", "Local Zipformer 20M"],
    ["local-parakeet-tdt-0.6b-v3", "Local Parakeet v3"],
    ["local-sense-voice", "Local SenseVoice"],
    ["local-moonshine-tiny", "Local Moonshine Tiny"],
    ["local-whisper-tiny-en", "Local Whisper Tiny"],
    ["local-zipformer-en", "Local Zipformer"],
    ["local-moonshine-base", "Local Moonshine Base"],
    ["local-parakeet-tdt-0.6b-v2", "Local Parakeet v2"],
    ["local-nemotron-streaming", "Local Nemotron"],
    ["local-whisper-turbo", "Local Whisper Turbo"],
  ];
  const TRANSLATION_MODELS = [
    ["gemini-3.1-flash-lite", "Flash-Lite"],
    ["gemini-flash-latest", "Flash"],
    ["gemini-2.5-flash", "2.5 Flash"],
  ];
  const LANGUAGES = [
    ["en", "EN"], ["vi", "VI"], ["es", "ES"], ["pt", "PT"], ["fr", "FR"], ["de", "DE"],
    ["ru", "RU"], ["ja", "JA"], ["ko", "KO"], ["zh", "ZH"], ["th", "TH"], ["id", "ID"],
  ];
  const DEFAULT_DEVICES = [
    ["default-mic", "Default mic"],
    ["system-loopback", "System audio"],
  ];

  const $ = (id) => document.getElementById(id);
  let currentStatus = null;
  let syncing = false;

  function headers() {
    return { [CLIENT_HEADER]: "streamdeck-pi", "Content-Type": "application/json" };
  }

  function fill(sel, entries, value) {
    sel.innerHTML = "";
    for (const [v, label] of entries) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = label;
      if (v === value) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function shortDevice(label) {
    return label.replace(/^Default microphone$/, "Default mic").replace(/^System audio.*$/, "System audio");
  }

  function renderStatus(status) {
    const reachable = !!status;
    $("notRunning").hidden = reachable;
    const state = status ? status.session.state : "unreachable";
    const live = state === "live";
    const st = $("state");
    st.dataset.state = live ? "on" : state === "error" || !reachable ? "warn" : "off";
    $("stateText").textContent =
      state === "live" ? "ON AIR" :
      state === "starting" ? "STARTING" :
      state === "error" ? "ERROR" :
      reachable ? "STANDBY" : "OFFLINE";
    $("keyHint").textContent = live || state === "starting" ? "KEY = STOP" : "KEY = START";
    const url = status && status.relay.viewerUrl;
    const show = !!url && (live || (status.config && status.config.linkMode === "fixed"));
    $("viewerUrl").value = show ? url.replace(/^[a-z]+:\/\//i, "") : "";
    $("viewerUrl").title = show ? url : "";
  }

  function renderConfig(cfg) {
    if (!cfg) return;
    syncing = true;
    const devices = (currentStatus ? currentStatus.devices : []).map((d) => [d.id, shortDevice(d.label)]);
    fill($("audioSource"), devices.length ? devices : DEFAULT_DEVICES, cfg.audioSource);
    const ready = new Set(((currentStatus && currentStatus.localModels) || []).filter((m) => m.downloaded).map((m) => m.id));
    const sttList = STT_MODELS.concat(LOCAL_MODELS.filter(([id]) => ready.has(id) || id === cfg.stt));
    fill($("stt"), sttList, cfg.stt);
    fill($("translation"), TRANSLATION_MODELS, cfg.translation);
    fill($("langSource"), LANGUAGES, cfg.languages.source);
    fill($("langTarget"), LANGUAGES, cfg.languages.target);
    const on = cfg.translationEnabled !== false && !!cfg.geminiApiKey;
    $("translateToggle").textContent = on ? "ON" : "OFF";
    $("translateToggle").classList.toggle("off", !on);
    $("blkTranslate").classList.toggle("off", !on);
    $("translateToggle").title = cfg.geminiApiKey ? "" : "Add a Gemini key in the desktop app (KEYS)";
    syncing = false;
  }

  async function refresh() {
    let status = null;
    try {
      const res = await fetch(`${API}/status`);
      if (res.ok) status = await res.json();
    } catch {
      status = null;
    }
    currentStatus = status;
    renderStatus(status);
    if (status) renderConfig(status.config);
    else {
      renderConfig({
        stt: "deepgram-nova-3",
        translation: "gemini-3.1-flash-lite",
        languages: { source: "en", target: "vi" },
        audioSource: "default-mic",
        translationEnabled: true,
        geminiApiKey: "x",
      });
    }
  }

  async function patchConfig(patch) {
    if (syncing) return;
    try {
      const res = await fetch(`${API}/config`, { method: "POST", headers: headers(), body: JSON.stringify(patch) });
      if (res.ok) {
        currentStatus = await res.json();
        renderStatus(currentStatus);
        renderConfig(currentStatus.config);
      }
    } catch {
      renderStatus(null);
    }
  }

  for (const id of ["stt", "translation", "audioSource"]) {
    $(id).addEventListener("change", () => patchConfig({ [id]: $(id).value }));
  }
  $("langSource").addEventListener("change", () => patchConfig({ languages: { source: $("langSource").value } }));
  $("langTarget").addEventListener("change", () => patchConfig({ languages: { target: $("langTarget").value } }));
  $("translateToggle").addEventListener("click", () => {
    const cfg = currentStatus && currentStatus.config;
    if (!cfg || !cfg.geminiApiKey) return;
    patchConfig({ translationEnabled: cfg.translationEnabled === false });
  });

  $("copyBtn").addEventListener("click", async () => {
    const url = $("viewerUrl").title || $("viewerUrl").value;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      $("viewerUrl").select();
      document.execCommand("copy");
    }
    $("copyBtn").textContent = "COPIED";
    setTimeout(() => ($("copyBtn").textContent = "COPY"), 1200);
  });

  $("rotateBtn").addEventListener("click", async () => {
    try {
      const res = await fetch(`${API}/link/rotate`, { method: "POST", headers: headers() });
      if (res.ok) await refresh();
    } catch {
      renderStatus(null);
    }
  });

  // live status via SSE; refresh() as fallback on error
  function connectEvents() {
    try {
      const es = new EventSource(`${API}/events`);
      es.onmessage = (ev) => {
        try {
          const evt = JSON.parse(ev.data);
          if (evt.type === "status") {
            currentStatus = evt.status;
            renderStatus(currentStatus);
            renderConfig(currentStatus.config);
          }
        } catch {
          /* noop */
        }
      };
      es.onerror = () => {
        es.close();
        renderStatus(null);
        setTimeout(connectEvents, 4000);
      };
    } catch {
      setTimeout(refresh, 4000);
    }
  }

  refresh().then(connectEvents);
})();
