const fs = require("fs").promises;
const path = require("path");

const { state } = require("../state/stateManager");
const { config } = require("../config");
const { gameAreaToMarkdown, minimapToMarkdown } = require("../formatters/markdownFormatter");
const {
  buildObservationExposure,
  playerCoordinateFrame,
  validatedVisibleInteractableSurface,
  validatedRuntimeObjectSurface,
} = require("./observationContract");
const { sanitizeCurrentPromptText, sanitizeModelText } = require("./modelSurfaceSanitizer");

let cachedGamePromptText = null;

function escapeXml(text) {
  if (text == null) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function runtimeObjectLabelLooksRaw(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  return /^(?:object|npc|runtime_object|sprite)[\s_-]?#?\d+$/i.test(text) || /^SPRITE_/i.test(text);
}

function safeRuntimeObjectLabel(npc) {
  for (const value of [npc?.objectLabel, npc?.object_label, npc?.name, npc?.label]) {
    const text = String(value ?? "").trim();
    if (text && !runtimeObjectLabelLooksRaw(text)) return text;
  }
  return "runtime_object";
}

function coordinatePointForPrompt(point, coordinateFrame) {
  const xNumber = Number(point?.x);
  const yNumber = Number(point?.y ?? point?.z);
  const x = Number.isFinite(xNumber) ? Math.trunc(xNumber) : point?.x ?? "";
  const y = Number.isFinite(yNumber) ? Math.trunc(yNumber) : point?.y ?? point?.z ?? "";
  const matrixGlobal = coordinateFrame?.coordinateMode === "matrix_global_position";
  const localX =
    point?.localX ??
    point?.local_x ??
    (matrixGlobal && Number.isFinite(xNumber) && coordinateFrame?.originX != null
      ? Math.trunc(xNumber) - coordinateFrame.originX
      : "");
  const localY =
    point?.localY ??
    point?.local_y ??
    (matrixGlobal && Number.isFinite(yNumber) && coordinateFrame?.originY != null
      ? Math.trunc(yNumber) - coordinateFrame.originY
      : "");
  return { x, y, localX, localY };
}

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

function normalizedScreenshotHash(value) {
  return String(value || "").trim().toLowerCase();
}

function hasUsableScreenshotHash(value) {
  const hash = normalizedScreenshotHash(value);
  return hash.length >= 10 && !INVALID_SCREENSHOT_HASHES.has(hash);
}

function currentObservationScreenshotHash(gameDataJson) {
  return normalizedScreenshotHash(
    gameDataJson?.observationFreshness?.screenshotHash ||
      gameDataJson?.screenshotHash ||
      gameDataJson?.emulator?.screenshotHash ||
      ""
  );
}

function matchesCurrentObservationScreenshot(entry, gameDataJson) {
  const textHash = normalizedScreenshotHash(entry?.screenshotHash);
  const currentHash = currentObservationScreenshotHash(gameDataJson);
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
    matchesCurrentObservationScreenshot(entry, gameDataJson) &&
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
    matchesCurrentObservationScreenshot(entry, gameDataJson) &&
    typeof entry.text === "string" &&
    entry.text.trim()
  );
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

function formatMemoryStructured(memoryObj) {
  const entries = memoryObj && typeof memoryObj === "object" ? Object.entries(memoryObj) : [];
  if (entries.length === 0) return "<memory />\n";

  const lines = ["<memory>"];
  for (const [k, v] of entries) {
    lines.push(`  <item key="${escapeXml(sanitizeModelText(k))}">${escapeXml(sanitizeModelText(v))}</item>`);
  }
  lines.push("</memory>");
  return lines.join("\n") + "\n";
}

function formatRecentMarkers(markers, lastVisitedMaps, isInDialog) {
  if (!markers || typeof markers !== "object" || Object.keys(markers).length === 0) {
    return "<markers>No markers set</markers>\n";
  }

  if (isInDialog) {
    return "<markers>Markers are not visible in dialogue</markers>\n";
  }

  const visited = Array.isArray(lastVisitedMaps) ? lastVisitedMaps : [];
  const lastVisitedMapIds = new Set(visited.map((entry) => String(entry?.map_id ?? "")));
  const mapIdToName = new Map(
    visited
      .filter((e) => e && typeof e === "object" && e.map_id != null)
      .map((e) => [String(e.map_id), String(e.map_name || `Unknown Map (${e.map_id})`)])
  );

  const mapMarkerStrings = [];
  for (const [mapId, mapMarkers] of Object.entries(markers)) {
    if (!lastVisitedMapIds.has(String(mapId))) continue;
    if (!mapMarkers || typeof mapMarkers !== "object" || Object.keys(mapMarkers).length === 0) continue;

    const mapName = sanitizeModelText(
      mapIdToName.get(String(mapId)) ||
      mapMarkers[Object.keys(mapMarkers)[0]]?.map_name ||
      `Unknown Map (${mapId})`
    );

    const sortedCoords = Object.keys(mapMarkers).sort((a, b) => {
      const [ax, ay] = a.split("_").map(Number);
      const [bx, by] = b.split("_").map(Number);
      if (ay !== by) return ay - by;
      return ax - bx;
    });

    const individualMarkerStrings = [];
    for (const coords of sortedCoords) {
      const marker = mapMarkers[coords];
      if (!marker || typeof marker !== "object") continue;
      const [x, y] = coords.split("_");
      const safeEmoji = sanitizeModelText(marker.emoji || "");
      const safeLabel = sanitizeModelText(marker.label || "");
      individualMarkerStrings.push(`(${sanitizeModelText(x)}, ${sanitizeModelText(y)})=${safeEmoji} ${safeLabel}`);
    }

    if (individualMarkerStrings.length === 0) continue;

    mapMarkerStrings.push(`  <map_markers map_id="${escapeXml(sanitizeModelText(mapId))}" map_name="${escapeXml(mapName)}">
  ${individualMarkerStrings.map((s) => escapeXml(s)).join("\n    ")}
</map_markers>`);
  }

  if (mapMarkerStrings.length === 0) {
    return "<markers>No markers set in recently visited maps</markers>\n";
  }

  return `           
<markers>
Your current markers from recently visited maps:
${mapMarkerStrings.join("\n")}
Notes:
- The markers may be inaccurate since you defined them yourself.
- Fix or delete markers as soon as you notice they are inaccurate.
- Remember marker ownership: All markers are set by you; they are not extracted from RAM.
</markers>
\n`;
}

function formatObjectives(objectives) {
  if (!objectives || typeof objectives !== "object") return "<objectives />\n";

  const safe = (o) => (o && typeof o === "object" ? o : { short_description: "", description: "" });
  const primary = safe(objectives.primary);
  const secondary = safe(objectives.secondary);
  const third = safe(objectives.third);
  const others = Array.isArray(objectives.others) ? objectives.others : [];

  const lines = ["<objectives>"];
  lines.push(
    `  <primary short="${escapeXml(sanitizeModelText(primary.short_description || ""))}">${escapeXml(sanitizeModelText(primary.description || ""))}</primary>`
  );
  lines.push(
    `  <secondary short="${escapeXml(sanitizeModelText(secondary.short_description || ""))}">${escapeXml(
      sanitizeModelText(secondary.description || "")
    )}</secondary>`
  );
  lines.push(
    `  <third short="${escapeXml(sanitizeModelText(third.short_description || ""))}">${escapeXml(sanitizeModelText(third.description || ""))}</third>`
  );
  if (others.length > 0) {
    lines.push("  <others>");
    for (const o of others) {
      const oo = safe(o);
      lines.push(
        `    <objective short="${escapeXml(sanitizeModelText(oo.short_description || ""))}">${escapeXml(
          sanitizeModelText(oo.description || "")
        )}</objective>`
      );
    }
    lines.push("  </others>");
  }
  lines.push("</objectives>");
  return lines.join("\n") + "\n";
}

function formatReliabilityDetails(gameDataJson) {
  const details = gameDataJson?.stateReliabilityDetails;
  const freshness = gameDataJson?.observationFreshness;
  const policy = gameDataJson?.observationPolicy;
  const exposure = buildObservationExposure(gameDataJson);
  const isRamAssisted = exposure.mode === "ram_assisted";
  const ramFields = ["position", "facing", "party", "inventory", "pcStorage", "progress", "money", "badges", "battle", "dialogue", "menu", "naming", "npcs", "interactables", "warps", "currentConnections", "romCollision"];
  const lines = [
    `<observation_surface mode="${escapeXml(policy?.mode || config.observation.mode)}">`,
    isRamAssisted
      ? "  <current_state>Use the current screenshot, RAM fields shown below, model-owned memory/objectives/markers, and sanitized prior action traces.</current_state>"
      : "  <current_state>Use the current screenshot, model-owned memory/objectives, and sanitized prior action traces.</current_state>",
    isRamAssisted
      ? "  <ram_rule>Every gameplay RAM field shown here is current-state game information.</ram_rule>"
      : "  <visual_rule>RAM-derived gameplay fields are not part of primary_visual gameplay.</visual_rule>",
  ];

  if (freshness && typeof freshness === "object") {
    lines.push(
      `  <freshness screenshot_hash="${escapeXml(freshness.screenshotHash || "")}" screenshot_age_ms="${escapeXml(freshness.screenshotAgeMs ?? "unknown")}" heartbeat_age_seconds="${escapeXml(freshness.heartbeatAgeSeconds ?? "unknown")}" visual_available="${freshness.visualAvailable === false ? "false" : "true"}" />`
    );
  }

  if (exposure.mode === "visual") {
    lines.push("  <ram_surface current_observation=\"not_shown\" />");
  } else if (details && typeof details === "object") {
    lines.push("  <ram_surface>");
    const validatedFields = [];
    if (navigationShownInRamPrompt(exposure)) validatedFields.push("position", "map", "minimap", "pathfinding");
    for (const field of ramFields) {
      if (fieldShownInRamPrompt(exposure, field)) validatedFields.push(field);
    }
    if (validatedFields.length === 0) {
      lines.push("    <none />");
    } else {
      for (const field of [...new Set(validatedFields)]) {
        if (["warps", "interactables", "currentConnections", "romCollision", "npcs"].includes(field) && !navigationShownInRamPrompt(exposure)) {
          continue;
        }
        lines.push(`    <field name="${escapeXml(field)}" />`);
      }
    }
    lines.push("  </ram_surface>");
  }

  lines.push("</observation_surface>");
  return lines.join("\n");
}

function formatUnavailableState(exposure) {
  return "";
}

function exposeAllDecodedRamForPrompt(exposure) {
  return Boolean(
    config.isHeartGold &&
      config.observation.exposeAllDecodedRam === true &&
      (exposure?.mode === "ram_assisted" || exposure?.diagnosticsAllowed === true)
  );
}

function fieldShownInRamPrompt(exposure, field) {
  return exposure?.fields?.[field]?.validated === true || exposeAllDecodedRamForPrompt(exposure);
}

function navigationShownInRamPrompt(exposure) {
  return (
    exposure?.navigation?.validated === true ||
    exposure?.location?.validated === true ||
    exposeAllDecodedRamForPrompt(exposure)
  );
}

function formatRecentVisibleText(gameDataJson, exposure) {
  if (!config.isHeartGold || exposure.mode !== "ram_assisted") return "";
  const entries = Array.isArray(gameDataJson?.recent_visible_text)
    ? gameDataJson.recent_visible_text
    : [];
  const battleCurrentlyActive = heartGoldBattleAuthoritativelyActive(gameDataJson);
  const fieldDialogueCurrentlyActive = isOwnerBoundCurrentFieldDialogueText(
    gameDataJson?.current_visible_text,
    gameDataJson
  );
  const currentUiCurrentlyActive = isOwnerBoundCurrentUiText(gameDataJson?.current_visible_text, gameDataJson);
  const surfaceAllowed = (surface) => {
    if (surface === "battle") return battleCurrentlyActive;
    if (surface === "field_dialogue") return fieldDialogueCurrentlyActive && !battleCurrentlyActive;
    if (surface === "current_ui") return currentUiCurrentlyActive && !battleCurrentlyActive;
    return false;
  };
  const decoderContractAllowed = (entry) => {
    const surface = entry?.surface || "";
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
    ].includes(entry?.decoderContract || entry?.decoder_contract || "");
  };
  const recentVisibilityContractAllowed = (entry) => {
    if ((entry?.surface || "") !== "battle") return true;
    return entry?.visibilityContract === "owner_bound_battle_textprinter_complete_v1";
  };
  const validatedEntries = entries
    .filter(
      (entry) =>
        entry &&
        entry.active === true &&
        entry.source === "ram_visible_text" &&
        entry.confidence === "validated_current" &&
        entry.contract === "current_visible_text_v1_recent_observed" &&
        decoderContractAllowed(entry) &&
        recentVisibilityContractAllowed(entry) &&
        surfaceAllowed(entry.surface || "unknown") &&
        Number.isFinite(Number(entry.frame)) &&
        Number.isFinite(Number(entry.contextEpoch)) &&
        Number(entry.contextEpoch) >= 0 &&
        hasUsableScreenshotHash(entry.screenshotHash) &&
        typeof entry.text === "string" &&
        entry.text.trim()
    )
    .slice(-6);
  if (validatedEntries.length === 0) return "";
  const lines = ["<recent_visible_text>"];
  for (const entry of validatedEntries) {
    lines.push(`  <text surface="${escapeXml(entry.surface || "unknown")}">${escapeXml(entry.text.trim())}</text>`);
  }
  lines.push("</recent_visible_text>");
  return lines.join("\n");
}

function formatInventory(inventory) {
  if (!inventory || typeof inventory !== "object") return "<inventory />\n";

  const pocketOrder = [
    "item_pocket",
    "medicine_pocket",
    "key_item_pocket",
    "ball_pocket",
    "battle_items_pocket",
    "tm_case",
    "berries_pocket",
    "mail_pocket",
  ];
  const pocketLabels = {
    item_pocket: "Items",
    medicine_pocket: "Medicine",
    key_item_pocket: "Key Items",
    ball_pocket: "Balls",
    battle_items_pocket: "Battle Items",
    tm_case: "TM Case",
    berries_pocket: "Berries",
    mail_pocket: "Mail",
  };

  const lines = ["<inventory>"];

  for (const pocketName of pocketOrder) {
    const pocket = inventory[pocketName];
    if (!Array.isArray(pocket) || pocket.length === 0) continue;
    lines.push(`  <pocket name="${escapeXml(pocketLabels[pocketName] || pocketName)}">`);
    pocket.forEach(([itemName, qty]) => {
      lines.push(`    <item name="${escapeXml(itemName)}" quantity="${Number(qty) || 0}" />`);
    });
    lines.push("  </pocket>");
  }

  const registeredItems = Array.isArray(inventory.registered_items) ? inventory.registered_items : [];
  if (registeredItems.length > 0) {
    lines.push("  <registered_items>");
    registeredItems.forEach((item) => {
      lines.push(
        `    <registered_item slot="${Number(item?.slot) || 0}" name="${escapeXml(
          item?.name || ""
        )}" />`
      );
    });
    lines.push("  </registered_items>");
  }

  lines.push("</inventory>");
  return lines.join("\n") + "\n";
}

function formatProgressFlags(progress) {
  if (!progress || typeof progress !== "object" || progress.validated !== true) {
    return `<progress_flags current_observation="not_shown" />\n`;
  }
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(progress, key);
  const boolAttr = (key) => {
    if (!hasOwn(key)) return null;
    return `${key}="${progress[key] === true ? "true" : "false"}"`;
  };
  const attrs = [
    `got_starter="${progress.got_starter === true ? "true" : "false"}"`,
    `got_pokedex="${progress.got_pokedex === true ? "true" : "false"}"`,
    `got_pokegear="${progress.got_pokegear === true ? "true" : "false"}"`,
    `got_bag="${progress.got_bag === true ? "true" : "false"}"`,
  ];
  for (const key of [
    "strength_enabled",
    "safari_zone_active",
    "safari_zone_has_step_limit",
    "flash_active",
    "defog_active",
  ]) {
    const attr = boolAttr(key);
    if (attr) attrs.push(attr);
  }
  if (hasOwn("safari_zone_steps_remaining")) {
    const steps = progress.safari_zone_steps_remaining;
    const stepText = Number.isInteger(steps)
      ? String(steps)
      : progress.safari_zone_active === true && progress.safari_zone_has_step_limit === false
        ? "none"
        : "";
    if (stepText) attrs.push(`safari_zone_steps_remaining="${stepText}"`);
  }
  if (Number.isInteger(progress.safari_zone_balls_remaining)) {
    attrs.push(`safari_zone_balls_remaining="${progress.safari_zone_balls_remaining}"`);
  }
  if (progress.starter_species_name) attrs.push(`starter="${escapeXml(progress.starter_species_name)}"`);
  return `<progress_flags ${attrs.join(" ")} />\n`;
}

function formatPcItems(pcItems) {
  const items = Array.isArray(pcItems) ? pcItems : [];
  const lines = [`<pc_items slot_count="${items.length}/50">`];
  if (items.length === 0) {
    lines.push("  <info>PC is empty</info>");
    lines.push("</pc_items>");
    return lines.join("\n") + "\n";
  }

  items.forEach((item, idx) => {
    lines.push(
      `  <item index_id="${idx}" name="${escapeXml(item?.name || "")}" quantity="${Number(item?.quantity) || 0}" />`
    );
  });
  lines.push("</pc_items>");
  return lines.join("\n") + "\n";
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

function formatPcPokemon(pcData) {
  if (!pcStorageDataValidated(pcData)) {
    return `<pc_pokemon current_observation="not_shown" />\n`;
  }
  const currentBox = Number(pcData?.current_box) || 1;
  const mons = Array.isArray(pcData?.pokemons) ? pcData.pokemons : [];
  const lines = [`<pc_pokemon current_box="${currentBox}" slot_count="${mons.length}/30">`];

  if (mons.length === 0) {
    lines.push("  <info>No Pokemon in PC</info>");
    lines.push("</pc_pokemon>");
    return lines.join("\n") + "\n";
  }

  for (const pokemon of mons) {
    if (!pokemon) continue;
    const nickname = pokemon.nickname || pokemon.species_name || "";
    const moves = Array.isArray(pokemon.moves) ? pokemon.moves : [];
    const moveList = moves.map((m) => `${m.name} (${Number(m.pp) || 0} PP)`).join(", ");
    const types = Array.isArray(pokemon.types) ? pokemon.types.join(", ") : "";

    const levelValue = Number(pokemon.level);
    const levelKnown = pokemon.level_known !== false && Number.isFinite(levelValue) && levelValue > 0;
    const levelAttr = levelKnown ? ` level="${levelValue}"` : "";
    const slotValue = Number(pokemon.box_slot ?? pokemon.slot ?? pokemon.slot_id);
    const heldItemNameRaw = typeof pokemon.held_item_name === "string" ? pokemon.held_item_name : "";
    const heldItemName = heldItemNameRaw || "NONE";
    lines.push(
      `  <pokemon slot="${Number.isFinite(slotValue) ? slotValue : 0}" species="${escapeXml(
        pokemon.species_name || ""
      )}" nickname="${escapeXml(nickname)}"${levelAttr}>`
    );
    lines.push(`    <held_item name="${escapeXml(heldItemName)}" />`);
    lines.push(`    <moves>${escapeXml(moveList)}</moves>`);
    lines.push(`    <types>${escapeXml(types)}</types>`);
    lines.push(`    <status>${escapeXml(pokemon.status || "OK")}</status>`);
    lines.push("  </pokemon>");
  }

  lines.push("</pc_pokemon>");
  return lines.join("\n") + "\n";
}

function formatPokemonTeam(team, partySummary = null) {
  const mons = Array.isArray(team) ? team : [];
  const lines = ["<pokemon_team>"];
  if (mons.length === 0) {
    lines.push("  <info>No Pokemon party shown in current RAM.</info>");
    lines.push("</pokemon_team>");
    return lines.join("\n") + "\n";
  }

  for (const pokemon of mons) {
    const nickname = pokemon.nickname || pokemon.species_name;
    const status = pokemon.status || "OK";
    const moves = Array.isArray(pokemon.moves) ? pokemon.moves : [];
    const ability = pokemon.ability || "UNKNOWN";
    const heldItemNameRaw = typeof pokemon.held_item_name === "string" ? pokemon.held_item_name : "";
    const heldItemName = heldItemNameRaw || "NONE";
    const expValue = pokemon.exp == null ? null : Number(pokemon.exp);
    const expAttr = Number.isFinite(expValue) ? ` exp="${expValue}"` : "";
    lines.push(
      `  <pokemon species="${escapeXml(pokemon.species_name)}" nickname="${escapeXml(
        nickname
      )}" level="${Number(pokemon.level) || 0}"${expAttr}>`
    );
    lines.push(`    <hp current="${Number(pokemon.current_hp) || 0}" max="${Number(pokemon.max_hp) || 0}" />`);
    lines.push(`    <held_item name="${escapeXml(heldItemName)}" />`);
    lines.push("    <moves>");
    for (const m of moves) {
      lines.push(`      <move name="${escapeXml(m.name)}" pp="${Number(m.pp) || 0}" />`);
    }
    lines.push("    </moves>");
    lines.push(`    <types>${escapeXml((pokemon.types || []).join(", "))}</types>`);
    lines.push(`    <ability>${escapeXml(ability)}</ability>`);
    lines.push(`    <status>${escapeXml(status)}</status>`);
    lines.push(`    <is_shiny>${pokemon.is_shiny ? "true" : "false"}</is_shiny>`);
    lines.push("  </pokemon>");
  }

  lines.push("</pokemon_team>");
  return lines.join("\n") + "\n";
}

function formatBattleStatStages(statStages) {
  if (!statStages || typeof statStages !== "object") return "";
  const keys = ["attack", "defense", "speed", "special_attack", "special_defense", "accuracy", "evasion"];
  const values = {};
  for (const key of keys) {
    const value = Number(statStages[key]);
    if (!Number.isInteger(value) || value < -6 || value > 6) return "";
    values[key] = value;
  }
  return `<stat_stages attack="${values.attack}" defense="${values.defense}" speed="${values.speed}" special_attack="${values.special_attack}" special_defense="${values.special_defense}" accuracy="${values.accuracy}" evasion="${values.evasion}" />`;
}

function formatBattleHpPercentage(currentHp, maxHp) {
  const current = Number(currentHp) || 0;
  const max = Number(maxHp) || 0;
  if (max <= 0) return "unknown";
  return `${Math.max(0, Math.min(100, Math.round((current / max) * 100)))}%`;
}

function battleBattlerLabel(battleData, targetBattlerId) {
  if (targetBattlerId == null) return "";
  const targetKey = String(targetBattlerId);
  const entries = [
    ...(Array.isArray(battleData?.player_pokemons) ? battleData.player_pokemons.map((mon) => ["player", mon]) : []),
    ...(Array.isArray(battleData?.enemy_pokemons) ? battleData.enemy_pokemons.map((mon) => ["enemy", mon]) : []),
  ];
  for (const [side, mon] of entries) {
    if (String(mon?.battler_id ?? "") !== targetKey) continue;
    const name = mon?.nickname || mon?.species_name || mon?.species;
    return name ? `${side} ${name}` : side;
  }
  return "";
}

function formatBattleState(battleData, battleAuthoritativelyActive = null) {
  const inBattle = battleAuthoritativelyActive == null ? Boolean(battleData?.in_battle) : battleAuthoritativelyActive === true;
  if (!inBattle) return `<battle_state active="false" />\n`;

  const playerMons = Array.isArray(battleData?.player_pokemons) ? battleData.player_pokemons : [];
  const enemyMons = Array.isArray(battleData?.enemy_pokemons) ? battleData.enemy_pokemons : [];

  const lines = [
    `<battle_state active="true" trainer_battle="${battleData?.is_trainer_battle ? "true" : "false"}" double_battle="${
      battleData?.is_double_battle ? "true" : "false"
    }">`,
  ];

  lines.push(`  <player_side count="${playerMons.length}">`);
  for (const p of playerMons) {
    if (!p) continue;
    const nickname = p.nickname || p.species_name;
    lines.push(
      `    <pokemon species="${escapeXml(p.species_name)}" nickname="${escapeXml(
        nickname
      )}" level="${Number(p.level) || 0}" position="${escapeXml(p.position || "")}">`
    );
    lines.push(`      <hp current="${Number(p.current_hp) || 0}" max="${Number(p.max_hp) || 0}" />`);
    lines.push(`      <status>${escapeXml(p.status || "OK")}</status>`);
    lines.push("      <moves>");
    for (const m of p.moves || []) {
      lines.push(`        <move name="${escapeXml(m.name)}" pp="${Number(m.pp) || 0}" />`);
    }
    lines.push("      </moves>");
    lines.push(`      <types>${escapeXml((p.types || []).join(", "))}</types>`);
    const statStages = formatBattleStatStages(p.stat_stages);
    if (statStages) lines.push(`      ${statStages}`);
    lines.push("    </pokemon>");
  }
  lines.push("  </player_side>");

  lines.push(`  <enemy_side count="${enemyMons.length}">`);
  for (const e of enemyMons) {
    if (!e) continue;
    const curHp = Number(e.current_hp) || 0;
    const maxHp = Number(e.max_hp) || 0;
    lines.push(
      `    <pokemon species="${escapeXml(e.species_name)}" level="${Number(e.level) || 0}" position="${escapeXml(
        e.position || ""
      )}">`
    );
    lines.push(`      <hp percentage="${formatBattleHpPercentage(curHp, maxHp)}" />`);
    lines.push(`      <status>${escapeXml(e.status || "OK")}</status>`);
    lines.push(`      <types>${escapeXml((e.types || []).join(", "))}</types>`);
    const statStages = formatBattleStatStages(e.stat_stages);
    if (statStages) lines.push(`      ${statStages}`);
    lines.push("    </pokemon>");
  }
  lines.push("  </enemy_side>");

  const battleInput = battleData?.battle_input && typeof battleData.battle_input === "object" ? battleData.battle_input : null;
  if (battleInput?.available === true) {
    lines.push(
      `  <battle_input available="true" menu="${escapeXml(battleInput.menu_name || "unknown")}" touch_disabled="${
        battleInput.touch_disabled ? "true" : "false"
      }">`
    );
    const actions = Array.isArray(battleInput.player_actions) ? battleInput.player_actions : [];
    for (const action of actions) {
      const selectedMove =
        action.selected_move_name
          ? ` selected_move="${escapeXml(action.selected_move_name || "unknown")}"`
          : "";
      const actorLabel = battleBattlerLabel(battleData, action.battler_id);
      const actor = actorLabel ? ` actor="${escapeXml(actorLabel)}"` : "";
      const targetLabel = battleBattlerLabel(battleData, action.target_battler_id);
      const targetBattler = targetLabel ? ` target="${escapeXml(targetLabel)}"` : "";
      lines.push(
        `    <battler_action${actor} command="${escapeXml(
          action.command_name || "unknown"
        )}" input_selection="${escapeXml(action.input_selection_name || "unknown")}"${selectedMove}${targetBattler} />`
      );
    }
    lines.push("  </battle_input>");
  } else {
    lines.push(`  <battle_input available="false">Battle menu/input is not currently available.</battle_input>`);
  }

  lines.push("</battle_state>");
  return lines.join("\n") + "\n";
}

function getScreenPhaseInfo(gameDataJson, { isInDialog, movementMode, exposure = null } = {}) {
  const detector = gameDataJson?.ram_assisted?.modeDetector || {};
  const battle = detector.battle && typeof detector.battle === "object" ? detector.battle : {};
  const dialog = detector.dialog && typeof detector.dialog === "object" ? detector.dialog : {};
  const menu = detector.menu && typeof detector.menu === "object" ? detector.menu : {};
  const naming = detector.naming && typeof detector.naming === "object" ? detector.naming : {};
  const battleCandidate = heartGoldBattleAuthoritativelyActive(gameDataJson);
  const namingValidated = fieldShownInRamPrompt(exposure, "naming") || exposure?.diagnosticsAllowed === true;
  const menuValidated = fieldShownInRamPrompt(exposure, "menu") || exposure?.diagnosticsAllowed === true;
  const movementPhaseValidated =
    (fieldShownInRamPrompt(exposure, "movement") || exposure?.diagnosticsAllowed === true) &&
    (navigationShownInRamPrompt(exposure) || exposure?.diagnosticsAllowed === true);
  const namingActive = !battleCandidate && namingValidated && naming.active === true;
  const validatedCurrentText = gameDataJson?.current_visible_text;
  const textFrame = Number(validatedCurrentText?.frame);
  const textEpoch = Number(validatedCurrentText?.contextEpoch);
  const anchoredValidatedText =
    Number.isFinite(textFrame) &&
    textFrame >= 0 &&
    Number.isFinite(textEpoch) &&
    textEpoch >= 0 &&
    matchesCurrentObservationScreenshot(validatedCurrentText, gameDataJson);
  const validatedDialogText =
    validatedCurrentText &&
    validatedCurrentText.active === true &&
    validatedCurrentText.source === "ram_visible_text" &&
    validatedCurrentText.confidence === "validated_current" &&
    validatedCurrentText.contract === "current_visible_text_v1" &&
    String(validatedCurrentText.surface || "") === "field_dialogue" &&
    (validatedCurrentText.decoderContract || validatedCurrentText.decoder_contract || "") === FIELD_VISIBLE_TEXT_DECODER_CONTRACT &&
    anchoredValidatedText &&
    typeof validatedCurrentText.text === "string" &&
    validatedCurrentText.text.trim();
  const validatedCurrentUiText = isOwnerBoundCurrentUiText(validatedCurrentText, gameDataJson);
  const dialogVisible = Boolean(validatedDialogText || validatedCurrentUiText);
  const rawMenuVisible =
    menu.active === true &&
    menu.source !== "unavailable" &&
    menu.confidence !== "candidate";
  const menuVisible = !battleCandidate && !namingActive && menuValidated && rawMenuVisible;
  let phase = "unknown_or_transition";
  let inputControl = "inspect_screenshot";
  if (battleCandidate) {
    phase = "battle";
    inputControl = "battle_context_unknown";
  } else if (namingActive) {
    phase = "naming";
    inputControl = "text_entry_keyboard_or_type_text";
  } else if (dialogVisible) {
    phase = "dialogue_text_or_menu";
    inputControl = "text_advance_or_menu";
  } else if (menuVisible) {
    phase = "menu_or_touch_prompt";
    inputControl = "menu_navigation_or_touch";
  } else if (movementPhaseValidated && String(movementMode || "").toUpperCase() === "MOVING") {
    phase = "overworld_moving";
    inputControl = "movement_in_progress";
  }
  const confidence = battleCandidate
    ? "candidate_battle_with_screenshot_guard"
    : namingActive
      ? escapeXml(naming.confidence || "validated_ram")
    : dialogVisible
      ? "visible_ram_text"
      : menuVisible
        ? escapeXml(menu.confidence || "validated_ram")
        : "screenshot_required";
  return {
    phase,
    inputControl,
    battleCandidate,
    namingActive,
    dialogVisible,
    menuVisible,
    confidence,
    movementAuthoritative: phase === "overworld_moving",
  };
}

function formatScreenPhase(gameDataJson, { isInDialog, movementMode, phaseInfo = null, exposure = null } = {}) {
  const info = phaseInfo || getScreenPhaseInfo(gameDataJson, { isInDialog, movementMode, exposure });
  return `<screen_phase phase="${escapeXml(info.phase)}" input_control="${escapeXml(info.inputControl)}" battle_candidate="${info.battleCandidate ? "true" : "false"}" naming_active="${info.namingActive ? "true" : "false"}" dialog_visible="${info.dialogVisible ? "true" : "false"}" menu_visible="${info.menuVisible ? "true" : "false"}" />`;
}

function formatFieldMenuState(gameDataJson, exposure) {
  const menuValidated = fieldShownInRamPrompt(exposure, "menu") || exposure.diagnosticsAllowed;
  const menu = gameDataJson?.ram_assisted?.modeDetector?.menu || {};
  const items = Array.isArray(menu.items) ? menu.items : [];
  const visibleItems = items
    .filter((item) => typeof item?.text === "string" && item.text.trim())
    .slice(0, 12)
    .map((item) => ({
      text: item.text.trim(),
      selected: item.selected === true,
    }));
  if (!menuValidated || menu.active !== true || visibleItems.length === 0) {
    return `<field_menu active="false" current_observation="not_shown" />`;
  }
  const selectedItem = visibleItems.find((item) => item.selected === true);
  const cursorRaw = typeof menu.cursor === "string" ? menu.cursor.trim() : "";
  const cursor = selectedItem?.text || (visibleItems.some((item) => item.text === cursorRaw) ? cursorRaw : "");
  const attributes = ['active="true"'];
  if (typeof menu.title === "string" && menu.title.trim()) {
    attributes.push(`title="${escapeXml(menu.title.trim())}"`);
  }
  if (typeof menu.pocket === "string" && menu.pocket.trim()) {
    attributes.push(`pocket="${escapeXml(menu.pocket.trim())}"`);
  }
  if (typeof menu.mode === "string" && menu.mode.trim()) {
    attributes.push(`menu_mode="${escapeXml(menu.mode.trim())}"`);
  }
  if (typeof menu.box === "string" && menu.box.trim()) {
    attributes.push(`storage_box="${escapeXml(menu.box.trim())}"`);
  }
  if (cursor) {
    attributes.push(`cursor="${escapeXml(cursor)}"`);
  }
  const itemLines = visibleItems.map(
    (item) => `  <menu_item selected="${item.selected ? "true" : "false"}">${escapeXml(item.text)}</menu_item>`
  );
  return `<field_menu ${attributes.join(" ")}>\n${itemLines.join("\n")}\n</field_menu>`;
}

function formatNamingState(gameDataJson, exposure) {
  const namingValidated = fieldShownInRamPrompt(exposure, "naming") || exposure.diagnosticsAllowed;
  const naming = gameDataJson?.ram_assisted?.modeDetector?.naming || gameDataJson?.naming_state || {};
  if (!namingValidated || naming.active !== true) {
    return `<naming_state active="false" current_observation="not_shown" />`;
  }
  const entryText = naming.entryText || naming.currentText || naming.text || "";
  const numericAttribute = (name, value) => {
    const number = Number(value);
    return Number.isFinite(number) ? `${name}="${Math.trunc(number)}"` : "";
  };
  const cursor = naming.cursor && typeof naming.cursor === "object" ? naming.cursor : {};
  const attributes = [
    'active="true"',
    numericAttribute("entry_length", naming.entryLength ?? String(entryText).length),
    numericAttribute("max_length", naming.maxLen ?? naming.maxLength),
    numericAttribute("text_cursor_pos", naming.textCursorPos ?? naming.cursorPos),
    numericAttribute("keyboard_cursor_x", cursor.x ?? naming.cursorX),
    numericAttribute("keyboard_cursor_y", cursor.y ?? naming.cursorY),
  ].filter(Boolean);
  const keyboardMode = naming.keyboardMode || naming.modeName || "";
  if (typeof keyboardMode === "string" && keyboardMode.trim()) {
    attributes.push(`keyboard_mode="${escapeXml(keyboardMode.trim())}"`);
  }
  return `<naming_state ${attributes.join(" ")}><current_text>${escapeXml(entryText)}</current_text></naming_state>`;
}

function formatRuntimeObjects(gameDataJson, exposure) {
  const surface = validatedRuntimeObjectSurface(gameDataJson, exposure);
  if (surface.validated !== true && !exposeAllDecodedRamForPrompt(exposure)) {
    return `<runtime_objects current_observation="not_shown" />`;
  }
  const summary = surface.summary || {};
  const entries = Array.isArray(surface.entries) ? surface.entries : [];
  const lines = [
    `<runtime_objects count="${Number(summary.count ?? entries.length) || 0}" visible_count="${Number(summary.visibleCount ?? entries.length) || 0}">`,
  ];
  for (const npc of entries.slice(0, 12)) {
    const label = safeRuntimeObjectLabel(npc);
    lines.push(
      `  <object name="${escapeXml(label)}" x="${escapeXml(npc?.x ?? "")}" y="${escapeXml(npc?.y ?? "")}" facing="${escapeXml(npc?.facing || "unknown")}" visible="${npc?.isVisible === true ? "true" : "false"}" blocking="${npc?.isBlocking === true ? "true" : "false"}" interactable_candidate="${npc?.isInteractableCandidate === true ? "true" : "false"}" required_facing="${escapeXml(npc?.requiredFacing || "unknown")}" in_front_of_player="${npc?.inFrontOfPlayer === true ? "true" : "false"}" />`
    );
  }
  lines.push("</runtime_objects>");
  return lines.join("\n");
}

function formatVisibleInteractables(gameDataJson, exposure) {
  if (!navigationShownInRamPrompt(exposure)) {
    return `<visible_interactables current_observation="not_shown" />`;
  }
  const surface = validatedVisibleInteractableSurface(gameDataJson, exposure);
  if (surface.validated !== true && !exposeAllDecodedRamForPrompt(exposure)) {
    return `<visible_interactables current_observation="not_shown" />`;
  }
  const coordinateFrame = playerCoordinateFrame(gameDataJson);
  const summary = surface.summary || {};
  const lines = [
    `<visible_interactables count="${Number(summary.count ?? surface.entries.length) || 0}" visible_count="${surface.entries.length}">`,
  ];
  if (surface.current) {
    const current = coordinatePointForPrompt(surface.current, coordinateFrame);
    lines.push(
      `  <current_interaction kind="${escapeXml(surface.current.kind || "check")}" x="${escapeXml(current.x)}" y="${escapeXml(current.y)}" local_x="${escapeXml(current.localX)}" local_y="${escapeXml(current.localY)}" required_facing="${escapeXml(surface.current.requiredFacing || "unknown")}" />`
    );
  }
  for (const entry of surface.entries.slice(0, 16)) {
    const rendered = coordinatePointForPrompt(entry, coordinateFrame);
    const useFrom = Array.isArray(entry.useFrom)
      ? entry.useFrom
          .slice(0, 4)
          .map((tile) => {
            const renderedTile = coordinatePointForPrompt(tile, coordinateFrame);
            return `${renderedTile.x},${renderedTile.y},${tile?.requiredFacing || "unknown"}`;
          })
          .join(";")
      : "";
    lines.push(
      `  <interactable kind="${escapeXml(entry.kind || "check")}" x="${escapeXml(rendered.x)}" y="${escapeXml(rendered.y)}" local_x="${escapeXml(rendered.localX)}" local_y="${escapeXml(rendered.localY)}" distance="${escapeXml(entry.distance ?? "")}" required_facing="${escapeXml(entry.requiredFacing || "unknown")}" in_front_of_player="${entry.inFrontOfPlayer === true ? "true" : "false"}" use_from="${escapeXml(useFrom)}" />`
    );
  }
  lines.push("</visible_interactables>");
  return lines.join("\n");
}

function formatFieldMoveAffordances(gameDataJson, exposure) {
  if (!navigationShownInRamPrompt(exposure)) {
    return `<field_move_affordances current_observation="not_shown" />`;
  }
  if (!fieldShownInRamPrompt(exposure, "fieldMoveAffordances")) {
    return `<field_move_affordances current_observation="not_shown" />`;
  }
  const data = gameDataJson?.field_move_affordances || gameDataJson?.ram_assisted?.field_move_affordances || {};
  const affordances = Array.isArray(data.affordances) ? data.affordances : [];
  const coordinateFrame = playerCoordinateFrame(gameDataJson);
  const target = coordinatePointForPrompt(data.target || {}, coordinateFrame);
  if (affordances.length === 0) {
    return `<field_move_affordances count="0" facing="${escapeXml(data.facing || "unknown")}" target_x="${escapeXml(
      target.x
    )}" target_y="${escapeXml(target.y)}" />`;
  }
  const lines = [
    `<field_move_affordances count="${affordances.length}" facing="${escapeXml(
      data.facing || "unknown"
    )}" target_x="${escapeXml(target.x)}" target_y="${escapeXml(target.y)}" local_x="${escapeXml(
      target.localX
    )}" local_y="${escapeXml(target.localY)}">`,
  ];
  for (const entry of affordances.slice(0, 4)) {
    const rendered = coordinatePointForPrompt(entry, coordinateFrame);
    lines.push(
      `  <affordance move="${escapeXml(entry.move || "")}" target="${escapeXml(
        entry.target || ""
      )}" x="${escapeXml(rendered.x)}" y="${escapeXml(rendered.y)}" local_x="${escapeXml(
        rendered.localX
      )}" local_y="${escapeXml(rendered.localY)}" required_facing="${escapeXml(
        entry.requiredFacing || data.facing || "unknown"
      )}" />`
    );
  }
  lines.push("</field_move_affordances>");
  return lines.join("\n");
}

async function buildUserInputText(gameDataJson) {
  const { counters } = state;

  const exposure = buildObservationExposure(gameDataJson);
  const trainer = gameDataJson?.current_trainer_data || null;
  const rawPos = trainer?.position || { map_name: "Unknown", map_id: "0-0", x: 0, y: 0, elevation: 0 };
  const showDecodedRam = exposeAllDecodedRamForPrompt(exposure);
  const navigationValidated = exposure.navigation.validated || exposure.diagnosticsAllowed || showDecodedRam;
  const locationValidated = exposure.location.validated || navigationValidated || exposure.diagnosticsAllowed || showDecodedRam;
  const pos = locationValidated ? rawPos : { map_name: "not_shown", map_id: "not_shown", x: 0, y: 0, elevation: 0 };
  const coordinateFrame = navigationValidated ? playerCoordinateFrame(gameDataJson) : null;
  const facingValidated = fieldShownInRamPrompt(exposure, "facing") || exposure.diagnosticsAllowed;
  const locationFacing = facingValidated ? rawPos.facing || "unknown" : "not_shown";
  const facingStatus = facingValidated
    ? `<player_facing direction="${escapeXml(rawPos.facing || "unknown")}" />`
    : `<player_facing current_observation="not_shown">Use the screenshot and recent action trace to infer facing.</player_facing>`;
  const playerLocationTag = navigationValidated
    ? `<player_location map="${escapeXml(pos.map_name)}" map_id="${escapeXml(pos.map_id)}" coordinate_mode="${escapeXml(coordinateFrame?.coordinateMode || "map_local_position")}" global_x="${escapeXml(coordinateFrame?.globalX ?? pos.x)}" global_y="${escapeXml(coordinateFrame?.globalY ?? pos.y)}" local_x="${escapeXml(coordinateFrame?.localX ?? pos.x)}" local_y="${escapeXml(coordinateFrame?.localY ?? pos.y)}" facing="${escapeXml(locationFacing)}" x="${pos.x}" y="${pos.y}" elevation="${Number(pos.elevation) || 0}" />`
    : locationValidated
      ? `<player_location map="${escapeXml(pos.map_name)}" map_id="${escapeXml(pos.map_id)}" coordinates="not_shown" />`
      : `<player_location current_observation="not_shown">Use screenshot-first reasoning for position and movement.</player_location>`;
  const isInDialog = Boolean(gameDataJson?.is_talking_to_npc);
  const dialogueVisibleValidated = fieldShownInRamPrompt(exposure, "dialogue") || exposure.diagnosticsAllowed;
  const dialogText = String(gameDataJson?.open_dialog_text || "");
  const dialogueTextSourceContract = `${exposure.fields?.dialogue?.source || ""} ${
    exposure.fields?.dialogue?.contract || ""
  }`;
  const dialogueTextComesFromValidatedRam =
    /(current_visible_text|ram_visible_text|textprinter|msgbuffer|stringbuffer|script_environment|ram_text)/i.test(
      dialogueTextSourceContract
    ) && !/ocr/i.test(dialogueTextSourceContract);
  const dialogueTextValidated =
    exposure.diagnosticsAllowed ||
    (fieldShownInRamPrompt(exposure, "dialogue") && dialogueTextComesFromValidatedRam);

  const movementValidated = fieldShownInRamPrompt(exposure, "movement") || exposure.diagnosticsAllowed;
  const movementMode = movementValidated
    ? gameDataJson?.player_movement_mode || gameDataJson?.ram_assisted?.modeDetector?.movement?.mode || "UNKNOWN"
    : null;
  const strengthEnabled = Boolean(gameDataJson?.strength_enabled);
  const strengthValidated = fieldShownInRamPrompt(exposure, "strength") || exposure.diagnosticsAllowed;
  const flashValidated = fieldShownInRamPrompt(exposure, "flash") || exposure.diagnosticsAllowed;
  const visibilityValidated = fieldShownInRamPrompt(exposure, "visibility") || exposure.diagnosticsAllowed;

  const visibilityReduced = Boolean(gameDataJson?.visibility_reduced);
  const visibilityState = gameDataJson?.visibility_state || "unknown";

  const visibleGrid = Array.isArray(gameDataJson?.game_area_meta_tiles) ? gameDataJson.game_area_meta_tiles : null;
  const minimap = gameDataJson?.minimap_data || null;
  const visibleAreaOrigin = gameDataJson?.visible_area_data?.origin || { x: pos.x, y: pos.y };
  const visibleW = gameDataJson?.visible_area_data?.width || (visibleGrid && visibleGrid[0] ? visibleGrid[0].length : 0);
  const visibleH = gameDataJson?.visible_area_data?.height || (visibleGrid ? visibleGrid.length : 0);
  // The visible grid comes with an origin (top-left world coords), so the
  // player's local position in the grid is (player - origin).
  let localRow = Number(pos.y) - Number(visibleAreaOrigin.y);
  let localCol = Number(pos.x) - Number(visibleAreaOrigin.x);
  if (!Number.isFinite(localRow) || localRow < 0 || localRow >= visibleH) {
    localRow = visibleH ? Math.floor(visibleH / 2) : 0;
  }
  if (!Number.isFinite(localCol) || localCol < 0 || localCol >= visibleW) {
    localCol = visibleW ? Math.floor(visibleW / 2) : 0;
  }

  let gameAreaDisplay = null;
  let minimapDisplay = null;
  const runtimeObjectSurface = validatedRuntimeObjectSurface(gameDataJson, exposure);
  const modelVisibleNpcs = runtimeObjectSurface.validated === true ? runtimeObjectSurface.entries : null;
  const modelVisibleNpcsInView = runtimeObjectSurface.validated === true ? runtimeObjectSurface.entries : null;

  if (navigationValidated && !isInDialog && visibleGrid && minimap && minimap.grid) {
    const displayMinimap = minimap;

    // Viewport uses `origin` instead of assuming the player is always at (4,4).
    // Keep markdown format stable and adapt coordinate math in the formatter.
    gameAreaDisplay = gameAreaToMarkdown(
      visibleGrid,
      pos.x,
      pos.y,
      pos.map_id,
      pos.map_name,
      displayMinimap.height || minimap.grid.length,
      displayMinimap.width || minimap.grid[0]?.length || 0,
      visibleAreaOrigin.x,
      visibleAreaOrigin.y,
      minimap.orientation ?? null,
      modelVisibleNpcsInView
    );

  // Keep console monitor output aligned with the model-safe prompt surface.
  console.log("Visible game area:", sanitizeCurrentPromptText(gameAreaDisplay));

    minimapDisplay = minimapToMarkdown(
      displayMinimap,
      pos.x,
      pos.y,
      pos.map_id,
      pos.map_name,
      minimap.orientation ?? null,
      visibleGrid,
      localRow,
      localCol,
      modelVisibleNpcs
    );
  }


  const trainerName = trainer?.name || "PLAYER";
  const money = fieldShownInRamPrompt(exposure, "money") || exposure.diagnosticsAllowed ? trainer?.money ?? 0 : "unknown";
  const badgeCount = fieldShownInRamPrompt(exposure, "badges") || exposure.diagnosticsAllowed ? trainer?.badge_count ?? 0 : "unknown";
  const badgeTotal = gameDataJson?.game?.badgeTotal || trainer?.badge_total || 8;
  const gameTitle = gameDataJson?.game?.title || "Pokemon HeartGold";
  const gamePlatform = gameDataJson?.game?.platform || "Nintendo DS";
  const stateReliability = gameDataJson?.game?.stateReliability || "ram_first";
  const reliabilityDetails = formatReliabilityDetails(gameDataJson);
  const visualPrimary = exposure.mode === "visual";
  const pathfindingContract = gameDataJson?.ram_assisted?.pathfinding;
  const pythonPathfindingDisabled = pathfindingContract?.available === false;
  const romCollisionValidated = fieldShownInRamPrompt(exposure, "romCollision");
  const pathfindingEnabled = navigationValidated && romCollisionValidated && pathfindingContract?.available === true && !pythonPathfindingDisabled;
  const minimapBoundsSource = gameDataJson?.minimap_data || {};
  const staticGridAvailable =
    Array.isArray(minimapBoundsSource.static_grid) &&
    (
      pathfindingContract?.staticGridConfidence === "rom_derived" ||
      minimapBoundsSource.static_confidence === "rom_derived"
    );
  const pathfindingStatus = pathfindingEnabled
    ? staticGridAvailable
      ? "enabled"
      : "disabled"
    : "disabled";
  const mapBounds =
    navigationValidated &&
    staticGridAvailable &&
    Number.isFinite(Number(minimapBoundsSource.static_origin_x)) &&
    Number.isFinite(Number(minimapBoundsSource.static_origin_y))
      ? {
          minX: Number(minimapBoundsSource.static_origin_x),
          minY: Number(minimapBoundsSource.static_origin_y),
          maxX:
            Number(minimapBoundsSource.static_origin_x) +
            (Number.isFinite(Number(minimapBoundsSource.static_width))
              ? Number(minimapBoundsSource.static_width)
              : minimapBoundsSource.static_grid[0]?.length || 0) -
            1,
          maxY:
            Number(minimapBoundsSource.static_origin_y) +
            (Number.isFinite(Number(minimapBoundsSource.static_height))
              ? Number(minimapBoundsSource.static_height)
              : minimapBoundsSource.static_grid.length || 0) -
            1,
        }
      : null;
  const pathfindingBoundsText =
    pathfindingEnabled && mapBounds
      ? " ROM static collision is loaded for same-map path_to_location execution; full geometry and generated routes are not printed as player-visible map knowledge."
      : pathfindingEnabled && !staticGridAvailable
        ? " No ROM static collision grid is loaded for this map; path_to_location is disabled rather than using observed fog as if it were a full map. Prefer screenshot-guided button_sequence for visible paths."
      : "";
  const pathfindingReason = navigationValidated
    ? (!romCollisionValidated
        ? "path_to_location is disabled for this observation because same-map collision data is not available. Use screenshot-guided key_press/touch actions for visible paths."
        : pythonPathfindingDisabled
        ? `path_to_location is disabled for this observation: ${pathfindingContract?.disabledReason || "unknown"}`
        : `navigation available.${pathfindingBoundsText}`)
    : "path_to_location is disabled for this observation. Use screenshot-first key_press/touch actions.";
  const partySection =
    fieldShownInRamPrompt(exposure, "party") || exposure.diagnosticsAllowed
      ? formatPokemonTeam(gameDataJson?.current_pokemon_data, gameDataJson?.ram_assisted?.party)
      : `<pokemon_team current_observation="not_shown">No party RAM is shown in this observation.</pokemon_team>\n`;
  const inventorySection =
    fieldShownInRamPrompt(exposure, "inventory") || exposure.diagnosticsAllowed
      ? formatInventory(gameDataJson?.inventory_data)
      : `<inventory current_observation="not_shown">No inventory RAM is shown in this observation.</inventory>\n`;
  const progressSection =
    fieldShownInRamPrompt(exposure, "progress") || exposure.diagnosticsAllowed
      ? formatProgressFlags(gameDataJson?.progress_flags || gameDataJson?.ram_assisted?.progress)
      : `<progress_flags current_observation="not_shown" />\n`;
  const pcItemsSection =
    config.isHeartGold
      ? '<pc_items not_applicable="true">No separate PC item storage is exposed for this game; use current inventory.</pc_items>\n'
      : exposure.diagnosticsAllowed
        ? formatPcItems(gameDataJson?.pc_items)
        : `<pc_items current_observation="not_shown" />\n`;
  const pcStorageValidated =
    fieldShownInRamPrompt(exposure, "pcStorage") && (showDecodedRam || pcStorageDataValidated(gameDataJson?.pc_data));
  const pcPokemonSection =
    exposure.diagnosticsAllowed || pcStorageValidated
      ? formatPcPokemon(gameDataJson?.pc_data)
      : `<pc_pokemon current_observation="not_shown" />\n`;
  const battleSection =
    fieldShownInRamPrompt(exposure, "battle") || exposure.diagnosticsAllowed
      ? formatBattleState(gameDataJson?.battle_data, heartGoldBattleAuthoritativelyActive(gameDataJson))
      : `<battle_state active="unknown" current_observation="not_shown">No battle RAM is shown in this observation.</battle_state>\n`;
  const screenPhaseInfo = config.isHeartGold ? getScreenPhaseInfo(gameDataJson, { isInDialog, movementMode, exposure }) : null;
  const validatedFieldDialogueActive = screenPhaseInfo?.dialogVisible === true;
  const screenPhaseSection = config.isHeartGold
    ? formatScreenPhase(gameDataJson, { isInDialog, movementMode, phaseInfo: screenPhaseInfo, exposure })
    : "";
  const fieldMenuSection = config.isHeartGold ? formatFieldMenuState(gameDataJson, exposure) : "";
  const namingSection = config.isHeartGold ? formatNamingState(gameDataJson, exposure) : "";
  const runtimeObjectsSection = config.isHeartGold ? formatRuntimeObjects(gameDataJson, exposure) : "";
  const currentVisibleTextSurfaceActive = (entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (entry.surface === "battle") {
      return heartGoldBattleAuthoritativelyActive(gameDataJson);
    }
    if (entry.surface === "field_dialogue") {
      return isInDialog === true || screenPhaseInfo?.dialogVisible === true;
    }
    if (entry.surface === "current_ui") {
      return isInDialog === true || screenPhaseInfo?.dialogVisible === true;
    }
    return false;
  };
  const currentVisibleTextHasObservationAnchor = (entry) => {
    if (!entry || typeof entry !== "object") return false;
    const frame = Number(entry.frame);
    if (!Number.isFinite(frame) || frame < 0) return false;
    return matchesCurrentObservationScreenshot(entry, gameDataJson);
  };
  const currentVisibleTextDecoderContractAllowed = (entry) => {
    const surface = entry?.surface || "";
    if (surface === "field_dialogue") {
      return (entry?.decoderContract || entry?.decoder_contract || "") === FIELD_VISIBLE_TEXT_DECODER_CONTRACT;
    }
    if (surface === "current_ui") {
      return (entry?.decoderContract || entry?.decoder_contract || "") === CURRENT_UI_VISIBLE_TEXT_DECODER_CONTRACT;
    }
    if (surface !== "battle") return true;
    return (entry?.decoderContract || entry?.decoder_contract || "") === "owner_bound_battle_msgbuffer_textprinter_current_v1";
  };
  const currentVisibleText =
    gameDataJson?.current_visible_text &&
    gameDataJson.current_visible_text.active === true &&
    gameDataJson.current_visible_text.source === "ram_visible_text" &&
    gameDataJson.current_visible_text.contract === "current_visible_text_v1" &&
    gameDataJson.current_visible_text.confidence === "validated_current" &&
    Number.isFinite(Number(gameDataJson.current_visible_text.contextEpoch)) &&
    Number(gameDataJson.current_visible_text.contextEpoch) >= 0 &&
    currentVisibleTextDecoderContractAllowed(gameDataJson.current_visible_text) &&
    currentVisibleTextSurfaceActive(gameDataJson.current_visible_text) &&
    currentVisibleTextHasObservationAnchor(gameDataJson.current_visible_text) &&
    typeof gameDataJson.current_visible_text.text === "string" &&
    gameDataJson.current_visible_text.text.trim()
      ? gameDataJson.current_visible_text
      : null;
  const currentVisibleTextSection = currentVisibleText
    ? `<visible_text surface="${escapeXml(currentVisibleText.surface || "unknown")}">${escapeXml(
        currentVisibleText.text
      )}</visible_text>`
    : "";
  const recentVisibleTextSection = formatRecentVisibleText(gameDataJson, exposure);
  const nearbyWarpEntries = Array.isArray(gameDataJson?.nearby_warps) ? gameDataJson.nearby_warps : [];
  const visibleWarpEntries = Array.isArray(gameDataJson?.visible_warps) ? gameDataJson.visible_warps : [];
  const visibleInteractablesSection = formatVisibleInteractables(gameDataJson, exposure);
  const fieldMoveAffordancesSection = formatFieldMoveAffordances(gameDataJson, exposure);
  const currentConnectionData = gameDataJson?.current_connections || {};
  const currentConnectionEntries = Array.isArray(currentConnectionData?.connections) ? currentConnectionData.connections : [];
  const formatWarpEntry = (warp) => {
    const rendered = coordinatePointForPrompt(warp, coordinateFrame);
    return `  <warp x="${escapeXml(rendered.x)}" y="${escapeXml(rendered.y)}" local_x="${escapeXml(
      rendered.localX
    )}" local_y="${escapeXml(rendered.localY)}" coordinate_mode="${escapeXml(
      coordinateFrame?.coordinateMode || "map_local_position"
    )}" distance="${Number(warp.distance)}" destination="not_shown" />`;
  };
  const nearbyWarpsSection =
    navigationValidated && fieldShownInRamPrompt(exposure, "warps") && nearbyWarpEntries.length > 0
      ? `<nearby_warps>\n${nearbyWarpEntries
          .map(formatWarpEntry)
          .join("\n")}\n</nearby_warps>`
      : navigationValidated && fieldShownInRamPrompt(exposure, "warps")
        ? `<nearby_warps count="0" />`
        : `<nearby_warps current_observation="not_shown" />`;
  const visibleWarpsSection =
    navigationValidated && fieldShownInRamPrompt(exposure, "warps") && visibleWarpEntries.length > 0
      ? `<visible_entrances>\n${visibleWarpEntries
          .map(formatWarpEntry)
          .join("\n")}\n</visible_entrances>`
      : navigationValidated && fieldShownInRamPrompt(exposure, "warps")
        ? `<visible_entrances count="0" />`
        : `<visible_entrances current_observation="not_shown" />`;
  const currentConnectionsSection =
    navigationValidated && fieldShownInRamPrompt(exposure, "currentConnections") && currentConnectionEntries.length > 0
      ? `<current_connections>\n${currentConnectionEntries
          .map(
            (entry) =>
              `  <connection direction="${escapeXml(
                entry.direction || ""
              )}" destination="not_shown" />`
          )
          .join("\n")}\n</current_connections>`
      : navigationValidated && fieldShownInRamPrompt(exposure, "currentConnections")
        ? `<current_connections count="0" />`
        : `<current_connections current_observation="not_shown" />`;
  const markersSection = navigationValidated
    ? formatRecentMarkers(state.markers, state.lastVisitedMaps, isInDialog)
    : `<markers current_observation="not_shown">Coordinate markers are unavailable until the current observation shows map identity and position.</markers>\n`;
  const situationStatus = visualPrimary
    ? `
  <screen_mode_hint>Determine overworld/dialogue/menu/battle/loading/naming from the DS screenshot. The screenshot is a vertical DS layout: top screen above bottom screen. The persistent bottom-screen MENU/CHECK panel is standby UI, not an open menu unless a real modal menu/touch prompt is visible. RAM gameplay fields are not shown in primary_visual.</screen_mode_hint>
  <path_to_location status="disabled">Not available in primary_visual; navigate from screenshot, memory, objectives, and action traces.</path_to_location>`
    : `
  <path_to_location status="${escapeXml(pathfindingStatus)}">${escapeXml(pathfindingReason)}</path_to_location>
  ${screenPhaseSection}
  ${fieldMenuSection}
  ${namingSection}
  ${runtimeObjectsSection}
  ${currentVisibleTextSection}
  ${recentVisibleTextSection}
  ${fieldMoveAffordancesSection}
  ${
    dialogueVisibleValidated && validatedFieldDialogueActive
      ? `<dialog_status active="true">In dialogue/menu with current anchored RAM text</dialog_status>`
      : `<dialog_status current_observation="not_shown">Determine dialogue/menu state from the screenshot.</dialog_status>`
  }
  ${
    validatedFieldDialogueActive && dialogText && dialogueTextValidated
      ? `<dialog_text>${escapeXml(dialogText)}</dialog_text>`
      : ""
  }
  ${
    navigationValidated && movementValidated
      ? `<movement_mode active_control="${screenPhaseInfo?.movementAuthoritative === false ? "false" : "true"}">${escapeXml(movementMode)}</movement_mode>`
      : `<movement_mode current_observation="not_shown" />`
  }
  ${
    strengthValidated
      ? `<strength_status>${strengthEnabled ? "true" : "false"}</strength_status>`
      : `<strength_status current_observation="not_shown" />`
  }
  ${
    flashValidated
      ? `<flash_needed>${gameDataJson?.flash_needed ? "true" : "false"}</flash_needed>
  <flash_active>${gameDataJson?.flash_active ? "true" : "false"}</flash_active>
  <defog_needed>${gameDataJson?.defog_needed ? "true" : "false"}</defog_needed>
  <defog_active>${gameDataJson?.defog_active ? "true" : "false"}</defog_active>`
      : `<flash_needed current_observation="not_shown" />
  <flash_active current_observation="not_shown" />
  <defog_needed current_observation="not_shown" />
  <defog_active current_observation="not_shown" />`
  }
  ${
    visibilityValidated
      ? `<visibility reduced="${visibilityReduced ? "true" : "false"}" state="${escapeXml(visibilityState)}" window="${visibleH}x${visibleW}">
    ${visibilityReduced ? "Visibility is reduced." : ""}
  </visibility>`
      : `<visibility current_observation="not_shown">Use the DS screenshot for visibility/darkness.</visibility>`
  }`;
  let userInputText = `
<game_state timestamp="${new Date().toISOString()}" current_step="${counters.currentStep}">
<game_identity title="${escapeXml(gameTitle)}" platform="${escapeXml(gamePlatform)}" profile="${escapeXml(config.gameProfile)}" state_reliability="${escapeXml(visualPrimary ? "primary_visual" : stateReliability)}" />
${config.isHeartGold ? '<screen_layout platform="Nintendo DS" image="vertical_256x384" top_screen="x=0..255,y=0..191" bottom_touch_screen="x=0..255,y=192..383" bottom_local_touch="x=0..255,y=0..191">The screenshot is two stacked DS screens. The top screen is visual-only and not touchable. The bottom half is the touch screen; a persistent MENU/CHECK panel there is standby UI, not necessarily an opened menu.</screen_layout>\n' : ""}
${reliabilityDetails}
<current_situation>
  <navigation_state available="${navigationValidated ? "true" : "false"}" location_available="${locationValidated ? "true" : "false"}" mode="${escapeXml(exposure.mode)}">
    ${playerLocationTag}
    ${!navigationValidated || facingValidated ? facingStatus : ""}
  </navigation_state>
${situationStatus}
${nearbyWarpsSection}
${visibleWarpsSection}
${visibleInteractablesSection}
${currentConnectionsSection}
</current_situation>

<player_stats>
  <trainer name="${escapeXml(trainerName)}" money="${money}" badges="${badgeCount}/${badgeTotal}" />
  ${partySection}
  ${inventorySection}
  ${progressSection}
  ${pcItemsSection}
  ${pcPokemonSection}
</player_stats>

${battleSection}

<objectives_section>
${formatObjectives(state.objectives)}
</objectives_section>

${formatMemoryStructured(state.memory)}

${markersSection}

<visible_area>
${!navigationValidated ? "Current map grid is not shown in this observation. Use the screenshot for movement." : isInDialog ? "Not visible in dialogue" : gameAreaDisplay || "No visible area data"}
</visible_area>

<explored_map>
${!navigationValidated ? "Current minimap geometry is not shown in this observation. path_to_location is disabled." : isInDialog ? "Not visible in dialogue" : minimapDisplay || "No minimap data"}
</explored_map>

</game_state>
  `.trim();

  if (state.selfCritiqueReminderPending) {
    userInputText += `
<self_criticism_reminder>
If the latest self-criticism names a concrete memory, objective, or marker fix that is still supported by the current observation, apply that fix alongside your next useful gameplay action.
If there is no concrete supported fix, keep playing from the current observation.
</self_criticism_reminder>`;
    state.selfCritiqueReminderAcknowledged = true;
  }

  userInputText = sanitizeCurrentPromptText(userInputText);

  // Save the userInputText into a debug file
  fs.writeFile(config.paths.lastUserInputTextSaveFile, userInputText, "utf8");

  return userInputText;
}

async function buildDeveloperPrompt() {
  let gamePrompt;
  try {
    gamePrompt = await fs.readFile(config.paths.gamePromptFile, "utf8");
    cachedGamePromptText = gamePrompt;
  } catch (error) {
    if (cachedGamePromptText) {
      gamePrompt = `${cachedGamePromptText}

## HARNESS PROMPT ASSET WARNING

The configured prompt file could not be read for this observation, so the last successfully loaded prompt text is being reused. Treat this as a harness asset warning, not as game evidence.
`;
    } else {
      gamePrompt = "You are an AI playing Pokemon HeartGold through the local game interface. Codex Desktop `ram_assisted` is the current-state game lane when configured. Use the DS screenshot, exposed RAM-assisted state, memory, objectives, and the execute_action schema. Do not inspect the repo, console logs, local files, local search results, runtime folders, hidden runtime files, or monitor-only artifacts for gameplay. Use PowerShell/Invoke-RestMethod only for official local endpoint transport; no `rg`, grep, file-read, repo browsing, or local-search commands are allowed for gameplay information. A generic HeartGold prompt is being used because the configured prompt asset is unavailable.";
    }
  }
  if (config.isHeartGold) {
    gamePrompt += `

## HEARTGOLD NAVIGATION UPDATE

A bounded RAM-observed fog minimap is available when <navigation_state available="true"> and <explored_map> appears. Codex Desktop \`ram_assisted\` is the current-state game lane for HeartGold when observation mode is ram_assisted. HeartGold's ram_assisted interface uses a current-state RAM surface: any RAM-derived gameplay field shown in the prompt is meant to be treated as current game state. In ram_assisted mode, path_to_location is disabled unless semantic map identity is verified and coordinates are high-confidence.
- Known wall/collision tiles are blocked.
- Known visited tiles are walkable for reasoning, but path_to_location itself requires a ROM-derived static collision grid.
- Unknown fog tiles are not used by path_to_location as a substitute for full map geometry.
- Use \`path_to_location\` as a same-map actuator, not a route oracle: it may only move toward explicitly shown current-map map_id/coordinates when its prompt status is enabled. If <path_to_location status="disabled"> appears, use screenshot-guided \`key_press\` or \`touch\` actions instead.

## HEARTGOLD OBSERVATION POLICY

HeartGold observations are the DS screenshot, freshness/hash metadata, model-visible RAM state, minimap/fog-of-war when enabled, model-owned memory/objectives/markers, and sanitized prior action traces. Do not inspect the repo, console logs, local files, local search results, or runtime folders for gameplay; use PowerShell/Invoke-RestMethod only for official local endpoint transport, and do not use \`rg\`, grep, file-read, repo browsing, or local-search commands for gameplay information. If a shown RAM field and the screenshot disagree, stop and classify it as an observation conflict.
`;
  }
  return {
    role: "developer",
    content: [{ type: "input_text", text: gamePrompt }],
  };
}

module.exports = { buildUserInputText, formatMemoryStructured, buildDeveloperPrompt };
