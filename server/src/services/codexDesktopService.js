const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

const { config } = require("../config");
const { state, savePersistentState, recordPlayerReasoningTurn } = require("../state/stateManager");
const { fetchGameData, fetchBridgeHealth, loadState } = require("./pythonService");
const { prepareModelImagePath } = require("./screenshotService");
const { buildUserInputText } = require("../ai/promptBuilder");
const { processHistoryForAPI } = require("../ai/historyProcessor");
const { defineTools, handleToolCall } = require("../ai/tools");
const {
  buildObservationExposure,
  playerCoordinateFrame,
  validatedVisibleInteractableSurface,
  validatedRuntimeObjectEntries,
  validatedRuntimeObjectSurface,
} = require("../ai/observationContract");
const {
  redactHistoricalNavigationTraceText,
  sanitizeCurrentPromptText,
  sanitizeFunctionCallArguments,
  sanitizeModelText,
  sanitizeModelValue,
} = require("../ai/modelSurfaceSanitizer");
const { recordHarnessFailure, recordModelCall, recordModelObservation, recordObservation } = require("../benchmark/metrics");
const {
  applyManifestEntryGate,
  auditActionArtifact,
  auditModelVisibleManifest,
  auditObservationArtifact,
  surfacePolicy,
} = require("../benchmark/heartgoldRamAuditor");
const { MARKDOWN_TILES, FALLBACK } = require("../constants/tiles");
const { updateProgressSteps } = require("../core/progressTracker");

let lastCodexDesktopObservation = null;

const OBSERVATION_MODE_ALIASES = new Map([
  ["standard", "ram_assisted"],
  ["standard_assisted", "ram_assisted"],
  ["assisted", "ram_assisted"],
]);

const INVALID_SCREENSHOT_HASHES = new Set([
  "missing",
  "none",
  "null",
  "undefined",
  "unknown",
  "placeholder",
  "stale_or_missing",
  "unavailable",
  "hash",
  "screenhash",
]);

const FIELD_VISIBLE_TEXT_DECODER_CONTRACT = "owner_bound_script_environment_textprinter_current_visible_v1";
const CURRENT_UI_VISIBLE_TEXT_DECODER_CONTRACT = "owner_bound_current_ui_state_visible_text_v1";

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildDegradedVisualGameData(bridgeHealth) {
  const screenshotPath = bridgeHealth?.screenshot?.path || null;
  const screenshotHash = bridgeHealth?.screenshot?.hash || null;
  const frame = Number(bridgeHealth?.heartbeat?.frame || 0) || 0;
  const screenshotAgeMs = Number(bridgeHealth?.screenshot?.ageMs || 0) || 0;
  if (!bridgeHealth?.ok || !bridgeHealth?.heartbeatFresh || !screenshotPath || !screenshotHash) {
    return null;
  }
  return {
    game: {
      profile: "heartgold",
      title: "Pokemon HeartGold",
      platform: "Nintendo DS",
      observationMode: "visual",
      stateReliability: "visual_degraded_bridge_fallback",
    },
    observationPolicy: {
      mode: "visual",
      exposeOracle: false,
      stateConfidenceRequired: true,
    },
    screenshotFresh: true,
    screenshotHash,
    screenshotCacheKey: `${frame}_${String(screenshotHash).slice(0, 12)}`,
    observationFreshness: {
      screenshotHash,
      screenshotCacheKey: `${frame}_${String(screenshotHash).slice(0, 12)}`,
      screenshotAgeMs,
      screenshotFresh: true,
      visualAvailable: true,
      screenshotPath,
      screenshotSnapshotPath: screenshotPath,
    },
    emulator: {
      frame,
      screenshotFresh: true,
      screenshotHash,
      screenshotCacheKey: `${frame}_${String(screenshotHash).slice(0, 12)}`,
      screenshotRawPath: screenshotPath,
      screenshotSnapshotPath: screenshotPath,
      screenshotAgeMs,
      screenshotRawWidth: Number(bridgeHealth?.screenshot?.rawWidth || 256) || 256,
      screenshotRawHeight: Number(bridgeHealth?.screenshot?.rawHeight || 384) || 384,
      visualAvailable: true,
    },
    harnessDiagnostics: {
      degradedVisualOnly: true,
      requestDataOk: false,
      requestDataError: "Python bridge did not return structured game data; using visual-only degraded observation fallback.",
    },
  };
}

async function writeArtifact(name, payload) {
  await fs.mkdir(config.codexDesktop.outputDir, { recursive: true });
  const filePath = path.join(config.codexDesktop.outputDir, `${nowStamp()}_${name}.json`);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

function actionSchemaType(schema) {
  return schema?.properties?.type?.const || null;
}

function compactToolSchema(exposure, gameDataJson) {
  const tools = defineTools();
  const tool = tools.find((item) => item?.name === "execute_action") || tools[0] || null;
  if (!tool || !config.isHeartGold) return tool;
  const cloned = JSON.parse(JSON.stringify(tool));
  if (cloned?.parameters?.properties?.actions) {
    cloned.parameters.required = ["actions"];
    if (cloned.parameters.properties.step_details) {
      cloned.parameters.properties.step_details.description =
        "Player-authored continuity for this action batch. Choose your own wording and amount of detail from the exposed HeartGold observation.";
    }
    if (cloned.parameters.properties.chat_message) {
      cloned.parameters.properties.chat_message.description =
        "Player-authored gameplay commentary. Choose your own wording and amount of detail; do not follow a fixed narration template.";
    }
    if (cloned.parameters.properties.avatar_emotion) {
      cloned.parameters.properties.avatar_emotion.description =
        "Player-authored expression for this turn. Choose a mood from the current gameplay beat.";
    }
  }
  const anyOf = cloned?.parameters?.properties?.actions?.items?.anyOf;
  if (!Array.isArray(anyOf)) return cloned;

  const decodedNavigationAllowed = shouldExposeDecodedNavigation(exposure);
  const pathfindingAllowed =
    decodedNavigationAllowed === true && gameDataJson?.ram_assisted?.pathfinding?.available === true;
  const coordinateActionsAllowed = decodedNavigationAllowed === true;
  cloned.parameters.properties.actions.items.anyOf = anyOf.filter((schema) => {
    const type = actionSchemaType(schema);
    if (type === "path_to_location") return pathfindingAllowed;
    if (type === "add_marker" || type === "delete_marker") return coordinateActionsAllowed;
    return true;
  });
  return cloned;
}

function compactActionFormat() {
  const allowedKeys = [
    "up",
    "down",
    "left",
    "right",
    "a",
    "b",
    "x",
    "y",
    "l",
    "r",
    "start",
    "select",
    "face_up",
    "face_down",
    "face_left",
    "face_right",
  ];
  return {
    transport: {
      observe: `GET http://127.0.0.1:${config.wsPort}/codexDesktop/observation`,
      act: `POST http://127.0.0.1:${config.wsPort}/codexDesktop/action?include_next_observation=1`,
      continue_from: "next_observation when present; GET observation again only as fallback",
    },
    envelope_required_fields: ["actions"],
    envelope_optional_fields: ["step_details", "chat_message", "avatar_emotion"],
    allowed_keys: allowedKeys,
    key_press: {
      shape: { type: "key_press", keys: ["a"], frames: 8 },
      note: "Use keys:[...] exactly. Do not use singular key. Button names are normalized to lowercase.",
    },
    button_sequence: {
      shape: { type: "button_sequence", sequence: [{ keys: ["down"], frames: 8 }] },
      note: "Use for ordered inputs; key_press is simultaneous input.",
    },
    wait: {
      shape: { type: "wait", frames: 30 },
      note: "Use frames, not duration_ms. HeartGold runs at normal speed unless the run config says otherwise.",
    },
    touch: {
      shape: { type: "touch", x: 128, y: 96, coordinate_space: "bottom", screen: "bottom" },
      note: "Default touch coordinates are DS bottom-screen local 256x192.",
    },
    type_text: { shape: { type: "type_text", value: "GPT" } },
  };
}

function gameplayScreenshotHash(gameDataJson) {
  return (
    gameDataJson?.observationFreshness?.screenshotHash ||
    gameDataJson?.screenshotHash ||
    gameDataJson?.emulator?.screenshotHash ||
    null
  );
}

function normalizedScreenshotHash(value) {
  return String(value || "").trim().toLowerCase();
}

function hasUsableScreenshotHash(value) {
  const hash = normalizedScreenshotHash(value);
  return hash.length >= 10 && !INVALID_SCREENSHOT_HASHES.has(hash);
}

function hasOwnObjectField(value, key) {
  return value != null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}

function heartGoldBattleAuthoritativelyActive(gameDataJson) {
  if (hasOwnObjectField(gameDataJson, "is_in_battle")) {
    return gameDataJson.is_in_battle === true;
  }
  return gameDataJson?.battle_data?.in_battle === true;
}

function validatedCurrentTextMatchesCurrentScreenshot(entry, gameDataJson) {
  const textHash = normalizedScreenshotHash(entry?.screenshotHash);
  const currentHash = normalizedScreenshotHash(gameplayScreenshotHash(gameDataJson));
  return hasUsableScreenshotHash(textHash) && hasUsableScreenshotHash(currentHash) && textHash === currentHash;
}

function isOwnerBoundCurrentFieldDialogueText(entry, gameDataJson) {
  const frame = Number(entry?.frame);
  const epoch = Number(entry?.contextEpoch);
  return (
    entry &&
    entry.active === true &&
    entry.source === "ram_visible_text" &&
    entry.confidence === "validated_current" &&
    entry.contract === "current_visible_text_v1" &&
    String(entry.surface || "") === "field_dialogue" &&
    (entry.decoderContract || entry.decoder_contract || "") === FIELD_VISIBLE_TEXT_DECODER_CONTRACT &&
    Number.isFinite(frame) &&
    frame >= 0 &&
    Number.isFinite(epoch) &&
    epoch >= 0 &&
    validatedCurrentTextMatchesCurrentScreenshot(entry, gameDataJson) &&
    typeof entry.text === "string" &&
    entry.text.trim()
  );
}

function isOwnerBoundCurrentUiText(entry, gameDataJson) {
  const frame = Number(entry?.frame);
  const epoch = Number(entry?.contextEpoch);
  return (
    entry &&
    entry.active === true &&
    entry.source === "ram_visible_text" &&
    entry.confidence === "validated_current" &&
    entry.contract === "current_visible_text_v1" &&
    String(entry.surface || "") === "current_ui" &&
    (entry.decoderContract || entry.decoder_contract || "") === CURRENT_UI_VISIBLE_TEXT_DECODER_CONTRACT &&
    Number.isFinite(frame) &&
    frame >= 0 &&
    Number.isFinite(epoch) &&
    epoch >= 0 &&
    validatedCurrentTextMatchesCurrentScreenshot(entry, gameDataJson) &&
    typeof entry.text === "string" &&
    entry.text.trim()
  );
}

function gameplayScreenshotCacheKey(gameDataJson) {
  return (
    gameDataJson?.screenshotCacheKey ||
    gameDataJson?.emulator?.screenshotCacheKey ||
    gameDataJson?.observationFreshness?.screenshotCacheKey ||
    null
  );
}

function screenshotFreshnessFailure(gameDataJson) {
  const freshness = gameDataJson?.observationFreshness || {};
  if (config.isHeartGold && !gameplayScreenshotHash(gameDataJson)) return "screenshot_hash_missing";
  if (config.isHeartGold && !gameplayScreenshotCacheKey(gameDataJson)) return "screenshot_cache_key_missing";
  if (
    gameDataJson?.screenshotFresh === false ||
    gameDataJson?.emulator?.screenshotFresh === false ||
    freshness.screenshotFresh === false ||
    freshness.visualAvailable === false
  ) {
    return "screenshot_stale_or_visual_unavailable";
  }
  const ageMs = Number(
    freshness.screenshotAgeMs ??
      gameDataJson?.screenshotAgeMs ??
      gameDataJson?.emulator?.screenshotAgeMs ??
      NaN
  );
  if (!Number.isFinite(ageMs)) return "screenshot_age_missing";
  if (ageMs > config.observation.maxScreenshotAgeMs) return `screenshot_age_${ageMs}_exceeds_${config.observation.maxScreenshotAgeMs}`;
  return null;
}

function sameDialogueTextRevealDrift(observedSnapshot, currentSnapshot) {
  const observedCurrent = observedSnapshot?.current || null;
  const currentCurrent = currentSnapshot?.current || null;
  if (!observedCurrent || !currentCurrent) return false;
  if (observedCurrent.surface !== currentCurrent.surface) return false;
  const observedEpoch = Number(observedCurrent.contextEpoch);
  const currentEpoch = Number(currentCurrent.contextEpoch);
  if (Number.isFinite(observedEpoch) && Number.isFinite(currentEpoch) && observedEpoch !== currentEpoch) return false;
  const observedText = String(observedCurrent.text || "").trim();
  const currentText = String(currentCurrent.text || "").trim();
  if (!observedText || !currentText || currentText.length <= observedText.length) return false;
  return currentText.startsWith(observedText);
}

function visibleTextKey(entry) {
  const surface = String(entry?.surface || "").trim();
  const text = String(entry?.text || "").trim();
  if (!surface || !text) return null;
  return `${surface}:${text}`;
}

function collapseConsecutiveDuplicateTextKeys(entries) {
  const collapsed = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = visibleTextKey(entry);
    if (!key || key === collapsed[collapsed.length - 1]) continue;
    collapsed.push(key);
  }
  return collapsed;
}

function sameDialogueTextBookkeepingDrift(observedSnapshot, currentSnapshot) {
  if (!observedSnapshot || !currentSnapshot) return false;
  const observedCurrent = observedSnapshot.current || null;
  const currentCurrent = currentSnapshot.current || null;
  if (Boolean(observedCurrent) !== Boolean(currentCurrent)) return false;
  if (observedCurrent && currentCurrent) {
    if (visibleTextKey(observedCurrent) !== visibleTextKey(currentCurrent)) return false;
  }
  const observedRecentRaw = (Array.isArray(observedSnapshot.recent) ? observedSnapshot.recent : [])
    .map(visibleTextKey)
    .filter(Boolean);
  const currentRecentRaw = (Array.isArray(currentSnapshot.recent) ? currentSnapshot.recent : [])
    .map(visibleTextKey)
    .filter(Boolean);
  const observedRecent = collapseConsecutiveDuplicateTextKeys(observedSnapshot.recent);
  const currentRecent = collapseConsecutiveDuplicateTextKeys(currentSnapshot.recent);
  return (
    observedRecentRaw.join("~") !== currentRecentRaw.join("~") &&
    observedRecent.length === currentRecent.length &&
    observedRecent.every((entry, index) => entry === currentRecent[index])
  );
}

function sameCurrentDialogueTextHistoryDrift(observedSnapshot, currentSnapshot) {
  if (!observedSnapshot || !currentSnapshot) return false;
  const observedCurrentKey = visibleTextKey(observedSnapshot.current || null);
  const currentCurrentKey = visibleTextKey(currentSnapshot.current || null);
  if (!observedCurrentKey || observedCurrentKey !== currentCurrentKey) return false;
  const observedRecent = (Array.isArray(observedSnapshot.recent) ? observedSnapshot.recent : [])
    .map(visibleTextKey)
    .filter(Boolean)
    .join("~");
  const currentRecent = (Array.isArray(currentSnapshot.recent) ? currentSnapshot.recent : [])
    .map(visibleTextKey)
    .filter(Boolean)
    .join("~");
  return observedRecent !== currentRecent;
}

function parseSignatureModePart(signature) {
  const parts = String(signature || "").split("|");
  if (parts.length < 3) return null;
  try {
    return { parts, mode: JSON.parse(parts[2]) };
  } catch {
    return null;
  }
}

function isDialogueValidationTransitionModePair(observedMode, currentMode) {
  const observedPhase = String(observedMode?.phase || "");
  const currentPhase = String(currentMode?.phase || "");
  const phases = new Set([observedPhase, currentPhase]);
  if (!phases.has("unknown_or_transition") || (!phases.has("dialogue") && !phases.has("inspect_screenshot"))) return false;
  if (phases.has("inspect_screenshot")) {
    const inspectMode = observedPhase === "inspect_screenshot" ? observedMode : currentMode;
    if (inspectMode?.confidence !== "visual_or_detector_state_without_validated_ram_surface") return false;
  }
  for (const key of ["menu", "naming", "movement"]) {
    if (JSON.stringify(observedMode?.[key] ?? null) !== JSON.stringify(currentMode?.[key] ?? null)) return false;
  }
  return true;
}

function nonTextStateMatchesExceptDialogueValidation(signatureA, signatureB) {
  const parsedA = parseSignatureModePart(signatureA);
  const parsedB = parseSignatureModePart(signatureB);
  if (!parsedA || !parsedB || parsedA.parts.length !== parsedB.parts.length) return false;
  if (!isDialogueValidationTransitionModePair(parsedA.mode, parsedB.mode)) return false;
  return parsedA.parts.every((part, index) => index === 2 || part === parsedB.parts[index]);
}

function samePromptDialogueValidationTransitionDrift(observedSnapshot, currentSnapshot, observedNonTextStateSignature, currentNonTextStateSignature) {
  if (!nonTextStateMatchesExceptDialogueValidation(observedNonTextStateSignature, currentNonTextStateSignature)) return false;
  const observedCurrentKey = visibleTextKey(observedSnapshot?.current || null);
  const currentCurrentKey = visibleTextKey(currentSnapshot?.current || null);
  if (observedCurrentKey && currentCurrentKey) return observedCurrentKey === currentCurrentKey;
  return Boolean(observedCurrentKey || currentCurrentKey);
}

function observationDriftFromGameData(gameDataJson, observed) {
  const currentHash = gameplayScreenshotHash(gameDataJson);
  const currentCacheKey = gameplayScreenshotCacheKey(gameDataJson);
  const observedHash = observed?.screenshotHash || null;
  const observedCacheKey = observed?.cacheKey || null;
  const observedAtMs = Number.isFinite(Date.parse(observed?.at || "")) ? Date.parse(observed.at) : null;
  const observedStateSignature = observed?.stateSignature || null;
  const observedNonTextStateSignature = observed?.nonTextStateSignature || null;
  const observedVisibleTextSnapshot = observed?.visibleTextSnapshot || null;
  const currentVisibleTextSnapshot = visibleTextSnapshot(gameDataJson);
  const preActionStateSignature = gameplayStateSignature(gameDataJson);
  const preActionNonTextStateSignature = gameplayStateSignature(gameDataJson, { includeVisibleText: false });
  const materialStateKnown = Boolean(observedStateSignature && preActionStateSignature);
  const nonTextStateKnown = Boolean(observedNonTextStateSignature && preActionNonTextStateSignature);
  const nonTextStateChanged = nonTextStateKnown && observedNonTextStateSignature !== preActionNonTextStateSignature;
  const textRevealDrift =
    nonTextStateKnown &&
    !nonTextStateChanged &&
    observedStateSignature !== preActionStateSignature &&
    sameDialogueTextRevealDrift(observedVisibleTextSnapshot, currentVisibleTextSnapshot);
  const textBookkeepingDrift =
    nonTextStateKnown &&
    !nonTextStateChanged &&
    observedStateSignature !== preActionStateSignature &&
    sameDialogueTextBookkeepingDrift(observedVisibleTextSnapshot, currentVisibleTextSnapshot);
  const currentDialogueTextHistoryDrift =
    nonTextStateKnown &&
    !nonTextStateChanged &&
    observedStateSignature !== preActionStateSignature &&
    sameCurrentDialogueTextHistoryDrift(observedVisibleTextSnapshot, currentVisibleTextSnapshot);
  const dialogueTextValidationTransitionDrift =
    nonTextStateKnown &&
    nonTextStateChanged &&
    observedStateSignature !== preActionStateSignature &&
    samePromptDialogueValidationTransitionDrift(
      observedVisibleTextSnapshot,
      currentVisibleTextSnapshot,
      observedNonTextStateSignature,
      preActionNonTextStateSignature
    );
  return {
    observed_screenshot_hash: observedHash,
    pre_action_screenshot_hash: currentHash || null,
    screenshot_hash_changed: Boolean(currentHash && observedHash && currentHash !== observedHash),
    observed_cache_key: observedCacheKey,
    pre_action_cache_key: currentCacheKey || null,
    cache_key_changed: Boolean(currentCacheKey && observedCacheKey && currentCacheKey !== observedCacheKey),
    observation_to_action_ms: observedAtMs === null ? null : Math.max(0, Date.now() - observedAtMs),
    observed_state_signature: observedStateSignature,
    pre_action_state_signature: preActionStateSignature,
    observed_non_text_state_signature: observedNonTextStateSignature,
    pre_action_non_text_state_signature: preActionNonTextStateSignature,
    material_state_known: materialStateKnown,
    material_state_changed: materialStateKnown && observedStateSignature !== preActionStateSignature,
    non_text_state_known: nonTextStateKnown,
    non_text_state_changed: nonTextStateChanged,
    same_dialogue_text_reveal_drift: textRevealDrift,
    same_dialogue_text_bookkeeping_drift: textBookkeepingDrift,
    same_current_dialogue_text_history_drift: currentDialogueTextHistoryDrift,
    dialogue_text_validation_transition_drift: dialogueTextValidationTransitionDrift,
  };
}

function skippedPreActionDriftFromObservation(observed) {
  const observedAtMs = Number.isFinite(Date.parse(observed?.at || "")) ? Date.parse(observed.at) : null;
  return {
    pre_action_refresh_skipped: true,
    observed_screenshot_hash: observed?.screenshotHash || null,
    pre_action_screenshot_hash: observed?.screenshotHash || null,
    screenshot_hash_changed: false,
    observed_cache_key: observed?.cacheKey || null,
    pre_action_cache_key: observed?.cacheKey || null,
    cache_key_changed: false,
    observation_to_action_ms: observedAtMs === null ? null : Math.max(0, Date.now() - observedAtMs),
    observed_state_signature: observed?.stateSignature || null,
    pre_action_state_signature: observed?.stateSignature || null,
    observed_non_text_state_signature: observed?.nonTextStateSignature || null,
    pre_action_non_text_state_signature: observed?.nonTextStateSignature || null,
    material_state_known: Boolean(observed?.stateSignature),
    material_state_changed: false,
    non_text_state_known: Boolean(observed?.nonTextStateSignature),
    non_text_state_changed: false,
  };
}

const LOW_STALL_PREACTION_ACTION_TYPES = new Set([
  "key_press",
  "button_sequence",
  "wait",
  "a_until_end_of_dialog",
  "type_text",
]);

function canSkipCodexDesktopPreActionRefresh(args, { hasTouchAction } = {}) {
  if (!config.isHeartGold || config.codexDesktop.skipPreActionRefresh !== true) return false;
  if (hasTouchAction === true) return false;
  if (!lastCodexDesktopObservation?.gameDataJson || lastCodexDesktopObservation.degradedVisualFallback === true) {
    return false;
  }
  const actions = Array.isArray(args?.actions) ? args.actions : [];
  if (actions.length === 0) return false;
  return actions.every((action) => LOW_STALL_PREACTION_ACTION_TYPES.has(String(action?.type || "")));
}

function visibleTextSnapshot(gameDataJson) {
  const current = gameDataJson?.current_visible_text;
  const currentEntry = isValidatedCurrentVisibleText(current, gameDataJson)
    ? {
        surface: current.surface || "",
        text: String(current.text || "").trim(),
        contextEpoch: current.contextEpoch ?? null,
      }
    : null;
  const recent = Array.isArray(gameDataJson?.recent_visible_text)
    ? gameDataJson.recent_visible_text
        .filter((entry) => isValidatedRecentVisibleText(entry, gameDataJson))
        .slice(-6)
        .map((entry) => ({
          surface: entry.surface || "",
          text: String(entry.text || "").trim(),
          contextEpoch: entry.contextEpoch ?? null,
        }))
    : [];
  return { current: currentEntry, recent };
}

function visibleTextSignature(gameDataJson) {
  const snapshot = visibleTextSnapshot(gameDataJson);
  const currentText = snapshot.current ? `${snapshot.current.surface}:${snapshot.current.text}` : "";
  const recent = snapshot.recent.map((entry) => `${entry.surface}:${entry.text}`).join("~");
  return `${currentText}|${recent}`;
}

function materialJson(value, maxLength = 2000) {
  try {
    return JSON.stringify(value ?? null).slice(0, maxLength);
  } catch {
    return "unserializable";
  }
}

function stableHash(value) {
  return crypto.createHash("sha256").update(materialJson(value, 200000)).digest("hex");
}

function runtimeObjectLabelLooksRaw(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  return /^(?:object|npc|runtime_object|sprite)[\s_-]?#?\d+$/i.test(text) || /^SPRITE_/i.test(text);
}

function safeRuntimeObjectLabel(entry) {
  for (const value of [entry?.objectLabel, entry?.object_label, entry?.name, entry?.label]) {
    const text = String(value ?? "").trim();
    if (text && !runtimeObjectLabelLooksRaw(text)) return text;
  }
  return "runtime_object";
}

function runtimeObjectSignature(gameDataJson) {
  const entries = validatedRuntimeObjectEntries(gameDataJson);
  return materialJson(
    entries.slice(0, 12).map((entry) => ({
      id: entry?.id ?? entry?.object_id ?? null,
      localId: entry?.localId ?? entry?.local_id ?? null,
      name: safeRuntimeObjectLabel(entry),
      mapId: entry?.map_id ?? entry?.mapId ?? null,
      x: entry?.x ?? null,
      y: entry?.y ?? null,
      initialX: entry?.initial_x ?? entry?.initialX ?? null,
      initialY: entry?.initial_y ?? entry?.initialY ?? null,
      facing: entry?.facing ?? null,
      active: entry?.isActive ?? entry?.active ?? null,
      visible: entry?.isVisible ?? entry?.visible ?? null,
      blocking: entry?.isBlocking ?? null,
      interactable: entry?.isInteractableCandidate ?? null,
      requiredFacing: entry?.requiredFacing ?? null,
      inFront: entry?.inFrontOfPlayer ?? null,
      staticBound: entry?.staticObjectBound ?? entry?.static_bound ?? null,
      confidence: entry?.confidence ?? null,
      contract: entry?.contract ?? null,
    }))
  );
}

function warpSignature(gameDataJson) {
  const exposure = buildObservationExposure(gameDataJson);
  if (exposure.fields?.warps?.validated !== true || exposure.navigation?.validated !== true) {
    return materialJson([]);
  }
  const warps = Array.isArray(gameDataJson?.visible_warps) ? gameDataJson.visible_warps : [];
  return materialJson(
    sanitizeVisibleWarpsForModel(warps, gameDataJson).map((warp) => ({
      x: warp?.x ?? null,
      y: warp?.y ?? null,
      coordinateMode: warp?.coordinateMode || null,
    }))
  );
}

function interactableSignature(gameDataJson) {
  const exposure = buildObservationExposure(gameDataJson);
  const surface = validatedVisibleInteractableSurface(gameDataJson, exposure);
  if (surface.validated !== true || exposure.fields?.interactables?.validated !== true || exposure.navigation?.validated !== true) {
    return materialJson({ visible: [], current: null });
  }
  const interactables = Array.isArray(surface.entries) ? surface.entries : [];
  const current = surface.current || null;
  return materialJson({
    visible: interactables.slice(0, 16).map((entry) => ({
      kind: entry?.kind || null,
      x: entry?.x ?? null,
      y: entry?.y ?? null,
      inFrontOfPlayer: entry?.inFrontOfPlayer === true,
    })),
    current: current
      ? {
          kind: current.kind || null,
          x: current.x ?? null,
          y: current.y ?? null,
        }
      : null,
  });
}

function currentConnectionsSignature(gameDataJson) {
  const exposure = buildObservationExposure(gameDataJson);
  if (exposure.fields?.currentConnections?.validated !== true || exposure.navigation?.validated !== true) {
    return materialJson(null);
  }
  const data = gameDataJson?.current_connections && typeof gameDataJson.current_connections === "object"
    ? gameDataJson.current_connections
    : gameDataJson?.ram_assisted?.current_connections && typeof gameDataJson.ram_assisted.current_connections === "object"
      ? gameDataJson.ram_assisted.current_connections
      : {};
  return materialJson(sanitizeCurrentConnectionsForModel(data), 3000);
}

function pathfindingSignature(gameDataJson) {
  const exposure = buildObservationExposure(gameDataJson);
  if (
    exposure.fields?.romCollision?.validated !== true ||
    exposure.navigation?.validated !== true ||
    gameDataJson?.ram_assisted?.pathfinding?.available !== true
  ) {
    return materialJson({ available: false });
  }
  const pathfinding = gameDataJson?.ram_assisted?.pathfinding || {};
  const visible = gameDataJson?.visible_area_data || {};
  return materialJson({
    available: pathfinding.available === true,
    disabledReason: pathfinding.disabledReason || null,
    gridSource: pathfinding.gridSource || null,
    visibleHash: visible.hash || visible.gridHash || visible.fingerprint || null,
    origin: visible.origin || null,
  });
}

function sanitizeCollisionGridForModel(gameDataJson) {
  const pathfinding = gameDataJson?.ram_assisted?.pathfinding || {};
  const visible = gameDataJson?.visible_area_data || {};
  const cells = semanticCollisionCellsForModel(gameDataJson, visible);
  return {
    path_to_location_available: pathfinding.available === true,
    gridSource: pathfinding.gridSource || null,
    visibleArea:
      visible && typeof visible === "object"
        ? {
            origin: visible.origin || null,
            width: visible.width ?? null,
            height: visible.height ?? null,
          }
        : null,
    ...(cells.length > 0 ? { cells } : {}),
  };
}

function semanticCollisionCellsForModel(gameDataJson, visible) {
  const grid = Array.isArray(gameDataJson?.game_area_meta_tiles) ? gameDataJson.game_area_meta_tiles : [];
  if (!Array.isArray(grid) || grid.length === 0) return [];
  const origin = visible && typeof visible === "object" && visible.origin && typeof visible.origin === "object"
    ? visible.origin
    : {};
  const originX = Number(origin.x);
  const originY = Number(origin.y);
  const widthLimit = Number.isFinite(Number(visible?.width)) ? Number(visible.width) : null;
  const heightLimit = Number.isFinite(Number(visible?.height)) ? Number(visible.height) : null;
  const maxRows = Math.min(grid.length, heightLimit ?? grid.length, 16);
  const rows = [];
  for (let y = 0; y < maxRows; y += 1) {
    const sourceRow = Array.isArray(grid[y]) ? grid[y] : [];
    const maxCols = Math.min(sourceRow.length, widthLimit ?? sourceRow.length, 16);
    const row = [];
    for (let x = 0; x < maxCols; x += 1) {
      row.push(semanticCollisionCellForModel(sourceRow[x], {
        x: Number.isFinite(originX) ? originX + x : null,
        y: Number.isFinite(originY) ? originY + y : null,
      }));
    }
    rows.push(row);
  }
  return rows;
}

function semanticCollisionCellForModel(tileCode, coordinate) {
  const numericCode = Number(tileCode);
  const known = Number.isInteger(numericCode) && Object.prototype.hasOwnProperty.call(MARKDOWN_TILES, numericCode);
  const description = known ? MARKDOWN_TILES[numericCode][1] : FALLBACK[1];
  return {
    x: coordinate.x,
    y: coordinate.y,
    terrain: description,
    passable: known ? !/\b(?:collision|impassable|wall)\b/i.test(description) : null,
  };
}

function collisionGridHasSemanticCells(value) {
  return Array.isArray(value?.cells) && value.cells.some((row) => Array.isArray(row) && row.length > 0);
}

function sanitizeVisibilityForModel(gameDataJson) {
  const visible = gameDataJson?.visible_area_data || {};
  const height = visible.height ?? (Array.isArray(gameDataJson?.game_area_meta_tiles) ? gameDataJson.game_area_meta_tiles.length : null);
  const width =
    visible.width ??
    (Array.isArray(gameDataJson?.game_area_meta_tiles) && Array.isArray(gameDataJson.game_area_meta_tiles[0])
      ? gameDataJson.game_area_meta_tiles[0].length
      : null);
  return {
    reduced: gameDataJson?.visibility_reduced === true,
    state: gameDataJson?.visibility_state || "unknown",
    window: Number.isFinite(Number(height)) && Number.isFinite(Number(width)) ? `${Number(height)}x${Number(width)}` : "",
    flash_needed: gameDataJson?.flash_needed === true,
    defog_needed: gameDataJson?.defog_needed === true,
  };
}

function partySignature(gameDataJson) {
  const exposure = buildObservationExposure(gameDataJson);
  if (exposure.fields?.party?.validated !== true) {
    return materialJson({ validated: false });
  }
  return materialJson(modelVisiblePartySurface(gameDataJson), 4000);
}

function inventorySignature(gameDataJson) {
  const exposure = buildObservationExposure(gameDataJson);
  if (exposure.fields?.inventory?.validated !== true) {
    return materialJson({ validated: false });
  }
  return materialJson(modelVisibleInventorySurface(gameDataJson?.inventory_data), 5000);
}

function pcStorageSignature(gameDataJson) {
  const exposure = buildObservationExposure(gameDataJson);
  const validated = exposure.fields?.pcStorage?.validated === true && pcStorageDataValidated(gameDataJson?.pc_data);
  if (!validated) {
    return materialJson({ validated: false });
  }
  return materialJson(modelVisiblePcStorageSurface(gameDataJson?.pc_data), 5000);
}

function battleSignature(gameDataJson) {
  const exposure = buildObservationExposure(gameDataJson);
  if (exposure.fields?.battle?.validated !== true) {
    return materialJson({ validated: false });
  }
  const battle = gameDataJson?.battle_data && typeof gameDataJson.battle_data === "object" ? gameDataJson.battle_data : {};
  const renderTypes = (types) =>
    Array.isArray(types)
      ? types
          .slice(0, 2)
          .map((type) => {
            if (typeof type === "string") return type.trim();
            if (!type || typeof type !== "object") return "";
            return String(type.name || type.type_name || "").trim();
          })
          .filter(Boolean)
      : [];
  const renderStatStages = (statStages) => {
    if (!statStages || typeof statStages !== "object" || Array.isArray(statStages)) return null;
    const ordered = ["attack", "defense", "speed", "special_attack", "special_defense", "accuracy", "evasion"];
    const out = {};
    for (const key of ordered) {
      const value = statStages[key];
      if (!Number.isInteger(value) || value < -6 || value > 6) return null;
      out[key] = value;
    }
    return out;
  };
  const renderMoves = (mons, includeMoves) =>
    includeMoves
      ? (Array.isArray(mons?.moves) ? mons.moves : [])
          .slice(0, 4)
          .map((move) => {
            const name = playerVisibleMoveName(move);
            if (!name) return null;
            return {
              name,
              pp: move?.pp ?? move?.current_pp ?? null,
              maxPp: move?.max_pp ?? move?.maxPp ?? null,
            };
          })
          .filter(Boolean)
      : [];
  const renderMons = (mons, { includeMoves = false } = {}) =>
    (Array.isArray(mons) ? mons : []).slice(0, 6).map((mon) => ({
      battlerId: mon?.battler_id ?? null,
      position: mon?.position || null,
      species: mon?.species_name || mon?.species || mon?.species_id || null,
      nickname: mon?.nickname || null,
      level: mon?.level ?? null,
      hp: mon?.current_hp ?? mon?.hp ?? null,
      maxHp: mon?.max_hp ?? mon?.maxHp ?? null,
      status: mon?.status_name || mon?.status || mon?.status_raw || null,
      types: renderTypes(mon?.types),
      moves: renderMoves(mon, includeMoves),
      statStages: renderStatStages(mon?.stat_stages),
    }));
  const inputAction = Array.isArray(battle.battle_input?.player_actions)
    ? battle.battle_input.player_actions.find((entry) => entry && typeof entry === "object")
    : null;
  return materialJson({
    validated: true,
    contract: exposure.fields?.battle?.contract || null,
    active: heartGoldBattleAuthoritativelyActive(gameDataJson),
    trainer: battle.is_trainer_battle ?? null,
    double: battle.is_double_battle ?? null,
    player: renderMons(battle.player_pokemons || battle.playerBattlers || battle.player, { includeMoves: true }),
    enemy: renderMons(battle.enemy_pokemons || battle.enemyBattlers || battle.enemy),
    input: battle.battle_input
      ? {
          available: battle.battle_input.available === true,
          menu: semanticBattleInputMenuName(gameDataJson, battle.battle_input),
          command: battle.battle_input.context_command_name || null,
          actionCommand: inputAction?.command_name || null,
          inputSelection: inputAction?.input_selection_name || null,
          selectedMove: inputAction?.selected_move_name || null,
          targetBattlerId: inputAction?.target_battler_id ?? null,
        }
      : null,
  }, 5000);
}

function battleHpPercentage(currentHp, maxHp) {
  const current = Number(currentHp) || 0;
  const max = Number(maxHp) || 0;
  if (max <= 0) return "unknown";
  return `${Math.max(0, Math.min(100, Math.round((current / max) * 100)))}%`;
}

function normalizedVisibleBattleText(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00e9/g, "e")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function validatedBattleTextValues(gameDataJson) {
  const values = [];
  const current = gameDataJson?.current_visible_text;
  if (isValidatedCurrentVisibleText(current, gameDataJson)) values.push(current.text);
  for (const entry of Array.isArray(gameDataJson?.recent_visible_text) ? gameDataJson.recent_visible_text : []) {
    if (isValidatedRecentVisibleText(entry, gameDataJson)) values.push(entry.text);
  }
  return values.map(normalizedVisibleBattleText).filter(Boolean);
}

function activePlayerBattlerFainted(battle) {
  const mons = battle?.player_pokemons || battle?.playerBattlers || battle?.player || [];
  return (Array.isArray(mons) ? mons : []).some((mon) => {
    const currentHp = Number(mon?.current_hp ?? mon?.hp);
    const maxHp = Number(mon?.max_hp ?? mon?.maxHp);
    return Number.isFinite(currentHp) && currentHp <= 0 && (!Number.isFinite(maxHp) || maxHp > 0);
  });
}

function battleInputHasTwoOptionYesSelection(battleInput) {
  const actions = Array.isArray(battleInput?.player_actions) ? battleInput.player_actions : [];
  return actions.some((action) => action?.input_selection_name === "fight_or_move_1_or_yes") &&
    actions.every((action) => !action?.selected_move_name && action?.target_battler_id == null);
}

function battleInputOutsideSelectionScreen(battleInput) {
  const context = String(battleInput?.context_command_name || "").trim();
  if (!context) return true;
  return context !== "SELECTION_SCREEN_INPUT";
}

function semanticBattleInputMenuName(gameDataJson, battleInput) {
  const battle = gameDataJson?.battle_data && typeof gameDataJson.battle_data === "object" ? gameDataJson.battle_data : null;
  const rawName = battleInput?.menu_name || battleInput?.menu_state || null;
  const forcedWildSwitchOrFleeState =
    battle?.is_trainer_battle === false &&
    activePlayerBattlerFainted(battle) &&
    battleInputOutsideSelectionScreen(battleInput) &&
    battleInputHasTwoOptionYesSelection(battleInput);
  if (
    rawName === "BATTLE_MENU_0" &&
    battleInput?.available === true &&
    battleInput?.validation === "battle_input_current_context_backref_validated" &&
    (forcedWildSwitchOrFleeState || validatedBattleTextValues(gameDataJson).some((text) => text === "use next pokemon?"))
  ) {
    return "SWITCH_OR_FLEE";
  }
  return rawName;
}

function progressSignature(gameDataJson) {
  const exposure = buildObservationExposure(gameDataJson);
  const trainer = gameDataJson?.current_trainer_data || {};
  const reliability = gameDataJson?.stateReliabilityDetails || {};
  const progressFlags = gameDataJson?.progress_flags && typeof gameDataJson.progress_flags === "object"
    ? gameDataJson.progress_flags
    : {};
  const moneyValidated = exposure.fields?.money?.validated === true && trainer.money != null;
  const badgesValidated = exposure.fields?.badges?.validated === true && trainer.badge_count != null;
  const progressValidated = exposure.fields?.progress?.validated === true && progressFlagsValidated(progressFlags);
  const safeProgressFlags = whitelistedProgressFlags(progressFlags);
  return materialJson({
    moneyValidated,
    moneyContract: moneyValidated ? reliability.money?.contract || exposure.fields?.money?.contract || null : null,
    money: moneyValidated ? trainer.money ?? null : null,
    badgesValidated,
    badgesContract: badgesValidated ? reliability.badges?.contract || exposure.fields?.badges?.contract || null : null,
    badgeCount: badgesValidated ? trainer.badge_count ?? null : null,
    badges: badgesValidated ? trainer.badges || null : null,
    progressValidated,
    progressContract: progressValidated ? reliability.progress?.contract || exposure.fields?.progress?.contract || null : null,
    flags: progressValidated ? safeProgressFlags : {},
  }, 4000);
}

function modeSignature(gameDataJson) {
  const exposure = buildObservationExposure(gameDataJson);
  const detector = gameDataJson?.ram_assisted?.modeDetector || {};
  const menu = detector.menu && typeof detector.menu === "object" ? detector.menu : {};
  const naming = detector.naming && typeof detector.naming === "object" ? detector.naming : {};
  const movement = detector.movement && typeof detector.movement === "object" ? detector.movement : {};
  const menuValidated = exposure.fields?.menu?.validated === true && menu.active === true;
  const namingValidated = exposure.fields?.naming?.validated === true && naming.active === true;
  const movementValidated = exposure.fields?.movement?.validated === true;
  const screenPhase = compactScreenPhase(gameDataJson, exposure);
  return materialJson({
    phase: screenPhase.phase || null,
    confidence: screenPhase.confidence || null,
    menu: menuValidated ? modelVisibleMenuSurface(menu) : null,
    naming: namingValidated ? modelVisibleNamingSurface(naming) : null,
    movement: movementValidated
      ? {
          mode: gameDataJson?.player_movement_mode || movement.mode || null,
          vehicle: movement.vehicle || null,
          surfing: movement.surfing === true,
          biking: movement.biking === true,
          diving: movement.diving === true,
        }
      : null,
  }, 4000);
}

function positionSignature(gameDataJson) {
  const exposure = buildObservationExposure(gameDataJson);
  if (exposure.location?.validated !== true && exposure.navigation?.validated !== true) {
    return materialJson({ validated: false });
  }
  const pos = gameDataJson?.current_trainer_data?.position || {};
  const signature = {
    locationValidated: exposure.location?.validated === true,
    navigationValidated: exposure.navigation?.validated === true,
    mapId: pos.map_id ?? null,
    mapName: pos.map_name ?? null,
  };
  if (exposure.navigation?.validated === true) {
    signature.x = pos.x ?? null;
    signature.y = pos.y ?? null;
    signature.elevation = pos.elevation ?? null;
    signature.facing = exposure.fields?.facing?.validated === true ? pos.facing ?? null : null;
  } else {
    signature.coordinatesUnavailable = true;
  }
  return materialJson(signature);
}

function gameplayStateSignature(gameDataJson, options = {}) {
  const includeVisibleText = options?.includeVisibleText !== false;
  const parts = [
    gameDataJson?.observationPolicy?.mode || gameDataJson?.game?.observationMode || config.observation.mode || "",
    positionSignature(gameDataJson),
    modeSignature(gameDataJson),
    includeVisibleText ? visibleTextSignature(gameDataJson) : "",
    partySignature(gameDataJson),
    inventorySignature(gameDataJson),
    pcStorageSignature(gameDataJson),
    battleSignature(gameDataJson),
    progressSignature(gameDataJson),
    runtimeObjectSignature(gameDataJson),
    warpSignature(gameDataJson),
    interactableSignature(gameDataJson),
    currentConnectionsSignature(gameDataJson),
    pathfindingSignature(gameDataJson),
  ];
  return parts.map((part) => String(part ?? "")).join("|");
}

function buildRamAuditSnapshot(gameDataJson, exposure, imageContract) {
  const pos = gameDataJson?.current_trainer_data?.position || {};
  const textProbe = gameDataJson?.harnessDiagnostics?.ramTextProbe || {};
  const compactTextProbe = (probe) =>
    probe && typeof probe === "object"
      ? {
          active: probe.active === true,
          status: probe.status || null,
          reason: probe.reason || null,
          contract: probe.contract || null,
          visiblePreview: probe.visiblePreview || probe.printer?.visiblePreview || null,
          candidateCount: Array.isArray(probe.candidates) ? probe.candidates.length : undefined,
          scanBudget: probe.scanBudget || probe.candidate_scan_budget || undefined,
          scanned: probe.scanned || undefined,
        }
      : null;
  return {
    purpose: "monitor_only_snapshot_of_model_visible_ram_surface",
    warning: "Not part of player model_input. External monitors may audit this artifact offline without polling BizHawk.",
    step: state.counters.currentStep,
    screenshotHash: imageContract?.screenshot_hash || gameplayScreenshotHash(gameDataJson) || null,
    observationMode: exposure.mode,
    modelVisible: {
      screenMode: gameDataJson?.screen_mode || null,
      screenModeConfidence: gameDataJson?.screen_mode_confidence || null,
      currentVisibleText: gameDataJson?.current_visible_text || null,
      recentVisibleText: Array.isArray(gameDataJson?.recent_visible_text)
        ? gameDataJson.recent_visible_text.slice(-6)
        : [],
      position:
        exposure.navigation?.validated === true
          ? {
              mapId: pos.map_id ?? null,
              mapName: pos.map_name || null,
              x: pos.x ?? null,
              y: pos.y ?? null,
              elevation: pos.elevation ?? null,
              facing: pos.facing || null,
            }
          : null,
      party: Array.isArray(gameDataJson?.current_pokemon_data) ? gameDataJson.current_pokemon_data : [],
      battle: gameDataJson?.battle_data || null,
      menu: gameDataJson?.menu || null,
      naming: gameDataJson?.naming_state || null,
    },
    decoderSummary: {
      textProbe: {
        battle: compactTextProbe(textProbe.battle),
        field: compactTextProbe(textProbe.field),
        generic: compactTextProbe(textProbe.generic),
      },
      observationFreshness: gameDataJson?.observationFreshness || null,
      stateReliability: gameDataJson?.stateReliabilityDetails || null,
    },
  };
}

function sanitizeVisibleWarpsForModel(warps, gameDataJson = null) {
  if (!Array.isArray(warps)) return [];
  const coordinateFrame = playerCoordinateFrame(gameDataJson);
  return warps.slice(0, 12).map((warp) => ({
    ...coordinatePointForSurface(warp, coordinateFrame),
    coordinateMode: coordinateFrame.coordinateMode,
    distance: warp?.distance ?? null,
    destination_unavailable: true,
  }));
}

function sanitizeVisibleInteractablesForModel(gameDataJson, exposure) {
  const surface = validatedVisibleInteractableSurface(gameDataJson, exposure);
  if (surface.validated !== true) return { current: null, entries: [] };
  const coordinateFrame = playerCoordinateFrame(gameDataJson);
  const sanitizeEntry = (entry) => ({
    kind: entry.kind || "check",
    ...coordinatePointForSurface(entry, coordinateFrame),
    coordinateMode: coordinateFrame.coordinateMode,
    distance: entry.distance ?? null,
    useFrom: Array.isArray(entry.useFrom)
      ? entry.useFrom.slice(0, 4).map((tile) => {
          const point = coordinatePointForSurface(tile, coordinateFrame);
          return {
            x: point.x,
            y: point.y,
            ...(point.localX != null ? { localX: point.localX } : {}),
            ...(point.localY != null ? { localY: point.localY } : {}),
            requiredFacing: tile?.requiredFacing || "unknown",
          };
        })
      : [],
    requiredFacing: entry.requiredFacing || "unknown",
    inFrontOfPlayer: entry.inFrontOfPlayer === true,
  });
  return {
    current: surface.current ? sanitizeEntry(surface.current) : null,
    entries: surface.entries.slice(0, 16).map(sanitizeEntry),
  };
}

function decodedVisibleInteractablesForModel(gameDataJson) {
  const rawEntries = Array.isArray(gameDataJson?.visible_interactables)
    ? gameDataJson.visible_interactables
    : Array.isArray(gameDataJson?.ram_assisted?.interactables?.visible)
      ? gameDataJson.ram_assisted.interactables.visible
      : [];
  const rawCurrent = gameDataJson?.current_interaction || gameDataJson?.ram_assisted?.interactables?.current || null;
  const coordinateFrame = playerCoordinateFrame(gameDataJson);
  const sanitizeUseFrom = (tiles) =>
    (Array.isArray(tiles) ? tiles : []).slice(0, 4).map((tile) => {
      const point = coordinatePointForSurface(tile, coordinateFrame);
      return {
        x: point.x,
        y: point.y,
        ...(point.localX != null ? { localX: point.localX } : {}),
        ...(point.localY != null ? { localY: point.localY } : {}),
        requiredFacing: ["up", "down", "left", "right"].includes(String(tile?.requiredFacing || ""))
          ? tile.requiredFacing
          : "unknown",
      };
    });
  const sanitizeEntry = (entry) => {
    if (!entry || typeof entry !== "object") return null;
    const point = coordinatePointForSurface(entry, coordinateFrame);
    return {
      kind: String(entry.kind || entry.type || "check"),
      x: point.x,
      y: point.y,
      ...(point.localX != null ? { localX: point.localX } : {}),
      ...(point.localY != null ? { localY: point.localY } : {}),
      coordinateMode: coordinateFrame.coordinateMode,
      distance: entry.distance ?? null,
      requiredFacing: ["unknown", "up", "down", "left", "right"].includes(String(entry.requiredFacing || "unknown"))
        ? String(entry.requiredFacing || "unknown")
        : "unknown",
      inFrontOfPlayer: entry.inFrontOfPlayer === true,
      useFrom: sanitizeUseFrom(entry.useFrom),
    };
  };
  const entries = rawEntries.map(sanitizeEntry).filter(Boolean);
  const current = sanitizeEntry(rawCurrent) || entries.find((entry) => entry.inFrontOfPlayer === true) || null;
  return { current, entries: entries.slice(0, 16) };
}

function sanitizeRuntimeObjectsForModel(gameDataJson, exposure) {
  const surface = validatedRuntimeObjectSurface(gameDataJson, exposure);
  if (surface.validated !== true) return [];
  const coordinateFrame = playerCoordinateFrame(gameDataJson);
  return surface.entries.slice(0, 16).map((entry) => ({
    name: safeRuntimeObjectLabel(entry),
    ...coordinatePointForSurface(entry, coordinateFrame),
    coordinateMode: coordinateFrame.coordinateMode,
    facing: entry.facing || null,
    blocking: entry.isBlocking === true || entry.blocking === true,
    visible: entry.isVisible === true || entry.visible === true,
    interactable: entry.isInteractableCandidate === true || entry.interactable === true,
    requiredFacing: entry.requiredFacing || null,
    inFrontOfPlayer: entry.inFrontOfPlayer === true,
    distance: entry.distance ?? null,
  }));
}

function decodedRuntimeObjectsForModel(gameDataJson) {
  const candidateSources = [
    gameDataJson?.npc_entries_visible,
    gameDataJson?.ram_assisted?.runtimeObjects?.visible,
    gameDataJson?.npc_entries,
    gameDataJson?.ram_assisted?.runtimeObjects?.entries,
  ];
  const entries = candidateSources.find((source) => Array.isArray(source) && source.length > 0) || [];
  const coordinateFrame = playerCoordinateFrame(gameDataJson);
  return entries.slice(0, 16).map((entry) => {
    const point = coordinatePointForSurface(entry, coordinateFrame);
    return {
      name: safeRuntimeObjectLabel(entry),
      x: point.x,
      y: point.y,
      ...(point.localX != null ? { localX: point.localX } : {}),
      ...(point.localY != null ? { localY: point.localY } : {}),
      coordinateMode: coordinateFrame.coordinateMode,
      facing: ["up", "down", "left", "right"].includes(String(entry?.facing || "")) ? entry.facing : null,
      blocking: entry?.isBlocking === true || entry?.blocking === true,
      visible: entry?.isVisible === true || entry?.visible === true,
      interactable: entry?.isInteractableCandidate === true || entry?.interactable === true,
      requiredFacing: ["up", "down", "left", "right"].includes(String(entry?.requiredFacing || ""))
        ? entry.requiredFacing
        : null,
      inFrontOfPlayer: entry?.inFrontOfPlayer === true,
      distance: entry?.distance ?? null,
    };
  });
}

function sanitizeCurrentConnectionsForModel(data) {
  if (!data || typeof data !== "object") return null;
  const connections = Array.isArray(data.connections) ? data.connections : [];
  return {
    connections: connections.slice(0, 8).map((entry) => ({
      direction: entry?.direction || null,
      destination_unavailable: true,
    })),
  };
}

function currentConnectionsAuditEvidence(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return {
    source: data.source || null,
    confidence: data.confidence || null,
    contract: data.contract || null,
    count: Array.isArray(data.connections) ? data.connections.length : data.count ?? null,
    currentCellEvidence: data.currentCellEvidence || data.current_cell_evidence || null,
  };
}

function sanitizeFieldMoveAffordancesForModel(data) {
  if (!data || typeof data !== "object") return null;
  const affordances = Array.isArray(data.affordances) ? data.affordances : [];
  return {
    available: data.available === true,
    facing: data.facing || "unknown",
    target: data.target && typeof data.target === "object" ? { x: data.target.x, y: data.target.y } : null,
    affordances: affordances.slice(0, 4).map((entry) => ({
      move: entry?.move || "",
      target: entry?.target || "",
      x: entry?.x,
      y: entry?.y,
      requiredFacing: entry?.requiredFacing || data.facing || "unknown",
    })),
  };
}

function exposeAllDecodedRamForModel(exposure) {
  return Boolean(
    config.isHeartGold &&
      config.observation.exposeAllDecodedRam === true &&
      (exposure?.mode === "ram_assisted" || exposure?.diagnosticsAllowed === true)
  );
}

function shouldExposeDecodedField(exposure, field) {
  return exposure?.fields?.[field]?.validated === true || exposeAllDecodedRamForModel(exposure);
}

function shouldExposeDecodedNavigation(exposure) {
  return exposure?.navigation?.validated === true || exposure?.location?.validated === true || exposeAllDecodedRamForModel(exposure);
}

function hasDecodedObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0);
}

function modelVisibleProgressFlagsSurface(progressFlags) {
  if (!progressFlags || typeof progressFlags !== "object" || Array.isArray(progressFlags)) return {};
  if (progressFlagsValidated(progressFlags)) return whitelistedProgressFlags(progressFlags);
  const allowed = [
    "got_starter",
    "got_pokedex",
    "got_pokegear",
    "got_bag",
    "strength_enabled",
    "flash_active",
    "defog_active",
    "safari_zone_active",
    "safari_zone_has_step_limit",
    "safari_zone_steps_remaining",
    "safari_zone_balls_remaining",
    "starter_species_name",
  ];
  const out = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(progressFlags, key)) continue;
    const value = progressFlags[key];
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string" || value == null) {
      out[key] = value;
    }
  }
  return out;
}

function progressFlagsValidated(progressFlags) {
  return Boolean(
    progressFlags &&
      typeof progressFlags === "object" &&
      progressFlags.validated === true &&
      progressFlags.validation === "validated_save_vars_flags_header_and_named_bits"
  );
}

function whitelistedProgressFlags(progressFlags) {
  if (!progressFlagsValidated(progressFlags)) return {};
  const out = {
    got_starter: progressFlags.got_starter === true,
    got_pokedex: progressFlags.got_pokedex === true,
    got_pokegear: progressFlags.got_pokegear === true,
    got_bag: progressFlags.got_bag === true,
    strength_enabled: progressFlags.strength_enabled === true,
    safari_zone_active: progressFlags.safari_zone_active === true,
    safari_zone_has_step_limit: progressFlags.safari_zone_has_step_limit === true,
    safari_zone_steps_remaining: Number.isInteger(progressFlags.safari_zone_steps_remaining)
      ? progressFlags.safari_zone_steps_remaining
      : null,
    safari_zone_balls_remaining: Number.isInteger(progressFlags.safari_zone_balls_remaining)
      ? progressFlags.safari_zone_balls_remaining
      : null,
    flash_active: progressFlags.flash_active === true,
    defog_active: progressFlags.defog_active === true,
  };
  if (progressFlags.starter_species_name != null) out.starter_species_name = String(progressFlags.starter_species_name);
  return out;
}

function pcStorageDataValidated(pcData) {
  const currentBox = Number(pcData?.current_box ?? pcData?.currentBox);
  return Boolean(
    pcData &&
      typeof pcData === "object" &&
      pcData.validation === "validated_pc_storage_header_and_box_mon_checksums" &&
      Number.isInteger(currentBox) &&
      currentBox >= 1 &&
      currentBox <= 18
  );
}

function positionLiveRamValue(pos) {
  if (Object.prototype.hasOwnProperty.call(pos || {}, "liveRam")) return pos.liveRam;
  if (Object.prototype.hasOwnProperty.call(pos || {}, "live_ram")) return pos.live_ram;
  return null;
}

const CURRENT_POSITION_CONTRACT = "ram_fieldsystem_location_localmapobject_position_current_v1";
const CURRENT_MAP_LOCATION_CONTRACT = "ram_fieldsystem_location_current_map_v1";

function positionCurrentRamContract(pos, reliability, exposure) {
  const rawContract = String(reliability?.position?.contract || pos?.contract || "");
  const coordinateConfidence = String(
    reliability?.position?.coordinateConfidence || pos?.coordinate_confidence || ""
  ).toLowerCase();
  const positionConfidence = String(
    reliability?.position?.confidence || pos?.position_confidence || rawContract || ""
  ).toLowerCase();
  const mapIdSource = String(
    reliability?.position?.mapIdSource || pos?.map_id_source || ""
  ).toLowerCase();
  const mapIdentityConfidence = String(
    reliability?.position?.mapIdentityConfidence || pos?.map_identity_confidence || ""
  ).toLowerCase();
  const hasRuntimeMap = mapIdSource === "fieldsystem.location" || mapIdSource === "field_system.location";
  if (exposure?.navigation?.validated !== true) {
    if (
      exposure?.location?.validated === true &&
      hasRuntimeMap &&
      mapIdentityConfidence === "verified" &&
      (rawContract === CURRENT_MAP_LOCATION_CONTRACT || rawContract !== CURRENT_POSITION_CONTRACT)
    ) {
      return CURRENT_MAP_LOCATION_CONTRACT;
    }
    return null;
  }
  if (rawContract === CURRENT_POSITION_CONTRACT) return CURRENT_POSITION_CONTRACT;

  const hasCurrentCoordinates = coordinateConfidence === "high";
  const hasUsablePosition = positionConfidence === "high" || positionConfidence === "verified_ram" || positionConfidence === "verified";
  if (hasRuntimeMap && hasCurrentCoordinates && hasUsablePosition && mapIdentityConfidence === "verified") {
    return CURRENT_POSITION_CONTRACT;
  }
  return rawContract || null;
}

function compactCoordinateText(pos, coordinateFrame) {
  const x = pos?.x ?? "?";
  const y = pos?.y ?? "?";
  const elevation = pos?.elevation ?? pos?.z;
  const elevationText = Number.isFinite(Number(elevation)) ? ` elevation=${Math.trunc(Number(elevation))}` : "";
  if (
    coordinateFrame?.coordinateMode === "matrix_global_position" &&
    coordinateFrame.localX != null &&
    coordinateFrame.localY != null
  ) {
    return `x=${x} y=${y} (matrix_global; local_x=${coordinateFrame.localX} local_y=${coordinateFrame.localY})${elevationText}`;
  }
  if (coordinateFrame?.coordinateMode && coordinateFrame.coordinateMode !== "map_local_position") {
    return `x=${x} y=${y} (${coordinateFrame.coordinateMode})${elevationText}`;
  }
  return `x=${x} y=${y}${elevationText}`;
}

function coordinatePointForSurface(point, coordinateFrame) {
  const xNumber = Number(point?.x);
  const yNumber = Number(point?.y ?? point?.z);
  const x = Number.isFinite(xNumber) ? Math.trunc(xNumber) : point?.x ?? null;
  const y = Number.isFinite(yNumber) ? Math.trunc(yNumber) : point?.y ?? point?.z ?? null;
  const matrixGlobal = coordinateFrame?.coordinateMode === "matrix_global_position";
  const localX =
    point?.localX ??
    point?.local_x ??
    (matrixGlobal && Number.isFinite(xNumber) && coordinateFrame?.originX != null
      ? Math.trunc(xNumber) - coordinateFrame.originX
      : null);
  const localY =
    point?.localY ??
    point?.local_y ??
    (matrixGlobal && Number.isFinite(yNumber) && coordinateFrame?.originY != null
      ? Math.trunc(yNumber) - coordinateFrame.originY
      : null);
  return { x, y, localX, localY };
}

function compactCoordinatePointText(point, coordinateFrame) {
  const rendered = coordinatePointForSurface(point, coordinateFrame);
  if (
    coordinateFrame?.coordinateMode === "matrix_global_position" &&
    rendered.localX != null &&
    rendered.localY != null
  ) {
    return `x=${rendered.x ?? "?"} y=${rendered.y ?? "?"} (local_x=${rendered.localX} local_y=${rendered.localY})`;
  }
  return `x=${rendered.x ?? "?"} y=${rendered.y ?? "?"}`;
}

function modelVisibleMenuSurface(menu) {
  if (!menu || typeof menu !== "object" || menu.active !== true) return null;
  const items = Array.isArray(menu.items)
    ? menu.items
        .filter((item) => typeof item?.text === "string" && item.text.trim())
        .slice(0, 32)
        .map((item) => ({
          text: item.text.trim(),
          selected: item.selected === true,
        }))
    : [];
  const selected = items.find((item) => item.selected === true);
  const surface = {
    active: true,
    cursor: selected?.text || null,
    items,
  };
  if (typeof menu.title === "string" && menu.title.trim()) {
    surface.title = menu.title.trim();
  }
  if (typeof menu.pocket === "string" && menu.pocket.trim()) {
    surface.pocket = menu.pocket.trim();
  }
  if (typeof menu.mode === "string" && menu.mode.trim()) {
    surface.menu_mode = menu.mode.trim();
  }
  if (typeof menu.box === "string" && menu.box.trim()) {
    surface.storage_box = menu.box.trim();
  }
  return surface;
}

function modelVisiblePokemonMoves(moves) {
  return (Array.isArray(moves) ? moves : [])
    .slice(0, 4)
    .map((move) => {
      if (typeof move === "string" && move.trim()) return { name: move.trim() };
      if (!move || typeof move !== "object") return null;
      const name = playerVisibleMoveName(move);
      if (!name) return null;
      const out = { name };
      const pp = move.pp ?? move.current_pp;
      const maxPp = move.max_pp ?? move.maxPp;
      if (pp != null) out.pp = pp;
      if (maxPp != null) out.max_pp = maxPp;
      return out;
    })
    .filter(Boolean);
}

function modelVisiblePokemonSummary(
  mon,
  { includeHp = true, includeStats = false, includeBox = false, includeAbility = true, includeShiny = true } = {}
) {
  if (!mon || typeof mon !== "object") return null;
  const out = {
    species_name: mon.species_name || mon.species || mon.name || null,
    nickname: mon.nickname || null,
    level: mon.level ?? null,
    exp: mon.exp ?? null,
    status: mon.status_name || mon.status || null,
    types: Array.isArray(mon.types) ? mon.types.slice(0, 2).filter(Boolean) : [],
    held_item_name: mon.held_item_name || mon.heldItemName || mon.held_item || null,
    moves: modelVisiblePokemonMoves(mon.moves),
  };
  if (includeAbility) {
    out.ability = mon.ability || mon.ability_name || null;
  }
  if (includeShiny) {
    out.is_shiny = mon.is_shiny === true;
  }
  if (includeHp) {
    out.current_hp = mon.current_hp ?? mon.hp ?? null;
    out.max_hp = mon.max_hp ?? mon.maxHp ?? null;
  }
  if (includeStats && mon.stats && typeof mon.stats === "object") {
    out.stats = {
      attack: mon.stats.attack ?? null,
      defense: mon.stats.defense ?? null,
      speed: mon.stats.speed ?? null,
      special_attack: mon.stats.special_attack ?? null,
      special_defense: mon.stats.special_defense ?? null,
    };
  }
  if (includeBox) {
    out.box = mon.box ?? mon.box_number ?? null;
    out.box_slot = mon.box_slot ?? mon.slot ?? null;
  }
  return out;
}

function modelVisiblePartySurface(gameDataJson) {
  const party = Array.isArray(gameDataJson?.current_pokemon_data)
    ? gameDataJson.current_pokemon_data
    : Array.isArray(gameDataJson?.ram_assisted?.party?.mons)
      ? gameDataJson.ram_assisted.party.mons
      : [];
  return party.slice(0, 6).map((mon) => modelVisiblePokemonSummary(mon, { includeHp: true, includeStats: true })).filter(Boolean);
}

function modelVisibleInventorySurface(inventory) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) return null;
  const pocketNames = [
    "item_pocket",
    "key_item_pocket",
    "ball_pocket",
    "tm_case",
    "berries_pocket",
    "medicine_pocket",
    "battle_items_pocket",
    "mail_pocket",
    "items",
    "medicine",
    "balls",
    "tms_hms",
    "berries",
    "mail",
    "battle_items",
    "key_items",
  ];
  const out = {};
  for (const pocketName of pocketNames) {
    const pocket = inventory[pocketName];
    const entries = Array.isArray(pocket) ? pocket : Array.isArray(pocket?.items) ? pocket.items : [];
    if (entries.length === 0) continue;
    out[pocketName] = entries
      .slice(0, 64)
      .map((item) => {
        if (Array.isArray(item)) {
          const [name, quantity] = item;
          return { name: String(name || "").trim(), quantity: quantity ?? null };
        }
        if (typeof item === "string") return { name: item.trim(), quantity: null };
        if (!item || typeof item !== "object") return null;
        return {
          name: String(item.name || item.item_name || "").trim(),
          quantity: item.quantity ?? item.qty ?? item.count ?? null,
        };
      })
      .filter((item) => item && item.name);
  }
  const registeredItems = Array.isArray(inventory.registered_items) ? inventory.registered_items : [];
  const visibleRegisteredItems = registeredItems
    .slice(0, 2)
    .map((item) => ({
      slot: Number(item?.slot) || 0,
      name: String(item?.name || item?.item_name || "").trim(),
    }))
    .filter((item) => item.slot >= 1 && item.slot <= 2 && item.name);
  if (visibleRegisteredItems.length > 0) {
    out.registered_items = visibleRegisteredItems;
  }
  return out;
}

function modelVisiblePcStorageSurface(pc) {
  if (!pc || typeof pc !== "object" || Array.isArray(pc)) return null;
  return {
    current_box: pc.current_box ?? pc.currentBox ?? null,
    box_count: pc.box_count ?? pc.boxCount ?? null,
    mons_per_box: pc.mons_per_box ?? pc.monsPerBox ?? null,
    total_mons: pc.total_mons ?? pc.totalMons ?? null,
    pokemons: (Array.isArray(pc.pokemons) ? pc.pokemons : [])
      .slice(0, 30)
      .map((mon) =>
        modelVisiblePokemonSummary(mon, {
          includeHp: false,
          includeStats: false,
          includeBox: true,
          includeAbility: false,
          includeShiny: false,
        })
      )
      .filter(Boolean),
  };
}

function modelVisiblePositionSurface(pos, coordinateFrame, facingValidated, navigationValidated) {
  if (navigationValidated !== true) {
    return {
      map_id: pos.map_id,
      map_name: pos.map_name,
      coordinates: "not_shown",
    };
  }
  return {
    map_id: pos.map_id,
    map_name: pos.map_name,
    x: pos.x,
    y: pos.y,
    elevation: pos.elevation ?? null,
    globalX: coordinateFrame?.globalX,
    globalY: coordinateFrame?.globalY,
    localX: coordinateFrame?.localX,
    localY: coordinateFrame?.localY,
    coordinateMode: coordinateFrame?.coordinateMode,
    facing: facingValidated ? pos.facing : null,
  };
}

function positionAuditEvidence(pos, coordinateFrame, reliability, navigationValidated) {
  if (navigationValidated !== true) {
    const mapIdSource = reliability.position?.mapIdSource || pos.map_id_source || "unknown";
    const mapIdentityConfidence =
      reliability.position?.mapIdentityConfidence || pos.map_identity_confidence || "unknown";
    return manifestAuditEvidence(
      "position",
      {
        mapIdSource,
        mapIdentityConfidence,
        mapNameSource: reliability.position?.mapNameSource || pos.map_name_source || "unknown",
        coordinatesUnavailable: true,
      },
      {
        current_map_identity_verified:
          ["verified"].includes(String(mapIdentityConfidence || "").toLowerCase()) &&
          ["fieldsystem.location", "field_system.location"].includes(String(mapIdSource || "").toLowerCase()),
      }
    );
  }
  const base = {
      pathCoordinateFrame: coordinateFrame.pathCoordinateFrame,
      mapOriginX: coordinateFrame.originX,
      mapOriginY: coordinateFrame.originY,
      mapWidth: coordinateFrame.width,
      mapHeight: coordinateFrame.height,
      inLocalBounds: coordinateFrame.inLocalBounds,
      liveRam: positionLiveRamValue(pos),
      coordinateConfidence: reliability.position?.coordinateConfidence || pos.coordinate_confidence || "high",
      positionConfidence: reliability.position?.confidence || pos.position_confidence || "high",
      mapIdSource: reliability.position?.mapIdSource || pos.map_id_source || "unknown",
      mapIdentityConfidence: reliability.position?.mapIdentityConfidence || pos.map_identity_confidence || "unknown",
  };
  return manifestAuditEvidence("position", base, {
    current_map_identity_verified:
      ["verified"].includes(String(base.mapIdentityConfidence || "").toLowerCase()) &&
      ["fieldsystem.location", "field_system.location"].includes(String(base.mapIdSource || "").toLowerCase()),
    current_coordinates_verified:
      finiteCoordinate(pos?.x) &&
      finiteCoordinate(pos?.y) &&
      (base.inLocalBounds === true || base.pathCoordinateFrame === "map_local_position"),
    current_elevation_verified: pos?.elevation != null || pos?.z != null,
  });
}

function modelVisibleValidatedTextSurface(entry) {
  if (!entry || typeof entry !== "object") return null;
  const surface = {
    active: entry.active === true,
    surface: typeof entry.surface === "string" && entry.surface.trim() ? entry.surface.trim() : "unknown",
    text: typeof entry.text === "string" ? entry.text : "",
  };
  if (Array.isArray(entry.options)) {
    surface.options = entry.options
      .map((option) => {
        if (typeof option === "string") return option.trim();
        if (option && typeof option === "object") return String(option.text || option.label || "").trim();
        return "";
      })
      .filter(Boolean);
  }
  if (typeof entry.cursor === "string" && entry.cursor.trim()) {
    surface.cursor = entry.cursor.trim();
  }
  return surface;
}

function validatedTextAuditEvidence(entry) {
  if (!entry || typeof entry !== "object") return null;
  const decoderContract = entry.decoderContract || entry.decoder_contract || null;
  return manifestAuditEvidence(
    "current_visible_text",
    {
    source: entry.source || null,
    confidence: entry.confidence || null,
    contract: entry.contract || null,
      decoderContract,
    visibilityContract: entry.visibilityContract || entry.visibility_contract || null,
    frame: entry.frame ?? null,
    contextEpoch: entry.contextEpoch ?? null,
    screenshotHash: entry.screenshotHash || entry.screenshot_hash || null,
    },
    {
      visible_now: entry.active === true,
      current_screenshot_bound: hasUsableScreenshotHash(entry.screenshotHash || entry.screenshot_hash),
      owner_bound_text_source:
        decoderContract === "owner_bound_script_environment_textprinter_current_visible_v1" ||
        decoderContract === "owner_bound_current_ui_state_visible_text_v1" ||
        decoderContract === "owner_bound_battle_msgbuffer_textprinter_current_v1",
    }
  );
}

function modelVisibleBattleSurface(gameDataJson) {
  const battle = gameDataJson?.battle_data && typeof gameDataJson.battle_data === "object" ? gameDataJson.battle_data : null;
  if (!battle || !heartGoldBattleAuthoritativelyActive(gameDataJson)) {
    return { in_battle: false };
  }
  const renderMoves = (moves) =>
    (Array.isArray(moves) ? moves : [])
      .filter((move) => move && typeof (move.name || move.move_name) === "string")
      .slice(0, 4)
      .map((move) => ({
        name: (move.name || move.move_name).trim(),
        pp: move.pp ?? move.current_pp ?? null,
      }));
  const renderBattlers = (mons, { includeMoves = false, exactHp = true } = {}) =>
    (Array.isArray(mons) ? mons : []).slice(0, 6).map((mon) => {
      const rendered = {
        species_name: mon?.species_name || mon?.species || mon?.name || null,
        nickname: mon?.nickname || null,
        level: mon?.level ?? null,
        position: mon?.position || null,
        status: mon?.status_name || mon?.status || null,
      };
      if (exactHp) {
        rendered.current_hp = mon?.current_hp ?? mon?.hp ?? null;
        rendered.max_hp = mon?.max_hp ?? mon?.maxHp ?? null;
      } else {
        rendered.hp_percentage = battleHpPercentage(mon?.current_hp ?? mon?.hp, mon?.max_hp ?? mon?.maxHp);
      }
      if (Array.isArray(mon?.types)) rendered.types = mon.types.slice(0, 2).filter(Boolean);
      if (mon?.stat_stages && typeof mon.stat_stages === "object") {
        rendered.stat_stages = {
          attack: mon.stat_stages.attack ?? null,
          defense: mon.stat_stages.defense ?? null,
          speed: mon.stat_stages.speed ?? null,
          special_attack: mon.stat_stages.special_attack ?? null,
          special_defense: mon.stat_stages.special_defense ?? null,
          accuracy: mon.stat_stages.accuracy ?? null,
          evasion: mon.stat_stages.evasion ?? null,
        };
      }
      if (includeMoves) rendered.moves = renderMoves(mon?.moves);
      return rendered;
    });
  const battlerLabel = (targetBattlerId) => {
    if (targetBattlerId == null) return null;
    const targetKey = String(targetBattlerId);
    const entries = [
      ...(Array.isArray(battle.player_pokemons) ? battle.player_pokemons.map((mon) => ["player", mon]) : []),
      ...(Array.isArray(battle.enemy_pokemons) ? battle.enemy_pokemons.map((mon) => ["enemy", mon]) : []),
    ];
    for (const [side, mon] of entries) {
      if (String(mon?.battler_id ?? "") !== targetKey) continue;
      const name = mon?.nickname || mon?.species_name || mon?.species || mon?.name;
      return name ? `${side} ${name}` : side;
    }
    return null;
  };
  const battleInput = battle.battle_input && typeof battle.battle_input === "object" ? battle.battle_input : null;
  const rendered = {
    in_battle: true,
    is_trainer_battle: battle.is_trainer_battle === true,
    is_double_battle: battle.is_double_battle === true,
    player_pokemons: renderBattlers(battle.player_pokemons || battle.playerBattlers || battle.player, { includeMoves: true }),
    enemy_pokemons: renderBattlers(battle.enemy_pokemons || battle.enemyBattlers || battle.enemy, { exactHp: false }),
  };
  if (battleInput) {
    rendered.battle_input = {
      available: battleInput.available === true,
      menu_name: semanticBattleInputMenuName(gameDataJson, battleInput),
      touch_disabled: battleInput.touch_disabled === true,
      player_actions: (Array.isArray(battleInput.player_actions) ? battleInput.player_actions : []).slice(0, 4).map((action) => ({
        actor: battlerLabel(action?.battler_id),
        command_name: action?.command_name || null,
        input_selection_name: action?.input_selection_name || null,
        selected_move_name: action?.selected_move_name || null,
        target: battlerLabel(action?.target_battler_id),
      })),
    };
  }
  return rendered;
}

function modelVisibleNamingSurface(naming) {
  if (!naming || typeof naming !== "object" || naming.active !== true) return null;
  return {
    active: true,
    entryText: naming.entryText || naming.currentText || naming.text || "",
    entryLength: naming.entryLength ?? String(naming.entryText || naming.currentText || naming.text || "").length,
    maxLen: naming.maxLen ?? naming.maxLength ?? null,
    textCursorPos: naming.textCursorPos ?? naming.cursorPos ?? null,
    cursor:
      naming.cursor && typeof naming.cursor === "object"
        ? { x: naming.cursor.x ?? null, y: naming.cursor.y ?? null }
        : { x: naming.cursorX ?? null, y: naming.cursorY ?? null },
    keyboardMode: naming.keyboardMode || naming.modeName || null,
  };
}

function runtimeObjectsAuditEvidence(surface) {
  const summary = surface?.summary && typeof surface.summary === "object" ? surface.summary : {};
  const rootBinding = summary.rootBinding || summary.root_binding || null;
  return manifestAuditEvidence(
    "runtime_objects",
    {
    source: summary.source || null,
    confidence: summary.confidence || null,
    contract: summary.contract || null,
    count: summary.count ?? null,
    visibleCount: summary.visibleCount ?? summary.visible_count ?? null,
    objectCount: summary.objectCount ?? summary.object_count ?? null,
    staticBoundCount: summary.staticBoundCount ?? summary.static_bound_count ?? null,
    semanticMapId: summary.semanticMapId ?? summary.semantic_map_id ?? null,
      rootBinding,
    },
    {
      current_map_object_manager_bound: surface?.validated === true && rootBinding?.currentMapBound === true,
      manager_fieldsystem_backref_bound:
        surface?.validated === true && rootBinding?.managerFieldSystemBound === true && rootBinding?.fieldSystemManagerBound === true,
      player_avatar_object_backref_bound: surface?.validated === true && rootBinding?.playerAvatarObjectBound === true,
      player_object_stride_membership_valid: surface?.validated === true && rootBinding?.playerStrideMember === true,
      visible_subset_current_map: surface?.validated === true && Array.isArray(surface?.entries),
    }
  );
}

function sanitizeManifestAuditEvidence(value) {
  if (value == null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function manifestAuditEvidence(field, baseEvidence = null, proofs = {}) {
  const evidence = baseEvidence && typeof baseEvidence === "object" && !Array.isArray(baseEvidence)
    ? { ...baseEvidence }
    : {};
  const required = Array.isArray(surfacePolicy(field)?.required_evidence)
    ? surfacePolicy(field).required_evidence.map(String).filter(Boolean)
    : [];
  const proven = [];
  for (const tag of required) {
    if (proofs[tag] === true || evidence[tag] === true) {
      evidence[tag] = true;
      proven.push(tag);
    }
  }
  evidence.requiredEvidence = Array.from(new Set([...(Array.isArray(evidence.requiredEvidence) ? evidence.requiredEvidence : []), ...proven]));
  evidence.evidence_tags = Array.from(new Set([...(Array.isArray(evidence.evidence_tags) ? evidence.evidence_tags : []), ...proven]));
  return evidence;
}

function cardinalDirection(value) {
  return ["up", "down", "left", "right"].includes(String(value || "").toLowerCase());
}

function finiteCoordinate(value) {
  return Number.isFinite(Number(value));
}

function modelImageAuditEvidence(imageContract, modelImage, gameDataJson) {
  return manifestAuditEvidence(
    "image",
    {
      screenshotHash: imageContract?.screenshot_hash || gameplayScreenshotHash(gameDataJson) || null,
      modelImageSha256: modelImage?.sha256 || imageContract?.model_image_sha256 || null,
      screenshotFresh:
        imageContract?.screenshot_fresh === true ||
        gameDataJson?.observationFreshness?.screenshotFresh === true ||
        modelImage?.screenshotFresh === true,
    },
    {
      screenshot_hash_present: Boolean(imageContract?.screenshot_hash || gameplayScreenshotHash(gameDataJson)),
      model_image_hash_present: Boolean(modelImage?.sha256 || imageContract?.model_image_sha256),
      freshness_present:
        imageContract?.screenshot_fresh === true ||
        gameDataJson?.observationFreshness?.screenshotFresh === true ||
        modelImage?.screenshotFresh === true,
    }
  );
}

function compactObservationAuditEvidence(userInputText) {
  return manifestAuditEvidence(
    "user_input_text",
    { producer: "codex_desktop_observation_builder" },
    { sanitized_player_prompt_surface: typeof userInputText === "string" && userInputText.trim().length > 0 }
  );
}

function facingAuditEvidence(pos, facingValidated) {
  return manifestAuditEvidence(
    "facing",
    { source: "local_map_object", facing: pos?.facing || null },
    {
      current_player_localmapobject_bound: facingValidated === true,
      facing_cardinal_direction_valid: facingValidated === true && cardinalDirection(pos?.facing),
    }
  );
}

function evidenceBoolean(evidence, snakeName, camelName) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  return evidence[snakeName] === true || evidence[camelName] === true;
}

function movementModeEvidence(gameDataJson) {
  const movementReliability = gameDataJson?.stateReliabilityDetails?.movement || {};
  const detectorMovement = gameDataJson?.ram_assisted?.modeDetector?.movement || {};
  for (const candidate of [
    movementReliability.movementModeEvidence,
    movementReliability.movement_mode_evidence,
    detectorMovement.movementModeEvidence,
    detectorMovement.movement_mode_evidence,
  ]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
  }
  return {};
}

function movementAuditEvidence(gameDataJson, exposure, movementModeValidated) {
  const movement = gameDataJson?.ram_assisted?.modeDetector?.movement || {};
  const evidence = movementModeEvidence(gameDataJson);
  const mode = gameDataJson?.player_movement_mode || movement.mode || null;
  const vehicleKnown =
    Object.prototype.hasOwnProperty.call(movement, "vehicle") ||
    Object.prototype.hasOwnProperty.call(movement, "surfing") ||
    Object.prototype.hasOwnProperty.call(movement, "biking") ||
    Object.prototype.hasOwnProperty.call(movement, "diving");
  return manifestAuditEvidence(
    "movement_mode",
    {
      source: exposure.fields?.movement?.source || null,
      contract: exposure.fields?.movement?.contract || null,
      mode,
      vehicle: movement.vehicle || null,
    },
    {
      current_player_localmapobject_bound:
        movementModeValidated === true &&
        evidenceBoolean(evidence, "current_player_localmapobject_bound", "currentPlayerLocalMapObjectBound"),
      movement_mode_decoded:
        movementModeValidated === true &&
        evidenceBoolean(evidence, "movement_mode_decoded", "movementModeDecoded") &&
        typeof mode === "string" &&
        mode.trim().length > 0,
      vehicle_state_decoded:
        movementModeValidated === true &&
        evidenceBoolean(evidence, "vehicle_state_decoded", "vehicleStateDecoded") &&
        vehicleKnown,
    }
  );
}

function fieldMoveAuditEvidence(gameDataJson, exposure, validated) {
  const data = gameDataJson?.field_move_affordances && typeof gameDataJson.field_move_affordances === "object"
    ? gameDataJson.field_move_affordances
    : gameDataJson?.ram_assisted?.field_move_affordances && typeof gameDataJson.ram_assisted.field_move_affordances === "object"
      ? gameDataJson.ram_assisted.field_move_affordances
      : {};
  const affordances = Array.isArray(data.affordances) ? data.affordances : [];
  return manifestAuditEvidence(
    "field_move_affordances",
    {
      source: exposure.fields?.fieldMoveAffordances?.source || null,
      contract: exposure.fields?.fieldMoveAffordances?.contract || null,
      affordanceCount: affordances.length,
    },
    {
      current_position_verified: validated === true && exposure.navigation?.validated === true,
      current_facing_verified: validated === true && exposure.fields?.facing?.validated === true,
      current_facing_tile_from_rom_land_data_or_current_facing_object_from_mapobjectmanager:
        validated === true && (data.target != null || affordances.length > 0),
      field_move_or_obstacle_metatile_or_object_predicate_decoded:
        validated === true && (data.target != null || affordances.length > 0),
    }
  );
}

function collisionGridAuditEvidence(gameDataJson, exposure, validated) {
  return manifestAuditEvidence(
    "collision_grid",
    {
      source: exposure.fields?.romCollision?.source || null,
      contract: exposure.fields?.romCollision?.contract || null,
      pathfindingAvailable: gameDataJson?.ram_assisted?.pathfinding?.available === true,
    },
    {
      current_map_verified: validated === true && exposure.navigation?.validated === true,
      live_position_validated: validated === true && exposure.navigation?.validated === true,
      metatile_behavior_decoded_for_known_surface_codes: validated === true && gameDataJson?.ram_assisted?.pathfinding?.available === true,
    }
  );
}

function visibilityAuditEvidence(gameDataJson, exposure, progressFlags) {
  const stateName = String(gameDataJson?.visibility_state || "");
  const fieldEffectVisible =
    gameDataJson?.flash_needed === true ||
    gameDataJson?.defog_needed === true ||
    /flash|defog/i.test(stateName);
  return manifestAuditEvidence(
    "visibility",
    {
      source: exposure.fields?.visibility?.source || null,
      contract: exposure.fields?.visibility?.contract || null,
      state: stateName || null,
    },
    {
      local_field_data_header_valid: exposure.fields?.visibility?.validated === true,
      current_weather_decoded: exposure.fields?.visibility?.validated === true && stateName && stateName !== "unknown",
      flash_or_defog_flag_named_fact_when_field_effect_status_visible:
        exposure.fields?.visibility?.validated === true && (!fieldEffectVisible || progressFlagsValidated(progressFlags)),
    }
  );
}

function partyAuditEvidence(gameDataJson, exposure) {
  const sourceParty = Array.isArray(gameDataJson?.current_pokemon_data)
    ? gameDataJson.current_pokemon_data
    : Array.isArray(gameDataJson?.ram_assisted?.party?.mons)
      ? gameDataJson.ram_assisted.party.mons
      : [];
  const party = modelVisiblePartySurface(gameDataJson);
  const contract = exposure.fields?.party?.contract;
  const completeContract = contract === "ram_save_party_header_validated_with_pokemon_checksum_and_stats";
  const partyCountValid = Array.isArray(party) && party.length <= 6 && party.length === sourceParty.length;
  return manifestAuditEvidence(
    "party",
    {
      source: exposure.fields?.party?.source || null,
      contract,
      partyCount: Array.isArray(party) ? party.length : null,
    },
    {
      party_count_bounds_valid: exposure.fields?.party?.validated === true && completeContract && partyCountValid,
      pokemon_checksum_valid: exposure.fields?.party?.validated === true && completeContract && partyCountValid,
      decrypted_stats_consistent: exposure.fields?.party?.validated === true && completeContract && partyCountValid,
    }
  );
}

function inventoryAuditEvidence(gameDataJson, exposure) {
  const inventory = gameDataJson?.inventory_data;
  const contract = exposure.fields?.inventory?.contract;
  const completeContract = contract === "ram_save_bag_slots_header_validated_with_pocket_bounds_and_itemdata_field_pocket_legality";
  return manifestAuditEvidence(
    "inventory",
    { source: exposure.fields?.inventory?.source || null, contract },
    {
      bag_save_header_valid: exposure.fields?.inventory?.validated === true && completeContract,
      pocket_bounds_valid: exposure.fields?.inventory?.validated === true && completeContract && inventory != null,
      item_ids_named: exposure.fields?.inventory?.validated === true && completeContract && inventory != null,
    }
  );
}

function pcStorageAuditEvidence(gameDataJson, exposure, validated) {
  const contract = exposure.fields?.pcStorage?.contract;
  const completeContract = contract === "ram_pc_storage_current_box_checksums_validated";
  return manifestAuditEvidence(
    "pc_storage",
    { source: exposure.fields?.pcStorage?.source || null, contract },
    {
      current_box_valid: validated === true && completeContract && pcStorageDataValidated(gameDataJson?.pc_data),
      box_checksums_valid: validated === true && completeContract && pcStorageDataValidated(gameDataJson?.pc_data),
      boxed_pokemon_checksums_valid: validated === true && completeContract && pcStorageDataValidated(gameDataJson?.pc_data),
    }
  );
}

function battleAuditEvidence(gameDataJson, exposure) {
  const contract = exposure.fields?.battle?.contract;
  const battle = gameDataJson?.battle_data && typeof gameDataJson.battle_data === "object" ? gameDataJson.battle_data : {};
  const battleInput = battle.battle_input && typeof battle.battle_input === "object" ? battle.battle_input : null;
  const playerActions = Array.isArray(battleInput?.player_actions) ? battleInput.player_actions : [];
  const inputValidated =
    battleInput?.validation === "battle_input_current_context_backref_validated" &&
    playerActions.some((action) => action?.command_name || action?.input_selection_name);
  const active = heartGoldBattleAuthoritativelyActive(gameDataJson);
  return manifestAuditEvidence(
    "battle",
    { source: exposure.fields?.battle?.source || null, contract },
    {
      battle_context_active: exposure.fields?.battle?.validated === true && active,
      active_battlers_validated: exposure.fields?.battle?.validated === true && active,
      enemy_backline_unavailable: exposure.fields?.battle?.validated === true && active,
      battle_input_current_context_backref_validated: exposure.fields?.battle?.validated === true && active && inputValidated,
      battle_ui_selection_semantic: exposure.fields?.battle?.validated === true && active && inputValidated,
    }
  );
}

function moneyAuditEvidence(exposure, trainer) {
  return manifestAuditEvidence(
    "money",
    { source: exposure.fields?.money?.source || null, contract: exposure.fields?.money?.contract || null },
    {
      player_profile_crc_valid: exposure.fields?.money?.validated === true && exposure.fields?.money?.contract === "ram_player_profile_money_bounds_validated",
      money_bounds_valid:
        exposure.fields?.money?.validated === true &&
        exposure.fields?.money?.contract === "ram_player_profile_money_bounds_validated" &&
        Number.isFinite(Number(trainer?.money)) &&
        Number(trainer.money) >= 0 &&
        Number(trainer.money) <= 999999,
    }
  );
}

function badgesAuditEvidence(exposure, trainer) {
  const contractValid =
    exposure.fields?.badges?.validated === true &&
    exposure.fields?.badges?.contract === "ram_player_profile_johto_kanto_badge_flags";
  const badgeCount = Number(trainer?.badge_count);
  const badgeTotal = Number(trainer?.badge_total ?? 16);
  const badgeCountValid =
    Number.isInteger(badgeCount) &&
    Number.isInteger(badgeTotal) &&
    badgeTotal >= 1 &&
    badgeTotal <= 16 &&
    badgeCount >= 0 &&
    badgeCount <= badgeTotal;
  const namedBadges =
    trainer?.badges && typeof trainer.badges === "object" && !Array.isArray(trainer.badges)
      ? Object.values(trainer.badges).every((owned) => typeof owned === "boolean")
      : false;
  return manifestAuditEvidence(
    "badges",
    { source: exposure.fields?.badges?.source || null, contract: exposure.fields?.badges?.contract || null },
    {
      player_profile_crc_valid: contractValid,
      named_badge_flags_only: contractValid && (namedBadges || (trainer?.badges == null && badgeCountValid)),
    }
  );
}

function progressAuditEvidence(exposure, progressFlags) {
  const safariCountersValid =
    progressFlags?.safari_zone_active !== true ||
    Object.prototype.hasOwnProperty.call(progressFlags || {}, "safari_zone_has_step_limit");
  return manifestAuditEvidence(
    "progress",
    { source: exposure.fields?.progress?.source || null, contract: exposure.fields?.progress?.contract || null },
    {
      save_vars_header_valid:
        exposure.fields?.progress?.validated === true &&
        exposure.fields?.progress?.contract === "ram_save_vars_flags_named_current_progress_no_raw_flags",
      named_current_progress_only: exposure.fields?.progress?.validated === true && progressFlagsValidated(progressFlags),
      strength_field_effect_named_fact:
        exposure.fields?.progress?.validated === true &&
        progressFlagsValidated(progressFlags) &&
        Object.prototype.hasOwnProperty.call(progressFlags || {}, "strength_enabled"),
      local_field_data_safari_counters_valid_when_present:
        exposure.fields?.progress?.validated === true && progressFlagsValidated(progressFlags) && safariCountersValid,
    }
  );
}

function screenPhaseAuditEvidence(screenPhase, screenPhaseValidated, screenshotHash) {
  return manifestAuditEvidence(
    "screen_phase",
    { confidence: screenPhase?.confidence || null },
    {
      current_screen_phase_from_validated_surface_or_screenshot:
        Boolean(screenPhase?.phase) && (screenPhaseValidated === true || Boolean(screenshotHash)),
    }
  );
}

function menuAuditEvidence(menu, exposure) {
  const items = Array.isArray(menu?.items) ? menu.items : Array.isArray(menu?.options) ? menu.options : [];
  return manifestAuditEvidence(
    "menu",
    { source: exposure.fields?.menu?.source || null, contract: exposure.fields?.menu?.contract || null },
    {
      current_menu_owner_bound: exposure.fields?.menu?.validated === true && menu?.active === true,
      cursor_current:
        exposure.fields?.menu?.validated === true &&
        menu?.active === true &&
        (menu?.cursor != null || menu?.cursorIndex != null || items.some((item) => item?.selected === true)),
    }
  );
}

function namingAuditEvidence(naming, exposure) {
  const hasEntryBuffer =
    Object.prototype.hasOwnProperty.call(naming || {}, "entryText") ||
    Object.prototype.hasOwnProperty.call(naming || {}, "currentText") ||
    Object.prototype.hasOwnProperty.call(naming || {}, "text");
  return manifestAuditEvidence(
    "naming",
    {
      source: exposure.fields?.naming?.source || null,
      contract: exposure.fields?.naming?.contract || null,
      validation: naming?.validation || null,
    },
    {
      current_naming_app_bound: exposure.fields?.naming?.validated === true && naming?.active === true,
      entry_buffer_current: exposure.fields?.naming?.validated === true && naming?.active === true && hasEntryBuffer,
    }
  );
}

function visibleWarpsAuditEvidence(gameDataJson, exposure, validated) {
  const warps = Array.isArray(gameDataJson?.visible_warps)
    ? gameDataJson.visible_warps
    : Array.isArray(gameDataJson?.ram_assisted?.warps?.visible)
      ? gameDataJson.ram_assisted.warps.visible
      : [];
  const warpEvidence =
    gameDataJson?.stateReliabilityDetails?.warps?.visibleWarpEvidence ||
    gameDataJson?.stateReliabilityDetails?.warps?.visible_warp_evidence ||
    gameDataJson?.ram_assisted?.warps?.visibleWarpEvidence ||
    gameDataJson?.ram_assisted?.warps?.visible_warp_evidence ||
    null;
  return manifestAuditEvidence(
    "visible_warps",
    {
      source: exposure.fields?.warps?.source || null,
      contract: exposure.fields?.warps?.contract || null,
      count: warps.length,
      visibleWarpEvidence: warpEvidence,
    },
    {
      current_map_verified:
        validated === true &&
        exposure.navigation?.validated === true &&
        warpEvidence?.currentMapVerified === true &&
        warpEvidence?.eventsBankBoundToCurrentMap === true,
      visible_warp_current_view:
        validated === true &&
        exposure.navigation?.validated === true &&
        warpEvidence?.visibleViewportVerified === true &&
        warpEvidence?.playerPositionBoundToViewport === true &&
        warpEvidence?.warpsFilteredToVisibleView === true &&
        warpEvidence?.destinationLabelsUnavailable === true,
    }
  );
}

function visibleInteractablesAuditEvidence(gameDataJson, exposure, validated) {
  const surface = validatedVisibleInteractableSurface(gameDataJson, exposure);
  return manifestAuditEvidence(
    "visible_interactables",
    {
      source: exposure.fields?.interactables?.source || null,
      contract: exposure.fields?.interactables?.contract || null,
      count: Array.isArray(surface.entries) ? surface.entries.length : null,
    },
    {
      current_map_verified: validated === true && exposure.navigation?.validated === true,
      bg_event_visible_in_current_view: validated === true && surface.validated === true,
      hidden_item_bg_events_filtered: validated === true && surface.validated === true,
    }
  );
}

function currentConnectionsRequiredAuditEvidence(data) {
  const evidence = currentConnectionsAuditEvidence(data) || {};
  const currentCellEvidence = evidence.currentCellEvidence || {};
  return manifestAuditEvidence("current_connections", evidence, {
    current_matrix_cell_verified:
      currentCellEvidence.headersPresent === true &&
      currentCellEvidence.currentCellInBounds === true &&
      currentCellEvidence.currentCellHeaderMatchesMap === true &&
      currentCellEvidence.connectionsDerivedFromCurrentCell === true,
    current_position_verified: currentCellEvidence.positionBoundToCurrentCell === true,
  });
}

function buildModelVisibleManifest(gameDataJson, exposure, imageContract, userInputText, modelImage, decodedRam = null) {
  const pos = gameDataJson?.current_trainer_data?.position || {};
  const coordinateFrame = playerCoordinateFrame(gameDataJson);
  const reliability = gameDataJson?.stateReliabilityDetails || {};
  const freshness = gameDataJson?.observationFreshness || {};
  const screenshotHash = imageContract?.screenshot_hash || gameplayScreenshotHash(gameDataJson) || null;
  const cacheKey = imageContract?.cache_key || gameplayScreenshotCacheKey(gameDataJson) || null;
  const modelDecodedRam = decodedRam || buildModelDecodedRam(gameDataJson, exposure);
  const validatedText = gameDataJson?.current_visible_text && typeof gameDataJson.current_visible_text === "object"
    ? gameDataJson.current_visible_text
    : null;
  const recentText = Array.isArray(gameDataJson?.recent_visible_text)
    ? gameDataJson.recent_visible_text.slice(-6)
    : [];
  const validatedCurrentText = isValidatedCurrentVisibleText(validatedText, gameDataJson) ? validatedText : null;
  const validatedRecentText = recentText.filter((item) => isValidatedRecentVisibleText(item, gameDataJson));
  const screenPhase = compactScreenPhase(gameDataJson, exposure);
  const trainer = gameDataJson?.current_trainer_data || {};
  const progressFlags = gameDataJson?.progress_flags && typeof gameDataJson.progress_flags === "object"
    ? gameDataJson.progress_flags
    : null;
  const progressValidated = exposure.fields?.progress?.validated === true && progressFlagsValidated(progressFlags);
  const pcStorageValidated = exposure.fields?.pcStorage?.validated === true && pcStorageDataValidated(gameDataJson?.pc_data);
  const collisionGridValidated =
    exposure.fields?.romCollision?.validated === true &&
    exposure.navigation?.validated === true &&
    gameDataJson?.ram_assisted?.pathfinding?.available === true;
  const collisionGridValue = collisionGridValidated ? sanitizeCollisionGridForModel(gameDataJson) : null;
  const collisionGridVisible = collisionGridValidated && collisionGridHasSemanticCells(collisionGridValue);
  const visibilityValidated = exposure.fields?.visibility?.validated === true;
  const facingValidated = exposure.fields?.facing?.validated === true;
  const movementModeValidated = exposure.fields?.movement?.validated === true;
  const fieldMoveAffordancesValidated =
    exposure.fields?.fieldMoveAffordances?.validated === true && exposure.navigation?.validated === true;
  const menu = gameDataJson?.ram_assisted?.modeDetector?.menu || null;
  const modelVisibleMenu = modelVisibleMenuSurface(menu);
  const naming = gameDataJson?.naming_state || gameDataJson?.ram_assisted?.modeDetector?.naming || null;
  const runtimeObjectSurface = validatedRuntimeObjectSurface(gameDataJson, exposure);
  const currentConnectionsData = gameDataJson?.current_connections && typeof gameDataJson.current_connections === "object"
    ? gameDataJson.current_connections
    : gameDataJson?.ram_assisted?.current_connections && typeof gameDataJson.ram_assisted.current_connections === "object"
      ? gameDataJson.ram_assisted.current_connections
      : null;
  const exposeDecoded = exposeAllDecodedRamForModel(exposure);
  const navigationVisible = exposure.location?.validated === true || exposure.navigation?.validated === true || exposeDecoded;
  const navigationCoordinatesVisible = exposure.navigation?.validated === true || exposeDecoded;
  const facingVisible = facingValidated || (exposeDecoded && typeof pos.facing === "string" && pos.facing.trim());
  const movement = gameDataJson?.ram_assisted?.modeDetector?.movement || {};
  const movementModeVisible =
    movementModeValidated ||
    (exposeDecoded && Boolean(gameDataJson?.player_movement_mode || movement.mode || movement.vehicle));
  const fieldMoveAffordancesData =
    gameDataJson?.field_move_affordances && typeof gameDataJson.field_move_affordances === "object"
      ? gameDataJson.field_move_affordances
      : gameDataJson?.ram_assisted?.field_move_affordances && typeof gameDataJson.ram_assisted.field_move_affordances === "object"
        ? gameDataJson.ram_assisted.field_move_affordances
        : null;
  const fieldMoveAffordancesVisible =
    fieldMoveAffordancesValidated || (exposeDecoded && hasDecodedObject(fieldMoveAffordancesData));
  const collisionGridDecoded =
    (collisionGridValidated || exposeDecoded) && gameDataJson?.ram_assisted?.pathfinding?.available === true;
  const collisionGridDecodedValue = collisionGridDecoded ? sanitizeCollisionGridForModel(gameDataJson) : null;
  const collisionGridDecodedVisible = collisionGridDecoded && collisionGridHasSemanticCells(collisionGridDecodedValue);
  const visibilityVisible =
    visibilityValidated ||
    (exposeDecoded &&
      (gameDataJson?.visibility_reduced != null ||
        gameDataJson?.visibility_state != null ||
        gameDataJson?.flash_needed != null ||
        gameDataJson?.defog_needed != null ||
        hasDecodedObject(gameDataJson?.visible_area_data)));
  const partyVisible =
    exposure.fields?.party?.validated === true ||
    (exposeDecoded && (Array.isArray(gameDataJson?.current_pokemon_data) || Array.isArray(gameDataJson?.ram_assisted?.party?.mons)));
  const inventoryVisible =
    exposure.fields?.inventory?.validated === true ||
    (exposeDecoded && (Array.isArray(gameDataJson?.inventory_data) || hasDecodedObject(gameDataJson?.inventory_data)));
  const pcStorageVisible = pcStorageValidated || (exposeDecoded && hasDecodedObject(gameDataJson?.pc_data));
  const battleVisible =
    exposure.fields?.battle?.validated === true || (exposeDecoded && hasDecodedObject(gameDataJson?.battle_data));
  const moneyVisible = (exposure.fields?.money?.validated === true || exposeDecoded) && trainer.money != null;
  const badgesVisible =
    (exposure.fields?.badges?.validated === true || exposeDecoded) &&
    (trainer.badge_count != null || hasDecodedObject(trainer.badges));
  const progressVisible = progressValidated || (exposeDecoded && hasDecodedObject(progressFlags));
  const menuVisible =
    (exposure.fields?.menu?.validated === true || exposeDecoded) && menu?.active === true && menu?.source !== "unavailable";
  const namingVisible = (exposure.fields?.naming?.validated === true || exposeDecoded) && naming?.active === true;
  const decodedRuntimeObjects = decodedRuntimeObjectsForModel(gameDataJson);
  const runtimeObjectsVisible = runtimeObjectSurface.validated === true || exposeDecoded;
  const warpsVisible =
    (exposure.fields?.warps?.validated === true && exposure.navigation?.validated === true) ||
    (exposeDecoded && (Array.isArray(gameDataJson?.visible_warps) || Array.isArray(gameDataJson?.ram_assisted?.warps?.visible)));
  const decodedVisibleInteractables = decodedVisibleInteractablesForModel(gameDataJson);
  const visibleInteractablesVisible =
    (exposure.fields?.interactables?.validated === true && exposure.navigation?.validated === true) || exposeDecoded;
  const currentConnectionsVisible =
    (exposure.fields?.currentConnections?.validated === true && exposure.navigation?.validated === true) ||
    (exposeDecoded && hasDecodedObject(currentConnectionsData));
  const screenPhaseValidated =
    (screenPhase.phase === "dialogue" && screenPhase.confidence === "ram_visible_text") ||
    (screenPhase.phase === "battle" && exposure.fields?.battle?.validated === true) ||
    (screenPhase.phase === "menu" && exposure.fields?.menu?.validated === true) ||
    (screenPhase.phase === "naming" && exposure.fields?.naming?.validated === true) ||
    (screenPhase.phase === "overworld_moving" &&
      exposure.fields?.movement?.validated === true &&
      exposure.navigation?.validated === true);
  const entry = (
    field,
    { visible, validated, contract, source, value, unavailableReason, frame, contextEpoch, auditEvidence, requiredEvidence } = {}
  ) => {
    const modelVisibleValue = visible === true ? sanitizeModelValue(value ?? null) : null;
    const shouldKeepAuditEvidence = visible === true || validated === true;
    return applyManifestEntryGate({
      field,
      visible: visible === true,
      validated: validated === true,
      source: source || null,
      contract: contract || null,
      value_hash: modelVisibleValue == null ? null : stableHash(modelVisibleValue).slice(0, 16),
      value: modelVisibleValue,
      frame: frame ?? null,
      contextEpoch: contextEpoch ?? null,
      audit_evidence: shouldKeepAuditEvidence
        ? sanitizeManifestAuditEvidence(manifestAuditEvidence(field, auditEvidence ?? null, requiredEvidence || {}))
        : null,
      screenshotHash,
      cacheKey,
      unavailable_reason: visible === true ? null : (unavailableReason || "not_in_current_observation"),
    });
  };
  const entries = [
    entry("image", {
      visible: Boolean(imageContract?.image_id || imageContract?.screenshot_hash),
      validated: Boolean(screenshotHash && cacheKey),
      contract: "heartgold_model_image_current_ds_screenshot_v1",
      source: "prepared_model_image",
      value: imageContract || null,
      auditEvidence: modelImageAuditEvidence(imageContract, modelImage, gameDataJson),
    }),
    entry("user_input_text", {
      visible: Boolean(userInputText),
      validated: true,
      contract: "codex_desktop_compact_player_observation_v1",
      source: "codex_desktop_observation_builder",
      value: userInputText || "",
      auditEvidence: compactObservationAuditEvidence(userInputText),
    }),
    entry("decoded_ram", {
      visible: hasDecodedObject(modelDecodedRam),
      validated: hasDecodedObject(modelDecodedRam),
      contract: "decoded_current_ram_gameplay_state_v1",
      source: "heartgold_current_ram_decoders",
      value: modelDecodedRam,
      auditEvidence: {
        current_observation_only: true,
        complete_current_bridge_snapshot: true,
        expose_all_decoded_ram_policy: exposeDecoded,
      },
      unavailableReason: "decoded_ram_unavailable",
    }),
    entry("position", {
      visible: navigationVisible,
      validated: exposure.location?.validated === true || exposure.navigation?.validated === true,
      contract: positionCurrentRamContract(pos, reliability, exposure),
      source: reliability.position?.source || pos.source || "unknown",
      value:
        navigationVisible
          ? modelVisiblePositionSurface(pos, coordinateFrame, facingVisible, navigationCoordinatesVisible)
          : null,
      auditEvidence:
        navigationVisible
          ? positionAuditEvidence(pos, coordinateFrame, reliability, navigationCoordinatesVisible)
          : null,
      unavailableReason: exposure.location?.reason || exposure.navigation?.reason || "navigation_not_validated",
    }),
    entry("facing", {
      visible: Boolean(facingVisible),
      validated: facingValidated,
      contract: reliability.facing?.contract || exposure.fields?.facing?.contract || null,
      source: reliability.facing?.source || exposure.fields?.facing?.source || "unknown",
      value: facingVisible ? { facing: pos.facing || null } : null,
      auditEvidence: facingAuditEvidence(pos, facingValidated),
      unavailableReason: "facing_not_validated",
    }),
    entry("movement_mode", {
      visible: movementModeVisible,
      validated: movementModeValidated,
      contract: reliability.movement?.contract || exposure.fields?.movement?.contract || null,
      source: reliability.movement?.source || exposure.fields?.movement?.source || "unknown",
      value: movementModeVisible
        ? (() => {
            return {
              mode: gameDataJson?.player_movement_mode || movement.mode || "UNKNOWN",
              vehicle: movement.vehicle || null,
              surfing: movement.surfing === true,
              biking: movement.biking === true,
              bikeType: movement.bikeType || null,
              diving: movement.diving === true,
            };
          })()
        : null,
      auditEvidence: movementAuditEvidence(gameDataJson, exposure, movementModeValidated),
      unavailableReason: "movement_mode_not_validated",
    }),
    entry("field_move_affordances", {
      visible: fieldMoveAffordancesVisible,
      validated: fieldMoveAffordancesValidated,
      contract: exposure.fields?.fieldMoveAffordances?.contract,
      source: exposure.fields?.fieldMoveAffordances?.source,
      value: fieldMoveAffordancesVisible
        ? sanitizeFieldMoveAffordancesForModel(fieldMoveAffordancesData)
        : null,
      auditEvidence: fieldMoveAuditEvidence(gameDataJson, exposure, fieldMoveAffordancesValidated),
      unavailableReason: "field_move_affordances_not_validated_or_navigation_unavailable",
    }),
    entry("current_visible_text", {
      visible: validatedCurrentText?.active === true,
      validated: validatedCurrentText?.source === "ram_visible_text" && validatedCurrentText?.confidence === "validated_current",
      contract: validatedCurrentText?.contract || reliability.dialogue?.contract || "current_visible_text_v1",
      source: validatedCurrentText?.source || "ram_visible_text",
      value: validatedCurrentText ? modelVisibleValidatedTextSurface(validatedCurrentText) : null,
      frame: validatedCurrentText?.frame ?? null,
      contextEpoch: validatedCurrentText?.contextEpoch ?? null,
      auditEvidence: validatedTextAuditEvidence(validatedCurrentText),
      unavailableReason: "no_current_visible_text",
    }),
    entry("collision_grid", {
      visible: collisionGridVisible || collisionGridDecodedVisible,
      validated: collisionGridVisible,
      contract: exposure.fields?.romCollision?.contract,
      source: exposure.fields?.romCollision?.source,
      value: collisionGridVisible ? collisionGridValue : collisionGridDecodedVisible ? collisionGridDecodedValue : null,
      auditEvidence: collisionGridVisible || collisionGridDecodedVisible ? collisionGridAuditEvidence(gameDataJson, exposure, collisionGridVisible) : null,
      unavailableReason: collisionGridValidated
        ? "collision_grid_semantic_cells_missing"
        : "collision_grid_not_validated_or_navigation_unavailable",
    }),
    entry("visibility", {
      visible: visibilityVisible,
      validated: visibilityValidated,
      contract: exposure.fields?.visibility?.contract,
      source: exposure.fields?.visibility?.source,
      value: visibilityVisible ? sanitizeVisibilityForModel(gameDataJson) : null,
      auditEvidence: visibilityAuditEvidence(gameDataJson, exposure, progressFlags),
      unavailableReason: "visibility_decoder_not_validated",
    }),
    entry("recent_visible_text", {
      visible: validatedRecentText.length > 0,
      validated: validatedRecentText.length > 0 && validatedRecentText.every((item) => item?.source === "ram_visible_text"),
      contract: "current_visible_text_v1_recent_observed",
      source: "ram_visible_text_history",
      value: validatedRecentText.map(modelVisibleValidatedTextSurface).filter(Boolean),
      auditEvidence: { entries: validatedRecentText.map(validatedTextAuditEvidence).filter(Boolean) },
      requiredEvidence: {
        recent_screenshot_bound: validatedRecentText.every((item) => hasUsableScreenshotHash(item?.screenshotHash || item?.screenshot_hash)),
        owner_bound_text_source: validatedRecentText.every((item) => {
          const decoderContract = item?.decoderContract || item?.decoder_contract || "";
          return (
            decoderContract === "owner_bound_script_environment_textprinter_current_visible_v1" ||
            decoderContract === "owner_bound_current_ui_state_visible_text_v1" ||
            decoderContract === "owner_bound_battle_msgbuffer_textprinter_current_v1" ||
            decoderContract === "validated_battle_system_msgbuffer_event_v1"
          );
        }),
      },
      unavailableReason: "no_recent_visible_text",
    }),
    entry("party", {
      visible: partyVisible,
      validated: exposure.fields?.party?.validated === true,
      contract: exposure.fields?.party?.contract,
      source: exposure.fields?.party?.source,
      value: partyVisible ? modelVisiblePartySurface(gameDataJson) : null,
      auditEvidence: partyAuditEvidence(gameDataJson, exposure),
      unavailableReason: "party_ram_not_validated",
    }),
    entry("inventory", {
      visible: inventoryVisible,
      validated: exposure.fields?.inventory?.validated === true,
      contract: exposure.fields?.inventory?.contract,
      source: exposure.fields?.inventory?.source,
      value: inventoryVisible ? modelVisibleInventorySurface(gameDataJson?.inventory_data) : null,
      auditEvidence: inventoryAuditEvidence(gameDataJson, exposure),
      unavailableReason: "inventory_ram_not_validated",
    }),
    entry("pc_storage", {
      visible: pcStorageVisible,
      validated: pcStorageValidated,
      contract: exposure.fields?.pcStorage?.contract,
      source: exposure.fields?.pcStorage?.source,
      value: pcStorageVisible ? modelVisiblePcStorageSurface(gameDataJson?.pc_data) : null,
      auditEvidence: pcStorageAuditEvidence(gameDataJson, exposure, pcStorageValidated),
      unavailableReason: "pc_storage_ram_not_validated",
    }),
    entry("battle", {
      visible: battleVisible,
      validated: exposure.fields?.battle?.validated === true,
      contract: exposure.fields?.battle?.contract,
      source: exposure.fields?.battle?.source,
      value: battleVisible ? modelVisibleBattleSurface(gameDataJson) : null,
      auditEvidence: battleAuditEvidence(gameDataJson, exposure),
      unavailableReason: "battle_ram_not_validated",
    }),
    entry("money", {
      visible: moneyVisible,
      validated: exposure.fields?.money?.validated === true && trainer.money != null,
      contract: exposure.fields?.money?.contract,
      source: exposure.fields?.money?.source,
      value: trainer.money ?? null,
      auditEvidence: moneyAuditEvidence(exposure, trainer),
      unavailableReason: "money_ram_not_validated",
    }),
    entry("badges", {
      visible: badgesVisible,
      validated: exposure.fields?.badges?.validated === true && trainer.badge_count != null,
      contract: exposure.fields?.badges?.contract,
      source: exposure.fields?.badges?.source,
      value: { count: trainer.badge_count ?? null, total: trainer.badge_total ?? 16, badges: trainer.badges || null },
      auditEvidence: badgesAuditEvidence(exposure, trainer),
      unavailableReason: "badge_ram_not_validated",
    }),
    entry("progress", {
      visible: progressVisible,
      validated: progressValidated,
      contract: exposure.fields?.progress?.contract,
      source: exposure.fields?.progress?.source,
      value: progressVisible ? modelVisibleProgressFlagsSurface(progressFlags) : null,
      auditEvidence: progressAuditEvidence(exposure, progressFlags),
      unavailableReason: "progress_ram_not_validated",
    }),
    entry("screen_phase", {
      visible: true,
      validated: screenPhaseValidated,
      contract: "heartgold_screen_phase_compact_current_surface_v1",
      source: "codex_desktop_compact_screen_phase",
      value: { phase: screenPhase.phase || "inspect_screenshot" },
      auditEvidence: screenPhaseAuditEvidence(screenPhase, screenPhaseValidated, screenshotHash),
      unavailableReason: "screen_phase_not_available",
    }),
    entry("menu", {
      visible: menuVisible,
      validated: exposure.fields?.menu?.validated === true && menu?.active === true,
      contract: exposure.fields?.menu?.contract,
      source: exposure.fields?.menu?.source,
      value: modelVisibleMenu,
      auditEvidence: menuAuditEvidence(menu, exposure),
      unavailableReason: "menu_ram_not_validated_or_inactive",
    }),
    entry("naming", {
      visible: namingVisible,
      validated: exposure.fields?.naming?.validated === true && naming?.active === true,
      contract: exposure.fields?.naming?.contract,
      source: exposure.fields?.naming?.source,
      value: modelVisibleNamingSurface(naming),
      auditEvidence: namingAuditEvidence(naming, exposure),
      unavailableReason: "naming_ram_not_validated_or_inactive",
    }),
    entry("runtime_objects", {
      visible: runtimeObjectsVisible,
      validated: runtimeObjectSurface.validated === true,
      contract: exposure.fields?.npcs?.contract,
      source: exposure.fields?.npcs?.source,
      value: runtimeObjectSurface.validated === true ? sanitizeRuntimeObjectsForModel(gameDataJson, exposure) : decodedRuntimeObjects,
      auditEvidence: runtimeObjectsAuditEvidence(runtimeObjectSurface),
      unavailableReason: runtimeObjectSurface.reason || "runtime_objects_not_validated",
    }),
    entry("visible_warps", {
      visible: warpsVisible,
      validated: exposure.fields?.warps?.validated === true && exposure.navigation?.validated === true,
      contract: exposure.fields?.warps?.contract,
      source: exposure.fields?.warps?.source,
      value: sanitizeVisibleWarpsForModel(gameDataJson?.visible_warps, gameDataJson),
      auditEvidence: visibleWarpsAuditEvidence(
        gameDataJson,
        exposure,
        exposure.fields?.warps?.validated === true && exposure.navigation?.validated === true
      ),
      unavailableReason: "warps_not_validated_or_navigation_unavailable",
    }),
    entry("visible_interactables", {
      visible: visibleInteractablesVisible,
      validated: exposure.fields?.interactables?.validated === true && exposure.navigation?.validated === true,
      contract: exposure.fields?.interactables?.contract,
      source: exposure.fields?.interactables?.source,
      value: exposure.fields?.interactables?.validated === true && exposure.navigation?.validated === true
        ? sanitizeVisibleInteractablesForModel(gameDataJson, exposure)
        : decodedVisibleInteractables,
      auditEvidence: visibleInteractablesAuditEvidence(
        gameDataJson,
        exposure,
        exposure.fields?.interactables?.validated === true && exposure.navigation?.validated === true
      ),
      unavailableReason: "visible_interactables_not_validated_or_navigation_unavailable",
    }),
    entry("current_connections", {
      visible: currentConnectionsVisible,
      validated: exposure.fields?.currentConnections?.validated === true && exposure.navigation?.validated === true,
      contract: exposure.fields?.currentConnections?.contract,
      source: exposure.fields?.currentConnections?.source,
      value: sanitizeCurrentConnectionsForModel(currentConnectionsData),
      auditEvidence: currentConnectionsRequiredAuditEvidence(currentConnectionsData),
      unavailableReason: "current_connections_not_validated_or_navigation_unavailable",
    }),
  ];
  const manifest = {
    version: 1,
    purpose: "artifact_only_manifest_of_player_visible_observation_surface",
    observation_id: imageContract?.observation_id || null,
    step: state.counters.currentStep,
    screenshotHash,
    cacheKey,
    screenshotFresh:
      gameDataJson?.observationFreshness?.screenshotFresh ??
      gameDataJson?.screenshotFresh ??
      gameDataJson?.emulator?.screenshotFresh ??
      null,
    screenshotAgeMs: freshness.screenshotAgeMs ?? null,
    modelImagePath: modelImage?.path || null,
    modelImageSha256: imageContract?.model_image_sha256 || null,
    mode: exposure.mode,
    entries,
  };
  return { ...manifest, audit: auditModelVisibleManifest(manifest), hash: stableHash(manifest) };
}

async function prepareObservationAnchorState(observationId) {
  if (!config.isHeartGold || config.codexDesktop.restoreObservationAnchor !== true) {
    return { enabled: false, path: null, response: null };
  }
  await fs.mkdir(config.codexDesktop.anchorDir, { recursive: true });
  const safeId = String(observationId || Date.now()).replace(/[^a-zA-Z0-9_.-]/g, "_");
  const anchorPath = path.join(config.codexDesktop.anchorDir, `${safeId}.State`);
  return {
    enabled: true,
    path: anchorPath,
    response: null,
  };
}

async function restoreObservationAnchorState(observation) {
  if (!config.isHeartGold || config.codexDesktop.restoreObservationAnchor !== true) {
    return { attempted: false, restored: false, path: null, response: null };
  }
  const anchorPath = observation?.anchorStatePath || null;
  if (!anchorPath) {
    throw new Error("Codex Desktop action requires a saved observation anchor state from the game interface loop.");
  }
  const response = await loadState(anchorPath);
  if (!response || (response.ok !== true && response.status !== true)) {
    const message = response?.message || response?.error || "unknown loadState failure";
    throw new Error(`Codex Desktop observation anchor restore failed: ${message}`);
  }
  return {
    attempted: true,
    restored: true,
    path: response.path || anchorPath,
    response: {
      ok: response.ok === true || response.status === true,
      status: response.status === true || response.ok === true,
      path: response.path || anchorPath,
    },
  };
}

function operatorPrompt() {
  const baseUrl = `http://127.0.0.1:${config.wsPort}`;
  return [
    "You are Codex Desktop playing Pokemon HeartGold, not acting as a repo-debugging assistant.",
    `When operating as a self-running Codex Desktop player on Windows, use GET ${baseUrl}/codexDesktop/observation for the first observation and POST ${baseUrl}/codexDesktop/action?include_next_observation=1 after each decision as the official local game interface. If Codex Desktop exposes PowerShell/Invoke-RestMethod as the transport mechanism, use it only for those local endpoint calls.`,
    "Use only model_input.image, model_input.user_input_text, model_input.decoded_ram, recent_history, recent_player_reasoning, model-owned memory/objectives, recalled reasoning archive entries, and the execute_action schema for gameplay decisions.",
    "Every normal turn should inspect the current official screenshot. You may view/open exactly the image path returned in model_input.image.path as the official current screenshot for that turn. Do not open any other image or file.",
    "PowerShell/Invoke-RestMethod is allowed only as Windows transport for the official local /codexDesktop endpoints. Do not use PowerShell, shell, rg/grep, repository search, or file reads to gather gameplay information.",
    "Do not inspect repository files, runtime JSON, Lua/Python internals, savestates, RAM dumps, screenshots outside model_input.image, or monitor-only artifacts to decide what to do in-game.",
    "Monitor-only artifacts are allowed only to report an interface failure, not to choose gameplay actions.",
    "Do not decide from truncated PowerShell object formatting. Assign endpoint results to variables and inspect model_input.image, model_input.user_input_text, model_input.decoded_ram, recent reasoning/history, and the action schema.",
    "For each turn, inspect the current official screenshot/state surface, submit one execute_action JSON object to /codexDesktop/action?include_next_observation=1, then continue from the returned next_observation. If next_observation is missing, GET /codexDesktop/observation as a fallback.",
    "Use generous local timeouts: about 30-45s for GET observation and 90s for POST action with include_next_observation. If a POST action times out, do not repeat the same input first; GET a fresh observation to see whether the input already happened.",
    "Transport silence: Do not narrate routine observation/action transport in the Codex conversation. Endpoint calls are only I/O; speak there only for meaningful gameplay expression, a decision you want to record, or an interface failure.",
    "Do not turn observation refresh into an in-game objective. Observing is interface I/O, not something the player character is trying to accomplish.",
    "Do not use a_until_end_of_dialog just because text is missing. Use it only when the official image/text clearly shows already-read low-information dialogue; if the official image cannot be viewed, stop and report an observation failure.",
    "Return one execute_action arguments object with an actions array. step_details, chat_message, and avatar_emotion are optional player-authored continuity/commentary fields for meaningful gameplay expression; routine endpoint transport needs no narration.",
    "Use button_sequence for sequential movement such as Down, Down, Left. key_press is simultaneous input, not a sequence.",
    "On the Pokemon HeartGold title screen or a visible 'Touch to Start' prompt, press Start first with key_press keys:[\"start\"]. Do not assume touch is required there.",
    "Prefer DS buttons for dialogue and menus; use touch only for clearly visible lower-screen targets or when faster.",
    "The attached HeartGold model image may be scaled up for readability. Raw DS coordinates are still 256x384: top screen y=0..191, bottom touch screen y=192..383. Default touch coordinates are bottom-local 256x192. If you choose a point from the attached scaled bitmap, use touch coordinate_space=\"model_scaled\", screen=\"full\", and source_width/source_height from model_input.image.",
    "In ram_assisted mode, decoded current RAM gameplay state shown in model_input.user_input_text and model_input.decoded_ram is part of the gameplay observation. Use the current decoded state together with the screenshot.",
    "If the screenshot is stale/unavailable, stop and classify it as a harness observation failure instead of guessing.",
  ].join("\n");
}

function normalizeObservationMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  return OBSERVATION_MODE_ALIASES.get(raw) || raw || "unknown";
}

function observationModeMismatch(gameDataJson) {
  if (!config.isHeartGold) return false;
  const bridgeMode = normalizeObservationMode(gameDataJson?.observationPolicy?.mode || gameDataJson?.game?.observationMode);
  const configMode = normalizeObservationMode(config.observation.mode);
  if (!bridgeMode || bridgeMode === "unknown") return false;
  return bridgeMode !== configMode || config.observation.modeWasInvalid === true;
}

function buildImageContract(modelImage, observationId) {
  const width = Number(modelImage?.width) || null;
  const height = Number(modelImage?.height) || null;
  const scale = Number(modelImage?.scale) || null;
  const imageId = modelImage?.cacheKey || modelImage?.screenshotHash || modelImage?.sha256 || null;
  return {
    observation_id: observationId,
    image_id: imageId,
    screenshot_hash: modelImage?.screenshotHash || null,
    model_image_sha256: modelImage?.sha256 || null,
    cache_key: modelImage?.cacheKey || null,
    screenshot_fresh: modelImage?.screenshotFresh ?? null,
    screenshot_age_ms: modelImage?.screenshotAgeMs ?? null,
    width,
    height,
    scale,
    raw_full: { width: 256, height: 384 },
    top_screen: { y_min: 0, y_max: 191, touchable: false },
    bottom_screen_full: { y_min: 192, y_max: 383, touchable: true },
    bottom_screen_local: { width: 256, height: 192, touchable: true },
    model_scaled_touch: {
      coordinate_space: "model_scaled",
      screen: "full",
      source_width: width,
      source_height: height,
    },
    action_loop_refreshes_observation: true,
  };
}

function modelVisibleImageMetadata(modelImage) {
  if (!modelImage || typeof modelImage !== "object") return null;
  return {
    path: modelImage.path || null,
    screenshotHash: modelImage.screenshotHash || null,
    screenshotFresh: modelImage.screenshotFresh ?? null,
    screenshotAgeMs: modelImage.screenshotAgeMs ?? null,
    width: modelImage.width || null,
    height: modelImage.height || null,
    scale: modelImage.scale || null,
    error: modelImage.error || null,
  };
}

function modelVisibleImageContract(imageContract) {
  if (!imageContract || typeof imageContract !== "object") return null;
  return {
    screenshot_hash: imageContract.screenshot_hash || null,
    screenshot_fresh: imageContract.screenshot_fresh ?? null,
    screenshot_age_ms: imageContract.screenshot_age_ms ?? null,
    width: imageContract.width ?? null,
    height: imageContract.height ?? null,
    scale: imageContract.scale ?? null,
    raw_full: imageContract.raw_full || { width: 256, height: 384 },
    top_screen: imageContract.top_screen || { y_min: 0, y_max: 191, touchable: false },
    bottom_screen_full: imageContract.bottom_screen_full || { y_min: 192, y_max: 383, touchable: true },
    bottom_screen_local: imageContract.bottom_screen_local || { width: 256, height: 192, touchable: true },
    model_scaled_touch: imageContract.model_scaled_touch || null,
    action_loop_refreshes_observation: imageContract.action_loop_refreshes_observation === true,
  };
}

function artifactRef(filePath, type) {
  if (!filePath) return null;
  return {
    id: path.basename(filePath),
    type,
    monitor_only: true,
  };
}

function modelVisibleObservationDrift(drift) {
  if (!drift || typeof drift !== "object") return null;
  return {
    screenshot_hash_changed: drift.screenshot_hash_changed === true,
    cache_key_changed: drift.cache_key_changed === true,
    material_state_known: drift.material_state_known === true,
    material_state_changed: drift.material_state_changed === true,
    observation_to_action_ms: drift.observation_to_action_ms ?? null,
  };
}

function modelVisibleAnchorRestore(anchorRestore) {
  if (!anchorRestore || typeof anchorRestore !== "object") return null;
  return {
    attempted: anchorRestore.attempted === true,
    restored: anchorRestore.restored === true,
  };
}

function modelVisibleActionResult(result, artifactPath) {
  if (!result || typeof result !== "object") return result;
  const {
    observation_artifact_path: observationArtifactPath,
    observation_model_image: observationModelImage,
    observation_drift: observationDrift,
    observation_anchor_restore: observationAnchorRestore,
    observation_screenshot_hash: _observationScreenshotHash,
    pre_action_screenshot_hash: _preActionScreenshotHash,
    observation_screenshot_hash_changed: _observationScreenshotHashChanged,
    observation_cache_key_changed: _observationCacheKeyChanged,
    observation_material_state_changed: _observationMaterialStateChanged,
    observation_drift_accepted_reason: _observationDriftAcceptedReason,
    observation_to_action_ms: _observationToActionMs,
    pre_action_refresh_skipped: _preActionRefreshSkipped,
    observation_monitor_only: _observationMonitorOnly,
    benchmark_semantic_success: _benchmarkSemanticSuccess,
    action_result_count: _actionResultCount,
    action_semantics: _actionSemantics,
    duration_ms: _durationMs,
    normalization_applied: _normalizationApplied,
    normalization_reason: _normalizationReason,
    ...safeResult
  } = result;
  return {
    ...safeResult,
    observation_artifact_ref: artifactRef(observationArtifactPath, "observation"),
    observation_model_image: modelVisibleImageMetadata(observationModelImage),
    artifact_ref: artifactRef(artifactPath, "action"),
  };
}

function formatImageContract(imageContract) {
  if (!imageContract) return "";
  return [
    "<current_image_evidence>",
    `  <current_image width="${imageContract.width || ""}" height="${imageContract.height || ""}" scale="${imageContract.scale || ""}" />`,
    '  <ds_layout raw_full="256x384" top_screen="y=0..191 visual_only" bottom_screen_full="y=192..383 touchable" bottom_screen_local="256x192 default_touch" />',
    `  <model_scaled_touch coordinate_space="model_scaled" screen="full" source_width="${imageContract.model_scaled_touch.source_width || ""}" source_height="${imageContract.model_scaled_touch.source_height || ""}" />`,
    "  <freshness_rule>Use this current image only for this decision. The game interface refreshes the screenshot/state before the next decision.</freshness_rule>",
    "</current_image_evidence>",
  ].join("\n");
}

function escapeXml(value) {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function compactStateObject(value, limit = 6) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([, item]) => item != null && String(item).trim() !== "")
    .slice(0, limit)
    .map(([key, item]) => ({
      key: sanitizeModelText(String(key)).slice(0, 120),
      value: sanitizeModelText(String(item)).slice(0, 300),
    }));
}

function pruneEmptyDecodedRam(value) {
  if (Array.isArray(value)) return value.map(pruneEmptyDecodedRam).filter((item) => item != null);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const pruned = pruneEmptyDecodedRam(item);
    if (pruned == null) continue;
    if (Array.isArray(pruned) && pruned.length === 0) continue;
    if (typeof pruned === "object" && !Array.isArray(pruned) && Object.keys(pruned).length === 0) continue;
    out[key] = pruned;
  }
  return out;
}

function cloneDecodedRamSnapshot(gameDataJson) {
  if (!gameDataJson || typeof gameDataJson !== "object") return {};
  return JSON.parse(JSON.stringify(gameDataJson));
}

function buildModelDecodedRam(gameDataJson, exposure) {
  void exposure;
  return cloneDecodedRamSnapshot(gameDataJson);
}

function compactObjectives() {
  const objectives = state.objectives || {};
  const entries = [
    ["primary", objectives.primary?.short_description || objectives.primary?.description || ""],
    ["secondary", objectives.secondary?.short_description || objectives.secondary?.description || ""],
    ["third", objectives.third?.short_description || objectives.third?.description || ""],
  ].filter(([, text]) => String(text || "").trim());
  if (Array.isArray(objectives.others)) {
    for (const item of objectives.others.slice(0, 3)) {
      const text = item?.short_description || item?.description || "";
      if (String(text || "").trim()) entries.push(["other", text]);
    }
  }
  return entries.map(([slot, text]) => [
    sanitizeModelText(String(slot)).slice(0, 120),
    sanitizeModelText(String(text)).slice(0, 300),
  ]);
}

function currentVisibleTextLines(gameDataJson) {
  const lines = [];
  const validHash = hasUsableScreenshotHash;
  const validEpoch = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;
  const validFrame = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;
  const battleActive = heartGoldBattleAuthoritativelyActive(gameDataJson);
  const fieldDialogueActive =
    !battleActive &&
    isOwnerBoundCurrentFieldDialogueText(gameDataJson?.current_visible_text, gameDataJson);
  const currentUiActive =
    !battleActive &&
    isOwnerBoundCurrentUiText(gameDataJson?.current_visible_text, gameDataJson);
  const isAllowedSurface = (entry) => {
    const surface = String(entry?.surface || "");
    if (surface === "battle") return battleActive;
    if (surface === "field_dialogue") return fieldDialogueActive;
    if (surface === "current_ui") return currentUiActive;
    return false;
  };
  const recentDecoderContractAllowed = (entry) => {
    const surface = String(entry?.surface || "");
    if (surface === "field_dialogue") {
      return (entry?.decoderContract || entry?.decoder_contract || "") === FIELD_VISIBLE_TEXT_DECODER_CONTRACT;
    }
    if (surface === "current_ui") {
      return (entry?.decoderContract || entry?.decoder_contract || "") === CURRENT_UI_VISIBLE_TEXT_DECODER_CONTRACT;
    }
    if (surface !== "battle") return true;
    return [
      "validated_battle_system_msgbuffer_event_v1",
      "owner_bound_battle_msgbuffer_textprinter_current_v1",
    ].includes(entry?.decoderContract || entry?.decoder_contract || "") &&
      entry?.visibilityContract === "owner_bound_battle_textprinter_complete_v1";
  };
  const isCurrentText = (entry) => isValidatedCurrentVisibleText(entry, gameDataJson);
  const isRecentText = (entry) =>
    entry?.active === true &&
    entry.source === "ram_visible_text" &&
    entry.confidence === "validated_current" &&
    entry.contract === "current_visible_text_v1_recent_observed" &&
    isAllowedSurface(entry) &&
    recentDecoderContractAllowed(entry) &&
    typeof entry.text === "string" &&
    entry.text.trim() &&
    validFrame(entry.frame) &&
    validEpoch(entry.contextEpoch) &&
    validHash(entry.screenshotHash);
  const isLikelyCompleteRecentText = (text) => {
    const value = String(text || "").trim();
    if (!value) return false;
    const lastToken = value.split(/\s+/).pop() || "";
    if (/^[a-z]$/i.test(lastToken) && !/[AI]$/.test(lastToken)) return false;
    if (/[.!?…:;)"']$/.test(value)) return true;
    return value.length >= 18 && !/\s+[a-z]{1,2}$/i.test(value);
  };
  const current = gameDataJson?.current_visible_text;
  const currentText = isCurrentText(current) ? current.text.trim() : "";
  if (currentText) {
    lines.push(
      `  <current_text surface="${escapeXml(current.surface || "unknown")}">${escapeXml(
        currentText
      )}</current_text>`
    );
  }
  const recent = Array.isArray(gameDataJson?.recent_visible_text)
    ? gameDataJson.recent_visible_text
        .filter((entry) => isRecentText(entry))
        .filter((entry) => isLikelyCompleteRecentText(entry.text))
    : [];
  const dedupedRecent = [];
  for (const entry of recent) {
    const text = String(entry.text || "").trim();
    if (currentText && (text === currentText || text.startsWith(currentText) || currentText.startsWith(text))) {
      continue;
    }
    if (dedupedRecent.some((kept) => kept.text === text || text.startsWith(kept.text) || kept.text.startsWith(text))) {
      continue;
    }
    dedupedRecent.push({ ...entry, text });
  }
  for (const entry of dedupedRecent.slice(-3)) {
    lines.push(
      `  <recent_text surface="${escapeXml(entry.surface || "unknown")}">${escapeXml(entry.text.trim())}</recent_text>`
    );
  }
  return lines;
}

function isValidatedCurrentVisibleText(entry, gameDataJson) {
  const frame = Number(entry?.frame);
  const epoch = Number(entry?.contextEpoch);
  const battleActive = heartGoldBattleAuthoritativelyActive(gameDataJson);
  const fieldDialogueActive =
    !battleActive &&
    isOwnerBoundCurrentFieldDialogueText(gameDataJson?.current_visible_text, gameDataJson);
  const currentUiActive =
    !battleActive &&
    isOwnerBoundCurrentUiText(gameDataJson?.current_visible_text, gameDataJson);
  const surface = String(entry?.surface || "");
  const surfaceActive = surface === "battle" ? battleActive : surface === "field_dialogue" ? fieldDialogueActive : surface === "current_ui" ? currentUiActive : false;
  const decoderContractAllowed =
    surface === "field_dialogue"
      ? (entry?.decoderContract || entry?.decoder_contract || "") === FIELD_VISIBLE_TEXT_DECODER_CONTRACT
      : surface === "current_ui"
        ? (entry?.decoderContract || entry?.decoder_contract || "") === CURRENT_UI_VISIBLE_TEXT_DECODER_CONTRACT
      : surface !== "battle" ||
        (entry?.decoderContract || entry?.decoder_contract || "") === "owner_bound_battle_msgbuffer_textprinter_current_v1";
  return (
    entry &&
    entry.active === true &&
    entry.source === "ram_visible_text" &&
    entry.confidence === "validated_current" &&
    entry.contract === "current_visible_text_v1" &&
    Number.isFinite(frame) &&
    frame >= 0 &&
    Number.isFinite(epoch) &&
    epoch >= 0 &&
    validatedCurrentTextMatchesCurrentScreenshot(entry, gameDataJson) &&
    surfaceActive &&
    decoderContractAllowed &&
    typeof entry.text === "string" &&
    entry.text.trim()
  );
}

function isValidatedRecentVisibleText(entry, gameDataJson) {
  const hash = String(entry?.screenshotHash || "").trim().toLowerCase();
  const frame = Number(entry?.frame);
  const epoch = Number(entry?.contextEpoch);
  const battleActive = heartGoldBattleAuthoritativelyActive(gameDataJson);
  const fieldDialogueActive =
    !battleActive &&
    isOwnerBoundCurrentFieldDialogueText(gameDataJson?.current_visible_text, gameDataJson);
  const currentUiActive =
    !battleActive &&
    isOwnerBoundCurrentUiText(gameDataJson?.current_visible_text, gameDataJson);
  const surface = String(entry?.surface || "");
  const surfaceActive = surface === "battle" ? battleActive : surface === "field_dialogue" ? fieldDialogueActive : surface === "current_ui" ? currentUiActive : false;
  const decoderContractAllowed =
    surface === "field_dialogue"
      ? (entry?.decoderContract || entry?.decoder_contract || "") === FIELD_VISIBLE_TEXT_DECODER_CONTRACT
      : surface === "current_ui"
        ? (entry?.decoderContract || entry?.decoder_contract || "") === CURRENT_UI_VISIBLE_TEXT_DECODER_CONTRACT
      : surface !== "battle" ||
        ([
          "validated_battle_system_msgbuffer_event_v1",
          "owner_bound_battle_msgbuffer_textprinter_current_v1",
        ].includes(entry?.decoderContract || entry?.decoder_contract || "") &&
          entry?.visibilityContract === "owner_bound_battle_textprinter_complete_v1");
  return (
    entry &&
    entry.active === true &&
    entry.source === "ram_visible_text" &&
    entry.confidence === "validated_current" &&
    entry.contract === "current_visible_text_v1_recent_observed" &&
    Number.isFinite(frame) &&
    frame >= 0 &&
    Number.isFinite(epoch) &&
    epoch >= 0 &&
    hash.length >= 10 &&
    !["missing", "none", "null", "unknown", "placeholder", "stale_or_missing", "hash", "screenhash"].includes(hash) &&
    surfaceActive &&
    decoderContractAllowed &&
    typeof entry.text === "string" &&
    entry.text.trim()
  );
}

function validatedCurrentVisibleText(gameDataJson) {
  const current = gameDataJson?.current_visible_text;
  return isValidatedCurrentVisibleText(current, gameDataJson) ? current : null;
}

function validatedDialogTextActive(gameDataJson) {
  const current = validatedCurrentVisibleText(gameDataJson);
  return current && ["field_dialogue", "current_ui"].includes(String(current.surface || ""));
}

function compactScreenPhase(gameDataJson, exposure) {
  const detector = gameDataJson?.ram_assisted?.modeDetector || {};
  const battle = detector.battle && typeof detector.battle === "object" ? detector.battle : {};
  const menu = detector.menu && typeof detector.menu === "object" ? detector.menu : {};
  const naming = detector.naming && typeof detector.naming === "object" ? detector.naming : {};
  const movement = detector.movement && typeof detector.movement === "object" ? detector.movement : {};
  const battleActive = heartGoldBattleAuthoritativelyActive(gameDataJson);
  const namingActive = !battleActive && exposure?.fields?.naming?.validated === true && naming.active === true;
  const menuActive =
    !battleActive &&
    !namingActive &&
    exposure?.fields?.menu?.validated === true &&
    menu.active === true &&
    menu.source !== "unavailable";
  const dialogActive =
    !battleActive &&
    !namingActive &&
    (exposure?.mode === "ram_assisted" || exposure?.diagnosticsAllowed === true) &&
    exposure?.fields?.dialogue?.validated === true &&
    validatedDialogTextActive(gameDataJson);
  const globalApp =
    (gameDataJson?.global_app && typeof gameDataJson.global_app === "object" ? gameDataJson.global_app : null) ||
    (detector.global_app && typeof detector.global_app === "object" ? detector.global_app : null);
  const globalAppData = globalApp?.app && typeof globalApp.app === "object" ? globalApp.app : {};
  const globalAppName = String(globalAppData.app || "");
  const globalAppActive =
    globalApp?.active === true &&
    globalAppData.active === true &&
    globalAppName &&
    !["none", "unknown"].includes(globalAppName);
  if (battleActive) {
    return {
      phase: "battle",
      confidence:
        exposure?.fields?.battle?.validated === true
          ? exposure.fields.battle.confidence || "validated_ram"
          : battle.confidence || gameDataJson?.screen_mode_confidence || "candidate",
    };
  }
  if (namingActive) return { phase: "naming", confidence: naming.confidence || "validated_ram" };
  if (dialogActive) return { phase: "dialogue", confidence: "ram_visible_text" };
  if (menuActive) return { phase: "menu", confidence: menu.confidence || "validated_ram" };
  if (globalAppActive) return { phase: globalAppName, confidence: globalApp.source || "ram_global_overlay" };
  if (
    exposure?.fields?.movement?.validated === true &&
    exposure?.navigation?.validated === true &&
    String(movement.mode || "").toUpperCase() === "MOVING"
  ) {
    return { phase: "overworld_moving", confidence: movement.confidence || "candidate" };
  }
  const rawMode = gameDataJson?.screen_mode || detector.mode || "inspect_screenshot";
  const rawConfidence = gameDataJson?.screen_mode_confidence || detector.confidence || "screenshot_required";
  if (["dialogue", "menu", "naming"].includes(String(rawMode || ""))) {
    return {
      phase: "inspect_screenshot",
      confidence: "visual_or_detector_state_without_validated_ram_surface",
    };
  }
  return { phase: rawMode || "inspect_screenshot", confidence: rawConfidence };
}

function formatCurrentVisibleTextForPlayer(gameDataJson, exposure) {
  if (exposure?.mode !== "ram_assisted" && exposure?.diagnosticsAllowed !== true) return "";
  const lines = currentVisibleTextLines(gameDataJson);
  if (lines.length === 0) return "";
  return ["Visible RAM text:", ...lines].join("\n");
}

function monDisplayName(mon) {
  return mon?.nickname || mon?.name || mon?.species_name || mon?.species || "unknown";
}

function playerVisibleMoveName(move) {
  if (typeof move === "string") return move;
  if (!move || typeof move !== "object") return null;
  return move.name || move.move_name || null;
}

function compactPartyLines(gameDataJson, exposure) {
  if (!shouldExposeDecodedField(exposure, "party")) {
    return ["Party: not shown in this observation."];
  }
  const party = Array.isArray(gameDataJson?.current_pokemon_data)
    ? gameDataJson.current_pokemon_data
    : Array.isArray(gameDataJson?.ram_assisted?.party?.mons)
      ? gameDataJson.ram_assisted.party.mons
      : [];
  const lines = [`Party (${party.length}):`];
  if (party.length === 0) {
    lines.push("- none decoded");
    return lines;
  }
  for (const mon of party.slice(0, 6)) {
    const hp = mon.current_hp ?? mon.hp ?? "?";
    const maxHp = mon.max_hp ?? mon.maxHp ?? "?";
    const status = mon.status_name || mon.status || "";
    const types = Array.isArray(mon.types) ? mon.types.slice(0, 2).filter(Boolean).join(", ") : "";
    const ability = mon.ability || mon.ability_name || "";
    const heldItem = mon.held_item_name || mon.heldItemName || mon.held_item || "";
    const shiny = typeof mon.is_shiny === "boolean" ? `; shiny=${mon.is_shiny ? "true" : "false"}` : "";
    const exp = Number(mon.exp);
    const expText = Number.isFinite(exp) ? ` EXP ${exp}` : "";
    const moves = Array.isArray(mon.moves)
      ? mon.moves
          .slice(0, 4)
          .map((move) => {
            const name = playerVisibleMoveName(move);
            if (!name) return null;
            const pp = move?.pp ?? move?.current_pp;
            return pp == null ? name : `${name} PP ${pp}`;
          })
          .filter(Boolean)
          .join(", ")
      : "";
    lines.push(`- ${monDisplayName(mon)} Lv${mon.level ?? "?"}${expText} HP ${hp}/${maxHp}${status ? ` ${status}` : ""}${types ? `; types: ${types}` : ""}${ability ? `; ability: ${ability}` : ""}${heldItem ? `; holding ${heldItem}` : ""}${shiny}${moves ? `; moves: ${moves}` : ""}`);
  }
  return lines;
}

function compactInventoryLines(gameDataJson, exposure) {
  if (!shouldExposeDecodedField(exposure, "inventory")) {
    return ["Inventory: not shown in this observation."];
  }
  const inventory = gameDataJson?.inventory_data;
  if (Array.isArray(inventory)) {
    return [`Inventory entries: ${inventory.length}.`];
  }
  if (!inventory || typeof inventory !== "object") return ["Inventory: none decoded."];
  const pocketNames = [
    "item_pocket",
    "key_item_pocket",
    "ball_pocket",
    "tm_case",
    "berries_pocket",
    "medicine_pocket",
    "battle_items_pocket",
    "mail_pocket",
    "items",
    "medicine",
    "balls",
    "tms_hms",
    "berries",
    "mail",
    "battle_items",
    "key_items",
  ];
  const lines = ["Inventory:"];
  for (const pocketName of pocketNames) {
    const pocket = inventory[pocketName];
    const entries = Array.isArray(pocket)
      ? pocket
      : Array.isArray(pocket?.items)
        ? pocket.items
        : [];
    if (entries.length === 0) continue;
    const rendered = entries
      .slice(0, 8)
      .map((item) => {
        if (Array.isArray(item)) {
          const [name, qty] = item;
          return qty == null ? String(name) : `${name} x${qty}`;
        }
        if (typeof item === "string") return item;
        const name = item?.name || item?.item_name || "item";
        const qty = item?.quantity ?? item?.qty ?? item?.count;
        return qty == null ? String(name) : `${name} x${qty}`;
      })
      .join(", ");
    lines.push(`- ${pocketName}: ${rendered}${entries.length > 8 ? ", ..." : ""}`);
  }
  const registeredItems = Array.isArray(inventory.registered_items) ? inventory.registered_items : [];
  const renderedRegisteredItems = registeredItems
    .slice(0, 2)
    .map((item) => {
      const slot = Number(item?.slot) || 0;
      const name = String(item?.name || item?.item_name || "").trim();
      if (slot < 1 || slot > 2 || !name) return null;
      return `slot ${slot} ${name}`;
    })
    .filter(Boolean);
  if (renderedRegisteredItems.length > 0) {
    lines.push(`- registered_items: ${renderedRegisteredItems.join(", ")}`);
  }
  if (lines.length === 1) lines.push("- no non-empty pockets decoded");
  return lines;
}

function compactPcStorageLines(gameDataJson, exposure) {
  if (!shouldExposeDecodedField(exposure, "pcStorage") || (!exposeAllDecodedRamForModel(exposure) && !pcStorageDataValidated(gameDataJson?.pc_data))) {
    return ["PC storage: not shown in this observation."];
  }
  const pc = gameDataJson?.pc_data && typeof gameDataJson.pc_data === "object" ? gameDataJson.pc_data : null;
  if (!pc) return ["PC storage: none decoded."];
  const currentBox = pc.current_box ?? pc.currentBox ?? "?";
  const totalMons = pc.total_mons ?? pc.totalMons ?? 0;
  const lines = [`PC storage: current_box=${currentBox} total_mons=${totalMons}.`];
  const mons = Array.isArray(pc.pokemons) ? pc.pokemons : [];
  if (mons.length === 0) {
    lines.push("- current box empty or no current-box Pokemon decoded");
    return lines;
  }
  for (const mon of mons.slice(0, 12)) {
    const name = mon.nickname || mon.species_name || mon.species || "unknown";
    const box = mon.box ?? mon.box_number ?? currentBox;
    const slot = mon.box_slot ?? mon.slot ?? "?";
    const levelValue = Number(mon.level);
    const level = mon.level_known !== false && Number.isFinite(levelValue) && levelValue > 0 ? ` Lv${levelValue}` : "";
    const expValue = Number(mon.exp);
    const exp = Number.isFinite(expValue) && expValue >= 0 ? ` EXP ${expValue}` : "";
    const moves = Array.isArray(mon.moves)
      ? mon.moves
          .slice(0, 4)
          .map(playerVisibleMoveName)
          .filter(Boolean)
          .join(", ")
      : "";
    const held = mon.held_item_name || mon.heldItemName || "";
    lines.push(
      `- box ${box} slot ${slot}: ${name}${level}${exp}${held ? ` holding ${held}` : ""}${moves ? `; moves: ${moves}` : ""}`
    );
  }
  return lines;
}

function compactBattleLines(gameDataJson, exposure) {
  const battle = gameDataJson?.battle_data || {};
  if (!shouldExposeDecodedField(exposure, "battle")) {
    return ["Battle: not shown in this observation."];
  }
  if (!heartGoldBattleAuthoritativelyActive(gameDataJson)) {
    return ["Battle: not active."];
  }
  const lines = [`Battle active: ${battle.is_trainer_battle ? "trainer" : "wild or unknown"}.`];
  const targetLabel = (targetBattlerId) => {
    if (targetBattlerId == null) return "";
    const targetKey = String(targetBattlerId);
    const allBattlers = [
      ...(Array.isArray(battle.player_pokemons) ? battle.player_pokemons : []),
      ...(Array.isArray(battle.playerBattlers) ? battle.playerBattlers : []),
      ...(Array.isArray(battle.player) ? battle.player : []),
      ...(Array.isArray(battle.enemy_pokemons) ? battle.enemy_pokemons : []),
      ...(Array.isArray(battle.enemyBattlers) ? battle.enemyBattlers : []),
      ...(Array.isArray(battle.enemy) ? battle.enemy : []),
    ];
    const match = allBattlers.find((mon) => String(mon?.battler_id ?? "") === targetKey);
    return match ? monDisplayName(match) : "";
  };
  const statStagesText = (statStages) => {
    if (!statStages || typeof statStages !== "object" || Array.isArray(statStages)) return "";
    const ordered = [
      ["attack", "Atk"],
      ["defense", "Def"],
      ["speed", "Spe"],
      ["special_attack", "SpA"],
      ["special_defense", "SpD"],
      ["accuracy", "Acc"],
      ["evasion", "Eva"],
    ];
    const parts = [];
    for (const [key, label] of ordered) {
      const value = statStages[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < -6 || value > 6) return "";
      parts.push(`${label} ${value > 0 ? `+${value}` : value}`);
    }
    return parts.join(", ");
  };
  const battlerStatusText = (mon) => {
    const status = mon?.status_name || mon?.status || "";
    return typeof status === "string" && status.trim() ? ` ${status.trim()}` : "";
  };
  const battlerTypesText = (mon) => {
    if (!Array.isArray(mon?.types)) return "";
    const types = mon.types
      .slice(0, 2)
      .map((type) => {
        if (typeof type === "string") return type.trim();
        if (!type || typeof type !== "object") return "";
        return String(type.name || type.type_name || "").trim();
      })
      .filter(Boolean);
    return types.length > 0 ? `; types: ${types.join(", ")}` : "";
  };
  const battlerMovesText = (mon) => {
    if (!Array.isArray(mon?.moves)) return "";
    const moves = mon.moves
      .slice(0, 4)
      .map((move) => {
        const name = playerVisibleMoveName(move);
        if (!name) return "";
        const pp = move?.pp ?? move?.current_pp;
        return pp == null ? name : `${name} PP ${pp}`;
      })
      .filter(Boolean);
    return moves.length > 0 ? `; moves: ${moves.join(", ")}` : "";
  };
  const renderMons = (label, mons, { includeMoves = false, exactHp = true } = {}) => {
    if (!Array.isArray(mons) || mons.length === 0) return;
    lines.push(`${label}:`);
    for (const mon of mons.slice(0, 6)) {
      const stages = statStagesText(mon.stat_stages);
      const status = battlerStatusText(mon);
      const types = battlerTypesText(mon);
      const moves = includeMoves ? battlerMovesText(mon) : "";
      const hp = exactHp
        ? `${mon.current_hp ?? mon.hp ?? "?"}/${mon.max_hp ?? mon.maxHp ?? "?"}`
        : battleHpPercentage(mon.current_hp ?? mon.hp, mon.max_hp ?? mon.maxHp);
      lines.push(`- ${monDisplayName(mon)} Lv${mon.level ?? "?"} HP ${hp}${status}${types}${moves}${stages ? `; stat stages: ${stages}` : ""}`);
    }
  };
  renderMons("Player battlers", battle.player_pokemons || battle.playerBattlers || battle.player, { includeMoves: true });
  renderMons("Enemy battlers", battle.enemy_pokemons || battle.enemyBattlers || battle.enemy, { exactHp: false });
  const input = battle.battle_input;
  if (input && typeof input === "object") {
    const inputAvailable = input.available === true;
    const menuName = semanticBattleInputMenuName(gameDataJson, input) || "";
    const action = Array.isArray(input.player_actions) ? input.player_actions.find((entry) => entry && typeof entry === "object") : null;
    const actionParts = [];
    if (action?.command_name && action?.input_selection_name) {
      actionParts.push(`${action.command_name} via ${action.input_selection_name}`);
    } else if (action?.command_name) {
      actionParts.push(String(action.command_name));
    } else if (action?.input_selection_name) {
      actionParts.push(`input ${action.input_selection_name}`);
    }
    if (action?.selected_move_name) actionParts.push(`selected move ${action.selected_move_name}`);
    const target = targetLabel(action?.target_battler_id);
    if (target) actionParts.push(`target ${target}`);
    const suffix = inputAvailable && actionParts.length ? `; ${actionParts.join("; ")}` : "";
    lines.push(`Battle input: ${inputAvailable ? "available" : "not available"}${menuName ? ` (${menuName})` : ""}${suffix}.`);
  }
  return lines;
}

function compactNamingLines(gameDataJson, exposure) {
  const namingValidated = shouldExposeDecodedField(exposure, "naming") || exposure.diagnosticsAllowed;
  const naming = gameDataJson?.naming_state || gameDataJson?.ram_assisted?.modeDetector?.naming || {};
  if (!namingValidated || naming.active !== true) return [];
  const numberText = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? String(Math.trunc(number)) : null;
  };
  const entryText = naming.entryText || naming.currentText || naming.text || "";
  const entryLength = numberText(naming.entryLength ?? String(entryText).length) || "?";
  const maxLength = numberText(naming.maxLen ?? naming.maxLength) || "?";
  const textCursorPos = numberText(naming.textCursorPos ?? naming.cursorPos);
  const cursor = naming.cursor && typeof naming.cursor === "object" ? naming.cursor : {};
  const keyboardCursorX = numberText(cursor.x ?? naming.cursorX);
  const keyboardCursorY = numberText(cursor.y ?? naming.cursorY);
  const keyboardMode = typeof naming.keyboardMode === "string" && naming.keyboardMode.trim()
    ? naming.keyboardMode.trim()
    : typeof naming.modeName === "string" && naming.modeName.trim()
      ? naming.modeName.trim()
      : "";
  const details = [`length ${entryLength}/${maxLength}`];
  if (textCursorPos != null) details.push(`text cursor ${textCursorPos}`);
  if (keyboardCursorX != null && keyboardCursorY != null) details.push(`keyboard cursor x=${keyboardCursorX} y=${keyboardCursorY}`);
  if (keyboardMode) details.push(`keyboard=${keyboardMode}`);
  return [`Naming screen: current text "${entryText}", ${details.join(", ")}.`];
}

function compactMenuLines(gameDataJson, exposure) {
  const menuValidated = shouldExposeDecodedField(exposure, "menu") || exposure.diagnosticsAllowed;
  const menu = gameDataJson?.ram_assisted?.modeDetector?.menu || {};
  if (!menuValidated || menu.active !== true || menu.source === "unavailable") return [];
  const lines = ["Menu open."];
  if (typeof menu.title === "string" && menu.title.trim()) {
    lines.push(`Menu: ${menu.title.trim()}`);
  }
  if (typeof menu.pocket === "string" && menu.pocket.trim()) {
    lines.push(`Menu pocket: ${menu.pocket.trim()}`);
  }
  if (typeof menu.mode === "string" && menu.mode.trim()) {
    lines.push(`Menu mode: ${menu.mode.trim()}`);
  }
  if (typeof menu.box === "string" && menu.box.trim()) {
    lines.push(`Menu box: ${menu.box.trim()}`);
  }
  const items = Array.isArray(menu.items) ? menu.items.filter((item) => typeof item?.text === "string" && item.text.trim()) : [];
  if (items.length > 0) {
    lines.push(`Menu items: ${items.slice(0, 10).map((item) => `${item.selected ? ">" : ""}${item.text.trim()}`).join(" | ")}`);
  }
  return lines;
}

function compactNavigationLines(gameDataJson, exposure) {
  const lines = [];
  const decodedNavigation = shouldExposeDecodedNavigation(exposure);
  if (decodedNavigation) {
    const pos = gameDataJson?.current_trainer_data?.position || {};
    const coordinateFrame = playerCoordinateFrame(gameDataJson);
    const facing = shouldExposeDecodedField(exposure, "facing") ? pos.facing || "unknown" : "not shown";
    if (exposure.navigation?.validated === true || exposeAllDecodedRamForModel(exposure)) {
      lines.push(
        `Location: ${pos.map_name || "unknown"} ${compactCoordinateText(pos, coordinateFrame)} facing=${facing}.`
      );
    } else {
      lines.push(`Location: ${pos.map_name || "unknown"} (coordinates not shown) facing=${facing}.`);
    }
    if (shouldExposeDecodedField(exposure, "movement")) {
      const movement = gameDataJson?.ram_assisted?.modeDetector?.movement || {};
      const mode = gameDataJson?.player_movement_mode || movement.mode || "UNKNOWN";
      const vehicle = movement.vehicle || "unknown";
      const bikeType = movement.bikeType ? ` bikeType=${movement.bikeType}` : "";
      lines.push(
        `Movement: ${mode}; vehicle=${vehicle}; surfing=${movement.surfing === true} biking=${movement.biking === true}${bikeType} diving=${movement.diving === true}.`
      );
    }
  } else {
    lines.push("Location: not shown in this observation.");
  }
  const pathfinding = gameDataJson?.ram_assisted?.pathfinding || {};
  if (pathfinding.available === true && decodedNavigation) {
    lines.push(
      "path_to_location: available from the current decoded collision grid."
    );
    lines.push(...compactCollisionGridLines(gameDataJson, exposure));
  } else {
    lines.push(`path_to_location: disabled (${playerSafePathfindingDisabledReason(pathfinding.disabledReason || exposure.navigation?.reason)}).`);
  }
  lines.push(...compactVisibilityLines(gameDataJson, exposure));
  lines.push(...compactFieldMoveAffordanceLines(gameDataJson, exposure));
  lines.push(...compactCurrentConnectionLines(gameDataJson, exposure));
  return lines;
}

function compactCollisionGridLines(gameDataJson, exposure) {
  if (
    !shouldExposeDecodedField(exposure, "romCollision") ||
    !shouldExposeDecodedNavigation(exposure) ||
    gameDataJson?.ram_assisted?.pathfinding?.available !== true
  ) {
    return [];
  }
  const collision = sanitizeCollisionGridForModel(gameDataJson);
  const rows = Array.isArray(collision.cells) ? collision.cells : [];
  if (rows.length === 0) return [];
  const width = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
  if (width === 0) return [];
  const pos = gameDataJson?.current_trainer_data?.position || {};
  const player = { x: Number(pos.x), y: Number(pos.y) };
  const lines = [
    `Collision grid (current visible ${rows.length}x${width}; legend #=blocked .=passable G=tall grass W=water D=door/warp H=headbutt tree C=cut tree B=boulder/rock ?=unknown @=player):`,
  ];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length === 0) continue;
    const rowY = Number.isFinite(Number(row[0]?.y)) ? Number(row[0].y) : "?";
    const symbols = row.map((cell) => collisionGridPromptSymbol(cell, player)).join("");
    lines.push(`y=${rowY}: ${symbols}`);
  }
  return lines;
}

function collisionGridPromptSymbol(cell, player) {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return "?";
  const x = Number(cell.x);
  const y = Number(cell.y);
  if (Number.isFinite(player.x) && Number.isFinite(player.y) && x === player.x && y === player.y) return "@";
  const terrain = String(cell.terrain || "").toLowerCase();
  if (cell.passable == null) return "?";
  if (/tall grass/.test(terrain)) return "G";
  if (/water|whirlpool|waterfall|dive/.test(terrain)) return "W";
  if (/headbutt tree/.test(terrain)) return "H";
  if (/cuttable tree/.test(terrain)) return "C";
  if (/boulder|breakable rock/.test(terrain)) return "B";
  if (/door|warp|ladder|stairs|entrance|escalator|hole/.test(terrain)) return "D";
  if (cell.passable === false) return "#";
  return ".";
}

function playerSafePathfindingDisabledReason(reason) {
  const text = String(reason || "").toLowerCase();
  if (!text) return "current navigation data is not available";
  if (/screenshot|fresh|cache/.test(text)) return "current screenshot is not fresh";
  if (/coordinate|position|facing|map_id|map identity|map_identity|live_position|confidence=/.test(text)) {
    return "current position is not available";
  }
  if (/grid|collision|minimap|pathfinding|geometry/.test(text)) {
    return "current collision grid is not available";
  }
  return "current navigation data is not available";
}

function compactVisibilityLines(gameDataJson, exposure) {
  if (!shouldExposeDecodedField(exposure, "visibility")) {
    return ["Visibility: not shown in this observation."];
  }
  const visibility = sanitizeVisibilityForModel(gameDataJson);
  return [
    `Visibility: reduced=${visibility.reduced === true} state=${visibility.state || "unknown"} window=${visibility.window || "unknown"} flash_needed=${visibility.flash_needed === true} defog_needed=${visibility.defog_needed === true}.`,
  ];
}

function compactFieldMoveAffordanceLines(gameDataJson, exposure) {
  if (!shouldExposeDecodedField(exposure, "fieldMoveAffordances") || !shouldExposeDecodedNavigation(exposure)) {
    return ["field_move_affordances: not shown in this observation."];
  }
  const data = gameDataJson?.field_move_affordances && typeof gameDataJson.field_move_affordances === "object"
    ? gameDataJson.field_move_affordances
    : gameDataJson?.ram_assisted?.field_move_affordances && typeof gameDataJson.ram_assisted.field_move_affordances === "object"
      ? gameDataJson.ram_assisted.field_move_affordances
      : {};
  const entries = Array.isArray(data.affordances) ? data.affordances : [];
  const coordinateFrame = playerCoordinateFrame(gameDataJson);
  const target = coordinatePointForSurface(data.target || {}, coordinateFrame);
  if (entries.length === 0) {
    return [
      `<field_move_affordances count="0" facing="${escapeXml(data.facing || "unknown")}" target_x="${escapeXml(
        target.x ?? ""
      )}" target_y="${escapeXml(target.y ?? "")}" />`,
    ];
  }
  const lines = [
    `<field_move_affordances count="${entries.length}" facing="${escapeXml(
      data.facing || "unknown"
    )}" target_x="${escapeXml(target.x ?? "")}" target_y="${escapeXml(target.y ?? "")}">`,
  ];
  for (const entry of entries.slice(0, 4)) {
    const rendered = coordinatePointForSurface(entry, coordinateFrame);
    lines.push(
      `  <affordance move="${escapeXml(entry?.move || "")}" target="${escapeXml(
        entry?.target || ""
      )}" x="${escapeXml(rendered.x ?? "")}" y="${escapeXml(rendered.y ?? "")}" required_facing="${escapeXml(
        entry?.requiredFacing || data.facing || "unknown"
      )}" />`
    );
  }
  lines.push("</field_move_affordances>");
  return lines;
}

function compactCurrentConnectionLines(gameDataJson, exposure) {
  if (!shouldExposeDecodedField(exposure, "currentConnections") || !shouldExposeDecodedNavigation(exposure)) {
    return ["current_connections: not shown in this observation."];
  }
  const data = gameDataJson?.current_connections && typeof gameDataJson.current_connections === "object"
    ? gameDataJson.current_connections
    : gameDataJson?.ram_assisted?.current_connections && typeof gameDataJson.ram_assisted.current_connections === "object"
      ? gameDataJson.ram_assisted.current_connections
      : {};
  const connections = Array.isArray(data.connections) ? data.connections : [];
  if (connections.length === 0) {
    return [
      '<current_connections count="0" />',
    ];
  }
  const lines = [
    "<current_connections>",
  ];
  for (const entry of connections.slice(0, 8)) {
    lines.push(
      `  <connection direction="${escapeXml(
        entry?.direction || ""
      )}" destination="not_shown" />`
    );
  }
  lines.push("</current_connections>");
  return lines;
}

function compactRuntimeObjectLines(gameDataJson, exposure) {
  const surface = validatedRuntimeObjectSurface(gameDataJson, exposure);
  const exposeDecoded = exposeAllDecodedRamForModel(exposure);
  if (surface.validated !== true && !exposeDecoded) {
    return ["Runtime objects/NPCs: not shown in this observation."];
  }
  const entries = surface.validated === true ? surface.entries : decodedRuntimeObjectsForModel(gameDataJson);
  const lines = [`Visible runtime objects/NPCs (${entries.length}):`];
  for (const npc of entries.slice(0, 8)) {
    const name = safeRuntimeObjectLabel(npc);
    const blocking = npc.isBlocking === true || npc.blocking === true;
    const interactable = npc.isInteractableCandidate === true || npc.interactable === true;
    const requiredFacing = npc.requiredFacing ? ` required_facing=${npc.requiredFacing}` : "";
    const inFront = npc.inFrontOfPlayer === true ? " in_front" : "";
    lines.push(`- ${name} x=${npc.x ?? "?"} y=${npc.y ?? "?"} facing=${npc.facing || "?"}${blocking ? " blocking" : ""}${interactable ? " interactable" : ""}${requiredFacing}${inFront}`);
  }
  if (entries.length === 0) lines.push("- none visible/decoded");
  return lines;
}

function compactWarpLines(gameDataJson, exposure) {
  if (!shouldExposeDecodedField(exposure, "warps") || !shouldExposeDecodedNavigation(exposure)) {
    return ["Visible entrances/warps: not shown in this observation."];
  }
  const warps = Array.isArray(gameDataJson?.visible_warps)
    ? gameDataJson.visible_warps
    : Array.isArray(gameDataJson?.ram_assisted?.warps?.visible)
      ? gameDataJson.ram_assisted.warps.visible
      : [];
  const lines = [`Visible entrances/warps (${warps.length}):`];
  const coordinateFrame = playerCoordinateFrame(gameDataJson);
  for (const warp of warps.slice(0, 6)) {
    lines.push(`- ${compactCoordinatePointText(warp, coordinateFrame)} entrance visible; destination not shown`);
  }
  if (warps.length === 0) lines.push("- none visible/decoded");
  return lines;
}

function compactVisibleInteractableLines(gameDataJson, exposure) {
  if (!shouldExposeDecodedField(exposure, "interactables") || !shouldExposeDecodedNavigation(exposure)) {
    return ["Visible interactables/check targets: not shown in this observation."];
  }
  const surface = validatedVisibleInteractableSurface(gameDataJson, exposure);
  if (surface.validated !== true && !exposeAllDecodedRamForModel(exposure)) {
    return ["Visible interactables/check targets: not shown in this observation."];
  }
  const coordinateFrame = playerCoordinateFrame(gameDataJson);
  const decodedSurface = surface.validated === true ? surface : decodedVisibleInteractablesForModel(gameDataJson);
  const entries = Array.isArray(decodedSurface.entries) ? decodedSurface.entries : [];
  const lines = [`Visible interactables/check targets (${entries.length}):`];
  const current = decodedSurface.current;
  if (current) {
    lines.push(`- current facing target: ${current.kind || "check"} ${compactCoordinatePointText(current, coordinateFrame)}`);
  }
  for (const entry of entries.slice(0, 8)) {
    const facing = entry.requiredFacing && entry.requiredFacing !== "unknown" ? ` required_facing=${entry.requiredFacing}` : "";
    const currentMark = entry.inFrontOfPlayer === true ? " in_front=true" : "";
    const useFrom = Array.isArray(entry.useFrom) && entry.useFrom.length > 0
      ? ` use_from=${entry.useFrom
          .slice(0, 2)
          .map((tile) => `${compactCoordinatePointText(tile, coordinateFrame)} facing=${tile.requiredFacing || "unknown"}`)
          .join(";")}`
      : "";
    lines.push(`- ${entry.kind || "check"} ${compactCoordinatePointText(entry, coordinateFrame)} distance=${entry.distance ?? "?"}${facing}${currentMark}${useFrom}`);
  }
  if (entries.length === 0) lines.push("- none visible/decoded");
  return lines;
}

function compactProgressLines(gameDataJson, exposure) {
  const lines = [];
  const trainer = gameDataJson?.current_trainer_data || {};
  if (shouldExposeDecodedField(exposure, "money") && trainer.money != null) lines.push(`Money: ${trainer.money}.`);
  if (shouldExposeDecodedField(exposure, "badges") && trainer.badge_count != null) lines.push(`Badges: ${trainer.badge_count}/${trainer.badge_total || 16}.`);
  if (shouldExposeDecodedField(exposure, "progress") && hasDecodedObject(gameDataJson?.progress_flags)) {
    const safeProgress = modelVisibleProgressFlagsSurface(gameDataJson.progress_flags);
    const named = Object.entries(safeProgress)
      .filter(([, value]) => typeof value === "boolean")
      .map(([key, value]) => `${key}=${value}`);
    if (safeProgress.safari_zone_active === true && Number.isInteger(safeProgress.safari_zone_balls_remaining)) {
      named.push(`safari_zone_balls_remaining=${safeProgress.safari_zone_balls_remaining}`);
    }
    if (safeProgress.safari_zone_active === true && safeProgress.safari_zone_has_step_limit === false) {
      named.push("safari_zone_steps_remaining=none");
    }
    if (named.length > 0) lines.push(`Progress flags: ${named.join(", ")}.`);
  }
  return lines;
}

function buildSimplePlayerPrompt() {
  const baseUrl = `http://127.0.0.1:${config.wsPort}`;
  return [
    "You are GPT playing Pokemon HeartGold autonomously from the current DS screenshot, decoded current game state, memory, objectives, recent player reasoning, and the execute_action schema.",
    `For Codex Desktop self-running play on Windows, the local HTTP endpoints are the official game interface: GET ${baseUrl}/codexDesktop/observation for the first observation, then POST ${baseUrl}/codexDesktop/action?include_next_observation=1 after each decision and continue from the returned next_observation. If Codex Desktop exposes PowerShell/Invoke-RestMethod as the transport mechanism, use it only for these local endpoint calls. Treat those calls as I/O only, not as extra gameplay knowledge.`,
    "Every normal turn should inspect the current official screenshot. You may view/open exactly the image path returned in model_input.image.path as the official current screenshot for that turn. Do not open any other image or file.",
    "Your job is to play the game from the current screenshot and decoded RAM observation, then decide your next inputs autonomously.",
    "step_details, chat_message, and avatar_emotion are player-authored continuity/commentary fields. They are optional for schema validity, but when you use them, choose your own wording and amount of detail from the current situation.",
    "PowerShell/Invoke-RestMethod is allowed only as Windows transport for the official local /codexDesktop endpoints. Do not use PowerShell, shell, rg/grep, file reads, or local search tools to gather gameplay information.",
    "Do not inspect files, RAM dumps, emulator internals, repository code, runtime JSON, or monitor-only artifacts for gameplay decisions.",
    "Older self-authored reasoning may be available through the reasoning archive; recalled entries are your own prior player history, not route hints.",
    "Do not decide from truncated PowerShell output. Inspect only model_input.image, model_input.user_input_text, model_input.decoded_ram, recent reasoning/history, memory/objectives, and the action schema.",
    "After POSTing an action with include_next_observation=1, inspect the returned next_observation screenshot before the next decision. If next_observation is missing, GET the next observation separately. Use a 90s POST timeout. If a GET observation times out, retry GET once. If a POST action times out, do not repeat the same input first; GET a fresh observation to see whether the input already happened.",
    "Transport silence: Do not narrate routine observation/action transport in the Codex conversation. Endpoint calls are only I/O; speak there only for meaningful gameplay expression, a decision you want to record, or an interface failure.",
    "Observation refresh is interface I/O, not an in-game objective. Mention it only when input is unavailable or stale enough that no safe gameplay action can be chosen.",
    "In ram_assisted mode, decoded current RAM gameplay state shown in model_input.user_input_text and model_input.decoded_ram is part of your game observation. Use the current decoded state together with the screenshot.",
    "Do not use a_until_end_of_dialog just because text is missing. Use it only when the official image/text clearly shows already-read low-information dialogue; if the official image cannot be viewed, stop and report an observation failure.",
    "Return exactly one execute_action arguments JSON object with an actions array. step_details, chat_message, and avatar_emotion may be included for meaningful gameplay expression using your own wording and amount of detail; routine endpoint transport needs no narration.",
    "On the Pokemon HeartGold title screen or a visible 'Touch to Start' prompt, press Start first with key_press keys:[\"start\"]. Do not assume touch is required there.",
    "Use DS buttons for dialogue/menus unless a lower touch-screen target is clearly faster. Touch coordinates are bottom-local 256x192 by default: x=0..255 and y=0..191, where y=0 is the top edge of the bottom screen. If you pick from the attached scaled image instead, use coordinate_space=\"model_scaled\", screen=\"full\", and source_width/source_height from model_input.image.",
  ].join("\n");
}

function buildSimplePlayerObservation(gameDataJson, imageContract, exposure) {
  const lines = [
    `Step ${state.counters.currentStep}. Mode: ${exposure.mode || "ram_assisted"}.`,
    `Current image: ${imageContract?.width || "?"}x${imageContract?.height || "?"}, scale ${imageContract?.scale || "?"}.`,
    "Nintendo DS layout: top screen is above; bottom screen is touch-capable. The persistent MENU/CHECK lower panel is standby UI, not an opened menu by itself.",
  ];
  const imageContractText = formatImageContract(imageContract);
  if (imageContractText) lines.unshift(imageContractText);

  const screenPhase = compactScreenPhase(gameDataJson, exposure);
  lines.push(`Current RAM screen: ${screenPhase.phase}. Use the screenshot for visible text, menus, and prompts.`);

  const visibleText = formatCurrentVisibleTextForPlayer(gameDataJson, exposure);
  if (visibleText) lines.push(visibleText);

  lines.push(...compactNavigationLines(gameDataJson, exposure));
  lines.push(...compactMenuLines(gameDataJson, exposure));
  lines.push(...compactNamingLines(gameDataJson, exposure));
  lines.push(...compactBattleLines(gameDataJson, exposure));
  lines.push(...compactPartyLines(gameDataJson, exposure));
  lines.push(...compactInventoryLines(gameDataJson, exposure));
  lines.push(...compactPcStorageLines(gameDataJson, exposure));
  lines.push(...compactProgressLines(gameDataJson, exposure));
  lines.push(...compactRuntimeObjectLines(gameDataJson, exposure));
  lines.push(...compactWarpLines(gameDataJson, exposure));
  lines.push(...compactVisibleInteractableLines(gameDataJson, exposure));

  const objectives = compactObjectives();
  if (objectives.length > 0) {
    lines.push("Objectives:");
    for (const [slot, text] of objectives) lines.push(`- ${slot}: ${text}`);
  }

  const memoryEntries = compactStateObject(state.memory, 8);
  if (memoryEntries.length > 0) {
    lines.push("Memory:");
    for (const entry of memoryEntries) lines.push(`- ${entry.key}: ${entry.value}`);
  }

  lines.push("Controls: key_press requires keys:[...] for one simultaneous press, button_sequence requires sequence:[{keys:[...]}] for ordered inputs, wait for animations, type_text on naming keyboards, touch only for clear lower-screen buttons. On title/'Touch to Start', use key_press keys:[\"start\"] first. Bottom touch coordinates are x=0..255,y=0..191.");
  return sanitizeCurrentPromptText(lines.join("\n"));
}

function omitMonitorOnlyObservationFields(observation) {
  if (!observation || typeof observation !== "object") return observation;
  const {
    ram_audit_snapshot: _ramAuditSnapshot,
    model_visible_manifest: _modelVisibleManifest,
    model_image_artifact: _modelImageArtifact,
    observation_audit: _observationAudit,
    ...playerSafeObservation
  } = observation;
  if (playerSafeObservation.model_surface_summary) {
    playerSafeObservation.model_surface_summary = modelSurfaceSummaryForPlayer(playerSafeObservation.model_surface_summary);
  }
  return playerSafeObservation;
}

function modelSurfaceSummaryForPlayer(summary) {
  if (!summary || typeof summary !== "object") return summary;
  const rawLane = summary.surface_lane || summary.benchmark_lane;
  const surfaceLane =
    rawLane === "primary_visual" || rawLane === "visual"
      ? "visual"
      : rawLane === "ram_assisted"
        ? "ram_assisted"
        : summary.observation_mode || "monitor";
  const playerSummary = {
    observation_mode: summary.observation_mode,
    surface_lane: surfaceLane,
    path_to_location_available: summary.path_to_location_available,
  };
  if (summary.monitor_only === true || summary.monitor_only === true) {
    playerSummary.monitor_only = true;
    playerSummary.configured_observation_mode = summary.configured_observation_mode;
    playerSummary.bridge_observation_mode = summary.bridge_observation_mode;
    playerSummary.degraded_visual_fallback = summary.degraded_visual_fallback;
  }
  return playerSummary;
}

async function buildCodexDesktopObservation({ includeDiagnostics = false, anchor = true } = {}) {
  const observationId = `${Date.now()}_step_${state.counters.currentStep}`;
  const anchorState =
    includeDiagnostics !== true && anchor !== false ? await prepareObservationAnchorState(observationId) : null;
  let gameDataJson = await fetchGameData(anchorState?.enabled === true ? { anchorStatePath: anchorState.path } : {});
  let degradedVisualFallback = false;
  if (!gameDataJson && config.codexDesktop.allowDegradedVisualFallback === true) {
    const bridgeHealth = await fetchBridgeHealth();
    gameDataJson = buildDegradedVisualGameData(bridgeHealth);
    degradedVisualFallback = Boolean(gameDataJson);
  }
  if (!gameDataJson) {
    throw new Error("Python bridge did not return game data");
  }
  if (anchorState?.enabled === true && !degradedVisualFallback && gameDataJson?.emulator?.anchorSaved !== true) {
    throw new Error(
      `Codex Desktop observation anchor save failed: ${gameDataJson?.emulator?.anchorError || "bridge did not confirm anchor save"}`
    );
  }

  const exposure = buildObservationExposure(gameDataJson);
  const modeMismatch = observationModeMismatch(gameDataJson);
  const requiresFreshModelObservation =
    includeDiagnostics !== true && config.isHeartGold && ["visual", "ram_assisted"].includes(exposure.mode);
  const freshnessFailure =
    requiresFreshModelObservation && !degradedVisualFallback ? screenshotFreshnessFailure(gameDataJson) : null;
  if (freshnessFailure) {
    const message = `Codex Desktop observation rejected: current screenshot is not fresh (${freshnessFailure}).`;
    recordHarnessFailure("stale_observation_model_input", message, { freshnessFailure });
    throw new Error(message);
  }

  const modelImage = await prepareModelImagePath(gameDataJson, {
    observationId,
    allowStaleSource: degradedVisualFallback,
  });
  const imageFreshnessFailure =
    requiresFreshModelObservation && (!modelImage?.screenshotHash || !modelImage?.cacheKey)
      ? "prepared_model_image_missing_hash_or_cache_key"
      : null;
  if (imageFreshnessFailure) {
    const message = `Codex Desktop observation rejected: prepared model image is not cacheable (${imageFreshnessFailure}).`;
    recordHarnessFailure("stale_observation_model_input", message, { freshnessFailure: imageFreshnessFailure });
    throw new Error(message);
  }
  const requiresPreparedModelImage =
    config.isHeartGold && ["visual", "ram_assisted"].includes(exposure.mode);
  if (requiresPreparedModelImage && !modelImage?.path) {
    throw new Error(`Codex Desktop observation requires a fresh prepared model image: ${modelImage?.error || "unknown error"}`);
  }

  state.gameDataJsonRef = gameDataJson;
  const progressUpdated = updateProgressSteps(gameDataJson);
  recordObservation(gameDataJson, {
    step: state.counters.currentStep,
    progressSteps: state.progressSteps,
  });

  const requestedSpeedMode = String(process.env.HEARTGOLD_SPEED_MODE || "100");
  const allowFastForward = ["1", "true", "yes", "on"].includes(String(process.env.HEARTGOLD_ALLOW_FAST_FORWARD || "").toLowerCase());
  const configMode = normalizeObservationMode(config.observation.mode);
  const requestedMode = normalizeObservationMode(config.observation.requestedMode);
  const benchmarkComparable =
    includeDiagnostics !== true &&
    ["visual", "ram_assisted"].includes(exposure.mode) &&
    ["visual", "ram_assisted"].includes(configMode) &&
    ["visual", "ram_assisted"].includes(requestedMode) &&
    config.observation.modeWasInvalid === false &&
    !modeMismatch &&
    !exposure.exposeOracle &&
    Number(modelImage?.scale || config.observation.modelImageScale) === Number(config.observation.modelImageScale) &&
    requestedSpeedMode === "100" &&
    !allowFastForward;

  const imageContract = includeDiagnostics ? null : buildImageContract(modelImage, observationId);
  const imageContractText = formatImageContract(imageContract);
  let userInputText = includeDiagnostics
    ? ""
    : buildSimplePlayerObservation(gameDataJson, imageContract, exposure);
  if (!includeDiagnostics && degradedVisualFallback) {
    userInputText =
      `Bridge note: structured RAM/game-state data is temporarily unavailable for this turn, so this observation is running in visual-only degraded mode. The screenshot may be the last captured bridge frame rather than a fresh RAM-synced frame. Decide from the visible screenshot first and use conservative visible-screen inputs until structured observation returns.\n` +
      userInputText;
  }
  const decodedRam = includeDiagnostics ? null : buildModelDecodedRam(gameDataJson, exposure);
  const modelVisibleManifest = includeDiagnostics
    ? null
    : buildModelVisibleManifest(gameDataJson, exposure, imageContract, userInputText, modelImage, decodedRam);
  const recentHistory = includeDiagnostics
    ? []
    : sanitizeRecentHistoryForDesktop(processHistoryForAPI(state.history).slice(-12), exposure);
  const recentPlayerReasoning = includeDiagnostics
    ? []
    : sanitizeRecentPlayerReasoningForDesktop(state.playerReasoning?.recent || [], exposure);
  const actionFormat = includeDiagnostics ? undefined : compactActionFormat();
  const observation = {
    schema: "heartgold_codex_desktop_observation_artifact_v1",
    artifact_source: "codex_desktop_service",
    artifact_kind: "observation",
    artifact_provenance: {
      producer: "server/src/services/codexDesktopService.js",
      route: "/codexDesktop/observation",
      player_response_omits_monitor_only_artifacts: true,
    },
    ok: true,
    provider: "codex-desktop",
    model: config.codexDesktop.model,
    reasoning_effort: config.codexDesktop.reasoningEffort,
    step: state.counters.currentStep,
    contract: {
      use_only_model_input_for_gameplay: true,
      official_transport: {
        observation: `http://127.0.0.1:${config.wsPort}/codexDesktop/observation`,
        action: `http://127.0.0.1:${config.wsPort}/codexDesktop/action`,
        optional_action_with_next_observation: `http://127.0.0.1:${config.wsPort}/codexDesktop/action?include_next_observation=1`,
        local_http_transport_is_allowed: true,
        gameplay_decisions_must_use_only_model_input: true,
      },
      do_not_read_repo_or_runtime_files_for_game_state: true,
      do_not_run_shell_or_rg_for_gameplay: true,
      submit_decision_to: "/codexDesktop/action",
      action_shape: "execute_action arguments JSON",
      action_format: actionFormat,
    },
    action_format: actionFormat,
    model_input:
      includeDiagnostics === true
        ? undefined
        : {
            image: modelVisibleImageMetadata(modelImage),
            image_contract: modelVisibleImageContract(imageContract),
            operator_prompt: buildSimplePlayerPrompt(),
            user_input_text: userInputText,
            decoded_ram: decodedRam,
            recent_history: recentHistory,
            recent_player_reasoning: recentPlayerReasoning,
            action_format: actionFormat,
            tool_schema: compactToolSchema(exposure, gameDataJson),
          },
    model_surface_summary: {
      observation_mode: exposure.mode,
      surface_lane: includeDiagnostics
        ? "monitor"
        : exposure.mode === "visual"
          ? "visual"
          : exposure.mode === "ram_assisted"
            ? "ram_assisted"
            : "monitor",
      run_comparable: includeDiagnostics
        ? false
        : benchmarkComparable && !degradedVisualFallback,
      monitor_only: includeDiagnostics === true,
      anchor_for_next_action:
        includeDiagnostics !== true && anchor !== false && config.codexDesktop.restoreObservationAnchor === true,
      navigation_available: shouldExposeDecodedNavigation(exposure),
      path_to_location_available:
        shouldExposeDecodedNavigation(exposure) === true && gameDataJson?.ram_assisted?.pathfinding?.available === true,
      mode_mismatch: modeMismatch,
      configured_observation_mode: config.observation.mode,
      bridge_observation_mode: gameDataJson?.observationPolicy?.mode || gameDataJson?.game?.observationMode || null,
      model_image_scale: Number(modelImage?.scale || config.observation.modelImageScale) || null,
      observation_anchor_restore: includeDiagnostics !== true && anchor !== false && anchorState?.enabled === true,
      degraded_visual_fallback: degradedVisualFallback,
    },
    harness_diagnostics: includeDiagnostics
      ? {
          bridge_request_ok: gameDataJson.bridgeRequestOk !== false,
          bridge_error: gameDataJson.bridgeError || null,
          observation_unavailable: gameDataJson.observationUnavailable === true,
          observation_freshness: gameDataJson.observationFreshness || null,
          state_reliability: gameDataJson.stateReliabilityDetails || null,
          model_image: modelImage || null,
          note: "Human-only monitor data. This response intentionally omits model_input and must not be used for gameplay decisions.",
        }
      : undefined,
  };

  if (includeDiagnostics !== true) {
    const observationAudit = auditObservationArtifact({
      model_input: observation.model_input,
      model_visible_manifest: modelVisibleManifest,
    });
    if (observationAudit.result !== "pass") {
      recordHarnessFailure("codex_desktop_observation_artifact_audit_failed", "Codex Desktop observation artifact audit failed.", {
        failures: observationAudit.failures,
      });
    }
  }
  const artifactPath = await writeArtifact("observation", observation);
  if (includeDiagnostics !== true && anchor !== false) {
    lastCodexDesktopObservation = {
      artifactPath,
      step: state.counters.currentStep,
      modelImage,
      screenshotHash: modelImage?.screenshotHash || gameDataJson?.observationFreshness?.screenshotHash || null,
      cacheKey: gameplayScreenshotCacheKey(gameDataJson),
      modelImageCacheKey: modelImage?.cacheKey || null,
      stateSignature: gameplayStateSignature(gameDataJson),
      nonTextStateSignature: gameplayStateSignature(gameDataJson, { includeVisibleText: false }),
      visibleTextSnapshot: visibleTextSnapshot(gameDataJson),
      at: new Date().toISOString(),
      monitorOnly: false,
      degradedVisualFallback,
      anchorStatePath: anchorState?.path || null,
      anchorStateSaved: anchorState?.enabled === true,
      anchorStateSignature: gameplayStateSignature(gameDataJson),
      gameDataJson,
    };
    recordModelObservation({
      provider: "codex-desktop",
      model: config.codexDesktop.model,
      reasoningEffort: config.codexDesktop.reasoningEffort,
      step: state.counters.currentStep,
      imagePath: modelImage?.path || null,
      modelImage,
      observationArtifactPath: artifactPath,
    });
  }
  if (progressUpdated) await savePersistentState();
  return {
    ...omitMonitorOnlyObservationFields(observation),
    artifact_ref: artifactRef(artifactPath, "observation"),
  };
}

function stripDesktopNormalization(value) {
  if (Array.isArray(value)) return value.map(stripDesktopNormalization);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "_codex_desktop_normalization") continue;
    out[key] = stripDesktopNormalization(item);
  }
  return out;
}

function stripPlayerVisibleNarration(value) {
  if (Array.isArray(value)) return value.map(stripPlayerVisibleNarration);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (["step_details", "chat_message", "avatar_emotion", "explanation"].includes(key)) continue;
    out[key] = stripPlayerVisibleNarration(child);
  }
  return out;
}

function removeHistoricalImages(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !(item && typeof item === "object" && item.type === "input_image"))
      .map(removeHistoricalImages);
  }
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (["image", "image_url", "modelImage"].includes(key)) continue;
    if (key === "model_input" && item && typeof item === "object") {
      const nested = removeHistoricalImages(item);
      if (nested && typeof nested === "object") {
        delete nested.image;
      }
      out[key] = nested;
      continue;
    }
    out[key] = removeHistoricalImages(item);
  }
  return out;
}

function redactNavigationFromHistoricalText(text) {
  return redactHistoricalNavigationTraceText(String(text || ""))
    .replace(/<player_location\b[^>]*\/>/gi, '<player_location current_observation="not_shown">historical navigation redacted</player_location>')
    .replace(/\b(map_id|map_name|x|y|z|facing)\s*=\s*"[^"]*"/gi, '$1="[redacted historical navigation]"')
    .replace(/\b(map_id|x|y|z)\s*=\s*-?\d+\b/gi, "$1=[redacted historical navigation]")
    .replace(/"(map_id|map_name|x|y|z|facing)"\s*:\s*"?[^",}\]]+"?/gi, '"$1":"redacted_historical_navigation"');
}

function redactNavigationFromFunctionArguments(argsString) {
  try {
    const parsed = JSON.parse(String(argsString || "{}"));
    let hasCoordinateNavigationAction = false;
    if (Array.isArray(parsed.actions)) {
      parsed.actions = parsed.actions.map((action) => {
        if (!action || typeof action !== "object") return action;
        const actionType = String(action.type || "");
        if (["path_to_location", "add_marker", "delete_marker"].includes(actionType)) {
          hasCoordinateNavigationAction = true;
        }
        const out = { ...action };
        for (const key of ["map_id", "map_name", "x", "y", "z", "target_x", "target_y"]) {
          if (key in out) {
            hasCoordinateNavigationAction = true;
            out[key] = "redacted_historical_navigation";
          }
        }
        if (typeof out.explanation === "string") out.explanation = redactNavigationFromHistoricalText(out.explanation);
        if (typeof out.label === "string") out.label = redactNavigationFromHistoricalText(out.label);
        return out;
      });
    }
    if (hasCoordinateNavigationAction) {
      if (typeof parsed.step_details === "string") {
        parsed.step_details = "[historical navigation action rationale redacted until the current observation]";
      }
      if (typeof parsed.chat_message === "string") {
        parsed.chat_message = "[historical navigation action message redacted until the current observation]";
      }
    } else {
      if (typeof parsed.step_details === "string") parsed.step_details = redactNavigationFromHistoricalText(parsed.step_details);
      if (typeof parsed.chat_message === "string") parsed.chat_message = redactNavigationFromHistoricalText(parsed.chat_message);
    }
    return JSON.stringify(parsed);
  } catch {
    return redactNavigationFromHistoricalText(argsString);
  }
}

function redactNavigationFromHistoryEntry(value, navigationValidated) {
  if (typeof value === "string") {
    const sanitized = sanitizeModelText(value);
    return navigationValidated === true ? sanitized : redactNavigationFromHistoricalText(sanitized);
  }
  if (Array.isArray(value)) return value.map((item) => redactNavigationFromHistoryEntry(item, navigationValidated));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (navigationValidated !== true && key === "arguments" && typeof item === "string" && value.type === "function_call") {
      out[key] = redactNavigationFromFunctionArguments(item);
    } else {
      out[key] = redactNavigationFromHistoryEntry(item, navigationValidated);
    }
  }
  return out;
}

function sanitizeRecentHistoryForDesktop(history, exposure = null) {
  if (!Array.isArray(history)) return [];
  const navigationAvailable = shouldExposeDecodedNavigation(exposure);
  return history.map((entry) => {
    if (entry?.role === "assistant" || entry?.role === "user") {
      return null;
    }
    let cloned = removeHistoricalImages(JSON.parse(JSON.stringify(entry)));
    if (cloned?.type === "function_call" && typeof cloned.arguments === "string") {
      try {
        const args = stripPlayerVisibleNarration(stripDesktopNormalization(JSON.parse(cloned.arguments)));
        cloned.arguments = JSON.stringify(args);
      } catch {
        cloned.arguments = cloned.arguments.replace(/,\s*"_codex_desktop_normalization"\s*:\s*\{[^}]*\}/g, "");
      }
    }
    cloned = stripDesktopNormalization(cloned);
    cloned = sanitizeModelValue(cloned);
    return redactNavigationFromHistoryEntry(cloned, navigationAvailable);
  }).filter(Boolean);
}

function sanitizeRecentPlayerReasoningForDesktop(records, exposure = null) {
  if (!Array.isArray(records)) return [];
  const navigationValidated = exposure?.navigation?.validated === true;
  return records.map((record) => redactNavigationFromHistoryEntry(sanitizeModelValue(record), navigationValidated));
}

function normalizeDesktopActionPayload(body) {
  const payload = body && typeof body === "object" ? body : {};
  if (payload.name === "execute_action" && typeof payload.arguments === "string") {
    return normalizeDesktopActionAliases(JSON.parse(payload.arguments), null);
  }
  if (payload.execute_action && typeof payload.execute_action === "object") {
    return normalizeDesktopActionAliases(payload.execute_action, null);
  }
  if (typeof payload.type === "string" && !Array.isArray(payload.actions)) {
    throw new Error(
      "Codex Desktop bare single-action shorthand is not accepted. Return one execute_action arguments object with an actions array."
    );
  }
  return normalizeDesktopActionAliases(payload, null);
}

function normalizeDesktopActionAlias(action) {
  if (!action || typeof action !== "object") return action;
  const type = String(action.type || "").trim().toLowerCase();
  if (type === "press" || type === "button_press" || type === "hold") {
    const keys = Array.isArray(action.keys)
      ? action.keys
      : Array.isArray(action.buttons)
        ? action.buttons
        : typeof action.key === "string"
          ? [action.key]
          : typeof action.button === "string"
            ? [action.button]
            : [];
    const out = { ...action, type: "key_press", keys };
    delete out.buttons;
    delete out.key;
    delete out.button;
    return out;
  }
  if (type === "button_sequence" && Array.isArray(action.sequence)) return action;
  if (type === "sequence") {
    if (Array.isArray(action.sequence)) return { ...action, type: "button_sequence" };
    if (Array.isArray(action.buttons)) {
      return {
        ...action,
        type: "button_sequence",
        sequence: action.buttons.map((button) => ({ keys: [button], frames: action.frames || 8 })),
      };
    }
  }
  return action;
}

function normalizeDesktopActionAliases(args, existingNormalization) {
  if (!args || typeof args !== "object" || !Array.isArray(args.actions)) {
    return { args, normalization: existingNormalization };
  }
  let changed = false;
  const actions = args.actions.map((action) => {
    const normalized = normalizeDesktopActionAlias(action);
    if (normalized !== action || normalized?.type !== action?.type || normalized?.keys !== action?.keys) {
      changed = true;
    }
    return normalized;
  });
  if (!changed) return { args, normalization: existingNormalization };
  return {
    args: { ...args, actions },
    normalization: {
      ...(existingNormalization || {}),
      applied: true,
      reason: existingNormalization?.reason || "desktop_action_aliases",
      actionCount: actions.length,
    },
  };
}

function validateDesktopExecuteActionEnvelope(args, normalization) {
  if (normalization?.applied === true) {
    throw new Error(
      "Codex Desktop action shorthand normalization is not accepted. Return the canonical execute_action schema without aliases."
    );
  }
  if (!Array.isArray(args?.actions) || args.actions.length === 0) {
    throw new Error(
      "Codex Desktop execute_action schema violation: missing required top-level field: actions. Return one execute_action arguments object with an actions array."
    );
  }
  args.actions.forEach((action, index) => {
    const type = typeof action?.type === "string" ? action.type : "";
    if (!type) {
      throw new Error(`Codex Desktop execute_action schema violation: action ${index + 1} is missing required field: type.`);
    }
    if (type === "key_press") {
      if (!Array.isArray(action.keys) || action.keys.length === 0) {
        throw new Error(
          `Codex Desktop execute_action schema violation: action ${index + 1} key_press must use keys:[...] with at least one button. Do not use a singular key field.`
        );
      }
    }
    if (type === "button_sequence") {
      if (!Array.isArray(action.sequence) || action.sequence.length === 0) {
        throw new Error(
          `Codex Desktop execute_action schema violation: action ${index + 1} button_sequence must use a non-empty sequence:[{keys:[...]}].`
        );
      }
    }
  });
}

function xmlUnescape(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function toolResultText(toolResult) {
  const output = toolResult?.output;
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output
    .map((item) => {
      if (typeof item === "string") return item;
      if (item?.type === "input_text" && typeof item.text === "string") return item.text;
      if (typeof item?.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function simplifyActionResultForPlayer(text) {
  const original = String(text || "");
  const playerNextStep = "Use the next observation screenshot and visible game state to decide what happened.";
  const simplified = original.replace(
    /<action_result\b[^>]*\btype="([^"]*)"[^>]*>[\s\S]*?<\/action_result>/gi,
    (block, actionType) => {
      const safeType = sanitizeModelText(actionType || "action");
      return `<action_result type="${safeType}"><next_step>${playerNextStep}</next_step></action_result>`;
    }
  );
  if (simplified !== original || !/<action_result\b/i.test(simplified)) return simplified;
  const actionType = simplified.match(/<action_result\b[^>]*\btype="([^"]*)"/i)?.[1] || "action";
  const messageMatch = simplified.match(/<message>([\s\S]*?)(?:<\/message>|$)/i);
  const safeType = sanitizeModelText(actionType);
  const safeMessage = sanitizeModelText(xmlUnescape(messageMatch?.[1] || ""));
  const message = safeMessage ? `<message>${safeMessage}</message>` : "";
  return `<action_result type="${safeType}">${message}<next_step>${playerNextStep}</next_step></action_result>`;
}

function sanitizeToolResultForDesktop(toolResult) {
  if (!toolResult || typeof toolResult !== "object") return toolResult;
  const cloned = sanitizeModelValue(JSON.parse(JSON.stringify(toolResult)));
  if (Array.isArray(cloned.output)) {
    cloned.output = cloned.output.map((item) => {
      if (typeof item === "string") return simplifyActionResultForPlayer(item);
      if (item && typeof item === "object" && typeof item.text === "string") {
        return { ...item, text: simplifyActionResultForPlayer(item.text) };
      }
      return item;
    });
  } else if (typeof cloned.output === "string") {
    cloned.output = simplifyActionResultForPlayer(cloned.output);
  }
  return cloned;
}

function analyzeToolResult(toolResult) {
  const text = toolResultText(toolResult);
  const actionMatches = Array.from(text.matchAll(/<action_result\b([^>]*)>/gi));
  const actionSemantics = actionMatches.map((match) => {
    const attrs = `${match[1] || ""}`;
    const attrValue = (name) => {
      const attrMatch = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
      return attrMatch ? xmlUnescape(attrMatch[1]) : null;
    };
    const rawSuccessAttr = attrValue("raw_success") ?? attrValue("success");
    const semanticSuccessAttr = attrValue("semantic_success");
    return {
      type: String(attrValue("type") || "").toLowerCase(),
      success: String(rawSuccessAttr).toLowerCase() === "true",
      semantic_success: String(semanticSuccessAttr).toLowerCase() === "true",
      raw_success: attrValue("raw_success"),
      input_delivered: attrValue("input_delivered"),
      visible_effect: attrValue("visible_effect"),
      semantic_target_verified: attrValue("semantic_target_verified"),
      semantic_outcome: attrValue("semantic_outcome"),
    };
  });
  if (actionMatches.length > 0) {
    const semanticSuccess = (item) => {
      const outcome = String(item.semantic_outcome || "").toLowerCase();
      return (
        item.success === true &&
        String(item.input_delivered || "").toLowerCase() === "true" &&
        (
          String(item.semantic_target_verified || "").toLowerCase() === "true" ||
          /^(completed|verified|semantic_completed|semantic_target_verified|target_verified|wait_completed|low_stall_input_delivered)$/.test(outcome)
        )
      );
    };
    const hardFailure = actionSemantics.find((item) => {
      const outcome = String(item.semantic_outcome || "").toLowerCase();
      return (
        String(item.input_delivered || "").toLowerCase() === "false" ||
        outcome === "input_not_delivered" ||
        outcome === "failed" ||
        outcome === "harness_error"
      );
    });
    const modelVisibleInputSuccess = (item) => {
      if (semanticSuccess(item)) return true;
      const type = String(item.type || "").toLowerCase();
      const inputDelivered = String(item.input_delivered || "").toLowerCase() === "true";
      const visibleEffect = String(item.visible_effect || "").toLowerCase() === "true";
      const semanticTarget = String(item.semantic_target_verified || "").toLowerCase();
      const outcome = String(item.semantic_outcome || "").toLowerCase();
      if (!inputDelivered || hardFailure === item) return false;
      if (semanticTarget === "false" && !(type === "touch" && visibleEffect)) return false;
      if (type === "touch" && semanticTarget !== "false") return true;
      if (outcome === "low_stall_input_delivered") return true;
      return (
        ["key_press", "button_sequence", "a_until_end_of_dialog", "touch"].includes(type) &&
        (visibleEffect || outcome === "visible_effect")
      );
    };
    const allBenchmarkSemanticSuccess = actionSemantics.every(semanticSuccess);
    const inputFailure = actionSemantics.find((item) => !modelVisibleInputSuccess(item));
    if (!inputFailure) {
      return {
        actionSuccess: true,
        benchmarkSemanticSuccess: allBenchmarkSemanticSuccess,
        actionResultCount: actionMatches.length,
        failureReason: null,
        actionSemantics,
      };
    }
    const failedBlock =
      text.match(/<action_result\b[^>]*\bsemantic_success="false"[^>]*>[\s\S]*?<\/action_result>/i) ||
      text.match(/<action_result\b[^>]*\bsuccess="false"[^>]*>[\s\S]*?<\/action_result>/i);
    const messageMatch = failedBlock?.[0]?.match(/<message>([\s\S]*?)<\/message>/i);
    const rawFailureReason = xmlUnescape(
      messageMatch?.[1] ||
        (hardFailure
          ? `Action input was not verified by the bridge: ${hardFailure.semantic_outcome || "unknown"}`
          : "Action result reported success=false.")
    );
    return {
      actionSuccess: false,
      benchmarkSemanticSuccess: false,
      actionResultCount: actionMatches.length,
      failureReason: sanitizeModelText(rawFailureReason),
      actionSemantics,
    };
  }
  if (/^\s*(ERROR|Error:)/im.test(text)) {
    const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || "Tool result reported an error.";
    return { actionSuccess: false, actionResultCount: 0, failureReason: sanitizeModelText(firstLine.trim()), actionSemantics: [] };
  }
  return { actionSuccess: null, actionResultCount: 0, failureReason: null, actionSemantics: [] };
}

function modelImageDimensions(observation) {
  const image = observation?.modelImage || {};
  const width = Number(image.width);
  const height = Number(image.height);
  return {
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null,
  };
}

function assertTouchRange(condition, message) {
  if (!condition) throw new Error(message);
}

function validateDesktopTouchActions(args, observation) {
  if (!config.isHeartGold) return;
  const { width, height } = modelImageDimensions(observation);
  const actions = Array.isArray(args?.actions) ? args.actions : [];
  for (const [index, action] of actions.entries()) {
    if (!action || action.type !== "touch") continue;
    const coordinateSpace = String(action.coordinate_space || "bottom").trim().toLowerCase().replace(/-/g, "_");
    const screen = String(action.screen || (coordinateSpace === "bottom" ? "bottom" : "full")).trim().toLowerCase();
    const x = Number(action.x);
    const y = Number(action.y);
    assertTouchRange(
      Number.isFinite(x) && Number.isFinite(y),
      `Codex Desktop touch action ${index} rejected: x/y must be finite numbers.`
    );
    if (coordinateSpace === "bottom" || coordinateSpace === "touch" || coordinateSpace === "bottom_screen") {
      if (screen !== "bottom") {
        throw new Error(
          `Codex Desktop touch action ${index} rejected: bottom coordinate_space must use screen="bottom". Use full_raw or model_scaled for full vertical DS screenshot coordinates.`
        );
      }
      assertTouchRange(
        x >= 0 && x <= 255 && y >= 0 && y <= 191,
        `Codex Desktop touch action ${index} rejected: bottom-screen coordinates must be within x=0..255 and y=0..191.`
      );
      continue;
    }
    if (coordinateSpace === "full_raw" || coordinateSpace === "screenshot") {
      if (screen !== "full") {
        throw new Error(
          `Codex Desktop touch action ${index} rejected: full_raw coordinate_space must use screen="full". Use bottom coordinate_space for bottom-local 256x192 coordinates.`
        );
      }
      assertTouchRange(
        x >= 0 && x <= 255 && y >= 192 && y <= 383,
        `Codex Desktop touch action ${index} rejected: full_raw touch must target the DS bottom screen within x=0..255 and y=192..383.`
      );
      continue;
    }
    const sourceWidth = Number(action.source_width);
    const sourceHeight = Number(action.source_height);
    if (coordinateSpace === "display" || coordinateSpace === "displayed") {
      throw new Error(
        `Codex Desktop touch action ${index} rejected: '${coordinateSpace}' is window-size dependent. Use bottom, full_raw, or model_scaled with the current model_input.image dimensions.`
      );
    }
    if (coordinateSpace !== "model_scaled") {
      throw new Error(`Codex Desktop touch action ${index} rejected: unsupported coordinate_space '${action.coordinate_space}'.`);
    }
    if (coordinateSpace === "model_scaled" && (!Number.isFinite(width) || !Number.isFinite(height))) {
      throw new Error(
        `Codex Desktop model_scaled touch action ${index} rejected: the current observation did not include model image dimensions.`
      );
    }
    if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) {
      throw new Error(
        coordinateSpace === "model_scaled"
          ? `Codex Desktop model_scaled touch action ${index} rejected: source_width and source_height must match the current model image (${width}x${height}).`
          : `Codex Desktop ${coordinateSpace} touch action ${index} rejected: source_width and source_height are required.`
      );
    }
    if (
      coordinateSpace === "model_scaled" &&
      (Math.round(sourceWidth) !== Math.round(width) || Math.round(sourceHeight) !== Math.round(height))
    ) {
      throw new Error(
        `Codex Desktop model_scaled touch action ${index} rejected: source dimensions ${sourceWidth}x${sourceHeight} do not match the current model image ${width}x${height}. Use the current model_input.image dimensions.`
      );
    }
    assertTouchRange(sourceWidth > 0 && sourceHeight > 0, `Codex Desktop touch action ${index} rejected: source dimensions must be positive.`);
    if (coordinateSpace === "model_scaled" && screen !== "full") {
      throw new Error(
        `Codex Desktop model_scaled touch action ${index} rejected: model_scaled coordinates must use screen="full" with model_input.image width/height.`
      );
    }
    assertTouchRange(
      x >= 0 && x < sourceWidth && y >= 0 && y < sourceHeight,
      `Codex Desktop touch action ${index} rejected: coordinates are outside the declared source image ${sourceWidth}x${sourceHeight}.`
    );
    if (screen === "full") {
      assertTouchRange(
        y >= sourceHeight / 2,
        `Codex Desktop touch action ${index} rejected: coordinates resolve to the top DS screen; touch can only target the bottom screen.`
      );
    } else if (screen !== "bottom") {
      throw new Error(`Codex Desktop touch action ${index} rejected: unsupported touch screen '${action.screen}'.`);
    }
  }
}

async function executeCodexDesktopAction(body = {}) {
  const startedAt = Date.now();
  const { args, normalization } = normalizeDesktopActionPayload(body);
  if (!Array.isArray(args.actions) || args.actions.length === 0) {
    throw new Error("Codex Desktop action must include a non-empty actions array");
  }
  if (!lastCodexDesktopObservation || lastCodexDesktopObservation.monitorOnly === true) {
    throw new Error("Codex Desktop action requires a prior gameplay observation from the same surface");
  }
  if (lastCodexDesktopObservation.step !== state.counters.currentStep) {
    throw new Error("Codex Desktop action requires a current observation for this step");
  }
  if (
    config.isHeartGold &&
    ["visual", "ram_assisted"].includes(config.observation.mode) &&
    (!lastCodexDesktopObservation.modelImage?.path || !lastCodexDesktopObservation.screenshotHash)
  ) {
    throw new Error("Codex Desktop action requires a prior observation with a prepared model image and screenshot hash");
  }
  validateDesktopExecuteActionEnvelope(args, normalization);
  args.step_details = typeof args.step_details === "string" ? args.step_details : "";
  args.chat_message = typeof args.chat_message === "string" ? args.chat_message : "";
  args.avatar_emotion = typeof args.avatar_emotion === "string" && args.avatar_emotion ? args.avatar_emotion : "thinking";
  const callId = `codex_desktop_${Date.now()}`;
  const functionCall = {
    type: "function_call",
    id: callId,
    call_id: callId,
    name: "execute_action",
    arguments: JSON.stringify({
      step_details: args.step_details,
      chat_message: args.chat_message,
      avatar_emotion: args.avatar_emotion,
      actions: args.actions,
    }),
  };

  const hasTouchAction = Array.isArray(args?.actions) && args.actions.some((action) => action?.type === "touch");
  const allWaitActions =
    Array.isArray(args?.actions) &&
    args.actions.length > 0 &&
    args.actions.every((action) => action?.type === "wait");
  const anchorRestore = await restoreObservationAnchorState(lastCodexDesktopObservation);
  const preActionRefreshSkipped = canSkipCodexDesktopPreActionRefresh(args, { hasTouchAction });
  let gameDataJson = preActionRefreshSkipped ? lastCodexDesktopObservation.gameDataJson : await fetchGameData();
  if (!gameDataJson) {
    throw new Error("Python bridge did not return game data before action execution");
  }
  if (gameDataJson.bridgeRequestOk === false || gameDataJson.observationUnavailable === true) {
    throw new Error(`Python bridge observation unavailable before action execution: ${gameDataJson.bridgeError || "unknown error"}`);
  }
  let observationDrift = null;
  if (preActionRefreshSkipped) {
    observationDrift = skippedPreActionDriftFromObservation(lastCodexDesktopObservation);
  } else if (config.isHeartGold && ["visual", "ram_assisted"].includes(config.observation.mode)) {
    observationDrift = observationDriftFromGameData(gameDataJson, lastCodexDesktopObservation);
    const freshnessFailure = screenshotFreshnessFailure(gameDataJson);
    if (freshnessFailure) {
      const message =
        `Codex Desktop action rejected: current screenshot is not fresh (${freshnessFailure}). The game interface must refresh observation before executing another action.`;
      recordHarnessFailure("stale_observation_action", message, { ...observationDrift, freshnessFailure });
      await writeArtifact("action_rejected", { request: args, reason: message, observationDrift, freshnessFailure });
      throw new Error(message);
    }
    const materialStateMatch =
      observationDrift?.material_state_known === true &&
      observationDrift?.material_state_changed !== true;
    if (hasTouchAction && observationDrift?.screenshot_hash_changed === true && !materialStateMatch) {
      const message =
        "Codex Desktop touch action rejected: the visible screenshot changed since the model observation. Touch targets are screen-position sensitive, so the game interface must refresh observation before executing touch.";
      recordHarnessFailure("stale_touch_observation_action", message, observationDrift);
      await writeArtifact("action_rejected", { request: args, reason: message, observationDrift });
      throw new Error(message);
    }
  }
  let observationDriftAcceptedReason = preActionRefreshSkipped ? "pre_action_refresh_skipped_low_stall" : null;
  if (
    (observationDrift?.screenshot_hash_changed === true || observationDrift?.cache_key_changed === true) &&
    observationDrift?.material_state_known === true &&
    observationDrift?.material_state_changed !== true
  ) {
    observationDriftAcceptedReason =
      anchorRestore.restored === true
        ? "restored_observation_anchor_material_match"
        : "material_state_match_visual_drift";
  }
  const waitAllowsPreActionTransitionDrift =
    allWaitActions &&
    (
      observationDrift?.screenshot_hash_changed === true ||
      observationDrift?.cache_key_changed === true ||
      observationDrift?.material_state_changed === true
    );
  if (observationDriftAcceptedReason === null && waitAllowsPreActionTransitionDrift) {
    observationDriftAcceptedReason = "wait_action_allows_pre_action_transition_drift";
  }
  if (
    observationDriftAcceptedReason === null &&
    hasTouchAction &&
    observationDrift?.screenshot_hash_changed !== true &&
    observationDrift?.same_dialogue_text_bookkeeping_drift === true
  ) {
    observationDriftAcceptedReason = "same_screenshot_dialogue_text_bookkeeping_drift";
  }
  if (
    observationDriftAcceptedReason === null &&
    hasTouchAction &&
    observationDrift?.screenshot_hash_changed !== true &&
    observationDrift?.same_current_dialogue_text_history_drift === true
  ) {
    observationDriftAcceptedReason = "same_screenshot_current_dialogue_text_history_drift";
  }
  if (
    observationDriftAcceptedReason === null &&
    !hasTouchAction &&
    observationDrift?.same_dialogue_text_reveal_drift === true
  ) {
    observationDriftAcceptedReason = "same_dialogue_text_reveal_drift";
  }
  if (
    observationDriftAcceptedReason === null &&
    !hasTouchAction &&
    observationDrift?.same_dialogue_text_bookkeeping_drift === true
  ) {
    observationDriftAcceptedReason = "same_dialogue_text_bookkeeping_drift";
  }
  if (
    observationDriftAcceptedReason === null &&
    !hasTouchAction &&
    observationDrift?.same_current_dialogue_text_history_drift === true
  ) {
    observationDriftAcceptedReason = "same_current_dialogue_text_history_drift";
  }
  if (
    observationDriftAcceptedReason === null &&
    !hasTouchAction &&
    observationDrift?.dialogue_text_validation_transition_drift === true
  ) {
    observationDriftAcceptedReason = "dialogue_text_validation_transition_drift";
  }
  if (
    observationDriftAcceptedReason === null &&
    observationDrift?.screenshot_hash_changed !== true &&
    observationDrift?.non_text_state_known === true &&
    observationDrift?.non_text_state_changed !== true
  ) {
    observationDriftAcceptedReason = "same_screenshot_non_text_state_stable";
  }
  if (
    observationDriftAcceptedReason === null &&
    (observationDrift?.screenshot_hash_changed === true || observationDrift?.cache_key_changed === true)
  ) {
    const message =
      "Codex Desktop action rejected: the observed screenshot/cache changed since the model observation. The game interface must refresh observation before executing another action.";
    recordHarnessFailure("stale_visual_observation_action", message, observationDrift);
    await writeArtifact("action_rejected", { request: args, reason: message, observationDrift });
    throw new Error(message);
  }
  if (
    observationDrift?.material_state_changed === true &&
    !waitAllowsPreActionTransitionDrift &&
    observationDriftAcceptedReason !== "same_dialogue_text_reveal_drift" &&
    observationDriftAcceptedReason !== "same_dialogue_text_bookkeeping_drift" &&
    observationDriftAcceptedReason !== "same_current_dialogue_text_history_drift" &&
    observationDriftAcceptedReason !== "dialogue_text_validation_transition_drift" &&
    observationDriftAcceptedReason !== "same_screenshot_dialogue_text_bookkeeping_drift" &&
    observationDriftAcceptedReason !== "same_screenshot_current_dialogue_text_history_drift"
  ) {
    const message =
      "Codex Desktop action rejected: the RAM/material state changed since the model observation. The game interface must send a fresh observation before accepting another action.";
    recordHarnessFailure("material_observation_drift_action", message, observationDrift);
    await writeArtifact("action_rejected", { request: args, reason: message, observationDrift });
    throw new Error(message);
  }
  validateDesktopTouchActions(args, lastCodexDesktopObservation);
  state.gameDataJsonRef = gameDataJson;

  const historyFunctionCall = {
    ...functionCall,
    arguments: sanitizeFunctionCallArguments(functionCall.name, functionCall.arguments),
  };
  state.history.push({
    role: "assistant",
    content: [{ type: "output_text", text: sanitizeModelText(args.chat_message || args.step_details || "Codex Desktop action.") }],
  });
  state.history.push(historyFunctionCall);
  recordPlayerReasoningTurn({
    step: state.counters.currentStep,
    callId,
    stepDetails: args.step_details,
    chatMessage: args.chat_message,
    avatarEmotion: args.avatar_emotion,
    actions: args.actions,
  });
  const toolResult = await handleToolCall(functionCall, gameDataJson, {
    normalizedActionSchemaCount: normalization?.actionCount || 0,
  });
  const modelSafeToolResult = sanitizeToolResultForDesktop(toolResult);
  state.history.push(modelSafeToolResult);
  state.counters.currentStep += 1;
  const toolOutcome = analyzeToolResult(toolResult);

  const durationMs = Number(body.model_duration_ms || body.duration_ms || Date.now() - startedAt);
  recordModelCall({
    provider: "codex-desktop",
    model: body.model || config.codexDesktop.model,
    reasoningEffort: body.reasoning_effort || config.codexDesktop.reasoningEffort,
    durationMs,
    imagePath: lastCodexDesktopObservation?.modelImage?.path || null,
    modelImage: lastCodexDesktopObservation?.modelImage || null,
    observationArtifactPath: lastCodexDesktopObservation?.artifactPath || null,
  });

  await savePersistentState();
  const result = {
    ok: true,
    provider: "codex-desktop",
    step: state.counters.currentStep,
    call_id: callId,
    action_success: toolOutcome.actionSuccess,
    overall_success: toolOutcome.actionSuccess === true,
    benchmark_semantic_success: toolOutcome.benchmarkSemanticSuccess === true,
    action_failure_reason: toolOutcome.failureReason,
    action_result_count: toolOutcome.actionResultCount,
    action_semantics: toolOutcome.actionSemantics || [],
    normalization_applied: normalization?.applied === true,
    normalization_reason: normalization?.reason || null,
    tool_result: modelSafeToolResult,
    duration_ms: durationMs,
    observation_artifact_path: lastCodexDesktopObservation?.artifactPath || null,
    observation_screenshot_hash: lastCodexDesktopObservation?.screenshotHash || null,
    pre_action_screenshot_hash: observationDrift?.pre_action_screenshot_hash || null,
    observation_screenshot_hash_changed: observationDrift?.screenshot_hash_changed === true,
    observation_cache_key_changed: observationDrift?.cache_key_changed === true,
    observation_material_state_changed: observationDrift?.material_state_changed === true,
    observation_drift: observationDrift,
    observation_drift_accepted_reason: observationDriftAcceptedReason,
    observation_to_action_ms: observationDrift?.observation_to_action_ms ?? null,
    pre_action_refresh_skipped: preActionRefreshSkipped,
    observation_model_image: lastCodexDesktopObservation?.modelImage || null,
    observation_monitor_only: lastCodexDesktopObservation?.monitorOnly === true,
    observation_anchor_restore: {
      attempted: anchorRestore.attempted === true,
      restored: anchorRestore.restored === true,
      path: anchorRestore.path || null,
    },
  };
  const actionArtifact = {
    schema: "heartgold_codex_desktop_action_artifact_v1",
    provider: "codex-desktop",
    artifact_source: "codex_desktop_service",
    artifact_kind: "action",
    contract: "codex_desktop_action_semantic_closure_v1",
    artifact_provenance: {
      producer: "server/src/services/codexDesktopService.js",
      route: "/codexDesktop/action",
      action_bound_to_last_observation: true,
    },
    request: args,
    result,
  };
  actionArtifact.action_audit = auditActionArtifact(actionArtifact);
  if (actionArtifact.action_audit.result !== "pass") {
    recordHarnessFailure("codex_desktop_action_artifact_audit_failed", "Codex Desktop action artifact audit failed.", {
      failures: actionArtifact.action_audit.failures,
    });
  }
  const artifactPath = await writeArtifact("action", actionArtifact);
  return modelVisibleActionResult(result, artifactPath);
}

module.exports = {
  buildCodexDesktopObservation,
  executeCodexDesktopAction,
  _private: {
    analyzeToolResult,
    buildModelVisibleManifest,
    buildSimplePlayerObservation,
    validateDesktopTouchActions,
  },
};
