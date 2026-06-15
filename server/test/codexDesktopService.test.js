const test = require("node:test");
const assert = require("node:assert/strict");

const { _private } = require("../src/services/codexDesktopService");
const { _private: toolsPrivate } = require("../src/ai/tools");

function minimalRamAssistedGameData() {
  const visibleInteractableContract = "current_visible_bg_event_interactable_no_raw_script";
  const interactable = {
    kind: "check",
    x: 8,
    y: 4,
    distance: 1,
    requiredFacing: "up",
    inFrontOfPlayer: true,
    useFrom: [{ x: 8, y: 5, requiredFacing: "up" }],
    confidence: "rom_derived",
    source: "heartgold_rom_zone_event_visible_bg_event",
    contract: visibleInteractableContract,
  };
  return {
    game: { profile: "heartgold", title: "Pokemon HeartGold", platform: "Nintendo DS" },
    observationPolicy: { mode: "ram_assisted" },
    screen_mode: "overworld",
    screen_mode_confidence: "validated_ram",
    current_trainer_data: {
      position: {
        map_id: "61",
        map_name: "New Bark Elm's Lab 1F",
        map_name_source: "pret_pokeheartgold_constants",
        map_identity_confidence: "verified",
        coordinate_confidence: "high",
        position_confidence: "high",
        facing: "up",
        x: 8,
        y: 5,
        elevation: 0,
        map_id_source: "FieldSystem.location",
        live_ram: true,
        contract: "ram_fieldsystem_location_localmapobject_position_current_v1",
      },
    },
    ram_assisted: {
      modeDetector: {
        movement: {
          mode: "WALK",
          vehicle: "foot",
          surfing: false,
          biking: false,
          diving: false,
        },
      },
      pathfinding: { available: true },
      interactables: {
        available: true,
        contract: "current_visible_interactable_affordances_v2",
        visible: [interactable],
        current: interactable,
      },
    },
    current_interaction: interactable,
    visible_interactables: [interactable],
    important_events: {
      EVENT_GOT_STARTER: false,
      EVENT_GOT_POKEDEX: false,
      EVENT_GOT_POKEGEAR: false,
      EVENT_GOT_BAG: false,
    },
    progress_flags: {
      validated: true,
      validation: "validated_save_vars_flags_header_and_named_bits",
      got_starter: false,
      got_pokedex: false,
      got_pokegear: false,
      got_bag: false,
      starter_species_name: "CYNDAQUIL",
      strength_enabled: false,
      flash_active: false,
      defog_active: false,
      safari_zone_active: false,
      safari_zone_has_step_limit: false,
    },
    raw_state: { event_flags: { EVENT_GOT_STARTER: false } },
    oracleDebug: { route_hint: "hidden" },
    stateReliabilityDetails: {
      position: {
        source: "FieldSystem.playerAvatar.mapObject",
        mapIdSource: "FieldSystem.location",
        confidence: "high",
        coordinateConfidence: "high",
        mapIdentityConfidence: "verified",
        mapNameSource: "pret_pokeheartgold_constants",
        contract: "ram_fieldsystem_location_localmapobject_position_current_v1",
      },
      facing: {
        source: "local_map_object_current_facing",
        confidence: "verified_ram",
        contract: "ram_localmapobject_current_facing_verified",
      },
      movement: {
        source: "LocalMapObject.movement+player_vehicle_state",
        confidence: "validated_ram",
        contract: "ram_localmapobject_movement_mode_and_vehicle_current_v1",
        movementModeEvidence: {
          currentPlayerLocalMapObjectBound: true,
          movementModeDecoded: true,
          vehicleStateDecoded: true,
        },
      },
      interactables: {
        source: "heartgold_rom_bg_events_plus_runtime_object_interactables",
        confidence: "validated_ram",
        contract: "current_visible_interactable_affordances_v2",
      },
      romCollision: {
        source: "heartgold_rom_matrix_land_data",
        confidence: "rom_derived",
        contract: "rom_derived_matrix_land_data_with_live_position_validation",
      },
    },
  };
}

const fullyExposedRamAssistedSurface = {
  mode: "ram_assisted",
  diagnosticsAllowed: false,
  navigation: { validated: true },
  location: { validated: true },
  fields: Object.fromEntries(
    [
      "facing",
      "movement",
      "romCollision",
      "interactables",
      "npcs",
      "warps",
      "currentConnections",
      "fieldMoveAffordances",
      "battle",
      "dialogue",
      "menu",
      "naming",
      "party",
      "inventory",
      "pcStorage",
      "progress",
      "visibility",
      "money",
      "badges",
    ].map((field) => [field, { validated: true, confidence: "validated_ram", contract: "test_contract" }])
  ),
};

test("desktop action history keeps general engine outcome facts visible to the player model", () => {
  const fullToolResult = {
    type: "function_call_output",
    call_id: "call_test",
    output: [
      {
        type: "input_text",
        text: [
          '<action_result type="button_sequence" semantic_success="true" raw_success="true" input_delivered="true" visible_effect="true" semantic_target_verified="false" semantic_outcome="sequence_interrupted_by_dialogue_after_progress">',
          "<message>Partial button sequence: executed 2/4 sequential button steps; 2 queued steps remained after interruption.</message>",
          "<details>Run:\n- ok: true\n- status: true\n- interruptedByDialog: true\n- interruptedAtIndex: 2\n- remainingCommandCount: 2\n\nNotes:\n- Dialog detected while executing commands, stopping sequence</details>",
          "</action_result>",
        ].join("\n"),
      },
    ],
  };

  const modelSafe = _private.sanitizeToolResultForDesktop(fullToolResult);
  const text = modelSafe.output[0].text;

  assert.match(text, /input_delivered="true"/);
  assert.match(text, /visible_effect="true"/);
  assert.match(text, /semantic_outcome="sequence_interrupted_by_dialogue_after_progress"/);
  assert.match(text, /interruptedByDialog: true/);
  assert.match(text, /remainingCommandCount: 2/);
  assert.doesNotMatch(text, /Use the next observation screenshot and visible game state to decide what happened/);

  const outcome = _private.analyzeToolResult(fullToolResult);
  assert.equal(outcome.actionSuccess, true);
  assert.equal(outcome.benchmarkSemanticSuccess, false);
  assert.equal(outcome.failureReason, null);
});

test("desktop player observation uses the canonical structured game-state surface", () => {
  const text = _private.buildSimplePlayerObservation(
    minimalRamAssistedGameData(),
    {
      width: 768,
      height: 1152,
      scale: 3,
      model_scaled_touch: { source_width: 768, source_height: 1152 },
    },
    fullyExposedRamAssistedSurface
  );

  assert.match(text, /<game_state\b/);
  assert.match(text, /<player_location\b[^>]*map="New Bark Elm&apos;s Lab 1F"/);
  assert.match(text, /<screen_phase\b/);
  assert.match(text, /<visible_interactables\b/);
  assert.match(text, /<current_interaction\b[^>]*kind="check"[^>]*x="8"[^>]*y="4"/);
  assert.doesNotMatch(text, /^Visible interactables\/check targets/m);
  assert.doesNotMatch(text, /got_starter|got_pokedex|got_pokegear|got_bag|starter_species_name|starter="/);
});

test("desktop decoded_ram is a sanitized gameplay surface, not a raw state dump", () => {
  const decodedRam = _private.buildModelDecodedRam(
    minimalRamAssistedGameData(),
    fullyExposedRamAssistedSurface
  );
  const json = JSON.stringify(decodedRam);

  assert.match(json, /"player"/);
  assert.match(json, /"visible_interactables"/);
  assert.doesNotMatch(json, /important_events|raw_state|oracleDebug|EVENT_GOT|got_starter|got_pokedex|got_pokegear|got_bag|starter_species/);
});

test("action trace summary describes forced or scripted movement as generic before-after state", () => {
  const text = toolsPrivate.summarizeTracePayloadMarkdown({
    ok: true,
    status: true,
    startedInDialog: false,
    interruptedByDialog: true,
    interruptedAtIndex: 0,
    remaining_keys: [{ type: "press", buttons: ["down"] }],
    results: [
      {
        type: "press",
        ok: true,
        ms: 600,
        screenChanged: true,
        interruptedByDialog: true,
        before: {
          map: { id: "61", name: "New Bark Elm's Lab 1F" },
          player: { position: { x: 6, y: 10 }, facing: "down" },
          dialog: { inDialog: false },
        },
        after: {
          map: { id: "61", name: "New Bark Elm's Lab 1F" },
          player: { position: { x: 6, y: 9 }, facing: "up" },
          dialog: { inDialog: true, visibleText: "Where are you going?" },
        },
      },
    ],
  });

  assert.match(text, /Outcome notes:/);
  assert.match(text, /dialog opened/i);
  assert.match(text, /position changed: \(6,10\) -> \(6,9\)/);
  assert.match(text, /facing changed: down -> up/);
  assert.match(text, /remainingCommandCount: 1/);
  assert.doesNotMatch(text, /Elm|starter|selector/i);
});
