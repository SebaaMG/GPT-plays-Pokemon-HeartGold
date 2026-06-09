(function () {
  "use strict";

  const MAX_LOG_ENTRIES = 500;
  const RECONNECT_DELAY_MS = 3000;
  const DEFAULT_POLL_MS = 800;
  const queryParams = new URLSearchParams(window.location.search || "");
  const DEFAULT_HOST = queryParams.get("host") || window.location.hostname || "localhost";
  const DEFAULT_PORT = queryParams.get("port") || window.location.port || "9885";
  const DEFAULT_GAME_TITLE = "Pokemon HeartGold";
  const DEFAULT_PLATFORM = "Nintendo DS";
  const DEFAULT_SCREEN_WIDTH = 512;
  const DEFAULT_SCREEN_HEIGHT = 768;

  const KNOWN_POCKET_ORDER = [
    "item_pocket",
    "medicine_pocket",
    "key_item_pocket",
    "ball_pocket",
    "battle_items_pocket",
    "tm_case",
    "berries_pocket",
    "mail_pocket",
  ];

  const FALLBACK_TILE = ["❓", "Unknown"];

  const ORIENTATION_SYMBOLS = {
    100: "🧍↓",
    101: "🧍↑",
    102: "🧍←",
    103: "🧍→",
  };

  const TILES = {
    0: ["⛔", "Wall (Collision/Impassable)"],
    1: ["🟫", "Free Ground"],
    2: ["🌿", "Tall Grass"],
    3: ["🌊", "Water"],
    4: ["💧↑", "Waterfall"],
    5: ["⛛→", "Ledge East"],
    6: ["⛛←", "Ledge West"],
    7: ["⛛↑", "Ledge North"],
    8: ["⛛↓", "Ledge South"],
    9: ["🌀", "Warp"],
    10: ["👤", "NPC (Collision)"],
    11: ["✨", "Interactive (Collision)"],
    14: ["🖥️", "PC (Collision)"],
    15: ["🗺️", "Region Map (Collision)"],
    16: ["📺", "Television (Collision)"],
    18: ["📚", "Bookshelf (Collision)"],
    21: ["🗑️", "Trash Can (Collision)"],
    22: ["🛒", "Shop Shelf (Collision)"],
    23: ["🟥", "Red Carpet"],
    24: ["⬜", "OOB (Walkable)"],
    25: ["⬛", "OOB (Collision)"],
    26: ["🚪", "Door"],
    27: ["🪜", "Ladder"],
    28: ["🛗", "Escalator"],
    29: ["🕳️", "Hole"],
    30: ["🧗", "Stairs"],
    31: ["🏔️", "Entrance"],
    32: ["➡️", "Warp Arrow"],
    33: ["🪨", "Boulder (Collision)"],
    35: ["🌳", "Cuttable Tree (Collision)"],
    36: ["🪨⛏️", "Breakable Rock (Collision)"],
    44: ["←", "Arrow Floor Left"],
    45: ["→", "Arrow Floor Right"],
    46: ["↑", "Arrow Floor Up"],
    47: ["↓", "Arrow Floor Down"],
    48: ["🧊", "Thin Ice"],
    49: ["🧊⚡", "Cracked Ice"],
    50: ["🌊←", "Water Current Left"],
    51: ["🌊→", "Water Current Right"],
    52: ["🌊↑", "Water Current Up"],
    53: ["🌊↓", "Water Current Down"],
    54: ["🌊🫧", "Dive Water"],
    55: ["🎁", "Item Ball (Collision)"],
    60: ["🌀→", "Spinner Right"],
    61: ["🌀←", "Spinner Left"],
    62: ["🌀↑", "Spinner Up"],
    63: ["🌀↓", "Spinner Down"],
    64: ["🌀⏹️", "Stop Spinner"],
    65: ["🔘", "Strength Switch"],
    66: ["🧱⏳", "Temporary Wall (Collision)"],
    67: ["🚪🔒", "Locked Door (Collision)"],
    68: ["🟫↑🚫", "Free Ground (North Edge Blocked)"],
    69: ["🟫↓🚫", "Free Ground (South Edge Blocked)"],
    70: ["🟫→🚫", "Free Ground (East Edge Blocked)"],
    71: ["🟫←🚫", "Free Ground (West Edge Blocked)"],
    72: ["🟫↑→🚫", "Free Ground (North+East Edges Blocked)"],
    73: ["🟫↑←🚫", "Free Ground (North+West Edges Blocked)"],
    74: ["🟫↓→🚫", "Free Ground (South+East Edges Blocked)"],
    75: ["🟫↓←🚫", "Free Ground (South+West Edges Blocked)"],
    140: ["🟫⚡", "Cracked Floor"],
  };

  const els = {
    hostInput: document.getElementById("host-input"),
    portInput: document.getElementById("port-input"),
    pollInput: document.getElementById("poll-input"),
    reconnectInput: document.getElementById("reconnect-input"),
    connectBtn: document.getElementById("connect-btn"),
    disconnectBtn: document.getElementById("disconnect-btn"),
    clearLogsBtn: document.getElementById("clear-logs-btn"),

    runtimeGrid: document.getElementById("runtime-grid"),
    observationGrid: document.getElementById("observation-grid"),
    modelSurfaceWrap: document.getElementById("model-surface-wrap"),
    metricsGrid: document.getElementById("metrics-grid"),
    actionEffectWrap: document.getElementById("action-effect-wrap"),
    stuckWrap: document.getElementById("stuck-wrap"),
    screenMeta: document.getElementById("screen-meta"),
    screenFrame: document.getElementById("screen-frame"),
    screenPath: document.getElementById("screen-path"),
    trainerGrid: document.getElementById("trainer-grid"),
    battleWrap: document.getElementById("battle-wrap"),
    teamList: document.getElementById("team-list"),
    inventoryWrap: document.getElementById("inventory-wrap"),
    objectivesWrap: document.getElementById("objectives-wrap"),
    progressWrap: document.getElementById("progress-wrap"),
    memoryWrap: document.getElementById("memory-wrap"),
    logList: document.getElementById("log-list"),
    summaryTitle: document.getElementById("summary-title"),
    criticismTitle: document.getElementById("criticism-title"),
    summaryStream: document.getElementById("summary-stream"),
    criticismStream: document.getElementById("criticism-stream"),
    minimapMeta: document.getElementById("minimap-meta"),
    minimapGrid: document.getElementById("minimap-grid"),
    minimapLegend: document.getElementById("minimap-legend"),
    markerList: document.getElementById("marker-list"),
  };

  const state = {
    settings: {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      pollMs: DEFAULT_POLL_MS,
      autoReconnect: true,
    },
    ws: null,
    manualDisconnect: false,
    reconnectTimer: null,
    pollTimer: null,
    isConnected: false,
    lastWsAt: null,
    lastDataAt: null,
    nextLogId: 1,
    logs: [],
    reasoningBuffer: "",
    reasoningFlushTimer: null,
    activeReasoningLogId: null,
    lastPollErrorMessage: "",

    game: {
      current_trainer_data: null,
      current_pokemon_data: [],
      inventory_data: {
        item_pocket: [],
        ball_pocket: [],
        key_item_pocket: [],
        tm_case: [],
        berries_pocket: [],
      },
      objectives: null,
      memory: {},
      markers: {},
      progressSteps: [],
      battle_data: null,
      remaining_until_criticism: 0,
      remaining_until_summary: 0,
      steps: 0,
      isThinking: false,
      isSummaryStep: false,
      isCriticismStep: false,
      visibility_reduced: false,
      visibility_window_width_tiles: null,
      visibility_window_height_tiles: null,
      safari_zone_counter: 0,
      safari_zone_active: false,
      last_summary: "",
      last_criticism: "",
      total_tokens_accumulated: 0,
      time_usage_totals: { reasoning_ms: 0, tools_ms: 0, overall_ms: 0, down_ms: 0 },
      screenshot_url: "",
      observationPolicy: null,
      observationFreshness: null,
      stateReliabilityDetails: null,
      benchmarkMetrics: null,
      stuckState: null,
    },
    gameInfo: {
      title: DEFAULT_GAME_TITLE,
      platform: DEFAULT_PLATFORM,
      romMd5: "",
    },
    emulator: {
      name: "",
      system: "",
      frame: null,
      screenWidth: DEFAULT_SCREEN_WIDTH,
      screenHeight: DEFAULT_SCREEN_HEIGHT,
      screenshotRawWidth: DEFAULT_SCREEN_WIDTH,
      screenshotRawHeight: DEFAULT_SCREEN_HEIGHT,
      clientScreenWidth: null,
      clientScreenHeight: null,
      screenshotRawPath: "",
    },
    tokenTotals: null,
    timeTotals: null,
    streams: {
      summaryText: "",
      criticismText: "",
      summaryInProgress: false,
      criticismInProgress: false,
    },
    minimap: {
      data: null,
      lastSeq: null,
      lastMarkersHash: "",
      markersByMap: {},
    },
  };

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function pickString(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  function finiteNumberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function formatNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "0";
    return num.toLocaleString("en-US");
  }

  function formatOptionalNumber(value) {
    const num = finiteNumberOrNull(value);
    return num === null ? "-" : num.toLocaleString("en-US");
  }

  function formatTime(ts) {
    if (!Number.isFinite(ts)) return "-";
    return new Date(ts).toLocaleTimeString();
  }

  function formatMs(ms) {
    const num = Number(ms);
    if (!Number.isFinite(num) || num <= 0) return "0s";
    const totalSec = Math.floor(num / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function previewText(value, maxLen = 16000) {
    const text = value == null ? "" : String(value);
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen)}\n... truncated ${formatNumber(text.length - maxLen)} chars ...`;
  }

  function jsonPreview(value, maxLen = 16000) {
    if (value == null) return "";
    try {
      return previewText(JSON.stringify(value, null, 2), maxLen);
    } catch {
      return previewText(String(value), maxLen);
    }
  }

  function normalizeInventory(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        item_pocket: [],
        medicine_pocket: [],
        key_item_pocket: [],
        ball_pocket: [],
        battle_items_pocket: [],
        tm_case: [],
        berries_pocket: [],
        mail_pocket: [],
      };
    }

    const safePocket = (v) =>
      Array.isArray(v)
        ? v
            .map((row) => {
              if (Array.isArray(row) && row.length >= 2) return [String(row[0] || ""), Number(row[1] || 0)];
              if (row && typeof row === "object") {
                const name = row.name || row.item_name || row.itemName || row.id || row.item_id || "";
                const quantity = row.quantity ?? row.qty ?? row.count ?? 0;
                return [String(name || ""), Number(quantity || 0)];
              }
              return null;
            })
            .filter((row) => row && row[0] && row[1] > 0)
        : [];

    const obj = raw;
    const out = {};
    for (const key of Object.keys(obj)) {
      out[key] = safePocket(obj[key]);
    }
    for (const key of KNOWN_POCKET_ORDER) {
      if (!out[key]) out[key] = [];
    }
    return out;
  }

  function buildWsUrl() {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${state.settings.host}:${state.settings.port}`;
  }

  function buildDataUrl() {
    const scheme = window.location.protocol === "https:" ? "https" : "http";
    return `${scheme}://${state.settings.host}:${state.settings.port}/dashboardState`;
  }

  function buildMinimapUrl() {
    const scheme = window.location.protocol === "https:" ? "https" : "http";
    return `${scheme}://${state.settings.host}:${state.settings.port}/minimapSnapshot`;
  }

  function normalizeGameInfo(raw) {
    const info = isPlainObject(raw) ? raw : {};
    return {
      title: pickString(info.title, info.name, state.gameInfo?.title, DEFAULT_GAME_TITLE) || DEFAULT_GAME_TITLE,
      platform: pickString(info.platform, state.gameInfo?.platform, DEFAULT_PLATFORM) || DEFAULT_PLATFORM,
      romMd5: pickString(info.romMd5, info.rom_md5, state.gameInfo?.romMd5),
    };
  }

  function normalizeEmulatorInfo(raw, payload) {
    const info = isPlainObject(raw) ? raw : {};
    const source = isPlainObject(payload) ? payload : {};
    const rawWidth =
      finiteNumberOrNull(info.screenshotRawWidth) ??
      finiteNumberOrNull(info.screenshot_raw_width) ??
      finiteNumberOrNull(source.screenshotRawWidth) ??
      finiteNumberOrNull(source.screenshot_raw_width) ??
      finiteNumberOrNull(source.observationFreshness?.rawWidth) ??
      state.emulator.screenshotRawWidth ??
      DEFAULT_SCREEN_WIDTH;
    const rawHeight =
      finiteNumberOrNull(info.screenshotRawHeight) ??
      finiteNumberOrNull(info.screenshot_raw_height) ??
      finiteNumberOrNull(source.screenshotRawHeight) ??
      finiteNumberOrNull(source.screenshot_raw_height) ??
      finiteNumberOrNull(source.observationFreshness?.rawHeight) ??
      state.emulator.screenshotRawHeight ??
      DEFAULT_SCREEN_HEIGHT;
    const width =
      rawWidth ??
      finiteNumberOrNull(info.screenWidth) ??
      finiteNumberOrNull(info.screen_width) ??
      finiteNumberOrNull(source.screenWidth) ??
      finiteNumberOrNull(source.screen_width) ??
      state.emulator.screenWidth ??
      DEFAULT_SCREEN_WIDTH;
    const height =
      rawHeight ??
      finiteNumberOrNull(info.screenHeight) ??
      finiteNumberOrNull(info.screen_height) ??
      finiteNumberOrNull(source.screenHeight) ??
      finiteNumberOrNull(source.screen_height) ??
      state.emulator.screenHeight ??
      DEFAULT_SCREEN_HEIGHT;

    return {
      name: pickString(info.name, state.emulator.name),
      system: pickString(info.system, source.system, state.emulator.system),
      frame: finiteNumberOrNull(info.frame) ?? finiteNumberOrNull(source.frame) ?? state.emulator.frame,
      screenWidth: width,
      screenHeight: height,
      screenshotRawWidth: rawWidth,
      screenshotRawHeight: rawHeight,
      clientScreenWidth:
        finiteNumberOrNull(info.clientScreenWidth) ??
        finiteNumberOrNull(info.client_screen_width) ??
        finiteNumberOrNull(source.clientScreenWidth) ??
        finiteNumberOrNull(source.client_screen_width) ??
        state.emulator.clientScreenWidth,
      clientScreenHeight:
        finiteNumberOrNull(info.clientScreenHeight) ??
        finiteNumberOrNull(info.client_screen_height) ??
        finiteNumberOrNull(source.clientScreenHeight) ??
        finiteNumberOrNull(source.client_screen_height) ??
        state.emulator.clientScreenHeight,
      screenshotHash: pickString(info.screenshotHash, info.screenshot_hash, source.screenshotHash, source.screenshot_hash),
      screenshotSnapshotPath: pickString(
        info.screenshotSnapshotPath,
        info.screenshot_snapshot_path,
        source.screenshotSnapshotPath,
        source.screenshot_snapshot_path,
        source.observationFreshness?.screenshotSnapshotPath
      ),
      screenshotCacheKey: pickString(
        info.screenshotCacheKey,
        info.screenshot_cache_key,
        source.screenshotCacheKey,
        source.screenshot_cache_key,
        source.observationFreshness?.screenshotCacheKey
      ),
      screenshotAgeMs:
        finiteNumberOrNull(info.screenshotAgeMs) ??
        finiteNumberOrNull(info.screenshot_age_ms) ??
        finiteNumberOrNull(source.screenshotAgeMs) ??
        finiteNumberOrNull(source.screenshot_age_ms),
      screenshotMtimeMs:
        finiteNumberOrNull(info.screenshotMtimeMs) ??
        finiteNumberOrNull(info.screenshot_mtime_ms) ??
        finiteNumberOrNull(source.screenshotMtimeMs) ??
        finiteNumberOrNull(source.screenshot_mtime_ms),
      screenshotRawPath: pickString(
        info.screenshotRawPath,
        info.screenshot_raw_path,
        source.screenshotRawPath,
        source.screenshot_raw_path,
        source.screenshot_path,
        state.game.screenshot_raw_path,
        state.emulator.screenshotRawPath
      ),
    };
  }

  function buildServerOrigin() {
    const scheme = window.location.protocol === "https:" ? "https" : "http";
    return `${scheme}://${state.settings.host}:${state.settings.port}`;
  }

  function normalizeScreenshotUrl(rawPath, cacheKey = "") {
    const path = pickString(rawPath);
    if (!path) return "";
    const cacheValue = encodeURIComponent(String(cacheKey || Date.now()));
    if (/^https?:/i.test(path)) {
      return `${path}${path.includes("?") ? "&" : "?"}t=${cacheValue}`;
    }
    if (/^(data:|blob:|file:)/i.test(path)) return path;
    if (path.startsWith("/")) {
      return `${buildServerOrigin()}${path}${path.includes("?") ? "&" : "?"}t=${cacheValue}`;
    }
    if (/^[a-zA-Z]:[\\/]/.test(path)) {
      return `${buildServerOrigin()}/screenshot/raw?t=${cacheValue}`;
    }
    return path;
  }

  function setInputDefaults() {
    els.hostInput.value = state.settings.host;
    els.portInput.value = state.settings.port;
    els.pollInput.value = String(state.settings.pollMs);
    els.reconnectInput.checked = state.settings.autoReconnect;
  }

  function readSettingsFromInputs() {
    const host = String(els.hostInput.value || "").trim() || DEFAULT_HOST;
    const portNum = Number(els.portInput.value);
    const pollNum = Number(els.pollInput.value);

    state.settings.host = host;
    state.settings.port = Number.isFinite(portNum) && portNum > 0 ? String(Math.trunc(portNum)) : DEFAULT_PORT;
    state.settings.pollMs =
      Number.isFinite(pollNum) && pollNum >= 100 ? Math.trunc(pollNum) : DEFAULT_POLL_MS;
    state.settings.autoReconnect = Boolean(els.reconnectInput.checked);

    els.hostInput.value = state.settings.host;
    els.portInput.value = state.settings.port;
    els.pollInput.value = String(state.settings.pollMs);
  }

  function trimLogs() {
    while (state.logs.length > MAX_LOG_ENTRIES) {
      const removed = state.logs.shift();
      if (removed && removed.id === state.activeReasoningLogId) {
        state.activeReasoningLogId = null;
      }
    }
  }

  function addLog(type, message, options = {}) {
    const entry = {
      id: state.nextLogId++,
      type,
      message: typeof message === "string" ? message : "",
      data: options.data || null,
      status: options.status || null,
      callId: options.callId || null,
      ts: Date.now(),
    };
    state.logs.push(entry);
    trimLogs();
    renderLogs();
    return entry.id;
  }

  function queueReasoningChunk(chunk) {
    if (!chunk) return;
    state.reasoningBuffer += chunk;
    if (state.reasoningFlushTimer !== null) return;

    state.reasoningFlushTimer = window.setTimeout(flushReasoningBuffer, 80);
  }

  function flushReasoningBuffer() {
    if (state.reasoningFlushTimer !== null) {
      clearTimeout(state.reasoningFlushTimer);
      state.reasoningFlushTimer = null;
    }
    if (!state.reasoningBuffer) return;

    const buffered = state.reasoningBuffer;
    state.reasoningBuffer = "";

    const existing = state.logs.find((log) => log.id === state.activeReasoningLogId);
    if (!existing) {
      state.activeReasoningLogId = addLog("reasoning", buffered, { status: "streaming" });
      return;
    }

    existing.message += buffered;
    existing.ts = Date.now();
    renderLogs();
  }

  function closeReasoningStream() {
    flushReasoningBuffer();
    const existing = state.logs.find((log) => log.id === state.activeReasoningLogId);
    if (existing) {
      existing.status = "done";
    }
    state.activeReasoningLogId = null;
    renderLogs();
  }

  function summarizeAction(action) {
    if (!action || typeof action !== "object") return "Unknown action";
    const type = String(action.type || "unknown");
    if (type === "key_press") {
      const keys = Array.isArray(action.keys) ? action.keys.join(", ") : "";
      return `key_press: ${keys}`;
    }
    if (type === "path_to_location") {
      return `path_to_location -> (${action.x}, ${action.y}) on map ${action.map_id || "?"}`;
    }
    if (type === "add_marker") {
      return `add_marker ${action.emoji || ""} ${action.label || ""} @ (${action.x}, ${action.y}) map ${action.map_id || "?"}`;
    }
    if (type === "delete_marker") {
      return `delete_marker @ (${action.x}, ${action.y}) map ${action.map_id || "?"}`;
    }
    if (type === "write_memory") {
      return `write_memory: ${action.key || ""}`;
    }
    if (type === "delete_memory") {
      return `delete_memory: ${action.key || ""}`;
    }
    if (type === "update_objectives") {
      return "update_objectives";
    }
    if (type === "restart_console") {
      return "restart_console";
    }
    try {
      return `${type}: ${JSON.stringify(action)}`;
    } catch {
      return type;
    }
  }

  function parseCoordKey(key) {
    const [xRaw, yRaw] = String(key).split("_");
    return { x: Number(xRaw), y: Number(yRaw) };
  }

  function getCurrentMapMarkers(currentMapId) {
    const fromPoll = currentMapId ? state.minimap.markersByMap[currentMapId] : null;
    if (fromPoll && typeof fromPoll === "object" && !Array.isArray(fromPoll)) return fromPoll;

    const fromWs = currentMapId && state.game.markers ? state.game.markers[currentMapId] : null;
    if (fromWs && typeof fromWs === "object" && !Array.isArray(fromWs)) return fromWs;

    return {};
  }

  function pocketDisplayName(key) {
    return String(key || "")
      .replaceAll("_", " ")
      .replace(/\b\w/g, (m) => m.toUpperCase());
  }

  function renderRuntime() {
    const tokenTotals = state.tokenTotals || {};
    const timeTotals = state.timeTotals || state.game.time_usage_totals || {};
    const g = state.game;
    const gameInfo = normalizeGameInfo(state.gameInfo);
    const emulator = normalizeEmulatorInfo(state.emulator, state.game);
    const connBadge = state.isConnected
      ? `<span class="badge ok">Connected</span>`
      : `<span class="badge err">Disconnected</span>`;
    const thinkingBadge = g.isThinking
      ? `<span class="badge warn">Thinking</span>`
      : `<span class="badge">Idle</span>`;
    const bridgeBadge = g.bridgeRequestOk === false
      ? `<span class="badge err">Bridge observation stale</span>`
      : `<span class="badge ok">Bridge observation ok</span>`;

    const lines = [
      ["Game", escapeHtml(gameInfo.title)],
      ["Platform", `<span class="badge ok">${escapeHtml(gameInfo.platform)}</span>`],
      [
        "Emulator",
        [emulator.name, emulator.system].filter(Boolean).map((v) => escapeHtml(v)).join(" / ") || "-",
      ],
      ["Frame", formatOptionalNumber(emulator.frame)],
      [
        "Screen",
        `DS ${formatOptionalNumber(emulator.screenWidth)}x${formatOptionalNumber(emulator.screenHeight)}`
          + (emulator.clientScreenWidth && emulator.clientScreenHeight
            ? `, client ${formatOptionalNumber(emulator.clientScreenWidth)}x${formatOptionalNumber(emulator.clientScreenHeight)}`
            : ""),
      ],
      ["Connection", `${connBadge} ${thinkingBadge}`],
      ["Bridge", `${bridgeBadge}${g.bridgeError ? ` ${escapeHtml(g.bridgeError)}` : ""}`],
      ["Data URL", `<span class="mono">${escapeHtml(buildDataUrl())}</span>`],
      ["Last data", formatTime(state.lastDataAt || state.lastWsAt)],
      ["Step", formatOptionalNumber(g.steps)],
      ["Summary step", g.isSummaryStep ? `<span class="badge warn">Yes</span>` : "No"],
      ["Criticism step", g.isCriticismStep ? `<span class="badge warn">Yes</span>` : "No"],
      ["Until summary", formatOptionalNumber(g.remaining_until_summary)],
      ["Until criticism", formatOptionalNumber(g.remaining_until_criticism)],
      ["Total tokens", formatNumber(tokenTotals.total_tokens || g.total_tokens_accumulated || 0)],
      ["Total cost", `$${Number(tokenTotals.discounted_cost || 0).toFixed(4)}`],
      ["Reasoning time", formatMs(timeTotals.reasoning_ms || 0)],
      ["Tools time", formatMs(timeTotals.tools_ms || 0)],
      ["Overall time", formatMs(timeTotals.overall_ms || 0)],
      ["Down time", formatMs(timeTotals.down_ms || 0)],
      ["Safari active", g.safari_zone_active ? "Yes" : "No"],
      ["Safari steps", formatNumber(g.safari_zone_counter || 0)],
    ];

    els.runtimeGrid.innerHTML = lines
      .map(([k, v]) => `<div class="k">${escapeHtml(k)}</div><div>${v}</div>`)
      .join("");
  }

  function renderObservationContract() {
    const g = state.game || {};
    const policy = isPlainObject(g.observationPolicy) ? g.observationPolicy : {};
    const freshness = isPlainObject(g.observationFreshness) ? g.observationFreshness : {};
    const details = isPlainObject(g.stateReliabilityDetails) ? g.stateReliabilityDetails : {};
    const position = isPlainObject(details.position) ? details.position : {};
    const screenshotAge = finiteNumberOrNull(freshness.screenshotAgeMs);
    const heartbeatAge = finiteNumberOrNull(freshness.heartbeatAgeSeconds);
    const hash = pickString(freshness.screenshotHash, g.screenshotHash);
    const screenshotFresh = freshness.screenshotFresh ?? g.screenshotFresh;
    const lines = [
      ["Mode", escapeHtml(policy.mode || g.game?.observationMode || "standard")],
      ["Bridge request", g.bridgeRequestOk === false ? `<span class="badge err">ok=false</span>` : `<span class="badge ok">ok=true</span>`],
      ["Bridge error", g.bridgeError ? escapeHtml(g.bridgeError) : "-"],
      ["Oracle exposed", policy.exposeOracle === true || g.game?.exposeOracle === true ? `<span class="badge err">Yes</span>` : `<span class="badge ok">No</span>`],
      ["Confidence required", policy.stateConfidenceRequired === false ? `<span class="badge warn">No</span>` : `<span class="badge ok">Yes</span>`],
      ["State reliability", escapeHtml(g.stateReliability || g.game?.stateReliability || "-")],
      ["Position", `${escapeHtml(position.source || "-")} / ${escapeHtml(position.confidence || "-")}`],
      ["Screenshot age", screenshotAge === null ? "-" : `${formatNumber(screenshotAge)} ms`],
      ["Screenshot hash", hash ? `<span class="mono">${escapeHtml(hash.slice(0, 16))}</span>` : "-"],
      ["Heartbeat age", heartbeatAge === null ? "-" : `${heartbeatAge.toFixed(2)}s`],
      ["Screenshot fresh", screenshotFresh === false ? `<span class="badge err">No</span>` : `<span class="badge ok">Yes</span>`],
      ["Visual", freshness.visualAvailable === false ? `<span class="badge err">Unavailable</span>` : `<span class="badge ok">Available</span>`],
    ];
    els.observationGrid.innerHTML = lines
      .map(([k, v]) => `<div class="k">${escapeHtml(k)}</div><div>${v}</div>`)
      .join("");
  }

  function renderBenchmarkMetrics() {
    const metrics = isPlainObject(state.game.benchmarkMetrics) ? state.game.benchmarkMetrics : {};
    const lines = [
      ["Run", `<span class="mono">${escapeHtml(metrics.run_id || "-")}</span>`],
      ["Provider/model", `${escapeHtml(metrics.provider || "-")} / ${escapeHtml(metrics.model || "-")}`],
      ["Steps", formatOptionalNumber(metrics.step_count)],
      ["Action batches", formatOptionalNumber(metrics.action_batches)],
      [
        "Semantic commands",
        `${formatOptionalNumber(metrics.successful_commands)} completed / ${formatOptionalNumber(metrics.failed_commands)} hard failed`,
      ],
      ["Raw accepted", formatOptionalNumber(metrics.raw_successful_commands)],
      [
        "Observed effects",
        `${formatOptionalNumber(metrics.observed_effect_commands)} seen / ${formatOptionalNumber(metrics.no_visible_effect_commands)} none / ${formatOptionalNumber(metrics.effect_unknown_commands)} unknown`,
      ],
      ["Collisions", formatOptionalNumber(metrics.collisions)],
      ["Maps", Array.isArray(metrics.unique_maps) ? formatNumber(metrics.unique_maps.length) : "0"],
      ["Explored tiles", formatOptionalNumber(metrics.minimap_explored_tiles)],
      ["Progress", `${formatOptionalNumber(metrics.progress_steps_completed)} done`],
      [
        "Pathfinding",
        `${formatOptionalNumber(metrics.path_to_location_success)} target reached / ${formatOptionalNumber(metrics.path_to_location_partial)} partial / ${formatOptionalNumber(metrics.path_to_location_fail)} failed`,
      ],
      ["Stale shots", formatOptionalNumber(metrics.stale_screenshots)],
      ["Bridge timeouts", formatOptionalNumber(metrics.bridge_timeouts)],
      ["Model calls", `${formatOptionalNumber(metrics.model_calls)} (${formatMs(metrics.total_model_ms || 0)})`],
    ];
    els.metricsGrid.innerHTML = lines
      .map(([k, v]) => `<div class="k">${escapeHtml(k)}</div><div>${v}</div>`)
      .join("");
  }

  function renderModelSurface() {
    if (!els.modelSurfaceWrap) return;
    const metrics = isPlainObject(state.game.benchmarkMetrics) ? state.game.benchmarkMetrics : {};
    const lastCall = isPlainObject(metrics.last_model_call) ? metrics.last_model_call : {};
    const latestObservation = isPlainObject(metrics.latest_model_observation) ? metrics.latest_model_observation : {};
    const surface = Object.keys(latestObservation).length > 0 ? latestObservation : lastCall;
    const latestCodexDesktopObservationArtifact = isPlainObject(state.game.latestCodexDesktopObservationArtifact)
      ? state.game.latestCodexDesktopObservationArtifact
      : {};
    const artifact = isPlainObject(latestCodexDesktopObservationArtifact.artifact)
      ? latestCodexDesktopObservationArtifact.artifact
      : {};
    const model_input = isPlainObject(artifact.model_input)
      ? artifact.model_input
      : isPlainObject(state.game.model_input)
        ? state.game.model_input
        : {};
    const decodedRam =
      isPlainObject(model_input.decoded_ram) || Array.isArray(model_input.decoded_ram)
        ? model_input.decoded_ram
        : isPlainObject(artifact.decoded_ram_snapshot) || Array.isArray(artifact.decoded_ram_snapshot)
          ? artifact.decoded_ram_snapshot
          : state.game.decoded_ram || null;
    const artifactImage = isPlainObject(model_input.image) ? model_input.image : {};
    const modelImage = Object.keys(artifactImage).length > 0
      ? artifactImage
      : isPlainObject(surface.model_image)
        ? surface.model_image
        : {};
    const health = isPlainObject(metrics.harness_health) ? metrics.harness_health : {};
    const mismatch = isPlainObject(health.observation_mode_mismatch) ? health.observation_mode_mismatch : null;
    const contract = isPlainObject(metrics.benchmark_contract) ? metrics.benchmark_contract : {};
    const imageId = pickString(modelImage.image_id, modelImage.screenshot_hash, modelImage.screenshotHash);
    const artifactPath = pickString(latestCodexDesktopObservationArtifact.path, surface.observation_artifact_path);
    const modelInputText = typeof model_input.user_input_text === "string" ? model_input.user_input_text : "";
    const decodedRamText = jsonPreview(decodedRam, 22000);
    const lines = [
      ["Provider/model", `${escapeHtml(metrics.provider || "-")} / ${escapeHtml(metrics.model || "-")}`],
      ["Lane", `${escapeHtml(metrics.benchmark_lane || "-")} ${metrics.benchmark_comparable === false ? `<span class="badge warn">not comparable</span>` : `<span class="badge ok">comparable</span>`}`],
      ["No shell/repo tools", contract.provider === "codex-desktop" ? `<span class="badge ok">Required</span>` : `<span class="badge warn">Check provider</span>`],
      ["Dashboard source", `${escapeHtml(state.game.dashboard_source || "-")} ${state.game.bridge_polling === false ? `<span class="badge ok">bridge_polling=false</span>` : `<span class="badge warn">bridge polling unknown</span>`}`],
      ["Artifact step", formatOptionalNumber(artifact.step ?? state.game.steps)],
      ["Model input time", artifact.artifact_provenance?.at ? `<span class="mono">${escapeHtml(artifact.artifact_provenance.at)}</span>` : surface.at ? `<span class="mono">${escapeHtml(surface.at)}</span>` : "-"],
      ["Monitor artifact", artifactPath ? `<span class="mono">${escapeHtml(artifactPath)}</span>` : "-"],
      ["Monitor image path", modelImage.path ? `<span class="mono">${escapeHtml(modelImage.path)}</span>` : "-"],
      ["Image size", modelImage.width && modelImage.height ? `${formatNumber(modelImage.width)}x${formatNumber(modelImage.height)} scale ${escapeHtml(modelImage.scale || "-")}` : "-"],
      ["Raw size", modelImage.raw_width && modelImage.raw_height ? `${formatNumber(modelImage.raw_width)}x${formatNumber(modelImage.raw_height)}` : modelImage.rawWidth && modelImage.rawHeight ? `${formatNumber(modelImage.rawWidth)}x${formatNumber(modelImage.rawHeight)}` : "-"],
      ["Image id/hash", imageId ? `<span class="mono">${escapeHtml(String(imageId).slice(0, 18))}</span>` : "-"],
      ["Mode mismatch", mismatch ? `<span class="badge err">${escapeHtml(mismatch.configured_mode)} != ${escapeHtml(mismatch.bridge_mode)}</span>` : `<span class="badge ok">No</span>`],
      ["Monitor split", `<span class="badge ok">Dashboard reads saved artifact details; gameplay uses model_input</span>`],
    ];
    const modelInputBlocks = `
      <details class="model-input-block" open>
        <summary>model_input.user_input_text</summary>
        <pre class="model-input-pre">${escapeHtml(modelInputText || "(empty)")}</pre>
      </details>
      <details class="model-input-block" open>
        <summary>model_input.decoded_ram</summary>
        <pre class="model-input-pre">${escapeHtml(decodedRamText || "(empty)")}</pre>
      </details>
    `;
    els.modelSurfaceWrap.innerHTML = `
      <div class="kv-grid compact">
        ${lines.map(([k, v]) => `<div class="k">${escapeHtml(k)}</div><div>${v}</div>`).join("")}
      </div>
      ${modelInputBlocks}
    `;
  }

  function effectBadge(value) {
    if (value === true) return `<span class="badge ok">Observed</span>`;
    if (value === false) return `<span class="badge warn">No visible effect</span>`;
    return `<span class="badge">Unknown</span>`;
  }

  function semanticStatusBadge(result) {
    const outcome = String(result?.semantic_outcome || "").trim();
    const rawFailed = result?.success === false || result?.raw_success === false;
    if (!rawFailed && (result?.semantic_success === true || /^(completed|verified|semantic_completed|target_verified)$/i.test(outcome))) {
      return `<span class="badge ok">Completed</span>`;
    }
    if (/^(partial_progress)$/i.test(outcome)) return `<span class="badge warn">Partial</span>`;
    if (/^(failed|blocked|harness_error|input_not_delivered)$/i.test(outcome) || rawFailed) {
      return `<span class="badge err">Failed</span>`;
    }
    if (result?.raw_success === true || result?.success === true || result?.input_delivered === true || result?.visible_effect === true) {
      return `<span class="badge warn">Unverified</span>`;
    }
    return `<span class="badge">Unknown</span>`;
  }

  function rawInputBadge(result) {
    if (result?.input_delivered === false || result?.success === false) return `<span class="badge err">Not delivered</span>`;
    if (result?.raw_success === true || result?.success === true || result?.input_delivered === true) {
      return `<span class="badge warn">Raw sent</span>`;
    }
    return `<span class="badge">Unknown</span>`;
  }

  function renderActionEffect() {
    const metrics = isPlainObject(state.game.benchmarkMetrics) ? state.game.benchmarkMetrics : {};
    const batch = isPlainObject(metrics.last_action_batch) ? metrics.last_action_batch : {};
    const summary = isPlainObject(batch.effect_summary) ? batch.effect_summary : {};
    const results = Array.isArray(batch.results) ? batch.results : [];
    if (!els.actionEffectWrap) return;
    if (!batch.call_id && results.length === 0) {
      els.actionEffectWrap.innerHTML = `<div class="muted">No action batch recorded yet.</div>`;
      return;
    }

    const header = `
      <div class="kv-grid compact">
        <div class="k">Last call</div><div><span class="mono">${escapeHtml(batch.call_id || "-")}</span></div>
        <div class="k">Batch effect</div><div>${formatOptionalNumber(summary.observed)} seen / ${formatOptionalNumber(summary.no_visible_effect)} none / ${formatOptionalNumber(summary.unknown)} unknown</div>
        <div class="k">Duration</div><div>${formatMs(batch.duration_ms || 0)}</div>
      </div>
    `;

    const rows = results.length
      ? results
          .map(
            (result, index) => `
              <div class="memory-item">
                <div class="pokemon-head">
                  <div>
                    <div class="pokemon-name">${escapeHtml(result.action_type || `action ${index + 1}`)}</div>
                    <div class="pokemon-sub">${escapeHtml(result.message || "")}</div>
                  </div>
                  <div>${effectBadge(result.effect_observed)}</div>
                </div>
                <div class="kv-grid compact">
                  <div class="k">Reason</div><div>${escapeHtml(result.effect_reason || "-")}</div>
                  <div class="k">Frame delta</div><div>${formatOptionalNumber(result.frame_delta)}</div>
                  <div class="k">Semantic status</div><div>${semanticStatusBadge(result)}</div>
                  <div class="k">Raw input</div><div>${rawInputBadge(result)}</div>
                  <div class="k">Outcome</div><div>${escapeHtml(result.semantic_outcome || "-")}</div>
                  <div class="k">Target verified</div><div>${result.semantic_target_verified === true ? `<span class="badge ok">Yes</span>` : result.semantic_target_verified === false ? `<span class="badge err">No</span>` : `<span class="badge">Unknown</span>`}</div>
                </div>
              </div>
            `
          )
          .join("")
      : `<div class="muted">No per-action effect rows.</div>`;

    els.actionEffectWrap.innerHTML = header + rows;
  }

  function renderStuckDetector() {
    const stuck = isPlainObject(state.game.stuckState)
      ? state.game.stuckState
      : isPlainObject(state.game.benchmarkMetrics?.stuck)
        ? state.game.benchmarkMetrics.stuck
        : {};
    const active = stuck.active === true;
    const warnings = Array.isArray(stuck.warnings) ? stuck.warnings.slice(0, 5) : [];
    els.stuckWrap.innerHTML = `
      <div>${active ? `<span class="badge err">Active</span>` : `<span class="badge ok">Clear</span>`} ${escapeHtml(stuck.reason || "")}</div>
      <div class="kv-grid compact">
        <div class="k">Same screenshot</div><div>${formatOptionalNumber(stuck.same_screenshot_count)}</div>
        <div class="k">Same position</div><div>${formatOptionalNumber(stuck.same_position_count)}</div>
        <div class="k">Same action</div><div>${formatOptionalNumber(stuck.same_action_count)}</div>
        <div class="k">No progress</div><div>${formatOptionalNumber(stuck.no_progress_steps)}</div>
        <div class="k">Episodes</div><div>${formatOptionalNumber(stuck.episodes)}</div>
      </div>
      ${
        warnings.length
          ? warnings.map((w) => `<div class="memory-item"><span class="muted">${escapeHtml(w.ts || "")}</span><br>${escapeHtml(w.reason || "")}</div>`).join("")
          : `<div class="muted">No stuck warnings.</div>`
      }
    `;
  }

  function renderDsScreen() {
    const gameInfo = normalizeGameInfo(state.gameInfo);
    const emulator = normalizeEmulatorInfo(state.emulator, state.game);
    const width = finiteNumberOrNull(emulator.screenWidth) ?? DEFAULT_SCREEN_WIDTH;
    const height = finiteNumberOrNull(emulator.screenHeight) ?? DEFAULT_SCREEN_HEIGHT;
    const rawPath = emulator.screenshotRawPath;
    const cacheKey = emulator.screenshotCacheKey || emulator.screenshotHash || emulator.screenshotMtimeMs || emulator.frame || Date.now();
    const screenshotUrl = normalizeScreenshotUrl(state.game.screenshot_url || rawPath, cacheKey);
    const freshness = isPlainObject(state.game.observationFreshness) ? state.game.observationFreshness : {};
    const screenshotFresh = freshness.screenshotFresh ?? state.game.screenshotFresh ?? emulator.screenshotFresh;
    const visualUnavailable = freshness.visualAvailable === false || state.game.observationUnavailable === true;

    els.screenMeta.innerHTML = [
      `<span class="badge ok">${escapeHtml(gameInfo.title)}</span>`,
      `<span class="badge">${escapeHtml(gameInfo.platform)}</span>`,
      emulator.system ? `<span class="badge">${escapeHtml(emulator.system)}</span>` : "",
      `<span class="mono">DS ${formatOptionalNumber(width)}x${formatOptionalNumber(height)}</span>`,
      emulator.clientScreenWidth && emulator.clientScreenHeight
        ? `<span class="badge">client ${formatOptionalNumber(emulator.clientScreenWidth)}x${formatOptionalNumber(emulator.clientScreenHeight)}</span>`
        : "",
      emulator.screenshotAgeMs != null ? `<span class="badge">${escapeHtml(String(emulator.screenshotAgeMs))} ms</span>` : "",
    ]
      .filter(Boolean)
      .join("");

    if (!screenshotUrl) {
      els.screenFrame.innerHTML = `<div class="ds-screen-placeholder">Waiting for Nintendo DS screenshot.</div>`;
      els.screenPath.innerHTML = `<span class="muted">No screenshot path yet.</span>`;
      return;
    }

    if (screenshotFresh === false || visualUnavailable) {
      els.screenFrame.innerHTML = `<div class="ds-screen-placeholder">Screenshot is stale or unavailable. ${escapeHtml(state.game.bridgeError || "")}</div>`;
      els.screenPath.innerHTML = `<span class="muted">${escapeHtml(emulator.screenshotSnapshotPath || rawPath || "No fresh screenshot")}</span>`;
      return;
    }

    els.screenFrame.style.aspectRatio = `${Math.trunc(width)} / ${Math.trunc(height)}`;
    els.screenFrame.innerHTML = `
      <img
        class="ds-screen-img"
        src="${escapeHtml(screenshotUrl)}"
        alt="${escapeHtml(gameInfo.title)} ${escapeHtml(gameInfo.platform)} screenshot"
        width="${Math.trunc(width)}"
        height="${Math.trunc(height)}"
      />
      <span class="ds-screen-label top">Top screen</span>
      <span class="ds-screen-label bottom">Bottom touch screen</span>
    `;
    els.screenPath.textContent = emulator.screenshotSnapshotPath || rawPath || screenshotUrl;

    const image = els.screenFrame.querySelector("img");
    if (image) {
      image.onerror = () => {
        els.screenFrame.innerHTML = `<div class="ds-screen-placeholder">Screenshot path is present, but the browser could not load it.</div>`;
      };
    }
  }

  function renderTrainer() {
    const t = state.game.current_trainer_data;
    if (!isPlainObject(t)) {
      els.trainerGrid.innerHTML = `<div class="muted">Waiting for trainer data...</div>`;
      return;
    }

    const pos = isPlainObject(t.position) ? t.position : {};
    const badges = isPlainObject(t.badges) ? t.badges : {};
    const badgeNames = Object.keys(badges).filter((k) => Boolean(badges[k]));
    const inBattle = Boolean(state.game.battle_data?.in_battle || state.game.is_in_battle);
    const money = finiteNumberOrNull(t.money);

    const lines = [
      ["Name", escapeHtml(pickString(t.name, "Unknown Trainer"))],
      ["Money", money === null ? "-" : `$${formatNumber(money)}`],
      ["Map", `${escapeHtml(pos.map_name || "-")} <span class="muted">(${escapeHtml(pos.map_id || "-")})</span>`],
      ["Position", `<span class="mono">X=${formatOptionalNumber(pos.x)} Y=${formatOptionalNumber(pos.y)}</span>`],
      ["Badges", finiteNumberOrNull(t.badge_count) === null ? formatNumber(badgeNames.length) : formatOptionalNumber(t.badge_count)],
      [
        "Flags",
        [
          state.game.flash_needed ? `<span class="badge warn">Flash Needed</span>` : "",
          state.game.flash_active ? `<span class="badge ok">Flash Active</span>` : "",
          state.game.visibility_reduced ? `<span class="badge warn">Reduced Visibility</span>` : "",
          state.game.is_talking_to_npc ? `<span class="badge warn">In Dialog</span>` : "",
          inBattle ? `<span class="badge err">In Battle</span>` : "",
        ]
          .filter(Boolean)
          .join(" ") || `<span class="muted">None</span>`,
      ],
      [
        "Badges list",
        badgeNames.length > 0
          ? badgeNames.map((b) => `<span class="badge">${escapeHtml(b)}</span>`).join(" ")
          : `<span class="muted">None</span>`,
      ],
    ];

    els.trainerGrid.innerHTML = lines
      .map(([k, v]) => `<div class="k">${escapeHtml(k)}</div><div>${v}</div>`)
      .join("");
  }

  function renderBattlePokemon(mon, side) {
    if (!isPlainObject(mon)) return "";
    const maxHp = Number(mon.max_hp || 0);
    const curHp = Number(mon.current_hp || 0);
    const hpPct = maxHp > 0 ? Math.max(0, Math.min(100, (curHp / maxHp) * 100)) : 0;
    const hpClass = hpPct <= 20 ? "critical" : hpPct <= 50 ? "low" : "";
    const moves = Array.isArray(mon.moves) ? mon.moves.filter((m) => isPlainObject(m)) : [];
    const title = side === "enemy" ? mon.species_name || mon.nickname || "Enemy" : mon.nickname || mon.species_name || "Player";
    const subtitle = [
      mon.species_name && mon.species_name !== title ? mon.species_name : "",
      Number.isFinite(Number(mon.level)) ? `Lv ${formatNumber(mon.level)}` : "",
      mon.position ? `pos ${mon.position}` : "",
      mon.battler_id !== undefined && mon.battler_id !== null ? `id ${mon.battler_id}` : "",
    ]
      .filter(Boolean)
      .join(" / ");

    return `
      <article class="battle-mon ${side === "enemy" ? "enemy" : "player"}">
        <div class="pokemon-head">
          <div>
            <div class="pokemon-name">${escapeHtml(title || "Unknown")}</div>
            <div class="pokemon-sub">${escapeHtml(subtitle || "-")}</div>
          </div>
          <div>${mon.status ? `<span class="badge warn">${escapeHtml(mon.status)}</span>` : `<span class="badge ok">OK</span>`}</div>
        </div>
        <div class="hp-row">
          <div class="hp-track"><div class="hp-fill ${hpClass}" style="width:${hpPct}%"></div></div>
          <div class="hp-label">${formatNumber(curHp)} / ${formatNumber(maxHp)} HP</div>
        </div>
        <div class="pokemon-sub">Types: ${Array.isArray(mon.types) && mon.types.length > 0 ? mon.types.map((t) => escapeHtml(t)).join(", ") : "?"}</div>
        ${
          moves.length > 0
            ? `<ul class="moves">${moves
                .map((m) => `<li>${escapeHtml(m.name || "?")} <span class="muted">PP ${formatNumber(m.pp || 0)}</span></li>`)
                .join("")}</ul>`
            : ""
        }
      </article>
    `;
  }

  function renderBattle() {
    const battle = isPlainObject(state.game.battle_data) ? state.game.battle_data : {};
    const visibleText = isPlainObject(state.game.current_visible_text) ? state.game.current_visible_text : null;
    const recentText = Array.isArray(state.game.recent_visible_text)
      ? state.game.recent_visible_text.filter((entry) => isPlainObject(entry)).slice(-6)
      : [];
    const playerMons = Array.isArray(battle.player_pokemons) ? battle.player_pokemons.filter((p) => isPlainObject(p)) : [];
    const enemyMons = Array.isArray(battle.enemy_pokemons) ? battle.enemy_pokemons.filter((p) => isPlainObject(p)) : [];
    const inBattle = Boolean(battle.in_battle || state.game.is_in_battle);

    const meta = [
      `<span class="badge">Dashboard monitor data</span>`,
      inBattle ? `<span class="badge err">In battle</span>` : `<span class="badge ok">Not in battle</span>`,
      battle.source ? `<span class="badge">${escapeHtml(battle.source)}</span>` : "",
      battle.validation ? `<span class="badge">${escapeHtml(battle.validation)}</span>` : "",
      battle.is_trainer_battle ? `<span class="badge warn">Trainer</span>` : "",
      battle.is_double_battle ? `<span class="badge warn">Double</span>` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const currentText =
      visibleText && visibleText.active === true && typeof visibleText.text === "string" && visibleText.text.trim()
        ? `<div class="battle-text-current"><span class="muted">${escapeHtml(visibleText.surface || "text")}</span><br>${escapeHtml(
            visibleText.text.trim()
          )}</div>`
        : `<div class="muted">No current RAM text.</div>`;

    const history =
      recentText.length > 0
        ? recentText
            .map(
              (entry) => `
                <div class="battle-text-line">
                  <span class="mono">${escapeHtml(String(entry.frame ?? "?"))}</span>
                  <span class="muted">${escapeHtml(entry.surface || "text")}</span>
                  ${escapeHtml(entry.text || "")}
                </div>
              `
            )
            .join("")
        : `<div class="muted">No recent battle/dialogue text.</div>`;

    els.battleWrap.innerHTML = `
      <div class="battle-meta">${meta}</div>
      <div class="battle-columns">
        <div>
          <h3>Player side</h3>
          ${playerMons.length ? playerMons.map((mon) => renderBattlePokemon(mon, "player")).join("") : `<div class="muted">No active player battle RAM.</div>`}
        </div>
        <div>
          <h3>Enemy side <span class="muted">dashboard-only exact HP</span></h3>
          ${enemyMons.length ? enemyMons.map((mon) => renderBattlePokemon(mon, "enemy")).join("") : `<div class="muted">No active enemy battle RAM.</div>`}
        </div>
      </div>
      <h3>Visible RAM text</h3>
      ${currentText}
      <h3>Recent text history</h3>
      <div class="battle-text-history">${history}</div>
    `;
  }

  function renderTeam() {
    const team = Array.isArray(state.game.current_pokemon_data)
      ? state.game.current_pokemon_data.filter((p) => isPlainObject(p))
      : [];
    const battle = isPlainObject(state.game.battle_data) ? state.game.battle_data : {};
    const activeIndices = new Set(
      Array.isArray(battle.party_indices)
        ? battle.party_indices.map((v) => Number(v))
        : Number.isFinite(Number(battle.party_index))
          ? [Number(battle.party_index)]
          : []
    );

    if (team.length === 0) {
      els.teamList.innerHTML = `<div class="muted">No team data yet.</div>`;
      return;
    }

    els.teamList.innerHTML = team
      .map((p, idx) => {
        const maxHp = Number(p.max_hp || 0);
        const curHp = Number(p.current_hp || 0);
        const hpPct = maxHp > 0 ? Math.max(0, Math.min(100, (curHp / maxHp) * 100)) : 0;
        const hpClass = hpPct <= 20 ? "critical" : hpPct <= 50 ? "low" : "";
        const inBattle = Boolean(state.game.battle_data?.in_battle || state.game.is_in_battle) && activeIndices.has(idx);

        const moves = Array.isArray(p.moves) ? p.moves.filter((m) => isPlainObject(m)) : [];
        const moveRows =
          moves.length > 0
            ? `<ul class="moves">${moves
                .map((m) => `<li>${escapeHtml(m.name || "?")} <span class="muted">PP ${formatNumber(m.pp || 0)}</span></li>`)
                .join("")}</ul>`
            : `<div class="muted">No moves</div>`;

        return `
          <article class="pokemon-card">
            <div class="pokemon-head">
              <div>
                <div class="pokemon-name">${escapeHtml(p.nickname || p.species_name || "Unknown")}</div>
                <div class="pokemon-sub">${escapeHtml(p.species_name || "Unknown")} • Lv ${formatNumber(p.level || 0)}</div>
              </div>
              <div>
                ${inBattle ? `<span class="badge warn">Active in battle</span>` : ""}
                ${p.status ? `<span class="badge err">${escapeHtml(p.status)}</span>` : ""}
                ${p.is_shiny ? `<span class="badge ok">Shiny</span>` : ""}
              </div>
            </div>
            <div class="hp-row">
              <div class="hp-track"><div class="hp-fill ${hpClass}" style="width:${hpPct}%"></div></div>
              <div class="hp-label">${formatNumber(curHp)} / ${formatNumber(maxHp)} HP</div>
            </div>
            <div class="pokemon-sub">Types: ${Array.isArray(p.types) && p.types.length > 0 ? p.types.map((t) => escapeHtml(t)).join(", ") : "?"}</div>
            ${moveRows}
          </article>
        `;
      })
      .join("");
  }

  function renderInventory() {
    const inventory = normalizeInventory(state.game.inventory_data);
    const pockets = Object.keys(inventory).sort((a, b) => {
      const ia = KNOWN_POCKET_ORDER.indexOf(a);
      const ib = KNOWN_POCKET_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    els.inventoryWrap.innerHTML = pockets
      .map((pocketKey) => {
        const items = Array.isArray(inventory[pocketKey]) ? inventory[pocketKey] : [];
        const rows =
          items.length > 0
            ? `<table class="table-lite"><tbody>${items
                .map(
                  (item) => `
                  <tr>
                    <td>${escapeHtml(item[0] || "")}</td>
                    <td class="mono" style="text-align:right;">x${formatNumber(item[1] || 0)}</td>
                  </tr>
                `
                )
                .join("")}</tbody></table>`
            : `<div class="muted">Empty</div>`;

        return `
          <article class="pocket-card">
            <h4>${escapeHtml(pocketDisplayName(pocketKey))} <span class="muted">(${formatNumber(items.length)})</span></h4>
            ${rows}
          </article>
        `;
      })
      .join("");
  }

  function renderObjectives() {
    const obj = state.game.objectives;
    if (!obj || typeof obj !== "object") {
      els.objectivesWrap.innerHTML = `<div class="muted">No objectives yet.</div>`;
      return;
    }

    const renderObjectiveBlock = (title, value) => {
      if (!value || typeof value !== "object") {
        return `<article class="objective-card"><h4>${escapeHtml(title)}</h4><div class="muted">Not set</div></article>`;
      }
      return `
        <article class="objective-card">
          <h4>${escapeHtml(title)}</h4>
          <div><strong>${escapeHtml(value.short_description || "-")}</strong></div>
          <div class="muted">${escapeHtml(value.description || "")}</div>
        </article>
      `;
    };

    const others = Array.isArray(obj.others) ? obj.others : [];
    const othersHtml =
      others.length > 0
        ? others
            .map(
              (it, idx) => `
            <article class="objective-card">
              <h4>Other ${idx + 1}</h4>
              <div><strong>${escapeHtml(isPlainObject(it) ? it.short_description || "-" : "-")}</strong></div>
              <div class="muted">${escapeHtml(isPlainObject(it) ? it.description || "" : "")}</div>
            </article>
          `
            )
            .join("")
        : `<article class="objective-card"><h4>Others</h4><div class="muted">No extra objectives.</div></article>`;

    els.objectivesWrap.innerHTML =
      renderObjectiveBlock("Primary", obj.primary) +
      renderObjectiveBlock("Secondary", obj.secondary) +
      renderObjectiveBlock("Third", obj.third) +
      othersHtml;
  }

  function renderProgress() {
    const steps = Array.isArray(state.game.progressSteps) ? state.game.progressSteps : [];
    if (steps.length === 0) {
      els.progressWrap.innerHTML = `<div class="muted">No progress data yet.</div>`;
      return;
    }

    const doneCount = steps.filter((s) => s && s.done).length;
    const pct = Math.max(0, Math.min(100, (doneCount / steps.length) * 100));

    const items = steps
      .map((step) => {
        const done = Boolean(step?.done);
        return `
          <div class="progress-item ${done ? "done" : ""}">
            <div>
              <div>${done ? "✅" : "⬜"} ${escapeHtml(step?.label || step?.id || "Unnamed step")}</div>
              <div class="meta">${escapeHtml(step?.type || "?")} • trigger: ${escapeHtml(step?.trigger || "?")}</div>
            </div>
            <div class="meta">${escapeHtml(step?.done_on || "")}</div>
          </div>
        `;
      })
      .join("");

    els.progressWrap.innerHTML = `
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="muted" style="margin-bottom: 0.4rem;">${formatNumber(doneCount)} / ${formatNumber(
        steps.length
      )} steps done (${pct.toFixed(1)}%)</div>
      ${items}
    `;
  }

  function renderMemory() {
    const memory = state.game.memory && typeof state.game.memory === "object" ? state.game.memory : {};
    const keys = Object.keys(memory).sort((a, b) => a.localeCompare(b));
    if (keys.length === 0) {
      els.memoryWrap.innerHTML = `<div class="muted">Memory is empty.</div>`;
      return;
    }

    els.memoryWrap.innerHTML = keys
      .map(
        (key) => `
        <article class="memory-item">
          <div><strong>${escapeHtml(key)}</strong></div>
          <div class="muted">${escapeHtml(String(memory[key] ?? ""))}</div>
        </article>
      `
      )
      .join("");
  }

  function renderStreams() {
    els.summaryTitle.textContent = state.streams.summaryInProgress
      ? "Summary (streaming...)"
      : "Summary";
    els.criticismTitle.textContent = state.streams.criticismInProgress
      ? "Criticism (streaming...)"
      : "Criticism";

    const summaryFallback = state.game.last_summary || "";
    const criticismFallback = state.game.last_criticism || "";
    els.summaryStream.textContent = state.streams.summaryText || summaryFallback || "";
    els.criticismStream.textContent = state.streams.criticismText || criticismFallback || "";
  }

  function renderMinimap() {
    const mm = state.minimap.data;
    if (!mm || !Array.isArray(mm.grid) || mm.grid.length === 0 || !Array.isArray(mm.grid[0])) {
      const pos = state.game.current_trainer_data?.position || {};
      const hint = pickString(mm?.visibility_hint, "HeartGold is currently screenshot-first; no verified minimap grid is available.");
      els.minimapMeta.innerHTML = [
        `<span class="badge warn">Screenshot-first navigation</span>`,
        pos.map_name ? `Map: <strong>${escapeHtml(pos.map_name)}</strong>` : "",
        pos.map_id ? `ID: <span class="mono">${escapeHtml(pos.map_id)}</span>` : "",
        `<span class="muted">${escapeHtml(hint)}</span>`,
      ]
        .filter(Boolean)
        .join(" • ");
      els.minimapGrid.innerHTML = "";
      els.minimapLegend.innerHTML = `<div class="muted">No tiles.</div>`;
      els.markerList.innerHTML = `<div class="muted">No markers.</div>`;
      return;
    }

    const grid = mm.grid;
    const height = Number.isFinite(Number(mm.height)) ? Number(mm.height) : grid.length;
    const width =
      Number.isFinite(Number(mm.width)) && Number(mm.width) > 0 ? Number(mm.width) : grid[0].length;

    const mapId =
      typeof mm.map_id === "string"
        ? mm.map_id
        : state.game.current_trainer_data?.position?.map_id || null;
    const mapName =
      typeof mm.map_name === "string"
        ? mm.map_name
        : state.game.current_trainer_data?.position?.map_name || "-";
    const playerX = Number(mm.player_x);
    const playerY = Number(mm.player_y);
    const orientation = Number(mm.orientation);
    const markers = getCurrentMapMarkers(mapId);

    const usedTileIds = new Set();
    const tiles = [];

    for (let y = 0; y < height; y++) {
      const row = Array.isArray(grid[y]) ? grid[y] : [];
      for (let x = 0; x < width; x++) {
        const rawId = row[x];
        const id = rawId === null || rawId === undefined ? null : Number(rawId);
        if (id !== null && Number.isFinite(id)) usedTileIds.add(id);

        const tileDef = id !== null && Number.isFinite(id) && TILES[id] ? TILES[id] : FALLBACK_TILE;
        let symbol = tileDef[0];
        let tileClass = "tile";

        if (x === playerX && y === playerY) {
          symbol = ORIENTATION_SYMBOLS[orientation] || "🧍";
          tileClass += " tile-player";
        } else if (id === null || !Number.isFinite(id)) {
          tileClass += " tile-unknown";
        }

        const marker = markers[`${x}_${y}`];
        if (marker && typeof marker === "object" && marker.emoji) {
          symbol = `${symbol}${String(marker.emoji)}`;
        }

        const markerTitle =
          marker && typeof marker === "object"
            ? ` | Marker: ${String(marker.emoji || "")} ${String(marker.label || "")}`
            : "";
        const title = `${x},${y} | ${tileDef[1]}${markerTitle}`;

        tiles.push(`<div class="${tileClass}" title="${escapeHtml(title)}">${escapeHtml(symbol)}</div>`);
      }
    }

    els.minimapGrid.style.gridTemplateColumns = `repeat(${width}, var(--tile-size))`;
    els.minimapGrid.innerHTML = tiles.join("");

    els.minimapMeta.innerHTML = [
      `Map: <strong>${escapeHtml(mapName)}</strong>`,
      mapId ? `ID: <span class="mono">${escapeHtml(mapId)}</span>` : "",
      `Size: <span class="mono">${formatNumber(width)}x${formatNumber(height)}</span>`,
      `Player: <span class="mono">X=${formatNumber(playerX)} Y=${formatNumber(playerY)}</span>`,
      Number.isFinite(Number(mm.seq)) ? `Seq: ${formatNumber(mm.seq)}` : "",
      Number.isFinite(Number(mm.updatedAtMs)) ? `Updated: ${formatTime(Number(mm.updatedAtMs))}` : "",
      state.game.visibility_reduced ? `<span class="badge warn">Reduced visibility</span>` : "",
    ]
      .filter(Boolean)
      .join(" • ");

    const legendRows = [...usedTileIds]
      .sort((a, b) => a - b)
      .map((id) => {
        const [sym, desc] = TILES[id] || FALLBACK_TILE;
        return `<div class="line"><span>${escapeHtml(sym)}</span><span class="mono">(${id})</span><span>${escapeHtml(desc)}</span></div>`;
      });
    legendRows.unshift(`<div class="line"><span>🧍</span><span>Player</span></div>`);
    legendRows.push(`<div class="line"><span>❓</span><span>Unknown/Fog</span></div>`);
    els.minimapLegend.innerHTML =
      legendRows.length > 0 ? legendRows.join("") : `<div class="muted">No legend data.</div>`;

    const markerKeys = Object.keys(markers).sort((a, b) => {
      const aa = parseCoordKey(a);
      const bb = parseCoordKey(b);
      if (aa.y !== bb.y) return aa.y - bb.y;
      return aa.x - bb.x;
    });
    els.markerList.innerHTML =
      markerKeys.length > 0
        ? markerKeys
            .map((key) => {
              const marker = markers[key] || {};
              const coords = parseCoordKey(key);
              return `<div class="line"><span>${escapeHtml(String(marker.emoji || ""))}</span><span>${escapeHtml(
                String(marker.label || "")
              )}</span><span class="mono">(${coords.x},${coords.y})</span></div>`;
            })
            .join("")
        : `<div class="muted">No markers on current map.</div>`;
  }

  function renderLogs() {
    if (!Array.isArray(state.logs) || state.logs.length === 0) {
      els.logList.innerHTML = `<div class="muted">No logs yet.</div>`;
      return;
    }

    const html = state.logs
      .map((entry) => {
        const typeClass =
          entry.type === "chat"
            ? "chat"
            : entry.type === "reasoning"
              ? "reasoning"
              : entry.type === "action"
                ? "action"
                : entry.type === "error"
                  ? "error"
                  : "status";
        const statusBadge = entry.status
          ? `<span class="badge ${entry.status === "error" ? "err" : entry.status === "pending" || entry.status === "unverified" || entry.status === "raw sent" ? "warn" : "ok"}">${escapeHtml(
              entry.status
            )}</span>`
          : "";

        let body = "";
        if (entry.type === "action") {
          const action = entry.data?.action;
          const summary = summarizeAction(action);
          const message = entry.data?.message || entry.message || "";
          const details = entry.data?.details;
          const semanticOutcome = entry.data?.semantic_outcome || null;
          const rawSuccess = entry.data?.raw_success ?? entry.data?.success ?? null;
          const rawSemanticLine =
            rawSuccess !== null ||
            entry.data?.semantic_success !== undefined ||
            semanticOutcome ||
            entry.data?.input_delivered !== undefined ||
            entry.data?.visible_effect !== undefined
              ? `<div class="muted">raw=${escapeHtml(String(rawSuccess))} semantic=${escapeHtml(String(entry.data?.semantic_success ?? "unknown"))} outcome=${escapeHtml(String(semanticOutcome || "unknown"))} input=${escapeHtml(String(entry.data?.input_delivered ?? "unknown"))} effect=${escapeHtml(String(entry.data?.visible_effect ?? "unknown"))}</div>`
              : "";
          body = `
            <div><strong>${escapeHtml(summary)}</strong></div>
            ${rawSemanticLine}
            ${message ? `<div class="text-block">${escapeHtml(message)}</div>` : ""}
            ${
              details
                ? `<details><summary>details</summary><pre class="stream-box" style="max-height:130px;">${escapeHtml(
                    String(details)
                  )}</pre></details>`
                : ""
            }
          `;
        } else if (entry.type === "chat") {
          const emotion = entry.data?.avatar_emotion ? ` <span class="badge">${escapeHtml(entry.data.avatar_emotion)}</span>` : "";
          body = `<div class="text-block">${escapeHtml(entry.message)}${emotion}</div>`;
        } else {
          body = `<div class="text-block">${escapeHtml(entry.message)}</div>`;
        }

        return `
          <article class="log-entry ${typeClass}">
            <div class="head">
              <div class="type">${escapeHtml(entry.type)}</div>
              <div>
                ${statusBadge}
                <span class="time">${formatTime(entry.ts)}</span>
              </div>
            </div>
            ${body}
          </article>
        `;
      })
      .join("");

    els.logList.innerHTML = html;
    els.logList.scrollTop = els.logList.scrollHeight;
  }

  function renderAllPanels() {
    renderRuntime();
    renderObservationContract();
    renderModelSurface();
    renderBenchmarkMetrics();
    renderActionEffect();
    renderStuckDetector();
    renderDsScreen();
    renderTrainer();
    renderBattle();
    renderTeam();
    renderInventory();
    renderObjectives();
    renderProgress();
    renderMemory();
    renderStreams();
    renderMinimap();
    renderLogs();
  }

  function mergeFullState(payload) {
    if (!payload || typeof payload !== "object") return;
    if (isPlainObject(payload.game)) {
      state.gameInfo = normalizeGameInfo(payload.game);
    }
    if (isPlainObject(payload.emulator) || payload.screenshot_raw_path || payload.screenshotRawPath) {
      state.emulator = normalizeEmulatorInfo(payload.emulator, payload);
    }
    if (typeof payload.ok === "boolean") {
      state.isConnected = payload.ok;
    }
    state.lastDataAt = Date.now();

    const merged = {
      ...state.game,
      ...payload,
      inventory_data: normalizeInventory(payload.inventory_data),
    };
    state.game = merged;

    if (payload.markers && typeof payload.markers === "object") {
      state.game.markers = payload.markers;
    }
    if (!state.streams.summaryInProgress && typeof payload.last_summary === "string") {
      state.streams.summaryText = payload.last_summary;
    }
    if (!state.streams.criticismInProgress && typeof payload.last_criticism === "string") {
      state.streams.criticismText = payload.last_criticism;
    }

    renderRuntime();
    renderObservationContract();
    renderModelSurface();
    renderBenchmarkMetrics();
    renderStuckDetector();
    renderDsScreen();
    renderTrainer();
    renderBattle();
    renderTeam();
    renderInventory();
    renderObjectives();
    renderProgress();
    renderMemory();
    renderStreams();
    renderMinimap();
  }

  function handleActionStart(payload) {
    if (!payload || typeof payload !== "object") return;

    if (typeof payload.step_details === "string" && payload.step_details.trim()) {
      addLog("status", payload.step_details.trim());
    }

    if (typeof payload.chat_message === "string" && payload.chat_message.trim()) {
      addLog("chat", payload.chat_message.trim(), {
        data: { avatar_emotion: payload.avatar_emotion || null },
      });
    }

    const actions = Array.isArray(payload.actions) ? payload.actions : [];
    const parentCallId = String(payload.call_id || "");

    if (actions.length === 0) {
      addLog("action", "Action batch started with no actions.", {
        status: "pending",
        callId: parentCallId,
        data: { action: { type: "unknown" }, message: "Pending..." },
      });
      return;
    }

    actions.forEach((action, index) => {
      addLog("action", "", {
        status: "pending",
        callId: `${parentCallId}_${index}`,
        data: { action, message: "Pending..." },
      });
    });
  }

  function handleActionExecuted(payload) {
    if (!payload || typeof payload !== "object") return;
    const callId = String(payload.call_id || "");
    const log = state.logs.find((entry) => entry.type === "action" && entry.callId === callId);
    const semanticStatus =
      payload.semantic_success === true && payload.success !== false && payload.raw_success !== false
        ? "completed"
        : /^(partial_progress)$/i.test(String(payload.semantic_outcome || ""))
          ? "unverified"
          : payload.success === false || payload.raw_success === false
            ? "error"
        : payload.input_delivered === true || payload.visible_effect === true || payload.success === true
          ? "unverified"
          : "error";

    if (!log) {
      addLog("action", String(payload.message || ""), {
        status: semanticStatus,
        callId,
        data: {
          action: { type: payload.action_type || "unknown" },
          success: payload.success,
          raw_success: payload.raw_success,
          semantic_success: payload.semantic_success,
          semantic_outcome: payload.semantic_outcome,
          input_delivered: payload.input_delivered,
          visible_effect: payload.visible_effect,
          message: payload.message || "",
          details: payload.details || "",
        },
      });
      return;
    }

    log.status = semanticStatus;
    log.data = {
      ...(log.data || {}),
      success: payload.success,
      raw_success: payload.raw_success,
      semantic_success: payload.semantic_success,
      semantic_outcome: payload.semantic_outcome,
      input_delivered: payload.input_delivered,
      visible_effect: payload.visible_effect,
      message: payload.message || "",
      details: payload.details || "",
      action_type: payload.action_type || (log.data?.action?.type ?? "unknown"),
    };
    log.ts = Date.now();
    renderLogs();
  }

  function handleWsMessage(event) {
    state.lastWsAt = Date.now();
    renderRuntime();

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      addLog("error", "Failed to parse WebSocket payload.");
      return;
    }

    const type = message?.type;
    const payload = message?.payload;

    switch (type) {
      case "full_state":
        mergeFullState(payload);
        return;

      case "objectives_update":
        state.game.objectives = payload || null;
        renderObjectives();
        return;

      case "memory_update":
        state.game.memory = payload && typeof payload === "object" ? payload : {};
        renderMemory();
        return;

      case "markers_update":
        state.game.markers = payload && typeof payload === "object" ? payload : {};
        renderMinimap();
        return;

      case "isThinking_update":
        state.game.isThinking = Boolean(payload);
        renderRuntime();
        return;

      case "isSummaryStep_update":
        state.game.isSummaryStep = Boolean(payload);
        renderRuntime();
        return;

      case "isCriticismStep_update":
        state.game.isCriticismStep = Boolean(payload);
        renderRuntime();
        return;

      case "token_usage_total":
        state.tokenTotals = payload || null;
        if (payload && Number.isFinite(Number(payload.total_tokens))) {
          state.game.total_tokens_accumulated = Number(payload.total_tokens);
        }
        renderRuntime();
        return;

      case "time_usage_total":
        state.timeTotals = payload || null;
        if (payload && typeof payload === "object") {
          state.game.time_usage_totals = {
            reasoning_ms: Number(payload.reasoning_ms || 0),
            tools_ms: Number(payload.tools_ms || 0),
            overall_ms: Number(payload.overall_ms || 0),
            down_ms: Number(payload.down_ms || 0),
          };
        }
        renderRuntime();
        return;

      case "benchmark_metrics_update":
        state.game.benchmarkMetrics = payload && typeof payload === "object" ? payload : null;
        state.game.stuckState = state.game.benchmarkMetrics?.stuck || null;
        renderBenchmarkMetrics();
        renderModelSurface();
        renderActionEffect();
        renderStuckDetector();
        return;

      case "token_usage": {
        const tokens = payload && typeof payload === "object" ? payload : {};
        addLog(
          "status",
          `Token usage: total=${formatNumber(tokens.total_tokens || 0)} input=${formatNumber(
            tokens.input_tokens || 0
          )} output=${formatNumber(tokens.output_tokens || 0)} cost=$${Number(
            tokens.discountedCost || tokens.discounted_cost || 0
          ).toFixed(4)}`
        );
        return;
      }

      case "status_update":
        if (typeof payload === "string") addLog("status", payload);
        return;

      case "error_message":
        addLog("error", typeof payload === "string" ? payload : "Unknown server error.");
        return;

      case "reasoning_chunk":
        queueReasoningChunk(typeof payload === "string" ? payload : String(payload ?? ""));
        return;

      case "reasoning_end":
        closeReasoningStream();
        return;

      case "summary_start":
        state.streams.summaryInProgress = true;
        state.streams.summaryText = "";
        renderStreams();
        addLog("status", "Summary stream started.");
        return;

      case "summary_chunk":
        state.streams.summaryText += typeof payload === "string" ? payload : String(payload ?? "");
        renderStreams();
        return;

      case "summary_end":
        state.streams.summaryInProgress = false;
        if (state.streams.summaryText) state.game.last_summary = state.streams.summaryText;
        renderStreams();
        addLog("status", typeof payload === "string" ? payload : "Summary stream ended.");
        return;

      case "criticism_start":
        state.streams.criticismInProgress = true;
        state.streams.criticismText = "";
        renderStreams();
        addLog("status", "Criticism stream started.");
        return;

      case "criticism_chunk":
        state.streams.criticismText += typeof payload === "string" ? payload : String(payload ?? "");
        renderStreams();
        return;

      case "criticism_end":
        state.streams.criticismInProgress = false;
        if (state.streams.criticismText) state.game.last_criticism = state.streams.criticismText;
        renderStreams();
        addLog("status", typeof payload === "string" ? payload : "Criticism stream ended.");
        return;

      case "action_start":
        handleActionStart(payload);
        return;

      case "action_executed":
        handleActionExecuted(payload);
        return;

      default:
        addLog("status", `Unhandled message type: ${String(type)}`);
    }
  }

  function clearReconnectTimer() {
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    clearReconnectTimer();
    if (!state.settings.autoReconnect) return;
    state.reconnectTimer = window.setTimeout(() => {
      connectWebSocket();
    }, RECONNECT_DELAY_MS);
  }

  function disconnectWebSocket(manual = false) {
    state.manualDisconnect = manual;
    clearReconnectTimer();

    const ws = state.ws;
    if (!ws) {
      state.isConnected = false;
      renderRuntime();
      return;
    }

    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;

    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, manual ? "Manual disconnect" : "Reconnect");
      }
    } catch {
      // ignore
    }

    state.ws = null;
    state.isConnected = false;
    renderRuntime();
  }

  function connectWebSocket() {
    readSettingsFromInputs();
    disconnectWebSocket(false);
    state.manualDisconnect = false;

    const wsUrl = buildWsUrl();
    addLog("status", `Connecting to ${wsUrl}`);

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      addLog("error", `WebSocket creation failed: ${error.message}`);
      scheduleReconnect();
      return;
    }

    state.ws = ws;

    ws.onopen = () => {
      if (state.ws !== ws) return;
      state.isConnected = true;
      state.lastWsAt = Date.now();
      clearReconnectTimer();
      renderRuntime();
      addLog("status", "WebSocket connected.");
    };

    ws.onmessage = handleWsMessage;

    ws.onerror = () => {
      if (state.ws !== ws) return;
      addLog("error", "WebSocket error.");
    };

    ws.onclose = (event) => {
      if (state.ws !== ws) return;
      state.ws = null;
      state.isConnected = false;
      renderRuntime();
      addLog("status", `WebSocket closed (code ${event.code}${event.reason ? `: ${event.reason}` : ""}).`);

      if (!state.manualDisconnect && state.settings.autoReconnect) {
        scheduleReconnect();
      }
    };
  }

  async function pollMinimapOnce() {
    const url = buildMinimapUrl();
    try {
      const response = await fetch(url, { method: "GET", cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = await response.json();
      if (!body || body.ok !== true || !body.data || !body.data.minimap_data) {
        return;
      }

      const minimap = body.data.minimap_data;
      const mapId = typeof body.data.map_id === "string" ? body.data.map_id : minimap.map_id || null;
      const mapMarkers =
        body.data.map_markers && typeof body.data.map_markers === "object" && !Array.isArray(body.data.map_markers)
          ? body.data.map_markers
          : null;

      if (mapId && mapMarkers) {
        state.minimap.markersByMap[mapId] = mapMarkers;
      }

      if (typeof body.data.visibility_reduced === "boolean") {
        state.game.visibility_reduced = body.data.visibility_reduced;
      }
      if (Number.isFinite(Number(body.data.visibility_window_width_tiles))) {
        state.game.visibility_window_width_tiles = Number(body.data.visibility_window_width_tiles);
      }
      if (Number.isFinite(Number(body.data.visibility_window_height_tiles))) {
        state.game.visibility_window_height_tiles = Number(body.data.visibility_window_height_tiles);
      }

      const nextSeq = Number.isFinite(Number(minimap.seq)) ? Number(minimap.seq) : null;
      const nextMarkersHash = mapMarkers ? JSON.stringify(mapMarkers) : state.minimap.lastMarkersHash;
      const seqChanged = nextSeq === null || nextSeq !== state.minimap.lastSeq;
      const markersChanged = nextMarkersHash !== state.minimap.lastMarkersHash;

      if (!seqChanged && !markersChanged) {
        return;
      }

      state.minimap.data = minimap;
      if (nextSeq !== null) state.minimap.lastSeq = nextSeq;
      state.minimap.lastMarkersHash = nextMarkersHash;
      state.lastPollErrorMessage = "";

      renderMinimap();
      renderRuntime();
    } catch (error) {
      const errMsg = `Minimap polling failed: ${error.message}`;
      if (errMsg !== state.lastPollErrorMessage) {
        state.lastPollErrorMessage = errMsg;
        addLog("error", errMsg);
      }
    }
  }

  async function pollGameStateOnce() {
    const url = buildDataUrl();
    try {
      const response = await fetch(url, { method: "GET", cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = await response.json();
      if (!isPlainObject(body)) {
        throw new Error("Invalid JSON payload");
      }
      if (body.ok === false) {
        throw new Error(pickString(body.error, body.message, "Bridge returned ok=false"));
      }

      mergeFullState(body);
      if (state.lastPollErrorMessage) {
        addLog("status", "HeartGold dashboard polling recovered.");
      }
      state.lastPollErrorMessage = "";
      state.isConnected = body.ok !== false;
      renderRuntime();
    } catch (error) {
      state.isConnected = false;
      const errMsg = `Dashboard polling failed: ${error.message}`;
      if (errMsg !== state.lastPollErrorMessage) {
        state.lastPollErrorMessage = errMsg;
        addLog("error", errMsg);
      }
      renderRuntime();
    }
  }

  function stopMinimapPolling() {
    if (state.pollTimer !== null) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startMinimapPolling() {
    stopMinimapPolling();

    const tick = async () => {
      await pollGameStateOnce();
      state.pollTimer = window.setTimeout(tick, state.settings.pollMs);
    };

    tick();
  }

  function wireControls() {
    els.connectBtn.addEventListener("click", () => {
      readSettingsFromInputs();
      connectWebSocket();
      addLog("status", `Connected to HeartGold agent server at ${buildDataUrl()}`);
      startMinimapPolling();
      renderRuntime();
    });

    els.disconnectBtn.addEventListener("click", () => {
      disconnectWebSocket(true);
      stopMinimapPolling();
      state.isConnected = false;
      addLog("status", "Manual disconnect.");
      renderRuntime();
    });

    els.clearLogsBtn.addEventListener("click", () => {
      state.logs = [];
      state.activeReasoningLogId = null;
      state.nextLogId = 1;
      renderLogs();
    });

    els.reconnectInput.addEventListener("change", () => {
      readSettingsFromInputs();
      renderRuntime();
    });
  }

  function bootstrap() {
    setInputDefaults();
    wireControls();
    renderAllPanels();
    connectWebSocket();
    addLog("status", `Connected to HeartGold agent server at ${buildDataUrl()}`);
    startMinimapPolling();
  }

  bootstrap();
})();
