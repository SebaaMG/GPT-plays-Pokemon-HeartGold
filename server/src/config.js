const path = require("path");

// `__dirname` points to `server/src`; ROOT_DIR is `server/`
const ROOT_DIR = path.join(__dirname, "..");
const GAME_PROFILE = String(process.env.GAME_PROFILE || "heartgold").toLowerCase();
const IS_HEARTGOLD = GAME_PROFILE === "heartgold";
const DEFAULT_PYTHON_BASE_URL = IS_HEARTGOLD ? "http://127.0.0.1:8010" : "http://127.0.0.1:8000";
const DEFAULT_DATA_DIR = IS_HEARTGOLD ? "gpt_data_heartgold" : "gpt_data";
const DEFAULT_PROMPTS_DIR = IS_HEARTGOLD ? "prompts_heartgold" : "prompts";
const DEFAULT_GAME_PROMPT_FILE = path.join(ROOT_DIR, DEFAULT_PROMPTS_DIR, "game.txt");
const DEFAULT_OPENAI_MODEL = "gpt-5.2";
const DEFAULT_REASONING_EFFORT = IS_HEARTGOLD ? "xhigh" : "high";
const AGENT_PROVIDER = String(process.env.AGENT_PROVIDER || (IS_HEARTGOLD ? "codex-desktop" : "openai")).toLowerCase();
const IS_CODEX_LOCAL_PROVIDER = AGENT_PROVIDER === "codex-cli" || AGENT_PROVIDER === "codex-desktop";
const OBSERVATION_MODE_ALIASES = new Map([
  ["standard_assisted", "ram_assisted"],
  ["assisted", "ram_assisted"],
  ["standard", "ram_assisted"],
]);
const OBSERVATION_MODES = new Set(["visual", "ram_assisted", "oracle_debug", "harness_validation"]);
const HEARTGOLD_OBSERVATION_MODE_RAW = String(
  process.env.HEARTGOLD_OBSERVATION_MODE || (IS_HEARTGOLD ? "ram_assisted" : "standard")
).toLowerCase();
const HEARTGOLD_OBSERVATION_MODE_NORMALIZED =
  OBSERVATION_MODE_ALIASES.get(HEARTGOLD_OBSERVATION_MODE_RAW) || HEARTGOLD_OBSERVATION_MODE_RAW;
const HEARTGOLD_OBSERVATION_MODE = OBSERVATION_MODES.has(HEARTGOLD_OBSERVATION_MODE_NORMALIZED)
  ? HEARTGOLD_OBSERVATION_MODE_NORMALIZED
  : "ram_assisted";
const envFlagDisabled = (value) => ["0", "false", "no", "off"].includes(String(value || "").trim().toLowerCase());
const envFlagEnabled = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
const envText = (...values) => {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
};
const CODEX_CLI_MODEL = envText(process.env.CODEX_MODEL, process.env.CODEX_DESKTOP_MODEL, process.env.OPENAI_MODEL);
const CODEX_DESKTOP_MODEL = envText(process.env.CODEX_DESKTOP_MODEL, process.env.CODEX_MODEL, process.env.OPENAI_MODEL);

const config = {
  gameProfile: GAME_PROFILE,
  isHeartGold: IS_HEARTGOLD,
  agentProvider: AGENT_PROVIDER,
  isCodexLocalProvider: IS_CODEX_LOCAL_PROVIDER,
  agentAutostart: process.env.AGENT_AUTOSTART !== "false",
  autoLaunchEmulator: process.env.AUTO_LAUNCH_EMULATOR !== "false",
  autoBootstrapIntro: process.env.AUTO_BOOTSTRAP_INTRO !== "false",
  wsPort: Number(process.env.WS_PORT || 9885),

  // --- OpenAI Configuration ---
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: envText(process.env.OPENAI_MODEL) || DEFAULT_OPENAI_MODEL,
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT || DEFAULT_REASONING_EFFORT,
    reasoningEffortBattle: process.env.OPENAI_REASONING_EFFORT_BATTLE || DEFAULT_REASONING_EFFORT,
    reasoningEffortDialog: process.env.OPENAI_REASONING_EFFORT_DIALOG || DEFAULT_REASONING_EFFORT,
    reasoningEffortCriticism: process.env.OPENAI_REASONING_EFFORT_CRITICISM || "high",
    reasoningEffortSummary: process.env.OPENAI_REASONING_EFFORT_SUMMARY || "xhigh",
    modelPathFinding: process.env.OPENAI_MODEL_PATHFINDING || "gpt-5.2",
    reasoningEffortPathfinding: process.env.OPENAI_REASONING_EFFORT_PATHFINDING || "high",
    reasoningSummary: process.env.OPENAI_REASONING_SUMMARY || "auto",

    tokenLimit: Number(process.env.OPENAI_TOKEN_LIMIT || 250000),
    timeout: Number(process.env.OPENAI_TIMEOUT_MS || 15 * 60 * 1000),
    service_tier: process.env.OPENAI_SERVICE_TIER || "priority",
    service_tierSelfCriticism:
      process.env.OPENAI_SERVICE_TIER_SELF_CRITICISM || process.env.OPENAI_SERVICE_TIER || "priority",
    service_tierSummary: process.env.OPENAI_SERVICE_TIER_SUMMARY || process.env.OPENAI_SERVICE_TIER || "priority",
    service_tierPathfinding: process.env.OPENAI_SERVICE_TIER_PATHFINDING || "priority",

    tokenPrice: {
      "gpt-5.2": { input: 1.75, cached_input: 0.175, output: 14 },
      "gpt-5.1": { input: 1.25, cached_input: 0.125, output: 10 },
      "gpt-5": { input: 1.25, cached_input: 0.125, output: 10 },
      "gpt-4.1": { input: 2, cached_input: 0.5, output: 8 },
      "o4-mini": { input: 1.1, cached_input: 0.275, output: 4.4 },
      "o3": { input: 10, cached_input: 2.5, output: 40 },
    },
  },

  // --- Python bridge configuration ---
  pythonServer: {
    baseUrl: process.env.PYTHON_BASE_URL || DEFAULT_PYTHON_BASE_URL,
    timeoutMs: Number(process.env.PYTHON_REQUEST_TIMEOUT_MS || (IS_HEARTGOLD ? 90000 : 10000)),
    actionTimeoutMs: Number(process.env.PYTHON_ACTION_TIMEOUT_MS || (IS_HEARTGOLD ? 90000 : 30000)),
    launchTimeoutMs: Number(process.env.PYTHON_LAUNCH_TIMEOUT_MS || (IS_HEARTGOLD ? 60000 : 30000)),
    bootstrapTimeoutMs: Number(process.env.PYTHON_BOOTSTRAP_TIMEOUT_MS || (IS_HEARTGOLD ? 120000 : 60000)),
    saveLoadTimeoutMs: Number(process.env.PYTHON_SAVE_LOAD_TIMEOUT_MS || (IS_HEARTGOLD ? 60000 : 30000)),
    endpoints: {
      requestData: "/requestData",
      minimapSnapshot: "/minimapSnapshot",
      sendCommands: "/sendCommands",
      restartConsole: "/restartConsole",
      launchEmulator: "/launchEmulator",
      bootstrapIntro: "/bootstrapIntro",
      saveState: "/saveState",
      loadState: "/loadState",
    },
  },

  // --- Runtime Paths ---
  get dataDir() {
    return process.env.GPT_DATA_DIR || DEFAULT_DATA_DIR;
  },

  // --- Local Codex CLI provider ---
  // Uses the logged-in Codex CLI account instead of OPENAI_API_KEY. Set
  // AGENT_PROVIDER=codex-cli to route main gameplay decisions through it.
  codexCli: {
    command: process.env.CODEX_CLI_COMMAND || "codex",
    model: CODEX_CLI_MODEL,
    reasoningEffort: process.env.CODEX_REASONING_EFFORT || process.env.OPENAI_REASONING_EFFORT || DEFAULT_REASONING_EFFORT,
    timeout: Number(process.env.CODEX_TIMEOUT_MS || 15 * 60 * 1000),
    get outputDir() {
      return process.env.CODEX_OUTPUT_DIR || path.join(ROOT_DIR, config.dataDir, "codex_cli");
    },
  },

  // Manual/operator provider for Codex Desktop. This mode does not call the
  // OpenAI API or spawn `codex exec`; it exports the benchmark observation and
  // accepts an execute_action JSON response from the current Codex Desktop
  // conversation.
  codexDesktop: {
    model: CODEX_DESKTOP_MODEL,
    reasoningEffort:
      process.env.CODEX_DESKTOP_REASONING_EFFORT ||
      process.env.CODEX_REASONING_EFFORT ||
      process.env.OPENAI_REASONING_EFFORT ||
      DEFAULT_REASONING_EFFORT,
    restoreObservationAnchor:
      IS_HEARTGOLD &&
      (envFlagEnabled(process.env.CODEX_DESKTOP_RESTORE_OBSERVATION_ANCHOR) ||
        envFlagEnabled(process.env.HEARTGOLD_CODEX_DESKTOP_RESTORE_ANCHOR)),
    skipPreActionRefresh:
      IS_HEARTGOLD && envFlagEnabled(process.env.HEARTGOLD_CODEX_DESKTOP_SKIP_PREACTION_REFRESH),
    allowDegradedVisualFallback:
      IS_HEARTGOLD && envFlagEnabled(process.env.HEARTGOLD_CODEX_DESKTOP_ALLOW_DEGRADED_VISUAL_FALLBACK),
    get outputDir() {
      return process.env.CODEX_DESKTOP_OUTPUT_DIR || path.join(ROOT_DIR, config.dataDir, "codex_desktop");
    },
    get anchorDir() {
      return process.env.CODEX_DESKTOP_ANCHOR_DIR || path.join(config.codexDesktop.outputDir, "anchors");
    },
  },

  observation: {
    mode: HEARTGOLD_OBSERVATION_MODE,
    requestedMode: HEARTGOLD_OBSERVATION_MODE_RAW,
    modeWasInvalid: !OBSERVATION_MODES.has(HEARTGOLD_OBSERVATION_MODE_NORMALIZED),
    exposeOracle: process.env.HEARTGOLD_EXPOSE_ORACLE === "true",
    confidenceRequired: process.env.HEARTGOLD_STATE_CONFIDENCE_REQUIRED !== "false",
    exposeAllDecodedRam: IS_HEARTGOLD && !envFlagDisabled(process.env.HEARTGOLD_EXPOSE_ALL_DECODED_RAM),
    modelImageScale: Math.max(1, Math.min(4, Number(process.env.HEARTGOLD_MODEL_IMAGE_SCALE || 3) || 3)),
    maxScreenshotAgeMs: Math.max(250, Number(process.env.HEARTGOLD_MAX_SCREENSHOT_AGE_MS || 5000) || 5000),
  },

  get promptsDir() {
    return process.env.PROMPTS_DIR || path.join(ROOT_DIR, DEFAULT_PROMPTS_DIR);
  },

  // --- File Paths ---
  paths: {
    baseDir: ROOT_DIR,

    get dataDir() {
      return config.dataDir;
    },

    get historySaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "history.json");
    },
    get memorySaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "memory.json");
    },
    get objectivesSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "objectives.json");
    },
    get markersSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "markers.json");
    },
    get countersSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "counters.json");
    },
    get badgesSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "badges_log.json");
    },
    get mapVisitsSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "map_visits.json");
    },
    get summariesSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "summaries.json");
    },
    get allSummariesSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "all_summaries.json");
    },
    get progressStepsFile() {
      return path.join(ROOT_DIR, config.dataDir, "progress_steps.json");
    },
    get progressStepsTemplateFile() {
      const explicit = process.env.PROGRESS_STEPS_TEMPLATE;
      if (explicit) return explicit;
      return path.join(ROOT_DIR, "progress_steps_heartgold.json");
    },
    get lastVisitedMapsFile() {
      return path.join(ROOT_DIR, config.dataDir, "last_visited_maps.json");
    },
    get playerReasoningArchiveFile() {
      return path.join(ROOT_DIR, config.dataDir, "player_reasoning_archive.json");
    },
    get gameDataJsonFile() {
      return path.join(ROOT_DIR, config.dataDir, "game_data.json");
    },
    get gamePromptFile() {
      return process.env.GAME_PROMPT_FILE || DEFAULT_GAME_PROMPT_FILE;
    },
    get lastCriticismSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "last_criticism.txt");
    },
    get tokenUsageFile() {
      return path.join(ROOT_DIR, config.dataDir, "token_usage.json");
    },
    get timeUsageFile() {
      return path.join(ROOT_DIR, config.dataDir, "time_usage.json");
    },
    get benchmarkMetricsFile() {
      return path.join(ROOT_DIR, config.dataDir, "benchmark_metrics.json");
    },
    get benchmarkEventsFile() {
      return path.join(ROOT_DIR, config.dataDir, "benchmark_events.jsonl");
    },
    get lastUserInputTextSaveFile() {
      return path.join(ROOT_DIR, config.dataDir, "last_userInputText_prompt.txt");
    },
  },

  // --- History Processing Configuration ---
  history: {
    keepLastNToolPartialResults: 20,
    keepLastNToolFullResults: 6,
    keepLastNUserMessagesWithMinimap: 1,
    keepLastNUserMessagesWithMemory: 1,
    keepLastNUserMessagesWithViewMap: 5,
    keepLastNUserMessagesWithImages: 10,
    keepLastNUserMessagesWithDetailedData: 4,
    keepLastNUserMessagesWithPokedex: 1,
    limitAssistantMessagesForSelfCriticism: 55,
    limitAssistantMessagesForSummary: 120,
  },

  // --- Tool Configuration ---
  tools: {
    strict: true,
  },

  // --- Loop Configuration ---
  loopDelayMs: 0,
  maxAgentSteps: Number(process.env.AGENT_MAX_STEPS || 0),
};

module.exports = { config };
