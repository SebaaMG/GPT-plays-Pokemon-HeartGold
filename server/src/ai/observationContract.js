const { config } = require("../config");
const { contractsForObservationField, surfacePolicy } = require("../benchmark/heartgoldRamAuditor");

const DEBUG_OBSERVATION_MODES = new Set(["harness_validation", "oracle_debug"]);
const OBSERVATION_MODE_ALIASES = new Map([
  ["standard", "ram_assisted"],
  ["standard_assisted", "ram_assisted"],
  ["assisted", "ram_assisted"],
]);
const VALIDATED_FIELD_CONFIDENCE = new Set([
  "verified",
  "verified_ram",
  "validated",
  "validated_current",
  "validated_ram",
  "rom_derived",
]);
const UNVALIDATED_FIELD_CONFIDENCE = new Set([
  "",
  "unknown",
  "unavailable",
  "candidate",
  "medium_or_candidate",
  "validation_failed",
  "failed",
  "stale",
  "diagnostic",
]);

const VALIDATED_FIELD_CONTRACTS = {
  battle: contractsForObservationField("battle"),
  dialogue: new Set([
    ...contractsForObservationField("current_visible_text"),
    ...contractsForObservationField("recent_visible_text"),
  ]),
  inventory: contractsForObservationField("inventory"),
  menu: contractsForObservationField("menu"),
  naming: contractsForObservationField("naming"),
  npcs: contractsForObservationField("runtime_objects"),
  interactables: contractsForObservationField("visible_interactables"),
  warps: contractsForObservationField("visible_warps"),
  currentConnections: contractsForObservationField("current_connections"),
  fieldMoveAffordances: contractsForObservationField("field_move_affordances"),
  facing: contractsForObservationField("facing"),
  movement: contractsForObservationField("movement"),
  romCollision: new Set(["rom_derived_matrix_land_data_with_live_position_validation"]),
  badges: contractsForObservationField("badges"),
  money: contractsForObservationField("money"),
  party: contractsForObservationField("party"),
  pcStorage: contractsForObservationField("pc_storage"),
  progress: contractsForObservationField("progress"),
  strength: contractsForObservationField("progress"),
  flash: new Set(["ram_local_field_data_current_weather_and_flash_flag_validated"]),
  visibility: new Set(["ram_local_field_data_current_weather_visibility_v1"]),
};

const REQUIRED_BATTLE_INPUT_CONTRACT = "ram_battle_context_active_battlers_and_input_validated";
if (!VALIDATED_FIELD_CONTRACTS.battle.has(REQUIRED_BATTLE_INPUT_CONTRACT)) {
  throw new Error("HeartGold RAM dictionary missing validated active battler + input battle contract.");
}
const VALIDATED_POSITION_CONTRACTS = new Set([...contractsForObservationField("position")].map(lower));
const CURRENT_MAP_LOCATION_CONTRACT = "ram_fieldsystem_location_current_map_v1";

const VALIDATED_RUNTIME_OBJECT_ENTRY_CONTRACTS = new Set([
  "current_runtime_map_object",
  "current_runtime_map_object_bound_to_current_static_object",
]);

const VALIDATED_VISIBLE_INTERACTABLE_ENTRY_CONTRACTS = new Set([
  "current_visible_bg_event_interactable_no_raw_script",
  "current_visible_runtime_object_talk_interactable_v1",
]);

const RUNTIME_OBJECT_ORACLE_KEYS = [
  "script_id",
  "scriptId",
  "script_number",
  "scriptNumber",
  "script",
  "event_flag",
  "eventFlag",
  "event_flags",
  "eventFlags",
  "event_id",
  "eventId",
  "event_script",
  "eventScript",
  "object_event_script",
  "objectEventScript",
  "raw_flags",
  "rawFlags",
  "flags",
];

const VISIBLE_INTERACTABLE_ORACLE_KEYS = [
  ...RUNTIME_OBJECT_ORACLE_KEYS,
  "raw",
  "rawEvent",
  "raw_event",
  "scriptIndex",
  "script_index",
  "zoneEvent",
  "zone_event",
  "eventType",
  "event_type",
  "eventValue",
  "event_value",
];

const DISALLOWED_VALIDATION_MARKER_PATTERN =
  /\b(?:tasvideos|mock[-_ ]?only|diagnostics?[-_ ]?only|harness_diagnostics|raw[-_ ]?address|address[-_ ]?candidate|high[-_ ]?confidence|candidate[-_ ]?(?:contract|source|fallback)?|fallback|generic)\b/i;

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

function sameMapId(left, right) {
  return String(left ?? "").trim() === String(right ?? "").trim();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = finiteNumber(value);
  return number == null ? null : Math.trunc(number);
}

function playerCoordinateFrame(gameDataJson) {
  const pos = gameDataJson?.current_trainer_data?.position || {};
  const romMap =
    gameDataJson?.rom_map_data && typeof gameDataJson.rom_map_data === "object"
      ? gameDataJson.rom_map_data
      : {};
  const minimap =
    gameDataJson?.minimap_data && typeof gameDataJson.minimap_data === "object"
      ? gameDataJson.minimap_data
      : {};
  const coordinateMode =
    pos.coordinateMode ||
    pos.coordinate_mode ||
    romMap.coordinateMode ||
    romMap.coordinate_mode ||
    minimap.static_coordinate_mode ||
    minimap.coordinateMode ||
    minimap.coordinate_mode ||
    null;
  const x = integerOrNull(pos.x);
  const y = integerOrNull(pos.y);
  const originX = integerOrNull(
    romMap.originX ?? romMap.origin_x ?? minimap.static_origin_x ?? minimap.originX ?? minimap.origin?.x
  );
  const originY = integerOrNull(
    romMap.originY ?? romMap.origin_y ?? minimap.static_origin_y ?? minimap.originY ?? minimap.origin?.y
  );
  const width = integerOrNull(romMap.width ?? romMap.w ?? minimap.static_width ?? minimap.width);
  const height = integerOrNull(romMap.height ?? romMap.h ?? minimap.static_height ?? minimap.height);
  const matrixGlobal =
    coordinateMode === "matrix_global_position" ||
    Boolean(originX != null && originY != null && (originX !== 0 || originY !== 0));
  const resolvedMode = coordinateMode || (matrixGlobal ? "matrix_global_position" : "map_local_position");
  const localX = x == null ? null : matrixGlobal && originX != null ? x - originX : x;
  const localY = y == null ? null : matrixGlobal && originY != null ? y - originY : y;
  const inLocalBounds =
    localX != null &&
    localY != null &&
    width != null &&
    height != null &&
    localX >= 0 &&
    localY >= 0 &&
    localX < width &&
    localY < height;

  return {
    coordinateMode: resolvedMode,
    globalX: x,
    globalY: y,
    x,
    y,
    localX,
    localY,
    originX,
    originY,
    width,
    height,
    inLocalBounds,
    pathCoordinateFrame: matrixGlobal ? "matrix_global_position" : "map_local_position",
  };
}

function isHeartGoldObservationData(gameDataJson) {
  const profile = lower(gameDataJson?.game?.profile || config.gameProfile);
  const platform = lower(gameDataJson?.game?.platform);
  return config.isHeartGold || profile === "heartgold" || platform === "nintendo ds";
}

function observationMode(gameDataJson) {
  const raw = lower(gameDataJson?.observationPolicy?.mode || config.observation.mode || "visual") || "visual";
  return OBSERVATION_MODE_ALIASES.get(raw) || raw;
}

function exposeOracle(gameDataJson) {
  return gameDataJson?.observationPolicy?.exposeOracle === true || config.observation.exposeOracle === true;
}

function confidenceRequired(gameDataJson) {
  if (gameDataJson?.observationPolicy?.stateConfidenceRequired === false) return false;
  return config.observation.confidenceRequired !== false;
}

function fieldDetails(gameDataJson, field) {
  const details = gameDataJson?.stateReliabilityDetails?.[field];
  return details && typeof details === "object" ? details : {};
}

function confidenceForField(gameDataJson, field) {
  const details = fieldDetails(gameDataJson, field);
  return lower(details.confidence || details.contract || details.source || "unknown");
}

function hasValidationFailure(details) {
  if (!details || typeof details !== "object") return false;
  if (details.validationFailure) return true;
  if (details.validation_failure) return true;
  if (Array.isArray(details.validationFailures) && details.validationFailures.length > 0) return true;
  if (Array.isArray(details.validation_failures) && details.validation_failures.length > 0) return true;
  return false;
}

function fieldHasExplicitUnvalidatedSignal(details) {
  if (!details || typeof details !== "object") return true;
  if (hasValidationFailure(details)) return true;
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(details, key);
  const confidence = lower(details.confidence);
  const contract = lower(details.contract);
  const source = lower(details.source);
  if (hasOwn("confidence") && UNVALIDATED_FIELD_CONFIDENCE.has(confidence)) return true;
  if (hasOwn("contract") && UNVALIDATED_FIELD_CONFIDENCE.has(contract)) return true;
  if (hasOwn("source") && UNVALIDATED_FIELD_CONFIDENCE.has(source)) return true;
  if (confidence.includes("candidate") || confidence.includes("validation_failed")) return true;
  if (contract.includes("candidate") || contract.includes("validation_failed")) return true;
  if (source.includes("candidate") || source.includes("validation_failed")) return true;
  if (DISALLOWED_VALIDATION_MARKER_PATTERN.test(confidence)) return true;
  if (DISALLOWED_VALIDATION_MARKER_PATTERN.test(contract)) return true;
  if (DISALLOWED_VALIDATION_MARKER_PATTERN.test(source)) return true;
  return false;
}

function evidenceBoolean(evidence, snakeName, camelName = null) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  return evidence[snakeName] === true || (camelName ? evidence[camelName] === true : false);
}

function movementModeEvidence(gameDataJson, details) {
  const detectorEvidence = gameDataJson?.ram_assisted?.modeDetector?.movement?.movementModeEvidence;
  const detectorSnakeEvidence = gameDataJson?.ram_assisted?.modeDetector?.movement?.movement_mode_evidence;
  for (const candidate of [
    details?.movementModeEvidence,
    details?.movement_mode_evidence,
    detectorEvidence,
    detectorSnakeEvidence,
  ]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
  }
  return null;
}

function movementFieldHasRequiredEvidence(gameDataJson, details) {
  const evidence = movementModeEvidence(gameDataJson, details);
  const required = Array.isArray(surfacePolicy("movement_mode")?.required_evidence)
    ? surfacePolicy("movement_mode").required_evidence.map(String).filter(Boolean)
    : [];
  if (required.length === 0) return false;

  const proofByTag = {
    current_player_localmapobject_bound: evidenceBoolean(
      evidence,
      "current_player_localmapobject_bound",
      "currentPlayerLocalMapObjectBound"
    ),
    movement_mode_decoded: evidenceBoolean(evidence, "movement_mode_decoded", "movementModeDecoded"),
    vehicle_state_decoded: evidenceBoolean(evidence, "vehicle_state_decoded", "vehicleStateDecoded"),
  };
  return required.every((tag) => proofByTag[tag] === true);
}

function fieldIsValidated(gameDataJson, field) {
  if (!isHeartGoldObservationData(gameDataJson)) return true;
  const mode = observationMode(gameDataJson);
  if (mode === "visual") return false;
  if (mode === "oracle_debug" && exposeOracle(gameDataJson)) return true;
  if (DEBUG_OBSERVATION_MODES.has(mode) && !confidenceRequired(gameDataJson)) return true;

  const details = fieldDetails(gameDataJson, field);
  const confidence = lower(details.confidence);
  const contract = lower(details.contract);
  const source = lower(details.source);
  if (fieldHasExplicitUnvalidatedSignal(details)) return false;
  if (field === "movement" && !movementFieldHasRequiredEvidence(gameDataJson, details)) return false;
  const validatedContracts = VALIDATED_FIELD_CONTRACTS[field];
  if (validatedContracts) return validatedContracts.has(contract);
  return (
    VALIDATED_FIELD_CONFIDENCE.has(confidence) ||
    VALIDATED_FIELD_CONFIDENCE.has(contract) ||
    VALIDATED_FIELD_CONFIDENCE.has(source)
  );
}

function navigationValidation(gameDataJson) {
  const mode = observationMode(gameDataJson);
  if (!isHeartGoldObservationData(gameDataJson)) {
    return { validated: true, reason: "non_heartgold_profile", mode };
  }
  if (mode === "visual") {
    return { validated: false, reason: "visual_mode_hides_decoded_navigation", mode };
  }
  if (mode === "oracle_debug" && exposeOracle(gameDataJson)) {
    return { validated: true, reason: "oracle_debug_enabled", mode };
  }
  if (DEBUG_OBSERVATION_MODES.has(mode) && !confidenceRequired(gameDataJson)) {
    return { validated: true, reason: "diagnostic_mode_confidence_requirement_disabled", mode };
  }

  const pos = gameDataJson?.current_trainer_data?.position || {};
  const details = fieldDetails(gameDataJson, "position");
  const coordinateConfidence = lower(pos.coordinate_confidence || details.coordinateConfidence || details.coordinate_confidence);
  const mapIdentityConfidence = lower(
    pos.map_identity_confidence || details.mapIdentityConfidence || details.map_identity_confidence
  );
  const positionConfidence = lower(pos.position_confidence || details.confidence || details.contract);
  const positionContract = lower(pos.contract || details.contract);
  const mapNameSource = lower(pos.map_name_source || details.mapNameSource || details.map_name_source);
  const mapIdSource = lower(pos.map_id_source || details.mapIdSource || details.map_id_source);
  const mapId = lower(pos.map_id);

  const hasRuntimeCurrentMap = mapIdSource === "fieldsystem.location" || mapIdSource === "field_system.location";
  const hasVerifiedMap = mapIdentityConfidence === "verified" && mapNameSource !== "generic_fallback" && hasRuntimeCurrentMap;
  const hasHighCoordinates = coordinateConfidence === "high";
  const hasUsablePosition = positionConfidence === "high" || positionConfidence === "verified_ram" || positionConfidence === "verified";
  const hasSpecificPositionContract = VALIDATED_POSITION_CONTRACTS.has(positionContract);

  if (hasVerifiedMap && hasHighCoordinates && hasUsablePosition && hasSpecificPositionContract) {
    return {
      validated: true,
      reason: "verified_map_identity_and_high_confidence_coordinates",
      mode,
      coordinateConfidence,
      mapIdentityConfidence,
      positionConfidence,
      mapNameSource,
      mapIdSource,
    };
  }

  const reasonParts = [];
  if (!hasVerifiedMap) reasonParts.push(`map_identity=${mapIdentityConfidence || "unknown"}`);
  if (!hasHighCoordinates) reasonParts.push(`coordinates=${coordinateConfidence || "unknown"}`);
  if (!hasUsablePosition) reasonParts.push(`position=${positionConfidence || "unknown"}`);
  if (!hasSpecificPositionContract) reasonParts.push(`position_contract=${positionContract || "unknown"}`);
  if (mapNameSource === "generic_fallback") reasonParts.push("map_name=generic_fallback");
  if (!hasRuntimeCurrentMap) reasonParts.push(`map_id_source=${mapIdSource || "unknown"}`);

  return {
    validated: false,
    reason: reasonParts.join(";") || "navigation_confidence_insufficient",
    mode,
    coordinateConfidence: coordinateConfidence || "unknown",
    mapIdentityConfidence: mapIdentityConfidence || "unknown",
    positionConfidence: positionConfidence || "unknown",
    mapNameSource: mapNameSource || "unknown",
    mapIdSource: mapIdSource || "unknown",
  };
}

function locationObservationValidation(gameDataJson) {
  const mode = observationMode(gameDataJson);
  if (!isHeartGoldObservationData(gameDataJson)) {
    return { validated: true, reason: "non_heartgold_profile", mode };
  }
  if (mode === "visual") {
    return { validated: false, reason: "visual_mode_hides_decoded_location", mode };
  }
  if (mode === "oracle_debug" && exposeOracle(gameDataJson)) {
    return { validated: true, reason: "oracle_debug_enabled", mode };
  }
  if (DEBUG_OBSERVATION_MODES.has(mode) && !confidenceRequired(gameDataJson)) {
    return { validated: true, reason: "diagnostic_mode_confidence_requirement_disabled", mode };
  }

  const pos = gameDataJson?.current_trainer_data?.position || {};
  const details = fieldDetails(gameDataJson, "position");
  const coordinateConfidence = lower(pos.coordinate_confidence || details.coordinateConfidence || details.coordinate_confidence);
  const mapIdentityConfidence = lower(
    pos.map_identity_confidence || details.mapIdentityConfidence || details.map_identity_confidence
  );
  const positionConfidence = lower(pos.position_confidence || details.confidence || details.contract);
  const positionContract = lower(pos.contract || details.contract);
  const mapNameSource = lower(pos.map_name_source || details.mapNameSource || details.map_name_source);
  const mapIdSource = lower(pos.map_id_source || details.mapIdSource || details.map_id_source);
  const hasHighCoordinates = coordinateConfidence === "high";
  const hasRuntimeCurrentMap = mapIdSource === "fieldsystem.location" || mapIdSource === "field_system.location";
  const verifiedMap = mapIdentityConfidence === "verified" && mapNameSource !== "generic_fallback" && hasRuntimeCurrentMap;
  const hasUsablePosition = positionConfidence === "high" || positionConfidence === "verified_ram" || positionConfidence === "verified";
  const hasSpecificPositionContract = VALIDATED_POSITION_CONTRACTS.has(positionContract);
  const hasMapOnlyLocationContract = positionContract === CURRENT_MAP_LOCATION_CONTRACT;

  if (verifiedMap && hasHighCoordinates && hasUsablePosition && hasSpecificPositionContract) {
    return {
      validated: true,
      reason: "verified_map_identity_and_high_confidence_coordinates",
      mode,
      coordinateConfidence,
      mapIdentityConfidence,
      positionConfidence,
      mapNameSource,
      mapIdSource,
    };
  }
  if (verifiedMap && hasMapOnlyLocationContract) {
    return {
      validated: true,
      reason: "verified_current_map_identity",
      mode,
      coordinateConfidence: coordinateConfidence || "unknown",
      mapIdentityConfidence,
      positionConfidence: positionConfidence || "unknown",
      mapNameSource,
      mapIdSource,
    };
  }

  const reasonParts = [];
  if (!verifiedMap) reasonParts.push(`map_identity=${mapIdentityConfidence || "unknown"}`);
  if (!hasHighCoordinates) reasonParts.push(`coordinates=${coordinateConfidence || "unknown"}`);
  if (!hasUsablePosition) reasonParts.push(`position=${positionConfidence || "unknown"}`);
  if (!hasSpecificPositionContract) reasonParts.push(`position_contract=${positionContract || "unknown"}`);
  if (mapNameSource === "generic_fallback") reasonParts.push("map_name=generic_fallback");
  if (!hasRuntimeCurrentMap) reasonParts.push(`map_id_source=${mapIdSource || "unknown"}`);
  return {
    validated: false,
    reason: reasonParts.join(";") || "location_confidence_insufficient",
    mode,
    coordinateConfidence: coordinateConfidence || "unknown",
    mapIdentityConfidence: mapIdentityConfidence || "unknown",
    positionConfidence: positionConfidence || "unknown",
    mapNameSource: mapNameSource || "unknown",
    mapIdSource: mapIdSource || "unknown",
  };
}

function buildObservationExposure(gameDataJson) {
  const mode = observationMode(gameDataJson);
  const heartgold = isHeartGoldObservationData(gameDataJson);
  const diagnosticsAllowed = heartgold && DEBUG_OBSERVATION_MODES.has(mode);
  const navigation = navigationValidation(gameDataJson);
  const location = locationObservationValidation(gameDataJson);
  const fields = {};
  for (const field of [
    "facing",
    "party",
    "inventory",
    "pcStorage",
    "progress",
    "money",
    "badges",
    "battle",
    "dialogue",
    "menu",
    "naming",
    "movement",
    "strength",
    "flash",
    "visibility",
    "npcs",
    "interactables",
    "warps",
    "currentConnections",
    "fieldMoveAffordances",
    "romCollision",
  ]) {
    const details = fieldDetails(gameDataJson, field);
    fields[field] = {
      validated: fieldIsValidated(gameDataJson, field),
      confidence: lower(details.confidence || "unknown") || "unknown",
      source: lower(details.source || "unknown") || "unknown",
      contract: lower(details.contract || details.source || "unknown") || "unknown",
    };
  }

  const unavailable = [];
  if (heartgold && !navigation.validated && !diagnosticsAllowed) {
    unavailable.push({
      field: "position_map_minimap_pathfinding",
      reason: navigation.reason,
    });
  }
  for (const field of ["party", "inventory", "pcStorage", "progress", "money", "badges", "battle"]) {
    if (heartgold && !fields[field].validated && !diagnosticsAllowed) {
      unavailable.push({
        field,
        reason: `${field}_confidence=${fields[field].confidence}`,
      });
    }
  }

  return {
    heartgold,
    mode,
    exposeOracle: exposeOracle(gameDataJson),
    confidenceRequired: confidenceRequired(gameDataJson),
    diagnosticsAllowed,
    navigation,
    location,
    fields,
    unavailable,
  };
}

function isValidatedRuntimeObjectEntry(gameDataJson, entry, options = {}) {
  if (!entry || typeof entry !== "object") return false;
  if (!fieldIsValidated(gameDataJson, "npcs")) return false;
  for (const key of RUNTIME_OBJECT_ORACLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(entry, key)) return false;
  }

  const {
    requireActive = true,
    requireVisible = true,
    requireBlocking = false,
    maxDistance = 16,
  } = options || {};

  const contract = String(entry.contract || "");
  if (!VALIDATED_RUNTIME_OBJECT_ENTRY_CONTRACTS.has(contract)) return false;
  if (entry.confidence !== "validated_ram") return false;
  if (entry.source !== "FieldSystem.mapObjectManager") return false;
  if (contract === "current_runtime_map_object_bound_to_current_static_object") {
    if (entry.staticObjectBound !== true) return false;
    if (entry.staticObjectSource !== "heartgold_rom_zone_event_current_map") return false;
    if (finiteNumber(entry.initial_x) == null || finiteNumber(entry.initial_y) == null) return false;
  } else if (entry.staticObjectBound === true) {
    return false;
  }
  if (requireActive && entry.isActive !== true) return false;
  if (requireVisible && entry.isVisible !== true) return false;
  if (requireBlocking && entry.isBlocking !== true) return false;

  const currentMapId = gameDataJson?.current_trainer_data?.position?.map_id;
  if (entry.map_id == null || currentMapId == null || !sameMapId(entry.map_id, currentMapId)) return false;

  const x = finiteNumber(entry.x);
  const y = finiteNumber(entry.y);
  if (x == null || y == null) return false;
  if (x < 0 || y < 0 || x > 4096 || y > 4096) return false;

  if (maxDistance != null) {
    let distance = finiteNumber(entry.distance);
    if (distance == null) {
      const playerX = finiteNumber(gameDataJson?.current_trainer_data?.position?.x);
      const playerY = finiteNumber(gameDataJson?.current_trainer_data?.position?.y);
      if (playerX == null || playerY == null) return false;
      distance = Math.abs(Math.trunc(x) - Math.trunc(playerX)) + Math.abs(Math.trunc(y) - Math.trunc(playerY));
    }
    if (distance > Number(maxDistance)) return false;
  }

  const requiredFacing = String(entry.requiredFacing || "unknown");
  if (!["unknown", "up", "down", "left", "right"].includes(requiredFacing)) return false;
  if (entry.inFrontOfPlayer != null && typeof entry.inFrontOfPlayer !== "boolean") return false;

  return true;
}

function isValidatedVisibleInteractableEntry(gameDataJson, entry, exposure = null) {
  if (!entry || typeof entry !== "object") return false;
  const fieldValidated = exposure?.fields?.interactables?.validated === true || fieldIsValidated(gameDataJson, "interactables");
  if (!fieldValidated) return false;
  for (const key of VISIBLE_INTERACTABLE_ORACLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(entry, key)) return false;
  }
  const contract = String(entry.contract || "");
  const kind = String(entry.kind || "");
  if (!VALIDATED_VISIBLE_INTERACTABLE_ENTRY_CONTRACTS.has(contract)) return false;
  if (contract === "current_visible_bg_event_interactable_no_raw_script") {
    if (entry.confidence !== "rom_derived") return false;
    if (entry.source !== "heartgold_rom_zone_event_visible_bg_event") return false;
    if (kind !== "check") return false;
  } else if (contract === "current_visible_runtime_object_talk_interactable_v1") {
    if (entry.confidence !== "validated_ram") return false;
    if (entry.source !== "FieldSystem.mapObjectManager_visible_runtime_object") return false;
    if (kind !== "talk") return false;
  } else {
    return false;
  }
  const x = finiteNumber(entry.x);
  const y = finiteNumber(entry.y);
  if (x == null || y == null) return false;
  if (x < 0 || y < 0 || x > 4096 || y > 4096) return false;
  const distance = finiteNumber(entry.distance);
  if (distance != null && (distance < 0 || distance > 64)) return false;
  const requiredFacing = String(entry.requiredFacing || "unknown");
  if (!["unknown", "up", "down", "left", "right"].includes(requiredFacing)) return false;
  if (entry.inFrontOfPlayer != null && typeof entry.inFrontOfPlayer !== "boolean") return false;
  if (entry.useFrom != null) {
    if (!Array.isArray(entry.useFrom) || entry.useFrom.length > 4) return false;
    for (const tile of entry.useFrom) {
      if (!tile || typeof tile !== "object") return false;
      for (const key of VISIBLE_INTERACTABLE_ORACLE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(tile, key)) return false;
      }
      const tileX = finiteNumber(tile.x);
      const tileY = finiteNumber(tile.y);
      if (tileX == null || tileY == null || tileX < 0 || tileY < 0 || tileX > 4096 || tileY > 4096) {
        return false;
      }
      if (!["up", "down", "left", "right"].includes(String(tile.requiredFacing || ""))) return false;
    }
  }
  return true;
}

function validatedVisibleInteractableEntries(gameDataJson, exposure = null) {
  const entries = Array.isArray(gameDataJson?.visible_interactables)
    ? gameDataJson.visible_interactables
    : Array.isArray(gameDataJson?.ram_assisted?.interactables?.visible)
      ? gameDataJson.ram_assisted.interactables.visible
      : [];
  return entries.filter((entry) => isValidatedVisibleInteractableEntry(gameDataJson, entry, exposure));
}

function visibleInteractableSummary(gameDataJson) {
  const candidates = [gameDataJson?.ram_assisted?.interactables, fieldDetails(gameDataJson, "interactables")];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
  }
  return {};
}

function validatedVisibleInteractableSurface(gameDataJson, exposure = null) {
  const fieldValidated = exposure?.fields?.interactables?.validated === true || fieldIsValidated(gameDataJson, "interactables");
  const diagnosticsAllowed = exposure?.diagnosticsAllowed === true;
  const entries = validatedVisibleInteractableEntries(gameDataJson, exposure);
  const summary = visibleInteractableSummary(gameDataJson);
  const contract = lower(summary.contract || exposure?.fields?.interactables?.contract);

  if (!fieldValidated && !diagnosticsAllowed) {
    return { validated: false, entries: [], current: null, summary, reason: "visible_interactables_not_validated" };
  }
  if (summary.available === false) {
    return { validated: false, entries: [], current: null, summary, reason: summary.reason || "visible_interactables_not_available" };
  }
  if (contract && !VALIDATED_FIELD_CONTRACTS.interactables.has(contract)) {
    return { validated: false, entries: [], current: null, summary, reason: "visible_interactables_contract_not_validated" };
  }

  const rawCurrent = gameDataJson?.current_interaction || gameDataJson?.ram_assisted?.interactables?.current || null;
  const current =
    rawCurrent && isValidatedVisibleInteractableEntry(gameDataJson, rawCurrent, exposure)
      ? rawCurrent
      : entries.find((entry) => entry.inFrontOfPlayer === true) || null;
  return { validated: true, entries, current, summary, reason: null };
}

function validatedRuntimeObjectEntries(gameDataJson, options = {}) {
  const entries = Array.isArray(gameDataJson?.npc_entries_visible) ? gameDataJson.npc_entries_visible : [];
  return entries.filter((entry) => isValidatedRuntimeObjectEntry(gameDataJson, entry, options));
}

function runtimeObjectSummary(gameDataJson) {
  const candidates = [
    gameDataJson?.ram_assisted?.runtimeObjects,
    gameDataJson?.runtime_objects_summary,
    fieldDetails(gameDataJson, "npcs"),
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
  }
  return {};
}

function validatedRuntimeObjectSurface(gameDataJson, exposure = null, options = {}) {
  const fieldValidated = exposure?.fields?.npcs?.validated === true || fieldIsValidated(gameDataJson, "npcs");
  const diagnosticsAllowed = exposure?.diagnosticsAllowed === true;
  const entries = validatedRuntimeObjectEntries(gameDataJson, options);
  const summary = runtimeObjectSummary(gameDataJson);
  const contract = lower(summary.contract || exposure?.fields?.npcs?.contract);
  const count = finiteNumber(summary.count);
  const visibleCount = finiteNumber(summary.visibleCount ?? summary.visible_count);

  if (!fieldValidated && !diagnosticsAllowed) {
    return { validated: false, entries: [], summary, reason: "runtime_objects_not_validated" };
  }
  if (summary.available === false) {
    return { validated: false, entries: [], summary, reason: summary.reason || "runtime_objects_not_available" };
  }
  if (contract && !VALIDATED_FIELD_CONTRACTS.npcs.has(contract)) {
    return { validated: false, entries: [], summary, reason: "runtime_objects_contract_not_validated" };
  }

  const hasAvailabilityEvidence =
    entries.length > 0 || count != null || visibleCount != null || summary.available === true || diagnosticsAllowed;
  if (!hasAvailabilityEvidence) {
    return { validated: false, entries: [], summary, reason: "runtime_objects_visibility_not_validated" };
  }
  if (entries.length === 0 && count != null && count > 0 && visibleCount === 0 && !diagnosticsAllowed) {
    return { validated: false, entries: [], summary, reason: "runtime_objects_visible_subset_empty_for_non_empty_map" };
  }

  return { validated: true, entries, summary, reason: null };
}

module.exports = {
  buildObservationExposure,
  confidenceForField,
  fieldIsValidated,
  isHeartGoldObservationData,
  isValidatedRuntimeObjectEntry,
  locationObservationValidation,
  navigationValidation,
  playerCoordinateFrame,
  runtimeObjectSummary,
  validatedVisibleInteractableEntries,
  validatedVisibleInteractableSurface,
  validatedRuntimeObjectSurface,
  validatedRuntimeObjectEntries,
};
