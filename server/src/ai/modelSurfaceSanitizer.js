const { config } = require("../config");

const ALWAYS_DIAGNOSTIC_KEY_PATTERN =
  "raw_state|raw_ram|harnessDiagnostics|harness_diagnostics|ram_audit_snapshot|model_visible_manifest|oracleDebug|oracle_debug|positionResolution|position_resolution|hidden_flags|event_flag|event_flags|warp_graph|future_warp_graph|rom_map_data";

const VISUAL_ONLY_DIAGNOSTIC_KEY_PATTERN =
  "static_grid|minimap_data|visible_area_data|game_area_meta_tiles|npc_entries|battle_data|inventory_data|current_trainer_data|current_pokemon_data";

const POINTER_LIKE_KEY_PATTERN =
  "(?:[A-Za-z0-9_]*?(?:ptr|pointer|addr|address)|appDataPtr|msgBufferPtr|ctxPtr|battleSystemPtr|listMenu2DPtr|saveDataPtr|bagPtr|fieldSystemPtr|scriptEnvironmentPtr|textPrinterPtr|rawWords|entryRawWords)";

const ORACLE_CONSTANT_TOKEN_PATTERN = /\b(?:MAPSEC|MAP|NARC)_[A-Z0-9_]+\b/g;

const ORACLE_NAVIGATION_KEY_PATTERN =
  /^(?:targetMapName|targetMapId|targetMapConstant|destinationMapName|destinationMapId|destinationMapConstant|anchor|eventsBank|eventsSymbol|matrixName|matrixCellX|matrixCellY)$/i;

const HIDDEN_POKEMON_MECHANIC_KEY_PATTERN =
  /^(?:pid|raw_pid|personality|ivs?|evs?|nature|nature_id|pp_ups?|friendship|pokerus|rng|rngSeed|enemyBase|backline|trainerBackline|hidden_mechanics|hidden_mechanics_diagnostics)$/i;

const RAW_POKEMON_ID_KEY_PATTERN =
  /^(?:species_id|form_id|status_raw|held_item_id|ability_id|slot_id|pokedex_id|move_id|starter_species_id|battler_id|personal_species_id|growth_rate_id|raw_type_ids|type_ids)$/i;

const ORACLE_LEAK_TEXT_PATTERN =
  /\b(?:TASVideos|raw[-_ ]?address|address[-_ ]?candidate|candidate[-_ ]?(?:contract|source|fallback)?|mock[-_ ]?only|diagnostics?[-_ ]?only|high[-_ ]?confidence|fallback|rngSeed|rng|enemyBase|backline|raw_pid|pid|personality)\b/gi;

const BARE_HEX_ADDRESS_PATTERN = /\b0x[0-9A-Fa-f]{6,}\b/g;
const BASE_HEX_OFFSET_PATTERN = /\bbase\+0x[0-9A-Fa-f]+\b/gi;

function shouldSanitizeModelText() {
  return config.isHeartGold && ["visual", "ram_assisted"].includes(config.observation.mode);
}

function isPrimaryVisualMode() {
  return config.isHeartGold && config.observation.mode === "visual";
}

function diagnosticKeyPatternForMode() {
  return isPrimaryVisualMode()
    ? `${ALWAYS_DIAGNOSTIC_KEY_PATTERN}|${VISUAL_ONLY_DIAGNOSTIC_KEY_PATTERN}`
    : ALWAYS_DIAGNOSTIC_KEY_PATTERN;
}

function diagnosticKeyRegexForMode() {
  return new RegExp(`\\b(${diagnosticKeyPatternForMode()})\\b`, "i");
}

function redactHistoricalNavigationTraceText(text) {
  return String(text || "")
    .replace(/^\s*-\s*Map:\s*.*$/gim, "- Map: [redacted from HeartGold historical action context]")
    .replace(/^\s*-\s*Position:\s*.*$/gim, "- Position: [redacted from HeartGold historical action context]")
    .replace(/^\s*Map updates:\s*$/gim, "Map updates: [redacted from HeartGold historical action context]")
    .replace(
      /^\s*-\s*(collision_to_free|free_to_collision|tiles_discovered)\s*\([^)]*\):.*$/gim,
      "- map update redacted from HeartGold historical action context"
    );
}

function generatedRouteCommandCount(value) {
  return Array.isArray(value) ? value.length : null;
}

function isGeneratedRouteSequenceKey(key) {
  return /^(remaining_keys|remainingCommands)$/i.test(String(key || ""));
}

function generatedRouteCommandText(text) {
  return /\b(?:press|hold|wait):(left|right|up|down)\b/i.test(String(text || ""));
}

function generatedRouteStepHeading(text) {
  return /###\s*Step\s+\d+\s+[-\u2014]?\s*(?:press|hold|wait):/i.test(String(text || ""));
}

function generatedRouteSequenceKeyText(text) {
  return /\b(?:remainingCommands|remaining_keys)\b/i.test(String(text || ""));
}

function hasGeneratedRouteTraceMarker(value, depth = 0) {
  if (depth > 8 || value == null) return false;
  if (typeof value === "string") {
    return (
      /Generated path keys/i.test(value) ||
      generatedRouteSequenceKeyText(value) ||
      generatedRouteCommandText(value) ||
      generatedRouteStepHeading(value)
    );
  }
  if (Array.isArray(value)) return value.some((item) => hasGeneratedRouteTraceMarker(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => {
    if (isGeneratedRouteSequenceKey(key)) return true;
    return hasGeneratedRouteTraceMarker(item, depth + 1);
  });
}

function redactGeneratedRouteTraceValue(value, inGeneratedRouteTrace = false, keyName = "") {
  if (isGeneratedRouteSequenceKey(keyName)) {
    const count = generatedRouteCommandCount(value);
    return {
      redacted: "generated_route_sequence",
      remainingCommandCount: count == null ? undefined : count,
    };
  }

  if (typeof value === "string") {
    let out = value
      .replace(/\s*Generated path keys:\s*"[^"]*"/gi, " generated route sequence redacted")
      .replace(/\s*Generated path keys:\s*&quot;[\s\S]*?&quot;/gi, " generated route sequence redacted")
      .replace(/\s*Generated path keys:\s*'[^']*'/gi, " generated route sequence redacted")
      .replace(/\s*Generated path keys:\s*\[[^\]]*\]/gi, " generated route sequence redacted")
      .replace(/\b(?:remainingCommands|remaining_keys)\b/gi, "remainingCommandCount");
    if (inGeneratedRouteTrace || generatedRouteCommandText(out) || generatedRouteStepHeading(out) || generatedRouteSequenceKeyText(out)) {
      out = out
        .replace(/\b(?:press|hold|wait):(left|right|up|down)\b/gi, "input_redacted")
        .replace(/(###\s*Step\s+\d+\s+[-\u2014]?\s*)(?:press|hold|wait):[^\n"(]*/gi, "$1input_redacted");
    }
    return out;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactGeneratedRouteTraceValue(item, inGeneratedRouteTrace, ""));
  }

  if (!value || typeof value !== "object") return value;

  const routeContext = inGeneratedRouteTrace || hasGeneratedRouteTraceMarker(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (isGeneratedRouteSequenceKey(key)) {
      const count = generatedRouteCommandCount(item);
      out.generatedRouteSequence = "redacted";
      if (count != null) out.remainingCommandCount = count;
      continue;
    }
    if (routeContext && /^(command|commands)$/i.test(key)) {
      out[key] = "[redacted generated route command]";
      continue;
    }
    out[key] = redactGeneratedRouteTraceValue(item, routeContext, key);
  }
  return out;
}

function redactGeneratedPathKeySequenceJsonText(text) {
  const raw = String(text || "");
  const trimmed = raw.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!hasGeneratedRouteTraceMarker(parsed)) return null;
  return JSON.stringify(redactGeneratedRouteTraceValue(parsed, true));
}

function findJsonLiteralEnd(text, start) {
  const opener = text[start];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : null;
  if (!closer) return -1;
  const stack = [closer];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (char !== stack[stack.length - 1]) return -1;
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

function redactEmbeddedGeneratedPathKeySequenceJsonText(text) {
  const raw = String(text || "");
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char !== "{" && char !== "[") {
      out += char;
      continue;
    }
    const end = findJsonLiteralEnd(raw, index);
    if (end < index) {
      out += char;
      continue;
    }
    const candidate = raw.slice(index, end + 1);
    const redacted = redactGeneratedPathKeySequenceJsonText(candidate);
    if (redacted) {
      out += redacted;
      index = end;
      continue;
    }
    out += char;
  }
  return out;
}

function redactGeneratedPathKeySequenceText(text) {
  const raw = String(text || "");
  const jsonRedacted = redactGeneratedPathKeySequenceJsonText(raw);
  const embeddedJsonRedacted = jsonRedacted || redactEmbeddedGeneratedPathKeySequenceJsonText(raw);
  return embeddedJsonRedacted
    .replace(/\s*Generated path keys:\s*"[^"]*"/gi, " Generated route sequence redacted")
    .replace(/\s*Generated path keys:\s*&quot;[\s\S]*?&quot;/gi, " Generated route sequence redacted")
    .replace(/\s*Generated path keys:\s*'[^']*'/gi, " Generated route sequence redacted")
    .replace(/\s*Generated path keys:\s*\[[^\]]*\]/gi, " Generated route sequence redacted")
    .replace(/^\s*-\s*remainingCommands:\s*.*$/gim, "- remainingCommandCount: [redacted generated route sequence]")
    .replace(/"remaining_keys"\s*:\s*\[[\s\S]*?\]/gi, '"remainingCommandCount":"[redacted generated route sequence]"')
    .replace(/"remainingCommands"\s*:\s*\[[\s\S]*?\]/gi, '"remainingCommandCount":"[redacted generated route sequence]"')
    .replace(/\b(?:remainingCommands|remaining_keys)\b/gi, "remainingCommandCount")
    .replace(/^(\s*### Step\s+\d+\s+.*?)(?:press|hold|wait):[^\n(]*(.*)$/gim, "$1input_redacted$2")
    .replace(/(###\s*Step\s+\d+\s+[-\u2014]?\s*)(?:press|hold|wait):[^\n"(]*/gi, "$1input_redacted")
    .replace(/\b(?:press|hold|wait):(left|right|up|down)\b/gi, "input_redacted");
}

function redactOracleNavigationText(text) {
  return String(text || "")
    .replace(ORACLE_CONSTANT_TOKEN_PATTERN, "[redacted_internal_constant]")
    .replace(
      /\b(targetMapName|targetMapId|targetMapConstant|destinationMapName|destinationMapId|destinationMapConstant|anchor|eventsBank|eventsSymbol|matrixName|matrixCellX|matrixCellY)\s*[:=]\s*"[^"]*"/gi,
      "navigation_oracle=[redacted]"
    )
    .replace(
      /\b(targetMapName|targetMapId|targetMapConstant|destinationMapName|destinationMapId|destinationMapConstant|anchor|eventsBank|eventsSymbol|matrixName|matrixCellX|matrixCellY)\s*[:=]\s*[^,\s<>)\]}]+/gi,
      "navigation_oracle=[redacted]"
    )
    .replace(
      /\b(targetMapName|targetMapId|targetMapConstant|destinationMapName|destinationMapId|destinationMapConstant|anchor|eventsBank|eventsSymbol|matrixName|matrixCellX|matrixCellY)\s+(?:"[^"]*"|'[^']*'|[^\n,.;<>)\]}]{1,80})/gi,
      "navigation_oracle=[redacted]"
    );
}

function sanitizeModelText(text) {
  const value = String(text || "");
  if (!shouldSanitizeModelText()) return value;
  const diagnosticKeyPattern = diagnosticKeyPatternForMode();

  let sanitized = redactOracleNavigationText(redactGeneratedPathKeySequenceText(value))
    .replace(ORACLE_LEAK_TEXT_PATTERN, "[redacted monitor-only marker]")
    .replace(BASE_HEX_OFFSET_PATTERN, "[redacted address]")
    .replace(BARE_HEX_ADDRESS_PATTERN, "[redacted address]")
    .replace(/<BENCHMARK_CONTEXT>[\s\S]*?<\/BENCHMARK_CONTEXT>/gi, "<GAME_CONTEXT>redacted historical context</GAME_CONTEXT>")
    .replace(/<GAME_CONTEXT>[\s\S]*?<\/GAME_CONTEXT>/gi, "<GAME_CONTEXT>redacted historical context</GAME_CONTEXT>")
    .replace(new RegExp(`"?(${diagnosticKeyPattern})"?\\s*:\\s*[\\s\\S]*?(?=\\n\\s*[,}\\]]|\\n<\\/|$)`, "gi"), '"redacted_monitor_only": "redacted"')
    .replace(new RegExp(`^.*\\b(${diagnosticKeyPattern})\\b.*$`, "gim"), "[monitor-only history line redacted]")
    .replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, "[local path redacted]")
    .replace(new RegExp(`"(${POINTER_LIKE_KEY_PATTERN})"\\s*:\\s*"[^"]*"`, "gi"), '"$1":"[redacted pointer]"')
    .replace(new RegExp(`"(${POINTER_LIKE_KEY_PATTERN})"\\s*:\\s*-?\\d+`, "gi"), '"$1":"[redacted pointer]"')
    .replace(new RegExp(`\\b(${POINTER_LIKE_KEY_PATTERN})\\s*=\\s*"[^"]*"`, "gi"), '$1="[redacted pointer]"')
    .replace(new RegExp(`\\b(${POINTER_LIKE_KEY_PATTERN})\\s*=\\s*(?:0x)?[0-9A-Fa-f]+`, "gi"), '$1="[redacted pointer]"')
    .replace(/\s+\b(?:source|confidence|contract|screenshot_hash|context_epoch|frame|screenshot_age_ms|heartbeat_age_seconds)="[^"]*"/gi, "")
    .replace(new RegExp(`^.*\\b(${POINTER_LIKE_KEY_PATTERN})\\b.*$\\n?`, "gim"), "");

  if (!isPrimaryVisualMode()) return sanitized;

  sanitized = redactHistoricalNavigationTraceText(sanitized);

  return sanitized
    .replace(/<player_location\b[^>]*\/>/gi, '<player_location current_observation="not_shown">historical navigation redacted</player_location>')
    .replace(/<player_stats>[\s\S]*?<\/player_stats>/gi, "<player_stats>historical player stats redacted from model surface</player_stats>")
    .replace(/<battle_state[\s\S]*?<\/battle_state>/gi, '<battle_state current_observation="not_shown">historical battle state redacted from model surface</battle_state>')
    .replace(/<visible_area>[\s\S]*?<\/visible_area>/gi, "<visible_area>historical visible-area text redacted; use the current screenshot</visible_area>")
    .replace(/<explored_map>[\s\S]*?<\/explored_map>/gi, "<explored_map>historical minimap text redacted; use the current observation</explored_map>")
    .replace(/^\s*-\s*Map:\s*.*$/gim, "- Map: [redacted from primary visual history]")
    .replace(/^\s*-\s*Position:\s*.*$/gim, "- Position: [redacted from primary visual history]")
    .replace(/^\s*Map updates:\s*$/gim, "Map updates: [redacted from primary visual history]")
    .replace(/^\s*-\s*(collision_to_free|free_to_collision|tiles_discovered)\s*\([^)]*\):.*$/gim, "- map update redacted from primary visual history")
    .replace(/^\s*-\s*startedInDialog:\s*(true|false)\s*$/gim, "- action monitor trace redacted from primary visual history")
    .replace(/^\s*-\s*interruptedByDialog:\s*(true|false)\s*$/gim, "- action monitor trace redacted from primary visual history")
    .replace(/^\s*-\s*interruptedAtIndex:\s*\d+\s*$/gim, "- action monitor trace redacted from primary visual history")
    .replace(/^\s*-\s*interruptedByCollision:\s*(true|false)\s*$/gim, "- action monitor trace redacted from primary visual history")
    .replace(/^\s*-\s*collisionStreak:\s*\d+\s*$/gim, "- action monitor trace redacted from primary visual history")
    .replace(/\b(map_id|x|y|z)\s*=\s*-?\d+\b/gi, "$1=[redacted]")
    .replace(/"(map_id|x|y|z)"\s*:\s*"?-?\d+"?/gi, '"$1":"redacted"');
}

function sanitizeCurrentPromptText(text) {
  const value = String(text || "");
  if (!shouldSanitizeModelText()) return value;
  const diagnosticKeyPattern = diagnosticKeyPatternForMode();

  return redactOracleNavigationText(redactGeneratedPathKeySequenceText(value))
    .replace(ORACLE_LEAK_TEXT_PATTERN, "[redacted monitor-only marker]")
    .replace(BASE_HEX_OFFSET_PATTERN, "[redacted address]")
    .replace(BARE_HEX_ADDRESS_PATTERN, "[redacted address]")
    .replace(new RegExp(`"?(${diagnosticKeyPattern})"?\\s*:\\s*[\\s\\S]*?(?=\\n\\s*[,}\\]]|\\n<\\/|$)`, "gi"), '"redacted_monitor_only": "redacted"')
    .replace(new RegExp(`^.*\\b(${diagnosticKeyPattern})\\b.*$`, "gim"), "[monitor-only history line redacted]")
    .replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, "[local path redacted]")
    .replace(new RegExp(`"(${POINTER_LIKE_KEY_PATTERN})"\\s*:\\s*"[^"]*"`, "gi"), '"$1":"[redacted pointer]"')
    .replace(new RegExp(`"(${POINTER_LIKE_KEY_PATTERN})"\\s*:\\s*-?\\d+`, "gi"), '"$1":"[redacted pointer]"')
    .replace(new RegExp(`\\b(${POINTER_LIKE_KEY_PATTERN})\\s*=\\s*"[^"]*"`, "gi"), '$1="[redacted pointer]"')
    .replace(new RegExp(`\\b(${POINTER_LIKE_KEY_PATTERN})\\s*=\\s*(?:0x)?[0-9A-Fa-f]+`, "gi"), '$1="[redacted pointer]"')
    .replace(/\s+\b(?:source|confidence|contract|screenshot_hash|context_epoch|frame|screenshot_age_ms|heartbeat_age_seconds)="[^"]*"/gi, "")
    .replace(new RegExp(`^.*\\b(${POINTER_LIKE_KEY_PATTERN})\\b.*$\\n?`, "gim"), "");
}

function containsDiagnosticKey(text) {
  return diagnosticKeyRegexForMode().test(String(text || ""));
}

function sanitizeActionForModelSurface(action) {
  if (!action || typeof action !== "object") return action;
  const type = String(action.type || "");

  if (isPrimaryVisualMode() && ["path_to_location", "add_marker", "delete_marker"].includes(type)) {
    return {
      type,
      redacted: true,
      reason: "coordinate/map action is not part of the primary visual observation surface",
    };
  }

  const sanitized = { ...action };
  if (isPrimaryVisualMode()) {
    for (const key of ["map_id", "map_name"]) {
      if (key in sanitized) sanitized[key] = null;
    }
  }
  if (typeof sanitized.value === "string") sanitized.value = sanitizeModelText(sanitized.value);
  if (typeof sanitized.explanation === "string") sanitized.explanation = sanitizeModelText(sanitized.explanation);
  if (typeof sanitized.label === "string") sanitized.label = sanitizeModelText(sanitized.label);
  return sanitizeModelValue(sanitized);
}

function sanitizeFunctionCallArguments(name, argsString) {
  if (!shouldSanitizeModelText()) return argsString;
  const raw = String(argsString || "");
  if (String(name || "") !== "execute_action") return sanitizeModelText(raw);

  try {
    const parsed = JSON.parse(raw);
    const safe = { ...parsed };
    if (Array.isArray(safe.actions)) safe.actions = safe.actions.map(sanitizeActionForModelSurface);
    const hasRedactedCoordinateAction = Array.isArray(safe.actions) && safe.actions.some((action) => action?.redacted);
    if (hasRedactedCoordinateAction) {
      safe.step_details = "[historical coordinate/navigation action rationale redacted in primary visual history]";
      if (typeof safe.chat_message === "string") {
        safe.chat_message = "[historical coordinate/navigation action message redacted in primary visual history]";
      }
    } else {
      if (typeof safe.step_details === "string") safe.step_details = sanitizeModelText(safe.step_details);
      if (typeof safe.chat_message === "string") safe.chat_message = sanitizeModelText(safe.chat_message);
    }
    return JSON.stringify(safe);
  } catch {
    const sanitized = sanitizeModelText(raw);
    if (!isPrimaryVisualMode()) return sanitized;
    return sanitized
      .replace(/"map_id"\s*:\s*"[^"]*"/gi, '"map_id":"redacted"')
      .replace(/"map_name"\s*:\s*"[^"]*"/gi, '"map_name":"redacted"')
      .replace(/"type"\s*:\s*"(path_to_location|add_marker|delete_marker)"/gi, '"type":"redacted_coordinate_action"');
  }
}

function sanitizeModelValueStrings(value) {
  if (typeof value === "string") return sanitizeModelText(value);
  if (Array.isArray(value)) return value.map(sanitizeModelValueStrings);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (ORACLE_NAVIGATION_KEY_PATTERN.test(key)) {
      out.redactedNavigationOracle = "[redacted]";
      continue;
    }
    if (HIDDEN_POKEMON_MECHANIC_KEY_PATTERN.test(key)) {
      out.redactedHiddenPokemonMechanic = "[redacted]";
      continue;
    }
    if (RAW_POKEMON_ID_KEY_PATTERN.test(key)) {
      out.redactedRawPokemonId = "[redacted]";
      continue;
    }
    out[key] = sanitizeModelValueStrings(item);
  }
  return out;
}

function sanitizeModelValue(value) {
  if (!shouldSanitizeModelText()) return value;
  if (typeof value === "string") return sanitizeModelText(value);
  const routeSafe = redactGeneratedRouteTraceValue(value, false);
  return sanitizeModelValueStrings(routeSafe);
}

module.exports = {
  redactHistoricalNavigationTraceText,
  sanitizeCurrentPromptText,
  sanitizeFunctionCallArguments,
  sanitizeModelText,
  sanitizeModelValue,
  containsDiagnosticKey,
  shouldSanitizeModelText,
  _private: { isPrimaryVisualMode, redactGeneratedPathKeySequenceText },
};
