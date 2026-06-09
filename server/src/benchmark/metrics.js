const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { config } = require("../config");
const socketHub = require("../core/socketHub");
const { buildObservationExposure } = require("../ai/observationContract");

const OBSERVATION_MODE_ALIASES = new Map([
  ["standard", "ram_assisted"],
  ["standard_assisted", "ram_assisted"],
  ["assisted", "ram_assisted"],
]);

function nowIso() {
  return new Date().toISOString();
}

function truthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function benchmarkLaneForMode(mode) {
  if (mode === "visual") return "primary_visual";
  if (mode === "ram_assisted") return "ram_assisted";
  return "diagnostic";
}

function normalizedObservationMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  return OBSERVATION_MODE_ALIASES.get(raw) || raw || "unknown";
}

function bridgeObservationMode(gameDataJson) {
  return normalizedObservationMode(gameDataJson?.observationPolicy?.mode || gameDataJson?.game?.observationMode || null);
}

function benchmarkComparableFromConfig() {
  const requestedSpeed = String(process.env.HEARTGOLD_SPEED_MODE || "100");
  const comparableModes = new Set(["visual", "ram_assisted"]);
  const configuredMode = normalizedObservationMode(config.observation.mode);
  const requestedMode = normalizedObservationMode(config.observation.requestedMode);
  const modelImageScale = Number(config.observation.modelImageScale);
  const hasFixedModelImageScale = Number.isInteger(modelImageScale) && modelImageScale >= 1 && modelImageScale <= 4;
  return (
    comparableModes.has(configuredMode) &&
    comparableModes.has(requestedMode) &&
    config.observation.modeWasInvalid === false &&
    config.observation.exposeOracle === false &&
    hasFixedModelImageScale &&
    requestedSpeed === "100" &&
    !truthyEnv(process.env.HEARTGOLD_ALLOW_FAST_FORWARD)
  );
}

function addUnique(list, value) {
  const arr = Array.isArray(list) ? list : [];
  return arr.includes(value) ? arr : [...arr, value];
}

function refreshComparabilityFlags(m) {
  if (!m || typeof m !== "object") return m;
  const configComparable = benchmarkComparableFromConfig();
  const normalizedCount = Math.max(0, Number(m.normalized_action_schema_count) || 0);
  m.strict_schema_comparable = normalizedCount === 0;
  if (!m.strict_schema_comparable) {
    m.comparability_warnings = addUnique(
      m.comparability_warnings,
      "codex_desktop_action_shorthand_normalized"
    );
  } else {
    m.comparability_warnings = Array.isArray(m.comparability_warnings) ? m.comparability_warnings : [];
  }
  m.benchmark_comparable =
    configComparable &&
    m.strict_schema_comparable &&
    !m.harness_health?.observation_mode_mismatch;
  return m;
}

function configuredModel() {
  if (config.agentProvider === "codex-cli") return config.codexCli.model;
  if (config.agentProvider === "codex-desktop") return config.codexDesktop.model;
  return config.openai.model;
}

function configuredReasoningEffort() {
  if (config.agentProvider === "codex-cli") return config.codexCli.reasoningEffort;
  if (config.agentProvider === "codex-desktop") return config.codexDesktop.reasoningEffort;
  return config.openai.reasoningEffort;
}

function currentBenchmarkContract() {
  return {
    profile: config.gameProfile,
    provider: config.agentProvider,
    model: configuredModel(),
    reasoning_effort: configuredReasoningEffort(),
    observation_mode: config.observation.mode,
    requested_observation_mode: config.observation.requestedMode,
    mode_was_invalid: config.observation.modeWasInvalid,
    benchmark_lane: benchmarkLaneForMode(config.observation.mode),
    expose_oracle: config.observation.exposeOracle,
    state_confidence_required: config.observation.confidenceRequired,
    model_image_scale: config.observation.modelImageScale,
    requested_speed_mode: String(process.env.HEARTGOLD_SPEED_MODE || "100"),
    allow_fast_forward: truthyEnv(process.env.HEARTGOLD_ALLOW_FAST_FORWARD),
  };
}

function sameBenchmarkContract(a, b) {
  if (!a || !b) return false;
  const keys = [
    "profile",
    "provider",
    "model",
    "reasoning_effort",
    "observation_mode",
    "requested_observation_mode",
    "mode_was_invalid",
    "benchmark_lane",
    "expose_oracle",
    "state_confidence_required",
    "model_image_scale",
    "requested_speed_mode",
    "allow_fast_forward",
  ];
  return keys.every((key) => a[key] === b[key]);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function emptyMetrics() {
  const contract = currentBenchmarkContract();
  return {
    run_id: process.env.BENCHMARK_RUN_ID || `heartgold-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    profile: contract.profile,
    provider: contract.provider,
    model: contract.model,
    reasoning_effort: contract.reasoning_effort,
    observation_mode: contract.observation_mode,
    requested_observation_mode: contract.requested_observation_mode,
    mode_was_invalid: contract.mode_was_invalid,
    benchmark_lane: contract.benchmark_lane,
    oracle_exposed: contract.expose_oracle,
    diagnostics_exposed: ["harness_validation", "oracle_debug"].includes(contract.observation_mode),
    primary_benchmark: contract.observation_mode === "ram_assisted",
    benchmark_comparable: benchmarkComparableFromConfig(),
    strict_schema_comparable: true,
    comparability_warnings: [],
    model_image_scale: contract.model_image_scale,
    requested_speed_mode: contract.requested_speed_mode,
    allow_fast_forward: contract.allow_fast_forward,
    benchmark_contract: contract,
    started_at: nowIso(),
    last_updated_at: nowIso(),
    emulator_speed_mode: contract.requested_speed_mode,
    rom_hash: null,
    step_count: 0,
    action_batches: 0,
    total_commands: 0,
    raw_successful_commands: 0,
    successful_commands: 0,
    failed_commands: 0,
    partial_failed_commands: 0,
    blocked_failed_commands: 0,
    interrupted_commands: 0,
    semantic_completed_commands: 0,
    partial_progress_commands: 0,
    blocked_commands: 0,
    semantic_unverified_commands: 0,
    observed_effect_commands: 0,
    no_visible_effect_commands: 0,
    effect_unknown_commands: 0,
    collisions: 0,
    map_transitions: 0,
    unique_maps: [],
    minimap_explored_tiles: 0,
    objectives_completed: 0,
    progress_steps_completed: 0,
    party_count: 0,
    badges: 0,
    battles_detected: 0,
    battles_won: null,
    battles_lost: null,
    battles_fled: null,
    dialogue_advances: 0,
    menu_interactions: 0,
    touch_interactions: 0,
    touch_axis_mismatch_count: 0,
    touch_semantic_unverified_count: 0,
    path_to_location_attempts: 0,
    path_to_location_success: 0,
    path_to_location_partial: 0,
    path_to_location_fail: 0,
    button_sequence_partial: 0,
    dialogue_advance_partial: 0,
    invalid_action_schema_count: 0,
    normalized_action_schema_count: 0,
    tool_errors: 0,
    harness_action_errors: 0,
    bridge_timeouts: 0,
    stale_screenshots: 0,
    stale_observation_actions_blocked: 0,
    mode_mismatch_count: 0,
    deadlock_episodes: 0,
    recovery_attempts: 0,
    save_count: 0,
    load_count: 0,
    model_calls: 0,
    model_call_durations_ms: [],
    total_model_ms: 0,
    command_trace_count: 0,
    last_frame: null,
    last_screenshot_hash: null,
    last_screenshot_age_ms: null,
    last_position_key: null,
    last_action_signature: null,
    last_model_call: null,
    latest_model_observation: null,
    last_action_batch: null,
    harness_health: {
      last_observation_ok: false,
      last_observation_at: null,
      last_error: null,
      last_error_at: null,
      observation_mode_mismatch: null,
      excluded_windows: [],
    },
    continuity: {
      decision_payload_samples: 0,
      step_details_chars_total: 0,
      chat_message_chars_total: 0,
      last_step_details_chars: null,
      last_chat_message_chars: null,
      pending_no_effect_signature: null,
      repeated_action_after_no_effect_count: 0,
      adapted_after_no_effect_count: 0,
      pending_blocked_signature: null,
      repeated_action_after_blocked_count: 0,
      adapted_after_blocked_count: 0,
      continuity_warnings: [],
    },
    stuck: {
      active: false,
      reason: null,
      warnings: [],
      recent_collision_batches: [],
      collision_cluster_count: 0,
      last_collision_cluster_at_step: null,
      same_screenshot_count: 0,
      same_position_count: 0,
      same_action_count: 0,
      no_progress_steps: 0,
      last_detected_at: null,
      last_recovered_at: null,
      recoveries: [],
      episodes: 0,
    },
  };
}

let metrics = null;

function loadMetrics() {
  if (metrics) return metrics;
  const fresh = emptyMetrics();
  try {
    if (fs.existsSync(config.paths.benchmarkMetricsFile)) {
      const raw = fs.readFileSync(config.paths.benchmarkMetricsFile, "utf8");
      const parsed = raw.trim() ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (process.env.BENCHMARK_RESUME_METRICS !== "true" && !sameBenchmarkContract(parsed.benchmark_contract, fresh.benchmark_contract)) {
          metrics = {
            ...fresh,
            previous_run: {
              run_id: parsed.run_id || null,
              reason: "benchmark contract changed; started a fresh metrics window",
            },
          };
          persistMetrics({ broadcast: false });
          return metrics;
        }
        metrics = { ...fresh, ...parsed };
        metrics.profile = fresh.profile;
        metrics.provider = fresh.provider;
        metrics.model = fresh.model;
        metrics.reasoning_effort = fresh.reasoning_effort;
        metrics.observation_mode = fresh.observation_mode;
        metrics.requested_observation_mode = fresh.requested_observation_mode;
        metrics.mode_was_invalid = fresh.mode_was_invalid;
        metrics.benchmark_lane = fresh.benchmark_lane;
        metrics.oracle_exposed = fresh.oracle_exposed;
        metrics.diagnostics_exposed = fresh.diagnostics_exposed;
        metrics.primary_benchmark = fresh.primary_benchmark;
        metrics.benchmark_comparable = fresh.benchmark_comparable;
        metrics.model_image_scale = fresh.model_image_scale;
        metrics.requested_speed_mode = fresh.requested_speed_mode;
        metrics.allow_fast_forward = fresh.allow_fast_forward;
        metrics.benchmark_contract = fresh.benchmark_contract;
        metrics.stuck = { ...fresh.stuck, ...(parsed.stuck || {}) };
        metrics.stuck.recent_collision_batches = Array.isArray(metrics.stuck.recent_collision_batches)
          ? metrics.stuck.recent_collision_batches
          : [];
        metrics.stuck.collision_cluster_count = Math.max(0, Number(metrics.stuck.collision_cluster_count) || 0);
        metrics.harness_health = { ...fresh.harness_health, ...(parsed.harness_health || {}) };
        metrics.continuity = { ...fresh.continuity, ...(parsed.continuity || {}) };
        metrics.continuity.continuity_warnings = Array.isArray(metrics.continuity.continuity_warnings)
          ? metrics.continuity.continuity_warnings
          : [];
        metrics.comparability_warnings = Array.isArray(metrics.comparability_warnings) ? metrics.comparability_warnings : [];
        metrics.stuck.recoveries = Array.isArray(metrics.stuck.recoveries) ? metrics.stuck.recoveries : [];
        return refreshComparabilityFlags(metrics);
      }
    }
  } catch (error) {
    console.warn("Failed to load benchmark metrics:", error.message);
  }
  metrics = fresh;
  persistMetrics();
  return metrics;
}

function persistMetrics({ broadcast = true } = {}) {
  if (!metrics) return;
  metrics.last_updated_at = nowIso();
  try {
    ensureDir(config.paths.benchmarkMetricsFile);
    fs.writeFileSync(config.paths.benchmarkMetricsFile, JSON.stringify(metrics, null, 2), "utf8");
  } catch (error) {
    console.warn("Failed to persist benchmark metrics:", error.message);
  }
  if (broadcast) {
    socketHub.broadcast({ type: "benchmark_metrics_update", payload: metrics });
  }
}

function appendEvent(type, payload = {}) {
  try {
    ensureDir(config.paths.benchmarkEventsFile);
    fs.appendFileSync(
      config.paths.benchmarkEventsFile,
      JSON.stringify({ ts: nowIso(), type, ...payload }) + "\n",
      "utf8"
    );
  } catch (error) {
    console.warn("Failed to append benchmark event:", error.message);
  }
}

function sha256File(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function screenshotInfo(gameDataJson) {
  const obs = gameDataJson?.observationFreshness || {};
  const rawPath =
    obs.screenshotPath ||
    gameDataJson?.screenshot_raw_path ||
    gameDataJson?.emulator?.screenshotRawPath ||
    gameDataJson?.raw_state?.bridge?.screenshotRawPath ||
    null;
  let ageMs = Number.isFinite(Number(obs.screenshotAgeMs)) ? Number(obs.screenshotAgeMs) : null;
  let hash = obs.screenshotHash || gameDataJson?.screenshotHash || gameDataJson?.emulator?.screenshotHash || null;
  if (rawPath && fs.existsSync(rawPath)) {
    try {
      const stat = fs.statSync(rawPath);
      if (ageMs === null) ageMs = Math.max(0, Date.now() - stat.mtimeMs);
      if (!hash) hash = sha256File(rawPath);
    } catch {
      // keep null fields
    }
  }
  return { rawPath, ageMs, hash };
}

function positionKey(gameDataJson) {
  const pos = gameDataJson?.current_trainer_data?.position;
  if (!pos || typeof pos !== "object") return null;
  const map = pos.map_id ?? "unknown";
  const x = pos.x ?? "?";
  const y = pos.y ?? "?";
  return `${map}:${x}:${y}:${gameDataJson?.is_talking_to_npc ? "dialog" : "free"}:${gameDataJson?.is_in_battle ? "battle" : "field"}`;
}

function countExploredTiles(minimap) {
  const grid = minimap?.grid;
  if (!Array.isArray(grid)) return 0;
  let count = 0;
  for (const row of grid) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      if (cell !== null && cell !== undefined) count += 1;
    }
  }
  return count;
}

function setStuck(nextActive, reason, details = {}) {
  const m = loadMetrics();
  const wasActive = m.stuck.active === true;
  if (nextActive && !m.stuck.active) {
    m.stuck.episodes += 1;
    m.deadlock_episodes += 1;
  }
  m.stuck.active = nextActive;
  m.stuck.reason = nextActive ? reason : null;
  if (nextActive) {
    m.stuck.last_detected_at = nowIso();
    const warning = { ts: m.stuck.last_detected_at, reason };
    m.stuck.warnings = [warning, ...(Array.isArray(m.stuck.warnings) ? m.stuck.warnings : [])].slice(0, 20);
    appendEvent("stuck_warning", warning);
  } else if (!nextActive && wasActive) {
    const recovery = {
      ts: nowIso(),
      reason: reason || "active stuck reasons cleared",
      previous_reason: details.previous_reason || null,
      screenshot_hash: details.screenshot_hash || null,
      position_key: details.position_key || null,
      dialog_active: details.dialog_active === true,
      battle_active: details.battle_active === true,
    };
    m.stuck.last_recovered_at = recovery.ts;
    m.stuck.recoveries = [recovery, ...(Array.isArray(m.stuck.recoveries) ? m.stuck.recoveries : [])].slice(0, 20);
    m.stuck_recoveries = Math.max(0, Number(m.stuck_recoveries) || 0) + 1;
    appendEvent("stuck_recovered", recovery);
  }
}

function recordObservation(gameDataJson, { step = 0, progressSteps = [] } = {}) {
  const m = loadMetrics();
  const exposure = buildObservationExposure(gameDataJson || {});
  const navigationValidated = !exposure.heartgold || exposure.navigation?.validated === true;
  const partyValidated = !exposure.heartgold || exposure.fields?.party?.validated === true;
  const badgesValidated = !exposure.heartgold || exposure.fields?.badges?.validated === true;
  m.step_count = Math.max(m.step_count || 0, Number(step) || 0);
  m.harness_health.last_observation_ok = Boolean(gameDataJson);
  m.harness_health.last_observation_at = nowIso();
  if (config.isHeartGold && gameDataJson) {
    const bridgeMode = bridgeObservationMode(gameDataJson);
    const configuredMode = normalizedObservationMode(config.observation.mode);
    const mismatch =
      bridgeMode !== "unknown" && (bridgeMode !== configuredMode || config.observation.modeWasInvalid === true);
    m.harness_health.observation_mode_mismatch = mismatch
      ? {
          configured_mode: configuredMode,
          bridge_mode: bridgeMode,
          mode_was_invalid: config.observation.modeWasInvalid === true,
          at: nowIso(),
        }
      : null;
    if (mismatch) {
      m.mode_mismatch_count += 1;
      m.benchmark_comparable = false;
      m.harness_health.last_error = `Observation mode mismatch: configured=${configuredMode}, bridge=${bridgeMode}`;
      m.harness_health.last_error_at = m.harness_health.observation_mode_mismatch.at;
      appendEvent("observation_mode_mismatch", m.harness_health.observation_mode_mismatch);
    }
  }

  const romHash = gameDataJson?.game?.romSha256 || gameDataJson?.game?.romMd5 || null;
  if (romHash) m.rom_hash = romHash;
  const frame = Number(gameDataJson?.emulator?.frame);
  if (Number.isFinite(frame)) m.last_frame = frame;

  const sshot = screenshotInfo(gameDataJson);
  m.last_screenshot_age_ms = sshot.ageMs;
  if (sshot.hash) {
    if (sshot.hash === m.last_screenshot_hash) {
      m.stuck.same_screenshot_count += 1;
    } else {
      m.stuck.same_screenshot_count = 0;
    }
    m.last_screenshot_hash = sshot.hash;
  }
  if (sshot.ageMs !== null && sshot.ageMs > 5000) {
    m.stale_screenshots += 1;
    appendEvent("stale_screenshot", { step, age_ms: sshot.ageMs, path: sshot.rawPath });
  }

  const pKey = positionKey(gameDataJson);
  let positionChanged = false;
  if (pKey && navigationValidated) {
    const previousPositionKey = m.last_position_key;
    if (pKey === m.last_position_key) {
      m.stuck.same_position_count += 1;
    } else {
      m.stuck.same_position_count = 0;
    }
    positionChanged = Boolean(previousPositionKey && pKey !== previousPositionKey);
    m.last_position_key = pKey;
    const mapId = String(gameDataJson?.current_trainer_data?.position?.map_id || "");
    if (navigationValidated && mapId && !["0", "unknown", "undefined"].includes(mapId) && !m.unique_maps.includes(mapId)) {
      m.unique_maps.push(mapId);
    }
  } else if (!navigationValidated) {
    m.stuck.same_position_count = 0;
  }

  const completedProgress = Array.isArray(progressSteps)
    ? progressSteps.filter((stepItem) => stepItem && stepItem.done === true).length
    : 0;
  const team = Array.isArray(gameDataJson?.current_pokemon_data) ? gameDataJson.current_pokemon_data : [];
  const partyPresenceCount = Number(gameDataJson?.ram_assisted?.party?.count);
  const nextPartyCount = partyValidated
    ? Math.max(team.length, Number.isFinite(partyPresenceCount) ? partyPresenceCount : 0)
    : m.party_count;
  const nextBadges = badgesValidated ? Number(gameDataJson?.current_trainer_data?.badge_count || m.badges || 0) : m.badges;
  const nextExploredTiles = Math.max(m.minimap_explored_tiles || 0, countExploredTiles(gameDataJson?.minimap_data));
  const meaningfulProgress =
    completedProgress > m.progress_steps_completed ||
    positionChanged ||
    nextPartyCount > (m.party_count || 0) ||
    nextBadges > (m.badges || 0) ||
    nextExploredTiles > (m.minimap_explored_tiles || 0);

  if (meaningfulProgress) {
    m.stuck.no_progress_steps = 0;
  } else {
    m.stuck.no_progress_steps += 1;
  }
  m.progress_steps_completed = Math.max(m.progress_steps_completed || 0, completedProgress);
  m.objectives_completed = completedProgress;

  if (partyValidated) m.party_count = nextPartyCount;
  if (badgesValidated) m.badges = nextBadges;
  if (gameDataJson?.is_in_battle || gameDataJson?.battle_data?.in_battle) m.battles_detected += 1;
  m.minimap_explored_tiles = nextExploredTiles;

  const stuckReasons = [];
  if (m.stuck.same_screenshot_count >= 8) stuckReasons.push(`same screenshot hash ${m.stuck.same_screenshot_count} observations`);
  const samePositionLooksStatic = m.stuck.same_position_count >= 12 && m.stuck.same_screenshot_count >= 3;
  if (samePositionLooksStatic && !gameDataJson?.is_talking_to_npc && !gameDataJson?.is_in_battle) {
    stuckReasons.push(`same position ${m.stuck.same_position_count} observations`);
  }
  const dialogOrBattleActive = gameDataJson?.is_talking_to_npc === true || gameDataJson?.is_in_battle === true;
  const repeatedActionLooksStuck =
    m.stuck.same_action_count >= 5 &&
    !dialogOrBattleActive &&
    !meaningfulProgress &&
    m.stuck.same_screenshot_count >= 3 &&
    m.stuck.same_position_count >= 3;
  if (repeatedActionLooksStuck) stuckReasons.push(`same action batch ${m.stuck.same_action_count} times`);
  if (
    m.stuck.no_progress_steps >= 50 &&
    (m.stuck.same_screenshot_count >= 8 || samePositionLooksStatic || m.stuck.same_action_count >= 5)
  ) {
    stuckReasons.push(`no benchmark progress ${m.stuck.no_progress_steps} observations`);
  }
  if (stuckReasons.length) setStuck(true, stuckReasons.join("; "));
  else if (m.stuck.active) {
    setStuck(false, "active stuck reasons cleared after new observation", {
      previous_reason: m.stuck.reason,
      screenshot_hash: sshot.hash || null,
      position_key: pKey || null,
      dialog_active: gameDataJson?.is_talking_to_npc === true,
      battle_active: gameDataJson?.is_in_battle === true,
    });
  }

  refreshComparabilityFlags(m);
  persistMetrics();
  return m;
}

function actionSignature(actions) {
  if (!Array.isArray(actions)) return "";
  return JSON.stringify(
    actions.map((action) => ({
      type: action?.type,
      keys: action?.keys,
      frames: action?.frames,
      max_presses: action?.max_presses,
      sequence: Array.isArray(action?.sequence)
        ? action.sequence.map((step) => ({
            keys: step?.keys ?? step?.buttons,
            frames: step?.frames,
          }))
        : undefined,
      x: action?.x,
      y: action?.y,
      map_id: action?.map_id,
    }))
  );
}

function continuityWarning(m, warning) {
  if (!m?.continuity) return;
  m.continuity.continuity_warnings = [
    warning,
    ...(Array.isArray(m.continuity.continuity_warnings) ? m.continuity.continuity_warnings : []),
  ].slice(0, 20);
  appendEvent("continuity_warning", warning);
}

function updateContinuityMetrics(
  m,
  {
    sig = "",
    noEffectSig = "",
    blockedSig = "",
    step = null,
    stepDetails = "",
    chatMessage = "",
    noVisibleEffects = 0,
    blockedCommands = 0,
    collisions = 0,
  } = {}
) {
  if (!m?.continuity) return { step_details_chars: 0, chat_message_chars: 0 };
  const detailsText = String(stepDetails || "");
  const messageText = String(chatMessage || "");
  const decisionPayload = {
    step_details_chars: detailsText.length,
    chat_message_chars: messageText.length,
  };
  if (decisionPayload.step_details_chars > 0 || decisionPayload.chat_message_chars > 0) {
    m.continuity.decision_payload_samples = Math.max(0, Number(m.continuity.decision_payload_samples) || 0) + 1;
    m.continuity.step_details_chars_total =
      Math.max(0, Number(m.continuity.step_details_chars_total) || 0) + decisionPayload.step_details_chars;
    m.continuity.chat_message_chars_total =
      Math.max(0, Number(m.continuity.chat_message_chars_total) || 0) + decisionPayload.chat_message_chars;
    m.continuity.last_step_details_chars = decisionPayload.step_details_chars;
    m.continuity.last_chat_message_chars = decisionPayload.chat_message_chars;
  }

  const previousNoEffectSignature = String(m.continuity.pending_no_effect_signature || "");
  const currentNoEffectSignature = String(noEffectSig || sig || "");
  if (previousNoEffectSignature && currentNoEffectSignature) {
    if (currentNoEffectSignature === previousNoEffectSignature) {
      m.continuity.repeated_action_after_no_effect_count =
        Math.max(0, Number(m.continuity.repeated_action_after_no_effect_count) || 0) + 1;
      continuityWarning(m, {
        ts: nowIso(),
        step: Number(step) || null,
        reason: "same action repeated after no visible effect",
        signature: currentNoEffectSignature,
      });
    } else {
      m.continuity.adapted_after_no_effect_count =
        Math.max(0, Number(m.continuity.adapted_after_no_effect_count) || 0) + 1;
    }
  }

  const previousBlockedSignature = String(m.continuity.pending_blocked_signature || "");
  const currentBlockedSignature = String(blockedSig || sig || "");
  if (previousBlockedSignature && currentBlockedSignature) {
    if (currentBlockedSignature === previousBlockedSignature) {
      m.continuity.repeated_action_after_blocked_count =
        Math.max(0, Number(m.continuity.repeated_action_after_blocked_count) || 0) + 1;
      continuityWarning(m, {
        ts: nowIso(),
        step: Number(step) || null,
        reason: "same action repeated after blocked/collision result",
        signature: currentBlockedSignature,
      });
    } else {
      m.continuity.adapted_after_blocked_count =
        Math.max(0, Number(m.continuity.adapted_after_blocked_count) || 0) + 1;
    }
  }

  m.continuity.pending_no_effect_signature =
    currentNoEffectSignature && Number(noVisibleEffects) > 0 ? currentNoEffectSignature : null;
  m.continuity.pending_blocked_signature =
    currentBlockedSignature && (Number(blockedCommands) > 0 || Number(collisions) > 0) ? currentBlockedSignature : null;
  return decisionPayload;
}

function responseEvents(response) {
  const events = [];
  if (Array.isArray(response?.events)) events.push(...response.events);
  if (Array.isArray(response?.trace?.events)) events.push(...response.trace.events);
  for (const item of nestedResponseItems(response)) {
    if (Array.isArray(item?.events)) events.push(...item.events);
    if (Array.isArray(item?.trace?.events)) events.push(...item.trace.events);
  }
  return events.map((event) => String(event));
}

function responseHasCollision(response) {
  if (response?.interruptedByCollision === true) return true;
  if (nestedResponseItems(response).some((item) => item?.interruptedByCollision === true)) return true;
  return responseEvents(response).some((event) => event.toLowerCase().includes("collision"));
}

function responseHasMapTransition(response) {
  if (response?.interruptedByMapTransition === true || response?.mapChanged === true) return true;
  if (nestedResponseItems(response).some((item) => item?.mapChanged === true)) return true;
  return responseEvents(response).some((event) => event.toLowerCase().includes("map_transition"));
}

function nestedResponseItems(response) {
  const items = [];
  for (const key of ["responses", "results"]) {
    if (Array.isArray(response?.[key])) {
      for (const item of response[key]) {
        if (item && typeof item === "object") items.push(item);
      }
    }
  }
  return items;
}

function responseItems(response) {
  const items = [];
  if (response && typeof response === "object") items.push(response);
  for (const key of ["responses", "results"]) {
    if (Array.isArray(response?.[key])) {
      for (const item of response[key]) {
      if (item && typeof item === "object") items.push(item);
      }
    }
  }
  return items;
}

function maxFrameDelta(response) {
  let maxDelta = null;
  for (const item of responseItems(response)) {
    const delta = Number(item?.frameDelta ?? item?.frame_delta ?? item?.framesAdvanced);
    if (Number.isFinite(delta)) maxDelta = maxDelta === null ? delta : Math.max(maxDelta, delta);
  }
  return maxDelta;
}

function actionEffectEvidence(response) {
  if (!response || typeof response !== "object") {
    return { observed: null, reason: "no_python_response", frameDelta: null };
  }
  const items = responseItems(response);
  const screenChanged = items.some((item) => item?.screenChanged === true);
  const screenUnchangedKnown = items.some((item) => item?.screenChanged === false);
  const positionUpdated = items.some((item) => item?.observedPositionUpdated === true);
  const positionUnchangedKnown = items.some((item) => item?.observedPositionUpdated === false);
  const interrupted =
    response?.interruptedByCollision === true ||
    response?.interruptedByDialog === true ||
    response?.interruptedByBattle === true ||
    items.some((item) => item?.interruptedByCollision === true || item?.interruptedByDialog === true || item?.interruptedByBattle === true);
  const collision = responseHasCollision(response);
  const mapTransition = responseHasMapTransition(response);
  const frameDelta = maxFrameDelta(response);

  if (screenChanged) return { observed: true, reason: "screen_changed", frameDelta };
  if (positionUpdated) return { observed: true, reason: "position_updated", frameDelta };
  if (mapTransition) return { observed: true, reason: "map_transition", frameDelta };
  if (interrupted || collision) return { observed: true, reason: collision ? "collision_or_blocked" : "interrupted", frameDelta };
  if (screenUnchangedKnown && positionUnchangedKnown) {
    return { observed: false, reason: "no_screen_or_position_change", frameDelta };
  }
  if (screenUnchangedKnown) return { observed: false, reason: "screen_unchanged", frameDelta };
  return { observed: null, reason: "effect_not_reported", frameDelta };
}

function isInvalidActionSchemaFailure(action, result) {
  if (action?.type === "key_press" && (!Array.isArray(action.keys) || action.keys.length === 0)) return true;
  const text = `${result?.message || ""}\n${result?.details || ""}`;
  return /\b(schema|invalid action|'keys' are missing|keys.*not an array|keys.*empty)\b/i.test(text);
}

function remainingCommandsFromResponse(response) {
  return Array.isArray(response?.remaining_keys) ? response.remaining_keys : [];
}

function responseHasUnverifiedTouchTarget(response) {
  if (!response || typeof response !== "object") return false;
  return responseItems(response).some((item) => {
    const outcome = String(item?.actionOutcome || "");
    return (
      outcome === "verified_visible_effect_with_unreliable_axis_echo" ||
      outcome === "input_delivered_visible_effect_semantic_unverified" ||
      item?.axisEchoReliable === false ||
      item?.touchAxisEchoWarning ||
      item?.semanticTargetVerified === false
    );
  });
}

function touchCoordinateMismatchEvidence(response) {
  if (!response || typeof response !== "object") return null;
  for (const item of responseItems(response)) {
    const command = item?.command || {};
    const warning = item?.touchAxisEchoWarning || item?.harnessWarning || item?.harnessFailureReason || null;
    const axisEchoMatched = item?.axisEchoMatched;
    const axisEchoReliable = item?.axisEchoReliable;
    const hasMismatch =
      axisEchoMatched === false ||
      axisEchoReliable === false ||
      Boolean(item?.touchAxisEchoWarning) ||
      String(item?.actionOutcome || "") === "verified_visible_effect_with_unreliable_axis_echo";
    if (!hasMismatch) continue;
    return {
      axis_echo_matched: axisEchoMatched === undefined ? null : axisEchoMatched === true,
      axis_echo_reliable: axisEchoReliable === undefined ? null : axisEchoReliable === true,
      requested: {
        x: Number.isFinite(Number(command.x ?? item?.x)) ? Number(command.x ?? item?.x) : null,
        y: Number.isFinite(Number(command.y ?? item?.y)) ? Number(command.y ?? item?.y) : null,
        coordinate_space: command.coordinate_space || item?.coordinate_space || null,
      },
      normalized: {
        x: Number.isFinite(Number(command.normalized_x ?? item?.normalized_x)) ? Number(command.normalized_x ?? item?.normalized_x) : null,
        y: Number.isFinite(Number(command.normalized_y ?? item?.normalized_y)) ? Number(command.normalized_y ?? item?.normalized_y) : null,
      },
      echo: {
        x: Number.isFinite(Number(item?.touchDebug?.during_axes?.["Touch X"])) ? Number(item.touchDebug.during_axes["Touch X"]) : null,
        y: Number.isFinite(Number(item?.touchDebug?.during_axes?.["Touch Y"])) ? Number(item.touchDebug.during_axes["Touch Y"]) : null,
      },
      semantic_target_verified: item?.semanticTargetVerified === undefined ? null : item.semanticTargetVerified === true,
      semantic_target_label: item?.semanticTargetLabel || command.target_label || null,
      warning: warning ? String(warning).slice(0, 240) : null,
    };
  }
  return null;
}

function typeTextAcceptedState(response) {
  if (!response || typeof response !== "object") return null;
  const item = responseItems(response).find((candidate) => candidate?.type === "type_text" || candidate?.acceptedStringMatchesRequested !== undefined);
  if (!item || item.acceptedStringMatchesRequested === undefined) return null;
  return item.acceptedStringMatchesRequested === true;
}

function responseInputDelivered(response) {
  if (!response || typeof response !== "object") return null;
  const items = responseItems(response);
  if (items.some((item) => item?.inputDelivered === false || item?.response?.inputDelivered === false)) return false;
  if (items.some((item) => item?.inputDelivered === true || item?.response?.inputDelivered === true)) return true;
  return null;
}

function isHarnessActionFailure(result) {
  const text = `${result?.message || ""}\n${result?.details || ""}`;
  return (
    /Request failed with status code \d+/i.test(text) ||
    /Python (?:bridge did not return game data|game state unavailable)/i.test(text) ||
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|network error/i.test(text)
  );
}

function semanticOutcomeForAction(action, result, response, effect) {
  const rawSuccess = result?.success === true;
  const explicitInputDelivered = result?.input_delivered ?? result?.inputDelivered ?? null;
  if (explicitInputDelivered === false) return "input_not_delivered";
  if (responseInputDelivered(response) === false) return "input_not_delivered";
  if (!rawSuccess && isHarnessActionFailure(result)) return "harness_error";
  if (rawSuccess && result?.semantic_success === true) return "completed";
  const explicitOutcome = result?.semantic_outcome || result?.semanticOutcome || null;
  if (explicitOutcome) {
    const normalized = String(explicitOutcome);
    if (/^(completed|verified|semantic_completed|semantic_target_verified|target_verified)$/.test(normalized)) {
      if (rawSuccess) return "completed";
    }
    if (/^(partial_progress|blocked|failed|harness_error|input_not_delivered|no_visible_effect|visible_effect|unverified)$/.test(normalized)) {
      return normalized;
    }
  }
  if (action?.type === "path_to_location") {
    const message = String(result?.message || "");
    if (responseHasMapTransition(response) && result?.success === true) return "partial_progress";
    if (remainingCommandsFromResponse(response).length > 0 || /^Partial path progress:/i.test(message)) {
      return "partial_progress";
    }
    if (result?.success !== true) return "failed";
    return "unverified";
  }
  if (action?.type === "button_sequence") {
    const message = String(result?.message || "");
    if (responseHasMapTransition(response) && result?.success === true) return "partial_progress";
    if (remainingCommandsFromResponse(response).length > 0 || /^Partial button sequence:/i.test(message)) {
      return "partial_progress";
    }
  }
  if (action?.type === "a_until_end_of_dialog") {
    const message = String(result?.message || "");
    if (/^Partial dialogue advance:/i.test(message)) {
      return "partial_progress";
    }
  }
  if (action?.type === "type_text") {
    const accepted = typeTextAcceptedState(response);
    if (accepted === true && rawSuccess) return "completed";
    if (accepted === false) return "unverified";
  }
  if (effect?.reason === "collision_or_blocked" || responseHasCollision(response)) return "blocked";
  if (action?.type === "touch" && responseHasUnverifiedTouchTarget(response)) return "unverified";
  if (result?.success !== true) return "failed";
  if (effect?.observed === true) return "visible_effect";
  if (effect?.observed === false) return "no_visible_effect";
  return "unverified";
}

function recordActionBatch({
  callId,
  step,
  actions = [],
  results = [],
  durationMs = 0,
  normalizedActionSchemaCount = 0,
  stepDetails = "",
  chatMessage = "",
} = {}) {
  const m = loadMetrics();
  const safeActions = Array.isArray(actions) ? actions : [];
  const safeResults = Array.isArray(results) ? results : [];
  const sig = actionSignature(safeActions);
  if (sig && sig === m.last_action_signature) m.stuck.same_action_count += 1;
  else m.stuck.same_action_count = 0;
  m.last_action_signature = sig;
  if (
    m.stuck.active === true &&
    m.stuck.same_action_count < 5 &&
    typeof m.stuck.reason === "string" &&
    m.stuck.reason.includes("same action batch")
  ) {
    setStuck(false, "action batch changed after same-action stuck warning", {
      previous_reason: m.stuck.reason,
    });
  }

  m.action_batches += safeActions.length > 0 ? 1 : 0;
  m.total_commands += safeActions.length;

  let rawSuccessful = 0;
  let successful = 0;
  let hardFailed = 0;
  let partialFailed = 0;
  let blockedFailed = 0;
  let harnessActionErrors = 0;
  let collisions = 0;
  let mapTransitions = 0;
  let interrupted = 0;
  let observedEffects = 0;
  let noVisibleEffects = 0;
  let effectUnknown = 0;
  let invalidActionSchema = 0;
  let semanticCompleted = 0;
  let partialProgress = 0;
  let blockedCommands = 0;
  let semanticUnverified = 0;
  let lastNoVisibleEffectSignature = "";
  let lastBlockedSignature = "";
  const resultSummaries = [];

  for (let i = 0; i < safeActions.length; i += 1) {
    const action = safeActions[i] || {};
    const result = safeResults[i] || {};
    const response = result.response || result.pythonResponse || null;
    const effect = actionEffectEvidence(response);
    const ok = result.success === true;
    const semanticOutcome = semanticOutcomeForAction(action, result, response, effect);
    const invalidSchema = !ok && isInvalidActionSchemaFailure(action, result);
    if (ok) rawSuccessful += 1;
    if (semanticOutcome === "completed") successful += 1;
    else if (semanticOutcome === "partial_progress") partialFailed += 1;
    else if (semanticOutcome === "blocked" && !ok) blockedFailed += 1;
    else if (semanticOutcome === "harness_error") harnessActionErrors += 1;
    else if (semanticOutcome === "failed") hardFailed += 1;
    if (invalidSchema) invalidActionSchema += 1;
    if (semanticOutcome === "completed") semanticCompleted += 1;
    else if (semanticOutcome === "partial_progress") partialProgress += 1;
    else if (semanticOutcome === "blocked") blockedCommands += 1;
    else if (semanticOutcome === "unverified" || semanticOutcome === "input_not_delivered" || semanticOutcome === "no_visible_effect" || semanticOutcome === "visible_effect") semanticUnverified += 1;

    if (action.type === "touch") m.touch_interactions += 1;
    const touchMismatch = action.type === "touch" ? touchCoordinateMismatchEvidence(response) : null;
    if (touchMismatch) m.touch_axis_mismatch_count = Math.max(0, Number(m.touch_axis_mismatch_count) || 0) + 1;
    if (action.type === "touch" && semanticOutcome === "unverified") {
      m.touch_semantic_unverified_count = Math.max(0, Number(m.touch_semantic_unverified_count) || 0) + 1;
    }
    if (action.type === "type_text") m.menu_interactions += 1;
    if (action.type === "path_to_location") {
      m.path_to_location_attempts += 1;
      if (semanticOutcome === "completed") m.path_to_location_success += 1;
      else if (semanticOutcome === "partial_progress") m.path_to_location_partial += 1;
      else m.path_to_location_fail += 1;
    }
    if (action.type === "button_sequence" && semanticOutcome === "partial_progress") {
      m.button_sequence_partial = Math.max(0, Number(m.button_sequence_partial) || 0) + 1;
    }
    if (action.type === "a_until_end_of_dialog" && semanticOutcome === "partial_progress") {
      m.dialogue_advance_partial = Math.max(0, Number(m.dialogue_advance_partial) || 0) + 1;
    }
    const keys = Array.isArray(action.keys) ? action.keys : [];
    if (keys.includes("a_until_end_of_dialog") || responseEvents(response).some((event) => event.includes("auto_a"))) {
      m.dialogue_advances += 1;
    }
    const collisionObserved = responseHasCollision(response);
    if (collisionObserved) collisions += 1;
    if (responseHasMapTransition(response)) mapTransitions += 1;
    if (
      response?.interruptedByCollision ||
      response?.interruptedByDialog ||
      response?.interruptedByBattle ||
      nestedResponseItems(response).some((item) => item?.interruptedByCollision || item?.interruptedByDialog || item?.interruptedByBattle)
    ) {
      interrupted += 1;
    }
    if (effect.observed === true) observedEffects += 1;
    else if (effect.observed === false) {
      noVisibleEffects += 1;
      lastNoVisibleEffectSignature = actionSignature([action]);
    }
    else effectUnknown += 1;
    if (semanticOutcome === "blocked" || collisionObserved) lastBlockedSignature = actionSignature([action]);
    resultSummaries.push({
      action_type: result.action_type,
      success: result.success,
      raw_success: ok,
      semantic_success: semanticOutcome === "completed",
      message: result.message,
      invalid_action_schema: invalidSchema,
      semantic_outcome: semanticOutcome,
      effect_observed: effect.observed,
      effect_reason: effect.reason,
      frame_delta: effect.frameDelta,
      touch_coordinate_mismatch: touchMismatch,
    });
  }

  m.raw_successful_commands = Math.max(0, Number(m.raw_successful_commands) || 0) + rawSuccessful;
  m.successful_commands += successful;
  m.failed_commands += hardFailed;
  m.partial_failed_commands = Math.max(0, Number(m.partial_failed_commands) || 0) + partialFailed;
  m.blocked_failed_commands = Math.max(0, Number(m.blocked_failed_commands) || 0) + blockedFailed;
  m.harness_action_errors = Math.max(0, Number(m.harness_action_errors) || 0) + harnessActionErrors;
  m.interrupted_commands += interrupted;
  m.semantic_completed_commands += semanticCompleted;
  m.partial_progress_commands += partialProgress;
  m.blocked_commands += blockedCommands;
  m.semantic_unverified_commands += semanticUnverified;
  m.observed_effect_commands += observedEffects;
  m.no_visible_effect_commands += noVisibleEffects;
  m.effect_unknown_commands += effectUnknown;
  m.invalid_action_schema_count += invalidActionSchema;
  m.normalized_action_schema_count += Math.max(0, Number(normalizedActionSchemaCount) || 0);
  if (normalizedActionSchemaCount > 0) {
    m.strict_schema_comparable = false;
    m.comparability_warnings = addUnique(
      m.comparability_warnings,
      "codex_desktop_action_shorthand_normalized"
    );
  }
  m.collisions += collisions;
  recordCollisionClusterSignal(m, {
    step: Number(step) || null,
    collisions,
    actions: safeActions,
    resultSummaries,
  });
  m.map_transitions += mapTransitions;
  m.tool_errors += Math.max(0, hardFailed - invalidActionSchema);
  m.command_trace_count += safeResults.reduce((count, result) => {
    const response = result?.response;
    if (!response || typeof response !== "object") return count;
    if (Array.isArray(response.results)) return count + response.results.length;
    return count + 1;
  }, 0);
  const decisionPayload = updateContinuityMetrics(m, {
    sig,
    noEffectSig: lastNoVisibleEffectSignature,
    blockedSig: lastBlockedSignature,
    step,
    stepDetails,
    chatMessage,
    noVisibleEffects,
    blockedCommands,
    collisions,
  });
  m.last_action_batch = {
    call_id: callId || null,
    step: Number(step) || null,
    duration_ms: Number(durationMs) || 0,
    actions: safeActions,
    decision_payload: decisionPayload,
    effect_summary: {
      observed: observedEffects,
      no_visible_effect: noVisibleEffects,
      unknown: effectUnknown,
    },
    normalized_action_schema_count: Math.max(0, Number(normalizedActionSchemaCount) || 0),
    results: resultSummaries,
  };
  appendEvent("action_batch", m.last_action_batch);
  refreshComparabilityFlags(m);
  persistMetrics();
}

function recordCollisionClusterSignal(m, { step = null, collisions = 0, actions = [], resultSummaries = [] } = {}) {
  if (!m?.stuck) return;
  const movementAction = Array.isArray(actions)
    ? actions.some((action) => ["key_press", "button_sequence", "path_to_location"].includes(action?.type))
    : false;
  const meaningfulCollision = collisions > 0 && movementAction;
  const recent = Array.isArray(m.stuck.recent_collision_batches) ? m.stuck.recent_collision_batches : [];
  if (meaningfulCollision) {
    recent.push({
      ts: nowIso(),
      step,
      collisions,
      actions: actions.map((action) => action?.type).filter(Boolean),
      result_reasons: resultSummaries
        .map((result) => result?.message || result?.effect_reason || null)
        .filter(Boolean)
        .slice(0, 3),
    });
  } else if (recent.length) {
    recent.push({ ts: nowIso(), step, collisions: 0, actions: [], result_reasons: ["non-collision action batch"] });
  }
  m.stuck.recent_collision_batches = recent.slice(-8);
  const recentCollisionCount = m.stuck.recent_collision_batches.filter((entry) => Number(entry?.collisions) > 0).length;
  const recentNonCollisionCount = m.stuck.recent_collision_batches.filter((entry) => Number(entry?.collisions) === 0).length;
  const shouldWarn = recentCollisionCount >= 3 && recentNonCollisionCount <= 2;
  if (!shouldWarn) return;
  const stepNumber = Number(step);
  const lastStep = Number(m.stuck.last_collision_cluster_at_step);
  if (Number.isFinite(stepNumber) && Number.isFinite(lastStep) && stepNumber - lastStep < 4) return;
  const warning = {
    ts: nowIso(),
    reason: `collision cluster: ${recentCollisionCount} recent movement batches hit collision`,
    step,
  };
  m.stuck.last_collision_cluster_at_step = Number.isFinite(stepNumber) ? stepNumber : step;
  m.stuck.collision_cluster_count = Math.max(0, Number(m.stuck.collision_cluster_count) || 0) + 1;
  m.stuck.warnings = [warning, ...(Array.isArray(m.stuck.warnings) ? m.stuck.warnings : [])].slice(0, 20);
  appendEvent("collision_cluster_warning", warning);
}

function numericMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boolMetric(value) {
  return typeof value === "boolean" ? value : null;
}

function modelImageMetric(modelImage) {
  if (!modelImage) return null;
  return {
    path: modelImage.path || null,
    image_id: modelImage.cacheKey || modelImage.screenshotHash || null,
    scale: modelImage.scale || null,
    width: modelImage.width || null,
    height: modelImage.height || null,
    raw_width: modelImage.rawWidth || null,
    raw_height: modelImage.rawHeight || null,
    screenshot_hash: modelImage.screenshotHash || null,
    sha256: modelImage.sha256 || modelImage.modelImageSha256 || modelImage.model_image_sha256 || null,
    screenshot_fresh: boolMetric(modelImage.screenshotFresh),
    screenshot_age_ms: numericMetric(modelImage.screenshotAgeMs),
    raw_source_age_ms: numericMetric(modelImage.rawSourceAgeMs),
  };
}

function recordModelCall(meta = {}) {
  const m = loadMetrics();
  const duration = Number(meta.durationMs || 0);
  m.model_calls += 1;
  if (Number.isFinite(duration) && duration > 0) {
    m.model_call_durations_ms.push(duration);
    if (m.model_call_durations_ms.length > 200) m.model_call_durations_ms = m.model_call_durations_ms.slice(-200);
    m.total_model_ms += duration;
  }
  m.last_model_call = {
    provider: meta.provider || config.agentProvider,
    model: meta.model || configuredModel(),
    reasoning_effort: meta.reasoningEffort || null,
    duration_ms: duration || null,
    image_path: meta.imagePath || null,
    observation_artifact_path: meta.observationArtifactPath || null,
    model_image: modelImageMetric(meta.modelImage),
    prompt_path: meta.promptPath || null,
    output_path: meta.outputPath || null,
    at: nowIso(),
  };
  appendEvent("model_call", m.last_model_call);
  persistMetrics();
}

function recordModelObservation(meta = {}) {
  const m = loadMetrics();
  m.latest_model_observation = {
    provider: meta.provider || config.agentProvider,
    model: meta.model || configuredModel(),
    reasoning_effort: meta.reasoningEffort || configuredReasoningEffort(),
    step: Number.isFinite(Number(meta.step)) ? Number(meta.step) : null,
    image_path: meta.imagePath || meta.modelImage?.path || null,
    observation_artifact_path: meta.observationArtifactPath || null,
    model_image: modelImageMetric(meta.modelImage),
    at: nowIso(),
  };
  appendEvent("model_observation", m.latest_model_observation);
  persistMetrics();
}

function recordHarnessFailure(kind, message, details = {}) {
  const m = loadMetrics();
  const error = { kind, message: String(message || ""), details, at: nowIso() };
  m.tool_errors += kind === "tool_error" ? 1 : 0;
  if (kind === "stale_observation_action") {
    m.stale_observation_actions_blocked = Math.max(0, Number(m.stale_observation_actions_blocked) || 0) + 1;
  }
  if (String(message || "").toLowerCase().includes("timeout")) m.bridge_timeouts += 1;
  m.harness_health.last_error = error.message;
  m.harness_health.last_error_at = error.at;
  m.harness_health.excluded_windows = [error, ...(Array.isArray(m.harness_health.excluded_windows) ? m.harness_health.excluded_windows : [])].slice(0, 50);
  appendEvent("harness_failure", error);
  persistMetrics();
}

function getBenchmarkMetrics() {
  return loadMetrics();
}

module.exports = {
  getBenchmarkMetrics,
  recordActionBatch,
  recordHarnessFailure,
  recordModelCall,
  recordModelObservation,
  recordObservation,
};
