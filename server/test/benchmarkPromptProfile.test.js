const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { defineTools, handleToolCall } = require("../src/ai/tools");
const { _private: codexCliPrivate } = require("../src/services/codexCliService");
const { _private: desktopPrivate } = require("../src/services/codexDesktopService");

const rootDir = path.join(__dirname, "..");

function promptText() {
  return fs.readFileSync(path.join(rootDir, "prompts_heartgold", "game.txt"), "utf8");
}

function assertNoBenchmarkCoaching(text, label) {
  const banned = [
    /a_until_end_of_dialog/i,
    /prefer\s+(?:D-pad|DS buttons|key_press|touch)/i,
    /use touch only/i,
    /unless button navigation clearly failed/i,
    /early bedroom/i,
    /NO INFO NEEDED/i,
    /CONTROL INFO/i,
    /ADVENTURE INFO/i,
    /battle checklist/i,
    /Priority order/i,
    /If stuck:/i,
    /Talk to nearby NPCs if story hints are needed/i,
    /For object-selection UIs/i,
    /On the Pokemon HeartGold title screen/i,
  ];
  for (const pattern of banned) {
    assert.doesNotMatch(text, pattern, `${label} contains coaching: ${pattern}`);
  }
}

test("HeartGold benchmark prompt is an instrument manual, not a strategy manual", () => {
  const text = promptText();

  assert.match(text, /RAM\+image/i);
  assert.match(text, /synchronized/i);
  assert.match(text, /official .*game interface/i);
  assert.match(text, /Do not inspect/i);
  assert.match(text, /Do not ask for route hints/i);
  assertNoBenchmarkCoaching(text, "game prompt");
});

test("Codex CLI prompt surface does not add benchmark coaching", () => {
  const text = codexCliPrivate.buildPrompt(
    [],
    {
      game: { title: "Pokemon HeartGold" },
      observationPolicy: { mode: "ram_assisted" },
      observationFreshness: { screenshotHash: "abc123", screenshotAgeMs: 1 },
      current_trainer_data: { position: { map_id: "1", map_name: "Test", x: 1, y: 2, facing: "down" } },
      ram_assisted: { pathfinding: { available: true } },
    },
    { width: 768, height: 1152, rawWidth: 256, rawHeight: 384, scale: 3 }
  );

  assert.match(text, /Return exactly one JSON object/i);
  assert.match(text, /structured state\/history/i);
  assertNoBenchmarkCoaching(text, "Codex CLI prompt");
});

test("Codex Desktop compact observation does not add benchmark coaching", () => {
  const text = desktopPrivate.buildSimplePlayerObservation(
    {
      game: { title: "Pokemon HeartGold" },
      observationPolicy: { mode: "ram_assisted" },
      observationFreshness: { screenshotHash: "abc123", screenshotAgeMs: 1 },
      current_trainer_data: { position: { map_id: "1", map_name: "Test", x: 1, y: 2, facing: "down" } },
      ram_assisted: { pathfinding: { available: true } },
    },
    {
      width: 768,
      height: 1152,
      rawWidth: 256,
      rawHeight: 384,
      scale: 3,
      model_scaled_touch: { source_width: 768, source_height: 1152 },
    },
    {
      mode: "ram_assisted",
      diagnosticsAllowed: false,
      navigation: { validated: true },
      fields: {},
    }
  );

  assert.match(text, /synchronized_ram_image="true"/);
  assert.match(text, /Controls:/);
  assertNoBenchmarkCoaching(text, "Codex Desktop observation");
});

test("benchmark action schema does not expose a_until_end_of_dialog", () => {
  const schema = JSON.stringify(defineTools());

  assert.doesNotMatch(schema, /a_until_end_of_dialog/);
  assert.match(schema, /button_sequence/);
  assert.match(schema, /key_press/);
  assert.match(schema, /touch/);
  assert.match(schema, /type_text/);
  assert.match(schema, /path_to_location/);
});

test("benchmark action handler rejects a_until_end_of_dialog if submitted manually", async () => {
  const result = await handleToolCall(
    {
      name: "execute_action",
      call_id: "call_dialog_macro",
      arguments: JSON.stringify({
        step_details: "",
        chat_message: "",
        avatar_emotion: "thinking",
        actions: [{ type: "a_until_end_of_dialog", frames: 120 }],
      }),
    },
    { game: { title: "Pokemon HeartGold" }, observationPolicy: { mode: "ram_assisted" } }
  );

  const text = JSON.stringify(result);
  assert.match(text, /not available in the HeartGold benchmark action surface/i);
  assert.doesNotMatch(text, /dialogue\/text advances/);
});
