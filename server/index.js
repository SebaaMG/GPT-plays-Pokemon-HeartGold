require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");

const { config } = require("./src/config");
const { state, loadPersistentState, attachBroadcast } = require("./src/state/stateManager");
const socketHub = require("./src/core/socketHub");
const {
  fetchMinimapSnapshot,
  getMinimapData,
  fetchGameData,
  launchEmulator,
  bootstrapIntro,
  saveState,
  loadState,
  fetchBridgeHealth,
} = require("./src/services/pythonService");
const { buildCodexDesktopObservation, executeCodexDesktopAction } = require("./src/services/codexDesktopService");
const { getBenchmarkMetrics, recordHarnessFailure } = require("./src/benchmark/metrics");
const { sanitizeModelText } = require("./src/ai/modelSurfaceSanitizer");

function latestScreenshotPath() {
  return (
    state.gameDataJsonRef?.screenshotSnapshotPath ||
    state.gameDataJsonRef?.emulator?.screenshotSnapshotPath ||
    state.gameDataJsonRef?.observationFreshness?.screenshotSnapshotPath ||
    state.gameDataJsonRef?.screenshot_raw_path ||
    state.gameDataJsonRef?.emulator?.screenshotRawPath ||
    null
  );
}

function latestScreenshotCacheKey() {
  return (
    state.gameDataJsonRef?.screenshotCacheKey ||
    state.gameDataJsonRef?.emulator?.screenshotCacheKey ||
    state.gameDataJsonRef?.observationFreshness?.screenshotCacheKey ||
    null
  );
}

function latestScreenshotUrl() {
  const cacheKey = latestScreenshotCacheKey();
  return cacheKey ? `/screenshot/snapshot/${encodeURIComponent(String(cacheKey))}.png` : "/screenshot/raw";
}

function setNoStore(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function safeSnapshotCacheKey(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 160 || !/^[A-Za-z0-9_.-]+$/.test(raw)) return null;
  return raw;
}

function sha256File(filePath) {
  try {
    return crypto.createHash("sha256").update(fsSync.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function serveScreenshotFile(res, filePath, metadata = {}) {
  setNoStore(res);
  const resolved = path.resolve(filePath);
  if (!fsSync.existsSync(resolved)) {
    res.status(404).json({ ok: false, error: "Screenshot file does not exist" });
    return;
  }
  const stat = fsSync.statSync(resolved);
  const screenshotHash = metadata.screenshotHash || sha256File(resolved);
  if (screenshotHash) res.setHeader("X-Screenshot-Hash", String(screenshotHash));
  if (Number.isFinite(Number(metadata.screenshotMtimeMs))) {
    res.setHeader("X-Screenshot-Mtime-Ms", String(metadata.screenshotMtimeMs));
  } else {
    res.setHeader("X-Screenshot-Mtime-Ms", String(Math.round(stat.mtimeMs)));
  }
  if (metadata.cacheKey) res.setHeader("X-Screenshot-Cache-Key", String(metadata.cacheKey));
  res.setHeader("X-Screenshot-Path", resolved);
  res.type("png");
  const stream = fsSync.createReadStream(resolved);
  stream.on("error", (error) => {
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: error.message });
    } else {
      res.end();
    }
  });
  stream.pipe(res);
}

function findSnapshotPathByCacheKey(cacheKey) {
  const safeKey = safeSnapshotCacheKey(cacheKey);
  if (!safeKey) return null;

  const latestPath = latestScreenshotPath();
  const candidates = [];
  if (latestPath && typeof latestPath === "string") {
    const resolvedLatest = path.resolve(latestPath);
    candidates.push(resolvedLatest);
    candidates.push(path.join(path.dirname(resolvedLatest), `ds_${safeKey}.png`));
    candidates.push(path.join(path.dirname(resolvedLatest), "observations", `ds_${safeKey}.png`));
  }
  const rawPath = state.gameDataJsonRef?.screenshot_raw_path || state.gameDataJsonRef?.emulator?.screenshotRawPath;
  if (rawPath && typeof rawPath === "string") {
    const rawDir = path.dirname(path.resolve(rawPath));
    candidates.push(path.join(rawDir, "observations", `ds_${safeKey}.png`));
    candidates.push(path.join(rawDir, `ds_${safeKey}.png`));
  }

  const expectedName = `ds_${safeKey}.png`;
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (path.basename(resolved) === expectedName && fsSync.existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

function readJsonFileOrNull(filePath) {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function codexDesktopArtifactSuffix(kind) {
  if (kind === "observation") return "_observation.json";
  if (kind === "action") return "_action.json";
  if (kind === "action_rejected") return "_action_rejected.json";
  return null;
}

function readLatestCodexDesktopArtifact(kind) {
  const suffix = codexDesktopArtifactSuffix(kind);
  const outputDir = config.codexDesktop?.outputDir;
  if (!suffix || !outputDir || !fsSync.existsSync(outputDir)) return null;

  const matches = fsSync
    .readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => {
      const artifactPath = path.join(outputDir, entry.name);
      let mtimeMs = null;
      try {
        mtimeMs = fsSync.statSync(artifactPath).mtimeMs;
      } catch {
        mtimeMs = null;
      }
      return { name: entry.name, path: artifactPath, mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const latest = matches[matches.length - 1] || null;
  if (!latest) return null;
  const artifact = readJsonFileOrNull(latest.path);
  return {
    kind,
    name: latest.name,
    path: latest.path,
    mtimeMs: latest.mtimeMs,
    artifact,
    parse_error: artifact ? null : "artifact_json_unavailable",
  };
}

function latestCodexDesktopObservationImage(observationEnvelope = null) {
  const envelope = observationEnvelope || readLatestCodexDesktopArtifact("observation");
  const artifact = envelope?.artifact && typeof envelope.artifact === "object" ? envelope.artifact : null;
  if (!artifact) return null;
  const modelInputImage = artifact.model_input?.image && typeof artifact.model_input.image === "object"
    ? artifact.model_input.image
    : null;
  const modelImageArtifact = artifact.model_image_artifact && typeof artifact.model_image_artifact === "object"
    ? artifact.model_image_artifact
    : null;
  const image = modelInputImage || modelImageArtifact || null;
  const imagePath = image?.path || modelImageArtifact?.path || null;
  if (!imagePath || typeof imagePath !== "string") return null;
  return {
    observation: envelope,
    image,
    path: imagePath,
    screenshotHash:
      image.screenshotHash ||
      image.screenshot_hash ||
      modelImageArtifact?.screenshotHash ||
      modelImageArtifact?.screenshot_hash ||
      artifact.model_input?.image_contract?.screenshot_hash ||
      artifact.model_image_artifact?.screenshotHash ||
      null,
    cacheKey:
      image.cacheKey ||
      image.cache_key ||
      modelImageArtifact?.cacheKey ||
      modelImageArtifact?.cache_key ||
      artifact.model_input?.image_contract?.cache_key ||
      null,
    screenshotMtimeMs:
      image.screenshotMtimeMs ||
      image.screenshot_mtime_ms ||
      modelImageArtifact?.screenshotMtimeMs ||
      modelImageArtifact?.screenshot_mtime_ms ||
      null,
  };
}

function decodedRamFromObservationArtifact(observation) {
  if (!observation || typeof observation !== "object") return null;
  const modelInputRam = observation.model_input?.decoded_ram || null;
  if (modelInputRam && typeof modelInputRam === "object") return modelInputRam;
  const snapshotRam = observation.decoded_ram_snapshot || null;
  if (snapshotRam && typeof snapshotRam === "object") return snapshotRam;
  const legacyModelVisible = observation.ram_audit_snapshot?.modelVisible || null;
  if (legacyModelVisible && typeof legacyModelVisible === "object") {
    return {
      _source: "ram_audit_snapshot.modelVisible",
      _legacy_artifact_without_model_input_decoded_ram: true,
      ...legacyModelVisible,
    };
  }
  return null;
}

function dashboardSafeCodexDesktopArtifactEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return envelope;
  const artifact = envelope.artifact && typeof envelope.artifact === "object" ? envelope.artifact : null;
  if (!artifact) return envelope;
  const {
    ram_audit_snapshot: _ramAuditSnapshot,
    model_visible_manifest: _modelVisibleManifest,
    observation_audit: _observationAudit,
    ...dashboardArtifact
  } = artifact;
  return { ...envelope, artifact: dashboardArtifact };
}

function fullStatePayload(lastSummaryText, lastCriticism) {
  return {
    game: state.gameDataJsonRef?.game || null,
    emulator: state.gameDataJsonRef?.emulator || null,
    screenshot_raw_path: state.gameDataJsonRef?.screenshot_raw_path || null,
    screenshotSnapshotPath: state.gameDataJsonRef?.screenshotSnapshotPath || state.gameDataJsonRef?.emulator?.screenshotSnapshotPath || null,
    screenshotCacheKey: state.gameDataJsonRef?.screenshotCacheKey || state.gameDataJsonRef?.emulator?.screenshotCacheKey || null,
    screenshotHash: state.gameDataJsonRef?.screenshotHash || state.gameDataJsonRef?.emulator?.screenshotHash || null,
    screenshotAgeMs: state.gameDataJsonRef?.screenshotAgeMs ?? state.gameDataJsonRef?.emulator?.screenshotAgeMs ?? null,
    screenshotFresh:
      state.gameDataJsonRef?.screenshotFresh ??
      state.gameDataJsonRef?.emulator?.screenshotFresh ??
      state.gameDataJsonRef?.observationFreshness?.screenshotFresh ??
      null,
    screenshot_url: latestScreenshotUrl(),
    bridgeRequestOk: state.gameDataJsonRef?.bridgeRequestOk !== false,
    bridgeError: state.gameDataJsonRef?.bridgeError || null,
    observationUnavailable: state.gameDataJsonRef?.observationUnavailable === true,
    current_trainer_data: state.gameDataJsonRef?.current_trainer_data || null,
    current_pokemon_data: state.gameDataJsonRef?.current_pokemon_data || [],
    inventory_data: state.gameDataJsonRef?.inventory_data || [],
    pc_items: state.gameDataJsonRef?.pc_items || [],
    pc_data: state.gameDataJsonRef?.pc_data || null,
    ram_assisted: state.gameDataJsonRef?.ram_assisted || null,
    harnessDiagnostics: state.gameDataJsonRef?.harnessDiagnostics || null,
    objectives: state.objectives,
    map_display: state.gameDataJsonRef?.map_display || null,
    visible_area_data: state.gameDataJsonRef?.visible_area_data || null,
    open_dialog_text: state.gameDataJsonRef?.open_dialog_text || "",
    important_events: state.gameDataJsonRef?.important_events || {},
    npc_entries: state.gameDataJsonRef?.npc_entries || [],
    npc_entries_visible: state.gameDataJsonRef?.npc_entries_visible || [],
    is_talking_to_npc: state.gameDataJsonRef?.is_talking_to_npc || false,
    is_in_battle: state.gameDataJsonRef?.is_in_battle || false,
    battle_data: state.gameDataJsonRef?.battle_data || null,
    flash_needed: state.gameDataJsonRef?.flash_needed || false,
    flash_active: state.gameDataJsonRef?.flash_active || false,
    visibility_reduced: state.gameDataJsonRef?.visibility_reduced || false,
    visibility_window_width_tiles: state.gameDataJsonRef?.visibility_window_width_tiles ?? null,
    visibility_window_height_tiles: state.gameDataJsonRef?.visibility_window_height_tiles ?? null,
    memory: state.memory,
    markers: state.markers,
    badgeHistory: state.badgeHistory,
    mapVisitHistory: state.mapVisitHistory,
    lastVisitedMaps: state.lastVisitedMaps,
    progressSteps: state.progressSteps,
    benchmarkMetrics: getBenchmarkMetrics(),
    stuckState: getBenchmarkMetrics().stuck,
    remaining_until_criticism: Math.max(
      0,
      config.history.limitAssistantMessagesForSelfCriticism -
        (state.counters.currentStep - state.counters.lastCriticismStep)
    ),
    remaining_until_summary: Math.max(
      0,
      config.history.limitAssistantMessagesForSummary - (state.counters.currentStep - state.counters.lastSummaryStep)
    ),
    steps: state.counters.currentStep,
    last_summary: lastSummaryText,
    last_criticism: lastCriticism,
    isThinking: state.isThinking,
    safari_zone_counter: state.gameDataJsonRef?.safari_zone_counter ?? 0,
    safari_zone_active: state.gameDataJsonRef?.safari_zone_active ?? false,
    strength_enabled: state.gameDataJsonRef?.strength_enabled ?? false,
    player_movement_mode: state.gameDataJsonRef?.player_movement_mode || "UNKNOWN",
    benchmark_note: state.gameDataJsonRef?.benchmark_note || "",
    stateReliability: state.gameDataJsonRef?.stateReliability || state.gameDataJsonRef?.game?.stateReliability || null,
    observationPolicy: state.gameDataJsonRef?.observationPolicy || null,
    observationFreshness: state.gameDataJsonRef?.observationFreshness || null,
    stateReliabilityDetails: state.gameDataJsonRef?.stateReliabilityDetails || null,
    rom_map_data: state.gameDataJsonRef?.rom_map_data || null,
    nearby_warps: state.gameDataJsonRef?.nearby_warps || [],
    visible_warps: state.gameDataJsonRef?.visible_warps || [],
  };
}

let gameLoopStarted = false;

const rawBroadcast = socketHub.broadcast;
const loopStepState = { isSummaryStep: false, isCriticismStep: false };
let lastLoopStepBroadcastAtMs = 0;

function computeLoopStepState() {
  const currentStep = state.counters?.currentStep ?? 0;
  const lastCriticismStep = state.counters?.lastCriticismStep ?? 0;
  const lastSummaryStep = state.counters?.lastSummaryStep ?? 0;

  const stepsSinceLastCriticism = currentStep - lastCriticismStep;
  const stepsSinceLastSummary = currentStep - lastSummaryStep;

  const shouldSummarizeBasedOnSteps =
    stepsSinceLastSummary >= config.history.limitAssistantMessagesForSummary;
  const shouldSummarizeBasedOnTokens =
    typeof state.lastTotalTokens === "number" && state.lastTotalTokens >= config.openai.tokenLimit;

  const isSummaryStep = shouldSummarizeBasedOnSteps || shouldSummarizeBasedOnTokens;
  const isCriticismStep =
    !isSummaryStep &&
    stepsSinceLastCriticism >= config.history.limitAssistantMessagesForSelfCriticism;

  return { isSummaryStep, isCriticismStep };
}

function broadcastLoopStepStateUpdate(nextState) {
  rawBroadcast({ type: "isSummaryStep_update", payload: nextState.isSummaryStep });
  rawBroadcast({ type: "isCriticismStep_update", payload: nextState.isCriticismStep });
}

function refreshLoopStepState() {
  const now = Date.now();
  // Avoid double-sending at the start of a loop when multiple "totals" broadcasts happen back-to-back.
  if (now - lastLoopStepBroadcastAtMs < 50) return;
  lastLoopStepBroadcastAtMs = now;

  const nextState = computeLoopStepState();
  loopStepState.isSummaryStep = nextState.isSummaryStep;
  loopStepState.isCriticismStep = nextState.isCriticismStep;
  broadcastLoopStepStateUpdate(nextState);
}

function broadcastWithLoopStepState(message) {
  try {
    if (message?.type === "token_usage_total" || message?.type === "time_usage_total") {
      // Treat these as "beginning of loop" signals.
      refreshLoopStepState();
    }

    if (
      message?.type === "full_state" &&
      message.payload &&
      typeof message.payload === "object" &&
      !Array.isArray(message.payload)
    ) {
      const nextState = computeLoopStepState();
      loopStepState.isSummaryStep = nextState.isSummaryStep;
      loopStepState.isCriticismStep = nextState.isCriticismStep;
      return rawBroadcast({ ...message, payload: { ...message.payload, ...nextState } });
    }
  } catch (error) {
    console.warn("Failed to enrich outbound WS message:", error);
  }

  return rawBroadcast(message);
}

socketHub.broadcast = broadcastWithLoopStepState;

function startGameLoopInBackground() {
  if (gameLoopStarted) return;
  gameLoopStarted = true;

  const run = async () => {
    try {
      const { gameLoop } = require("./src/core/gameLoop");
      await gameLoop();
    } catch (error) {
      console.error("Game loop crashed:", error);
      if (typeof socketHub.broadcast === "function") {
        socketHub.broadcast({
          type: "error_message",
          payload: `Game loop crashed: ${error.message}. Restarting...`,
        });
      }
      gameLoopStarted = false; // Allow a restart attempt
      setTimeout(startGameLoopInBackground, 5000);
    }
  };

  setImmediate(run); // Defer to keep the event loop free for incoming socket handshakes
}

async function start() {
  console.log(`Starting Pokemon agent server (profile: ${config.gameProfile})...`);
  if (config.isHeartGold && config.agentProvider === "codex-cli") {
    if (!config.codexCli.model) {
      throw new Error(
        "HeartGold codex-cli requires an explicit model. Pass -Model <model> to the start script or set CODEX_MODEL, CODEX_DESKTOP_MODEL, or OPENAI_MODEL."
      );
    }
  }
  await loadPersistentState();
  state.lastTotalTokens = 0;

  attachBroadcast(socketHub.broadcast);

  const app = express();
  app.use(cors());
  const frontendDir = path.resolve(__dirname, "..", "frontend");
  if (fsSync.existsSync(frontendDir)) {
    app.use(
      express.static(frontendDir, {
        etag: false,
        lastModified: false,
        setHeaders: (res) => setNoStore(res),
      })
    );
  }

  const server = http.createServer(app);
  const wsPort = config.wsPort;

  app.get("/health", (req, res) => {
    setNoStore(res);
    res.json({
      ok: true,
      gameProfile: config.gameProfile,
      agentProvider: config.agentProvider,
      agentAutostart: config.agentAutostart,
      autoLaunchEmulator: config.autoLaunchEmulator,
      autoBootstrapIntro: config.autoBootstrapIntro,
      dataDir: config.dataDir,
      codexDesktopOutputDir: config.codexDesktop.outputDir,
      wsPort,
      pythonBaseUrl: config.pythonServer.baseUrl,
      model: config.agentProvider === "codex-cli"
        ? config.codexCli.model
        : config.agentProvider === "codex-desktop"
          ? config.codexDesktop.model
          : config.openai.model,
      reasoningEffort: config.agentProvider === "codex-cli"
        ? config.codexCli.reasoningEffort
        : config.agentProvider === "codex-desktop"
          ? config.codexDesktop.reasoningEffort
          : config.openai.reasoningEffort,
    });
  });

  app.get("/bridgeHealth", async (req, res) => {
    setNoStore(res);
    const health = await fetchBridgeHealth();
    res.status(health?.ok === false ? 502 : 200).json(health);
  });

  app.get("/benchmarkMetrics", (req, res) => {
    setNoStore(res);
    res.json({ ok: true, data: getBenchmarkMetrics() });
  });

  app.get("/getMinimap", async (req, res) => {
    setNoStore(res);
    const minimapData = await getMinimapData();
    res.json(minimapData);
  });

  app.get("/gameState", async (req, res) => {
    setNoStore(res);
    const gameData = await fetchGameData();
    if (!gameData) {
      recordHarnessFailure("game_state_unavailable", "Python game state unavailable");
      res.status(502).json({ ok: false, error: "Python game state unavailable" });
      return;
    }
    state.gameDataJsonRef = gameData;
    const lastSummaryText = state.summaries.length > 0 ? state.summaries[state.summaries.length - 1].text : "";
    const lastCriticism = fsSync.existsSync(config.paths.lastCriticismSaveFile)
      ? fsSync.readFileSync(config.paths.lastCriticismSaveFile, "utf8")
      : "";
    res.json({
      ok: true,
      ...fullStatePayload(lastSummaryText, lastCriticism),
    });
  });

  app.get("/dashboardState", (req, res) => {
    setNoStore(res);
    const latestObservationArtifact = readLatestCodexDesktopArtifact("observation");
    const latestActionArtifact = readLatestCodexDesktopArtifact("action");
    const latestRejectedActionArtifact = readLatestCodexDesktopArtifact("action_rejected");
    const observation = latestObservationArtifact?.artifact || null;
    const modelInput = observation?.model_input || null;
    const decodedRam = decodedRamFromObservationArtifact(observation);
    const latestImage = latestCodexDesktopObservationImage(latestObservationArtifact);

    const lastSummaryText = state.summaries.length > 0 ? state.summaries[state.summaries.length - 1].text : "";
    const lastCriticism = fsSync.existsSync(config.paths.lastCriticismSaveFile)
      ? fsSync.readFileSync(config.paths.lastCriticismSaveFile, "utf8")
      : "";
    const cachedPayload = fullStatePayload(lastSummaryText, lastCriticism);
    const modelImage = latestImage?.image || {};
    const screenshotPath = latestImage?.path || cachedPayload.screenshotSnapshotPath || cachedPayload.screenshot_raw_path || null;
    const screenshotUrl = latestImage?.path ? "/codexDesktop/latestModelImage" : cachedPayload.screenshot_url;
    const rawWidth =
      Number(modelImage.raw_width || modelImage.rawWidth || modelImage.width || cachedPayload.emulator?.screenshotRawWidth || 256);
    const rawHeight =
      Number(modelImage.raw_height || modelImage.rawHeight || modelImage.height || cachedPayload.emulator?.screenshotRawHeight || 384);
    const emulator = {
      ...(cachedPayload.emulator || {}),
      screenshotRawPath: screenshotPath || cachedPayload.emulator?.screenshotRawPath || null,
      screenshotSnapshotPath: screenshotPath || cachedPayload.emulator?.screenshotSnapshotPath || null,
      screenshotHash: latestImage?.screenshotHash || cachedPayload.emulator?.screenshotHash || cachedPayload.screenshotHash || null,
      screenshotCacheKey: latestImage?.cacheKey || cachedPayload.emulator?.screenshotCacheKey || cachedPayload.screenshotCacheKey || null,
      screenshotRawWidth: Number.isFinite(rawWidth) ? rawWidth : cachedPayload.emulator?.screenshotRawWidth || 256,
      screenshotRawHeight: Number.isFinite(rawHeight) ? rawHeight : cachedPayload.emulator?.screenshotRawHeight || 384,
    };

    res.json({
      ok: true,
      dashboard_source: "cached_state_and_codex_desktop_artifacts",
      bridge_polling: false,
      ...cachedPayload,
      emulator,
      screenshot_raw_path: screenshotPath || cachedPayload.screenshot_raw_path || null,
      screenshotSnapshotPath: screenshotPath || cachedPayload.screenshotSnapshotPath || null,
      screenshotCacheKey: latestImage?.cacheKey || cachedPayload.screenshotCacheKey || null,
      screenshotHash: latestImage?.screenshotHash || cachedPayload.screenshotHash || null,
      screenshot_url: screenshotUrl,
      model_input: modelInput,
      decoded_ram: decodedRam,
      latestCodexDesktopObservationArtifact: dashboardSafeCodexDesktopArtifactEnvelope(latestObservationArtifact),
      latestCodexDesktopActionArtifact: latestActionArtifact,
      latestCodexDesktopRejectedActionArtifact: latestRejectedActionArtifact,
    });
  });

  app.get("/codexDesktop/latestObservationArtifact", (req, res) => {
    setNoStore(res);
    const latest = readLatestCodexDesktopArtifact("observation");
    if (!latest) {
      res.status(404).json({ ok: false, error: "No Codex Desktop observation artifact available" });
      return;
    }
    res.json({ ok: true, data: latest });
  });

  app.get("/codexDesktop/latestModelImage", (req, res) => {
    const latestImage = latestCodexDesktopObservationImage();
    if (!latestImage?.path) {
      setNoStore(res);
      res.status(404).json({ ok: false, error: "No Codex Desktop model image available" });
      return;
    }
    serveScreenshotFile(res, latestImage.path, {
      screenshotHash: latestImage.screenshotHash,
      screenshotMtimeMs: latestImage.screenshotMtimeMs,
      cacheKey: latestImage.cacheKey,
    });
  });

  app.get("/codexDesktop/observation", async (req, res) => {
    setNoStore(res);
    try {
      const includeDiagnostics = req.query?.diagnostics === "1" || req.query?.diagnostics === "true";
      const peek = req.query?.peek === "1" || req.query?.peek === "true" || req.query?.anchor === "0" || req.query?.anchor === "false";
      const observation = await buildCodexDesktopObservation({ includeDiagnostics, anchor: !peek });
      res.json(observation);
    } catch (error) {
      recordHarnessFailure("codex_desktop_observation_error", error.message, { stack: error.stack });
      res.status(502).json({ ok: false, error: sanitizeModelText(error.message) });
    }
  });

  app.post("/codexDesktop/action", express.json({ limit: "1mb" }), async (req, res) => {
    setNoStore(res);
    try {
      const includeNextObservation =
        req.query?.next_observation === "1" ||
        req.query?.next_observation === "true" ||
        req.query?.include_next_observation === "1" ||
        req.query?.include_next_observation === "true" ||
        req.body?.next_observation === true ||
        req.body?.include_next_observation === true;
      const result = await executeCodexDesktopAction(req.body || {});
      if (includeNextObservation) {
        const nextObservationSettleMs = Math.max(
          0,
          Math.min(5000, Number(process.env.CODEX_DESKTOP_NEXT_OBSERVATION_SETTLE_MS || (config.isHeartGold ? 1500 : 0)) || 0)
        );
        if (nextObservationSettleMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, nextObservationSettleMs));
        }
        try {
          result.next_observation = await buildCodexDesktopObservation({ includeDiagnostics: false, anchor: true });
        } catch (observationError) {
          const message = sanitizeModelText(observationError.message || String(observationError));
          recordHarnessFailure("codex_desktop_next_observation_error", message, { stack: observationError.stack });
          result.next_observation = null;
          result.next_observation_unavailable = true;
          result.next_observation_error = message;
        }
      }
      res.json(result);
    } catch (error) {
      recordHarnessFailure("codex_desktop_action_error", error.message, { stack: error.stack });
      res.status(400).json({ ok: false, error: sanitizeModelText(error.message) });
    }
  });

  app.post("/saveState", express.json(), async (req, res) => {
    const result = await saveState(req.body?.path);
    res.status(result?.ok ? 200 : 502).json(result);
  });

  app.post("/loadState", express.json(), async (req, res) => {
    const result = await loadState(req.body?.path);
    res.status(result?.ok ? 200 : 502).json(result);
  });

  function serveLatestScreenshot(req, res) {
    const rawPath = latestScreenshotPath();
    if (!rawPath || typeof rawPath !== "string") {
      setNoStore(res);
      res.status(404).json({ ok: false, error: "No screenshot path available yet" });
      return;
    }
    const screenshotAgeMs = state.gameDataJsonRef?.screenshotAgeMs ?? state.gameDataJsonRef?.emulator?.screenshotAgeMs;
    const screenshotFresh =
      state.gameDataJsonRef?.screenshotFresh ??
      state.gameDataJsonRef?.emulator?.screenshotFresh ??
      state.gameDataJsonRef?.observationFreshness?.screenshotFresh;
    const visualAvailable = state.gameDataJsonRef?.observationFreshness?.visualAvailable;
    if (screenshotFresh === false || visualAvailable === false || state.gameDataJsonRef?.observationUnavailable === true) {
      setNoStore(res);
      res.status(409).json({
        ok: false,
        error: state.gameDataJsonRef?.bridgeError || "Screenshot is stale or unavailable",
        screenshotAgeMs: Number.isFinite(Number(screenshotAgeMs)) ? Number(screenshotAgeMs) : null,
      });
      return;
    }
    if (Number.isFinite(Number(screenshotAgeMs)) && Number(screenshotAgeMs) > config.observation.maxScreenshotAgeMs) {
      setNoStore(res);
      res.status(409).json({ ok: false, error: "Screenshot is stale", screenshotAgeMs: Number(screenshotAgeMs) });
      return;
    }
    const screenshotHash = state.gameDataJsonRef?.screenshotHash || state.gameDataJsonRef?.emulator?.screenshotHash;
    const screenshotMtimeMs = state.gameDataJsonRef?.emulator?.screenshotMtimeMs;
    serveScreenshotFile(res, rawPath, {
      screenshotHash,
      screenshotMtimeMs,
      cacheKey: latestScreenshotCacheKey(),
    });
  }

  app.get("/screenshot/raw", serveLatestScreenshot);

  app.get("/screenshot/snapshot/:cacheKey.png", (req, res) => {
    const requested = String(req.params.cacheKey || "");
    if (!safeSnapshotCacheKey(requested)) {
      setNoStore(res);
      res.status(400).json({ ok: false, error: "Invalid screenshot snapshot cache key", requested });
      return;
    }
    const current = String(latestScreenshotCacheKey() || "");
    const snapshotPath = findSnapshotPathByCacheKey(requested);
    if (snapshotPath) {
      serveScreenshotFile(res, snapshotPath, { cacheKey: requested });
      return;
    }
    setNoStore(res);
    res.status(404).json({
      ok: false,
      error: "Requested screenshot snapshot is not available",
      requested,
      current: current || null,
    });
  });

  // Frontend polling endpoint:
  // - Proxies Python `/minimapSnapshot` (cache, non-bloquant pendant /sendCommands)
  // - Adds markers for the current map id
  app.get("/minimapSnapshot", async (req, res) => {
    setNoStore(res);
    const minimapData = await fetchMinimapSnapshot();
    if (!minimapData) {
      res.status(502).json({ ok: false, error: "Python minimap snapshot unavailable" });
      return;
    }

    const mapId = typeof minimapData.map_id === "string" ? minimapData.map_id : null;
    const mapMarkers =
      mapId && state.markers && typeof state.markers === "object" ? state.markers[mapId] || {} : {};

    const visibilityReduced = Boolean(minimapData.visibility_reduced);
    const visibilityWindowWidthTiles = Number.isFinite(Number(minimapData.visibility_window_width_tiles))
      ? Number(minimapData.visibility_window_width_tiles)
      : null;
    const visibilityWindowHeightTiles = Number.isFinite(Number(minimapData.visibility_window_height_tiles))
      ? Number(minimapData.visibility_window_height_tiles)
      : null;
    const visibilityHint = typeof minimapData.visibility_hint === "string" ? minimapData.visibility_hint : null;

    res.json({
      ok: true,
      data: {
        minimap_data: minimapData,
        map_id: mapId,
        map_markers: mapMarkers,
        visibility_reduced: visibilityReduced,
        visibility_window_width_tiles: visibilityWindowWidthTiles,
        visibility_window_height_tiles: visibilityWindowHeightTiles,
        visibility_hint: visibilityHint,
      },
    });
  });

  const wss = new socketHub.WebSocket.Server({ server });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(
      `[WS CONNECT] Frontend client connected from ${clientIp}. Current client count: ${
        socketHub.clients.size + 1
      }`
    );
    socketHub.registerClient(ws);

    try {
      const lastSummaryText =
        state.summaries.length > 0 ? state.summaries[state.summaries.length - 1].text : "";
      const lastCriticism = fsSync.existsSync(config.paths.lastCriticismSaveFile)
        ? fsSync.readFileSync(config.paths.lastCriticismSaveFile, "utf8")
        : "";

      const nextLoopStepState = computeLoopStepState();
      loopStepState.isSummaryStep = nextLoopStepState.isSummaryStep;
      loopStepState.isCriticismStep = nextLoopStepState.isCriticismStep;

      const initialState = {
        ...fullStatePayload(lastSummaryText, lastCriticism),
        isSummaryStep: loopStepState.isSummaryStep,
        isCriticismStep: loopStepState.isCriticismStep,
      };

      ws.send(JSON.stringify({ type: "full_state", payload: initialState }));
      socketHub.broadcast({ type: "status_update", payload: "Frontend connected, initial state sent." });
    } catch (e) {
      console.error("Error sending initial state:", e);
      if (ws.readyState === socketHub.WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error_message", payload: "Failed to send initial state." }));
      }
    }

    ws.on("message", (message) => {
      // Frontend messages are currently ignored (agent runs autonomously).
      // Keep for debugging.
      console.log("Received from client (ignored): %s", message);
    });

    ws.on("close", () => {
      console.log(`[WS CLOSE] Frontend client disconnected. Clients before: ${socketHub.clients.size}`);
      socketHub.unregisterClient(ws);
      console.log(`[WS CLOSE] Client removed. Clients after: ${socketHub.clients.size}`);
    });

    ws.on("error", (error) => {
      console.error(
        `[WS ERROR] WebSocket error on client: ${error.message}. Removing client. Clients before: ${socketHub.clients.size}`
      );
      socketHub.unregisterClient(ws);
      console.error(`[WS ERROR] Client removed due to error. Clients after: ${socketHub.clients.size}`);
    });
  });

  server.listen(wsPort, () => {
    console.log(`HTTP and WebSocket server started on http://localhost:${wsPort}`);
  });

  if (config.agentAutostart && config.agentProvider !== "codex-desktop") {
    if (config.isHeartGold && config.autoLaunchEmulator) {
      try {
        const launchResult = await launchEmulator();
        if (!launchResult?.ok && !launchResult?.running) {
          console.warn("HeartGold emulator launch returned a non-ok result:", launchResult);
          socketHub.broadcast({
            type: "error_message",
            payload: `HeartGold emulator launch returned non-ok: ${launchResult?.message || "unknown"}`,
          });
        }
        if (config.autoBootstrapIntro) {
          const bootstrapResult = await bootstrapIntro();
          if (!bootstrapResult?.ok) {
            console.warn("HeartGold intro bootstrap returned a non-ok result:", bootstrapResult);
            socketHub.broadcast({
              type: "error_message",
              payload: `HeartGold intro bootstrap returned non-ok: ${bootstrapResult?.message || "unknown"}`,
            });
          }
        }
      } catch (error) {
        console.warn("HeartGold emulator auto-launch failed:", error.message);
        socketHub.broadcast({
          type: "error_message",
          payload: `HeartGold emulator auto-launch failed: ${error.message}`,
        });
      }
    }
    startGameLoopInBackground();
  } else if (config.agentProvider === "codex-desktop") {
    console.log("Codex Desktop provider enabled. Use /codexDesktop/observation and /codexDesktop/action; no API/CLI model loop is started.");
  } else {
    console.log("Agent loop autostart disabled by AGENT_AUTOSTART=false.");
  }
}

start().catch((error) => {
  console.error("Fatal unhandled error:", error);
  if (typeof socketHub.broadcast === "function") {
    socketHub.broadcast({ type: "error_message", payload: `Fatal error: ${error.message}. Agent stopping.` });
  }
  process.exit(1);
});
