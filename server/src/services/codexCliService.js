const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { config } = require("../config");
const { buildObservationExposure } = require("../ai/observationContract");
const { prepareModelImagePath } = require("./screenshotService");
const { sanitizeFunctionCallArguments, sanitizeModelText, sanitizeModelValue } = require("../ai/modelSurfaceSanitizer");

function exposeAllDecodedRamForModel(exposure) {
  return Boolean(
    config.isHeartGold &&
      config.observation.exposeAllDecodedRam === true &&
      (exposure?.mode === "ram_assisted" || exposure?.diagnosticsAllowed === true)
  );
}

function decodedNavigationAllowed(exposure) {
  return (
    exposure?.navigation?.validated === true ||
    exposure?.location?.validated === true ||
    exposeAllDecodedRamForModel(exposure)
  );
}

function resolveCodexCommand() {
  if (config.codexCli.command !== "codex") {
    return { command: config.codexCli.command, prefixArgs: [], shell: false };
  }

  const appData = process.env.APPDATA;
  if (appData) {
    const codexJs = path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fsSync.existsSync(codexJs)) {
      return { command: process.execPath, prefixArgs: [codexJs], shell: false };
    }
  }

  return { command: "codex", prefixArgs: [], shell: true };
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      if (item.type === "input_text" || item.type === "output_text") return item.text || "";
      if (item.type === "input_image") return "[image attached separately]";
      return sanitizeModelText(JSON.stringify(item));
    })
    .filter(Boolean)
    .join("\n");
}

function formatHistoryItem(item, index) {
  if (!item || typeof item !== "object") return "";

  if (item.role) {
    const role = String(item.role).toUpperCase();
    return `\n<${role}_${index}>\n${sanitizeModelText(textFromContent(item.content))}\n</${role}_${index}>`;
  }

  if (item.type === "function_call") {
    return `\n<ASSISTANT_TOOL_CALL_${index} name="${item.name || "unknown"}">\n${sanitizeFunctionCallArguments(item.name, item.arguments || "")}\n</ASSISTANT_TOOL_CALL_${index}>`;
  }

  if (item.type === "function_call_output") {
    return `\n<TOOL_RESULT_${index}>\n${sanitizeModelText(textFromContent(item.output))}\n</TOOL_RESULT_${index}>`;
  }

  if (item.type === "message") {
    return `\n<ASSISTANT_MESSAGE_${index}>\n${sanitizeModelText(textFromContent(item.content))}\n</ASSISTANT_MESSAGE_${index}>`;
  }

  if (item.type === "reasoning") {
    return "";
  }

  return `\n<ITEM_${index} type="${item.type || "unknown"}">\n${sanitizeModelText(JSON.stringify(item))}\n</ITEM_${index}>`;
}

function latestScreenshotPath(gameDataJson) {
  const rawPath =
    gameDataJson?.screenshotSnapshotPath ||
    gameDataJson?.emulator?.screenshotSnapshotPath ||
    gameDataJson?.observationFreshness?.screenshotSnapshotPath ||
    gameDataJson?.screenshot_raw_path ||
    gameDataJson?.emulator?.screenshotRawPath ||
    gameDataJson?.screenshot_path ||
    null;
  if (!rawPath || typeof rawPath !== "string") return null;

  const resolved = path.resolve(rawPath);
  return fsSync.existsSync(resolved) ? resolved : null;
}

function actionTypesForExposure(exposure = null, gameDataJson = null) {
  const actionTypes = [
    "key_press",
    "touch",
    "type_text",
    "write_memory",
    "delete_memory",
    "update_objectives",
    "restart_console",
  ];

  if (!config.isHeartGold) {
    actionTypes.push("add_marker", "delete_marker", "path_to_location");
    return actionTypes;
  }

  const navigationValidated = decodedNavigationAllowed(exposure);
  const diagnosticsAllowed = exposure?.diagnosticsAllowed === true;
  const coordinateActionsAllowed = navigationValidated || diagnosticsAllowed;
  const pathfindingAllowed =
    coordinateActionsAllowed && gameDataJson?.ram_assisted?.pathfinding?.available !== false;

  if (coordinateActionsAllowed) {
    actionTypes.push("add_marker", "delete_marker");
  }
  if (pathfindingAllowed) {
    actionTypes.push("path_to_location");
  }
  return actionTypes;
}

function actionOutputSchema(exposure = null, gameDataJson = null) {
  const actionTypes = actionTypesForExposure(exposure, gameDataJson);

  const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
  const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };
  const nullableInteger = { anyOf: [{ type: "integer" }, { type: "null" }] };
  const nullableObjective = {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          short_description: { type: "string" },
          description: { type: "string" },
        },
        required: ["short_description", "description"],
      },
      { type: "null" },
    ],
  };
  const nullableObjectiveList = {
    anyOf: [
      {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            short_description: { type: "string" },
            description: { type: "string" },
          },
          required: ["short_description", "description"],
        },
      },
      { type: "null" },
    ],
  };

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      step_details: nullableString,
      actions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
              enum: actionTypes,
            },
            keys: {
              anyOf: [
                {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "string",
                    enum: [
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
                      "a_until_end_of_dialog",
                      "face_up",
                      "face_down",
                      "face_left",
                      "face_right",
                    ],
                  },
                },
                { type: "null" },
              ],
            },
            frames: nullableInteger,
            x: nullableNumber,
            y: nullableNumber,
            coordinate_space: {
              anyOf: [{ type: "string", enum: ["bottom", "full_raw", "display", "model_scaled"] }, { type: "null" }],
            },
            screen: {
              anyOf: [{ type: "string", enum: ["bottom", "full"] }, { type: "null" }],
            },
            source_width: nullableInteger,
            source_height: nullableInteger,
            map_id: nullableString,
            map_name: nullableString,
            emoji: nullableString,
            label: nullableString,
            key: nullableString,
            value: nullableString,
            explanation: nullableString,
            primary: nullableObjective,
            secondary: nullableObjective,
            third: nullableObjective,
            others: nullableObjectiveList,
          },
          required: [
            "type",
            "keys",
            "frames",
            "x",
            "y",
            "coordinate_space",
            "screen",
            "source_width",
            "source_height",
            "map_id",
            "map_name",
            "emoji",
            "label",
            "key",
            "value",
            "explanation",
            "primary",
            "secondary",
            "third",
            "others",
          ],
        },
      },
      chat_message: nullableString,
      avatar_emotion: nullableString,
    },
    required: ["actions"],
  };
}

function normalizeAction(action) {
  const normalized = {};
  for (const [key, value] of Object.entries(action || {})) {
    if (value !== null && value !== undefined) normalized[key] = value;
  }

  if (normalized.type === "touch" && !normalized.frames) {
    normalized.frames = 8;
  }
  if (normalized.type === "touch") {
    normalized.coordinate_space = normalized.coordinate_space || "bottom";
    if (!normalized.screen) {
      normalized.screen = normalized.coordinate_space === "bottom" ? "bottom" : "full";
    }
  }

  return normalized;
}

function isDialogLikeText(text) {
  return /\b(dialog|dialogue|text box|text page|narration|intro|oak|professor|advance|clearing|clear)\b/i.test(
    String(text || "")
  );
}

function isMenuLikeText(text) {
  const value = String(text || "").toLowerCase();
  if (/\b(no visible (choice|menu)|no (choice|menu)|without a (choice|menu))\b/.test(value)) {
    return false;
  }
  return /\b(visible (choice|menu|option)|choice screen|menu screen|choose|select|option screen|lower-screen target|control info|adventure info|no info needed|gender selection|boy|girl|portrait|highlighted|naming keyboard|keyboard|yes|no)\b/i.test(value);
}

function normalizeHeartGoldAction(action, actionPayload) {
  const normalized = normalizeAction(action);
  if (!config.isHeartGold) return normalized;

  const reasoningText = `${actionPayload?.step_details || ""}\n${actionPayload?.chat_message || ""}`;
  const isSingleA =
    normalized.type === "key_press" &&
    Array.isArray(normalized.keys) &&
    normalized.keys.length === 1 &&
    String(normalized.keys[0]).toLowerCase() === "a";

  if (isSingleA && isDialogLikeText(reasoningText) && !isMenuLikeText(reasoningText)) {
    normalized.keys = ["a_until_end_of_dialog"];
    if (!normalized.frames || normalized.frames < 90) normalized.frames = 90;
  }

  const usesDialogAdvance =
    normalized.type === "key_press" &&
    Array.isArray(normalized.keys) &&
    normalized.keys.length === 1 &&
    String(normalized.keys[0]).toLowerCase() === "a_until_end_of_dialog";

  if (usesDialogAdvance && isMenuLikeText(reasoningText)) {
    normalized.keys = ["a"];
    normalized.frames = 8;
  }

  return normalized;
}

function buildBenchmarkContext(gameDataJson, modelImage = null) {
  const exposure = buildObservationExposure(gameDataJson);
  const freshness = gameDataJson?.observationFreshness || {};
  const modelImageScale = modelImage?.scale || config.observation.modelImageScale;
  const requestedSpeedMode = String(process.env.HEARTGOLD_SPEED_MODE || "100");
  const allowFastForward = ["1", "true", "yes", "on"].includes(String(process.env.HEARTGOLD_ALLOW_FAST_FORWARD || "").toLowerCase());
  const benchmarkModes = new Set(["visual", "ram_assisted"]);
  const benchmarkComparable =
    benchmarkModes.has(exposure.mode) &&
    benchmarkModes.has(config.observation.requestedMode) &&
    config.observation.modeWasInvalid !== true &&
    !exposure.exposeOracle &&
    Number(modelImageScale) === Number(config.observation.modelImageScale) &&
    requestedSpeedMode === "100" &&
    !allowFastForward;
  const position = decodedNavigationAllowed(exposure)
    ? gameDataJson?.current_trainer_data?.position || null
    : null;
  const stateFields = {};
  for (const [field, details] of Object.entries(exposure.fields || {})) {
    if (details?.validated === true || exposeAllDecodedRamForModel(exposure)) {
      stateFields[field] = { shown: true };
    }
  }

  return {
    provider: "codex-cli",
    profile: config.gameProfile,
    observation_mode: exposure.mode,
    requested_observation_mode: config.observation.requestedMode,
    observation_mode_was_invalid: config.observation.modeWasInvalid,
    observation_lane:
      exposure.mode === "visual" ? "visual" : exposure.mode === "ram_assisted" || exposure.mode === "standard" ? "ram_assisted" : "monitor",
    primary_game_observation: exposure.mode === "ram_assisted",
    run_comparable: benchmarkComparable,
    requested_speed_mode: requestedSpeedMode,
    allow_fast_forward: allowFastForward,
    screenshot: {
      hash: freshness.screenshotHash || gameDataJson?.screenshotCacheKey || null,
      cache_key: gameDataJson?.screenshotCacheKey || gameDataJson?.emulator?.screenshotCacheKey || null,
      age_ms: freshness.screenshotAgeMs ?? null,
      heartbeat_age_seconds: freshness.heartbeatAgeSeconds ?? null,
      visual_available: freshness.visualAvailable !== false,
      raw_width: modelImage?.rawWidth || gameDataJson?.emulator?.screenWidth || null,
      raw_height: modelImage?.rawHeight || gameDataJson?.emulator?.screenHeight || null,
    },
    model_image: modelImage
      ? {
          image_id: modelImage.cacheKey || modelImage.screenshotHash || "current_ds_screenshot",
          screenshot_hash: modelImage.screenshotHash || freshness.screenshotHash || null,
          scale: modelImage.scale,
          width: modelImage.width,
          height: modelImage.height,
          raw_width: modelImage.rawWidth,
          raw_height: modelImage.rawHeight,
          coordinate_note:
            "Attached image is nearest-neighbor upscaled for readability. Default touch coordinates remain bottom-screen 256x192; use coordinate_space model_scaled with source_width/source_height only if choosing coordinates from the attached image.",
        }
      : null,
    navigation: {
      available: decodedNavigationAllowed(exposure),
      position,
      path_to_location:
        decodedNavigationAllowed(exposure) && gameDataJson?.ram_assisted?.pathfinding?.available !== false
          ? "enabled"
          : "disabled",
    },
    state_fields: exposure.mode === "visual" ? null : stateFields,
  };
}

function buildPrompt(apiInput, gameDataJson, modelImage = null) {
  const formattedInput = apiInput.map(formatHistoryItem).filter(Boolean).join("\n");
  const gameLabel = gameDataJson?.game?.title || "Pokemon HeartGold";

  return [
    "You are GPT playing Pokemon HeartGold autonomously.",
    `Game: ${gameLabel}.`,
    "You must not run shell commands, rg, grep, PowerShell, inspect files, edit files, or ask the user for help.",
    "Use the attached screenshot plus the structured state/history below.",
    "Return exactly one JSON object matching the provided schema.",
    "For each action object, fill irrelevant fields with null.",
    "Use key_press for normal Nintendo DS controls. Use touch for visible lower-screen targets when it is faster or clearer than buttons.",
    "The attached DS image may be nearest-neighbor upscaled for readability. Raw full-screen coordinates are still 256x384 and bottom-screen touch coordinates are still 256x192. If you choose coordinates directly from the attached model image, set coordinate_space \"model_scaled\", screen \"full\", and include source_width/source_height from GAME_CONTEXT.model_image.",
    "Use type_text with value \"GPT\" on the player naming keyboard instead of manually tapping letter coordinates.",
    "For HeartGold YES/NO confirmations and naming-screen OK, prefer D-pad/A over touch unless button navigation clearly failed.",
    "For visible HeartGold dialog/text boxes, prefer key_press with keys [\"a_until_end_of_dialog\"] over repeated single A turns.",
    "For a visible choice/menu, use D-pad/A or touch the visible lower-screen target, whichever is clearer.",
    "Use only the attached screenshot, decoded current game state, recent history, memory/objectives, and the action schema as gameplay knowledge.",
    "Treat fields labeled unknown, candidate, partial, inferred, or heuristic as uncertain and verify them against the screenshot before acting on them.",
    "If X does not open the start menu after one or two attempts in the early bedroom sequence, continue the story and set Text Speed later when menu access is actually available.",
    "The HeartGold bootstrap has already dismissed the CONTROL INFO / ADVENTURE INFO / NO INFO NEEDED menu. If Professor Oak or intro narration is visible, keep advancing it; do not try to pick NO INFO NEEDED again.",
    "If that initial menu ever appears again, buttons need three separated Down presses then A because the first Down only activates focus on CONTROL INFO.",
    "",
    "<GAME_CONTEXT>",
    JSON.stringify(sanitizeModelValue(buildBenchmarkContext(gameDataJson, modelImage)), null, 2),
    "</GAME_CONTEXT>",
    "",
    formattedInput,
  ].join("\n");
}

function runCodexExec({ prompt, schemaPath, outputPath, imagePath, reasoningEffort, cwd }) {
  return new Promise((resolve, reject) => {
    const codexCommand = resolveCodexCommand();
    const args = [
      ...codexCommand.prefixArgs,
      "-a",
      "never",
      "exec",
      "--ephemeral",
      "--ignore-rules",
      "--ignore-user-config",
      "-m",
      config.codexCli.model,
      "-c",
      `model_reasoning_effort="${reasoningEffort || config.codexCli.reasoningEffort}"`,
      "-c",
      'disabled_tools=["exec","command","apply_patch","mcp_tool_call","network_access"]',
    ];

    if (imagePath) {
      args.push("--image", imagePath);
    }

    args.push(
      "--json",
      "--color",
      "never",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "-C",
      cwd || config.codexCli.outputDir,
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "-"
    );

    const env = { ...process.env, OPENAI_API_KEY: "" };
    const child = spawn(codexCommand.command, args, {
      cwd: cwd || config.codexCli.outputDir,
      env,
      shell: codexCommand.shell,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`codex exec timed out after ${config.codexCli.timeout}ms`));
    }, config.codexCli.timeout);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`codex exec exited with ${code}: ${stdout}\n${stderr}`.trim()));
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function readJsonOutput(outputPath) {
  const raw = await fs.readFile(outputPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (match) return JSON.parse(match[1]);
    throw new Error(`Could not parse codex CLI JSON output: ${error.message}. Raw output: ${raw.slice(0, 500)}`);
  }
}

function validateActionPayload(payload, exposure = null, gameDataJson = null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Codex CLI output must be a JSON object");
  }
  if (!Array.isArray(payload.actions) || payload.actions.length === 0) {
    throw new Error("Codex CLI output must include at least one action");
  }
  const allowedTypes =
    actionOutputSchema(exposure, gameDataJson)?.properties?.actions?.items?.properties?.type?.enum || [];
  for (const [index, action] of payload.actions.entries()) {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error(`Action ${index} must be an object`);
    }
    if (!allowedTypes.includes(action.type)) {
      throw new Error(`Action ${index} has invalid type '${action.type}'`);
    }
  }
  return {
    ...payload,
    step_details: typeof payload.step_details === "string" ? payload.step_details : "",
    chat_message: typeof payload.chat_message === "string" ? payload.chat_message : "",
    avatar_emotion:
      typeof payload.avatar_emotion === "string" && payload.avatar_emotion ? payload.avatar_emotion : "thinking",
  };
}

async function callCodexCliForAction({ apiInput, gameDataJson, reasoningEffort, imagePath = null, imageMeta = null }) {
  await fs.mkdir(config.codexCli.outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(os.tmpdir(), "heartgold-codex-cli-runs", `${timestamp}-${Math.random().toString(16).slice(2)}`);
  const artifactDir = path.join(config.codexCli.outputDir, "runs", timestamp);
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(artifactDir, { recursive: true });
  const schemaPath = path.join(runDir, "action_schema.json");
  const outputPath = path.join(runDir, "action_output.json");
  const promptPath = path.join(runDir, "action_prompt.txt");
  const artifactSchemaPath = path.join(artifactDir, "action_schema.json");
  const artifactOutputPath = path.join(artifactDir, "action_output.json");
  const artifactPromptPath = path.join(artifactDir, "action_prompt.txt");
  const preparedImage = imagePath
    ? { path: imagePath, ...(imageMeta || {}) }
    : await prepareModelImagePath(gameDataJson).catch((error) => ({ path: null, error: error.message }));
  const exposure = buildObservationExposure(gameDataJson);
  const requiresPreparedModelImage =
    config.isHeartGold && ["visual", "ram_assisted"].includes(exposure.mode);
  if (requiresPreparedModelImage && !preparedImage?.path) {
    throw new Error(`HeartGold Codex CLI observation requires a fresh prepared model image: ${preparedImage?.error || "unknown error"}`);
  }
  const finalImagePath = preparedImage?.path || latestScreenshotPath(gameDataJson);
  let isolatedImagePath = null;
  if (finalImagePath) {
    isolatedImagePath = path.join(runDir, path.basename(finalImagePath));
    await fs.copyFile(finalImagePath, isolatedImagePath);
  }
  const prompt = buildPrompt(apiInput, gameDataJson, preparedImage?.path ? preparedImage : null);

  await fs.writeFile(schemaPath, JSON.stringify(actionOutputSchema(exposure, gameDataJson), null, 2), "utf8");
  await fs.writeFile(promptPath, prompt, "utf8");

  const startedAt = Date.now();
  const result = await runCodexExec({ prompt, schemaPath, outputPath, imagePath: isolatedImagePath, reasoningEffort, cwd: runDir });
  const actionPayload = validateActionPayload(await readJsonOutput(outputPath), exposure, gameDataJson);
  await Promise.all([
    fs.copyFile(schemaPath, artifactSchemaPath),
    fs.copyFile(outputPath, artifactOutputPath),
    fs.copyFile(promptPath, artifactPromptPath),
  ]);
  const actions = Array.isArray(actionPayload.actions)
    ? actionPayload.actions.map((action) => normalizeHeartGoldAction(action, actionPayload))
    : [];

  return {
    response: {
      id: `codex_cli_${Date.now()}`,
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: actionPayload.chat_message || "",
            },
          ],
        },
        {
          type: "function_call",
          id: `call_codex_cli_${Date.now()}`,
          call_id: `call_codex_cli_${Date.now()}`,
          name: "execute_action",
          arguments: JSON.stringify({
            step_details: actionPayload.step_details || "",
            actions,
            chat_message: actionPayload.chat_message || "",
            avatar_emotion: actionPayload.avatar_emotion || "thinking",
          }),
        },
      ],
      usage: null,
    },
    meta: {
      provider: "codex-cli",
      model: config.codexCli.model,
      reasoningEffort: reasoningEffort || config.codexCli.reasoningEffort,
      durationMs: Date.now() - startedAt,
      imagePath: finalImagePath,
      isolatedImagePath,
      modelImage: preparedImage || null,
      runDir,
      artifactDir,
      promptPath: artifactPromptPath,
      outputPath: artifactOutputPath,
      schemaPath: artifactSchemaPath,
      stdout: result.stdout,
      stderr: result.stderr,
    },
  };
}

module.exports = {
  callCodexCliForAction,
  _private: { actionOutputSchema, actionTypesForExposure, buildBenchmarkContext, buildPrompt, latestScreenshotPath, sanitizeModelText },
};
