const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { config } = require("../config");
const { sanitizeModelText, sanitizeModelValue } = require("../ai/modelSurfaceSanitizer");

/**
 * Central in-memory state for the agent.
 */
const state = {
  history: [],
  memory: {},
  objectives: { primary: {}, secondary: {}, third: {}, others: [] },
  markers: {},
  counters: { currentStep: 0, lastCriticismStep: 0, lastSummaryStep: 0 },
  summaries: [],
  allSummaries: [],
  badgeHistory: {},
  previousBadgesState: {},
  mapVisitHistory: {},
  progressSteps: [],
  lastVisitedMaps: [],
  skipNextUserMessage: false,
  selfCritiqueReminderPending: false,
  selfCritiqueReminderAcknowledged: false,
  gameDataJsonRef: null,
  lastTotalTokens: 0,
  isThinking: false,
  playerReasoning: { recent: [], archive: [] },
};

let broadcast = null;
const PLAYER_REASONING_RECENT_LIMIT = 12;

function attachBroadcast(fn) {
  broadcast = fn;
}

function setIsThinking(value) {
  state.isThinking = value;
  if (broadcast) {
    broadcast({ type: "isThinking_update", payload: value });
  }
}

function sanitizeMemoryState(memory) {
  if (!memory || typeof memory !== "object" || Array.isArray(memory)) return {};
  const out = {};
  for (const [key, value] of Object.entries(memory)) {
    const safeKey = sanitizeModelText(String(key || "")).slice(0, 200);
    if (!safeKey) continue;
    out[safeKey] = sanitizeModelText(String(value ?? ""));
  }
  return out;
}

function sanitizeObjectivesState(objectives) {
  const safe = sanitizeModelValue(objectives && typeof objectives === "object" ? objectives : {});
  return safe && typeof safe === "object" && !Array.isArray(safe) ? safe : {};
}

function sanitizeMarkersState(markers) {
  if (!markers || typeof markers !== "object" || Array.isArray(markers)) return {};
  const out = {};
  for (const [mapId, mapMarkers] of Object.entries(markers)) {
    if (!mapMarkers || typeof mapMarkers !== "object" || Array.isArray(mapMarkers)) continue;
    const safeMapId = sanitizeModelText(String(mapId || ""));
    if (!safeMapId) continue;
    const safeMarkers = {};
    for (const [coordKey, marker] of Object.entries(mapMarkers)) {
      if (!marker || typeof marker !== "object" || Array.isArray(marker)) continue;
      const safeCoordKey = String(coordKey || "");
      if (!safeCoordKey) continue;
      safeMarkers[safeCoordKey] = sanitizeModelValue(marker);
    }
    if (Object.keys(safeMarkers).length > 0) out[safeMapId] = safeMarkers;
  }
  return out;
}

function safeNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeTimestamp(value) {
  return typeof value === "string" ? sanitizeModelText(value).slice(0, 80) : null;
}

function sanitizeBadgeHistoryState(badgeHistory) {
  if (!badgeHistory || typeof badgeHistory !== "object" || Array.isArray(badgeHistory)) return {};
  const out = {};
  for (const [badgeId, info] of Object.entries(badgeHistory)) {
    const safeBadgeId = sanitizeModelText(String(badgeId || "")).slice(0, 120);
    if (!safeBadgeId) continue;
    if (info && typeof info === "object" && !Array.isArray(info)) {
      out[safeBadgeId] = {
        obtained: Boolean(info.obtained),
        step: safeNumberOrNull(info.step),
        timestamp: sanitizeTimestamp(info.timestamp),
      };
    } else {
      out[safeBadgeId] = { obtained: Boolean(info), step: null, timestamp: null };
    }
  }
  return out;
}

function sanitizeMapVisitHistoryState(mapVisitHistory) {
  if (!mapVisitHistory || typeof mapVisitHistory !== "object" || Array.isArray(mapVisitHistory)) return {};
  const out = {};
  for (const [mapId, info] of Object.entries(mapVisitHistory)) {
    const safeMapId = sanitizeModelText(String(mapId || "")).slice(0, 120);
    if (!safeMapId || safeMapId === "0-0") continue;
    const safeInfo = info && typeof info === "object" && !Array.isArray(info) ? info : {};
    out[safeMapId] = {
      map_name: sanitizeModelText(String(safeInfo.map_name || `Unknown Map (${safeMapId})`)).slice(0, 200),
      step: safeNumberOrNull(safeInfo.step),
      timestamp: sanitizeTimestamp(safeInfo.timestamp),
    };
  }
  return out;
}

function sanitizeLastVisitedMapsState(lastVisitedMaps) {
  if (!Array.isArray(lastVisitedMaps)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of lastVisitedMaps) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const safeMapId = sanitizeModelText(String(entry.map_id || "")).slice(0, 120);
    if (!safeMapId || safeMapId === "0-0" || seen.has(safeMapId)) continue;
    seen.add(safeMapId);
    out.push({
      map_id: safeMapId,
      map_name: sanitizeModelText(String(entry.map_name || `Unknown Map (${safeMapId})`)).slice(0, 200),
      timestamp: sanitizeTimestamp(entry.timestamp),
      step: safeNumberOrNull(entry.step),
    });
    if (out.length >= 7) break;
  }
  return out;
}

function sanitizeProgressStepsState(progressSteps) {
  if (!Array.isArray(progressSteps)) return [];
  return progressSteps
    .filter((step) => step && typeof step === "object" && !Array.isArray(step))
    .map((step) => {
      const safeStep = sanitizeModelValue(step);
      return {
        ...safeStep,
        done: safeStep.done === true,
        done_on: sanitizeTimestamp(safeStep.done_on),
      };
    });
}

function sanitizePlayerReasoningRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const safe = {
    step: safeNumberOrNull(record.step),
    call_id: sanitizeModelText(String(record.call_id || "")),
    at: sanitizeTimestamp(record.at),
    step_details: sanitizeModelText(String(record.step_details ?? "")),
    chat_message: sanitizeModelText(String(record.chat_message ?? "")),
    avatar_emotion: sanitizeModelText(String(record.avatar_emotion ?? "")),
  };
  if (Array.isArray(record.action_types)) {
    safe.action_types = record.action_types
      .map((item) => sanitizeModelText(String(item || "")))
      .filter(Boolean);
  }
  return safe;
}

function sanitizePlayerReasoningState(playerReasoning) {
  const source = playerReasoning && typeof playerReasoning === "object" && !Array.isArray(playerReasoning)
    ? playerReasoning
    : {};
  const recent = (Array.isArray(source.recent) ? source.recent : [])
    .map(sanitizePlayerReasoningRecord)
    .filter(Boolean);
  const archive = (Array.isArray(source.archive) ? source.archive : [])
    .map(sanitizePlayerReasoningRecord)
    .filter(Boolean);
  while (recent.length > PLAYER_REASONING_RECENT_LIMIT) {
    archive.push(recent.shift());
  }
  return { recent, archive };
}

async function readJsonFileOrDefault(filePath, fallbackValue, label) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`Error loading ${label}:`, error);
    }
    return typeof fallbackValue === "function" ? fallbackValue() : fallbackValue;
  }
}

function sanitizeModelOwnedPersistence() {
  state.memory = sanitizeMemoryState(state.memory);
  state.objectives = sanitizeObjectivesState(state.objectives);
  state.markers = sanitizeMarkersState(state.markers);
  state.badgeHistory = sanitizeBadgeHistoryState(state.badgeHistory);
  state.previousBadgesState = Object.fromEntries(
    Object.entries(state.badgeHistory).map(([badgeId, info]) => [badgeId, Boolean(info?.obtained)])
  );
  state.mapVisitHistory = sanitizeMapVisitHistoryState(state.mapVisitHistory);
  state.progressSteps = sanitizeProgressStepsState(state.progressSteps);
  state.lastVisitedMaps = sanitizeLastVisitedMapsState(state.lastVisitedMaps);
  state.playerReasoning = sanitizePlayerReasoningState(state.playerReasoning);
}

function recordPlayerReasoningTurn({ step, callId, stepDetails, chatMessage, avatarEmotion, actions } = {}) {
  state.playerReasoning = sanitizePlayerReasoningState(state.playerReasoning);
  const record = sanitizePlayerReasoningRecord({
    step,
    call_id: callId,
    at: new Date().toISOString(),
    step_details: stepDetails,
    chat_message: chatMessage,
    avatar_emotion: avatarEmotion,
    action_types: Array.isArray(actions) ? actions.map((action) => action?.type).filter(Boolean) : [],
  });
  if (!record) return;
  state.playerReasoning.recent.push(record);
  while (state.playerReasoning.recent.length > PLAYER_REASONING_RECENT_LIMIT) {
    state.playerReasoning.archive.push(state.playerReasoning.recent.shift());
  }
}

function recallPlayerReasoningArchive({ query = "", limit = 12, offset = 0, turnStart = null, turnEnd = null } = {}) {
  state.playerReasoning = sanitizePlayerReasoningState(state.playerReasoning);
  const exactQuery = String(query || "");
  const maxLimit = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 12)));
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const start = turnStart == null ? null : Number(turnStart);
  const end = turnEnd == null ? null : Number(turnEnd);
  const matched = state.playerReasoning.archive.filter((record) => {
    if (Number.isFinite(start) && Number(record.step) < start) return false;
    if (Number.isFinite(end) && Number(record.step) > end) return false;
    if (!exactQuery) return true;
    return (
      String(record.step_details || "").includes(exactQuery) ||
      String(record.chat_message || "").includes(exactQuery) ||
      String(record.avatar_emotion || "").includes(exactQuery)
    );
  });
  return {
    total_matched: matched.length,
    returned: matched.slice(safeOffset, safeOffset + maxLimit),
  };
}

function historyEndsWithSelfCritiqueMessage(currentHistory) {
  if (!Array.isArray(currentHistory) || currentHistory.length === 0) return false;

  for (let i = currentHistory.length - 1; i >= 0; i--) {
    const entry = currentHistory[i];
    if (!entry) continue;

    if (entry.role === "assistant" && Array.isArray(entry.content)) {
      return entry.content.some(
        (item) =>
          item &&
          item.type === "output_text" &&
          typeof item.text === "string" &&
          item.text.includes("<self_criticism>")
      );
    }

    if (entry.role === "user" || entry.role === "system") {
      break;
    }
  }

  return false;
}

async function loadPersistentState() {
  const defaultHistory = () => [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: "[NEW GAME STARTED. Please set the text speed as soon as you finish the intro and have access to the start menu. Keep the battle animations and battle style with default settings.]",
        },
      ],
    },
  ];
  state.history = await readJsonFileOrDefault(config.paths.historySaveFile, defaultHistory, "history");
  if (!Array.isArray(state.history) || state.history.length === 0) {
    console.warn("History state was invalid or empty. Reinitializing.");
    state.history = defaultHistory();
  }
  console.log("History loaded. Size:", state.history.length);

  state.selfCritiqueReminderPending = historyEndsWithSelfCritiqueMessage(state.history);
  if (state.selfCritiqueReminderPending) {
    console.log("Detected pending self-critique reminder from saved history.");
  }

  state.memory = await readJsonFileOrDefault(config.paths.memorySaveFile, {}, "memory");
  console.log("Memory size:", Object.keys(state.memory).length);
  console.log("Memory loaded.");

  try {
    const objectivesData = await fs.readFile(config.paths.objectivesSaveFile, "utf-8");
    state.objectives = JSON.parse(objectivesData);
    console.log("Objectives loaded.");
    if (typeof state.objectives.primary !== "object")
      state.objectives.primary = { short_description: "", description: "" };
    if (typeof state.objectives.secondary !== "object")
      state.objectives.secondary = { short_description: "", description: "" };
    if (typeof state.objectives.third !== "object")
      state.objectives.third = { short_description: "", description: "" };
    if (!Array.isArray(state.objectives.others)) state.objectives.others = [];
    state.objectives.others = state.objectives.others.filter((item) => typeof item === "object");
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("Objectives file not found, starting with empty objectives.");
    } else {
      console.error("Error loading objectives:", error);
    }
    state.objectives = {
      primary: { short_description: "", description: "" },
      secondary: { short_description: "", description: "" },
      third: { short_description: "", description: "" },
      others: [],
    };
  }

  try {
    const markersData = await fs.readFile(config.paths.markersSaveFile, "utf-8");
    state.markers = JSON.parse(markersData);
    console.log("Markers loaded.");
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("Markers file not found, starting with empty markers.");
      state.markers = {};
    } else {
      console.error("Error loading markers:", error);
      state.markers = {};
    }
  }

  try {
    const countersData = await fs.readFile(config.paths.countersSaveFile, "utf-8");
    state.counters = JSON.parse(countersData);
    console.log("Counters loaded.");
    if (typeof state.counters.currentStep !== "number") state.counters.currentStep = 0;
    if (typeof state.counters.lastCriticismStep !== "number") state.counters.lastCriticismStep = 0;
    if (typeof state.counters.lastSummaryStep !== "number") state.counters.lastSummaryStep = 0;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("Counters file not found, starting with default counters.");
    } else {
      console.error("Error loading counters:", error);
    }
    state.counters = { currentStep: 0, lastCriticismStep: 0, lastSummaryStep: 0 };
  }

  try {
    const badgesData = await fs.readFile(config.paths.badgesSaveFile, "utf-8");
    const rawBadges = JSON.parse(badgesData);
    const normalized = {};
    if (rawBadges && typeof rawBadges === "object" && !Array.isArray(rawBadges)) {
      for (const [badgeId, value] of Object.entries(rawBadges)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const obtained = typeof value.obtained === "boolean" ? value.obtained : true; // back-compat
          const step = typeof value.step === "number" ? value.step : null;
          const timestamp = typeof value.timestamp === "string" ? value.timestamp : null;
          normalized[String(badgeId)] = { obtained, step, timestamp };
        } else if (typeof value === "boolean") {
          normalized[String(badgeId)] = { obtained: value, step: null, timestamp: null };
        } else {
          normalized[String(badgeId)] = { obtained: false, step: null, timestamp: null };
        }
      }
    }
    state.badgeHistory = normalized;
    console.log("Badge history loaded.");
    state.previousBadgesState = {};
    for (const [badgeId, info] of Object.entries(state.badgeHistory)) {
      state.previousBadgesState[badgeId] = Boolean(info?.obtained);
    }
    console.log("Initialized previousBadgesState based on loaded badge history state.");
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("Badges log file not found, starting with empty history.");
    } else {
      console.error("Error loading badge history:", error);
    }
    state.badgeHistory = {};
    state.previousBadgesState = {};
  }

  try {
    const mapVisitsData = await fs.readFile(config.paths.mapVisitsSaveFile, "utf-8");
    state.mapVisitHistory = JSON.parse(mapVisitsData);
    console.log("Map visit history loaded.");
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("Map visit log file not found, starting with empty history.");
    } else {
      console.error("Error loading map visit history:", error);
    }
    state.mapVisitHistory = {};
  }

  try {
    const summariesData = await fs.readFile(config.paths.summariesSaveFile, "utf-8");
    state.summaries = JSON.parse(summariesData);
    if (!Array.isArray(state.summaries)) {
      console.warn("Summaries file contained non-array data. Resetting.");
      state.summaries = [];
    }
    console.log("Summaries loaded. Count:", state.summaries.length);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("Summaries file not found, starting with empty summaries list.");
    } else {
      console.error("Error loading summaries:", error);
    }
    state.summaries = [];
  }

  try {
    const allSummariesData = await fs.readFile(config.paths.allSummariesSaveFile, "utf-8");
    state.allSummaries = JSON.parse(allSummariesData);
    if (!Array.isArray(state.allSummaries)) {
      console.warn("All summaries file contained non-array data. Resetting.");
      state.allSummaries = [];
    }
    console.log("All summaries loaded. Count:", state.allSummaries.length);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("All summaries file not found, starting with empty all summaries list.");
    } else {
      console.error("Error loading all summaries:", error);
    }
    state.allSummaries = [];
  }

  {
    let loadedSteps = [];
    let shouldSeedFromTemplate = false;

    try {
      const progressStepsData = await fs.readFile(config.paths.progressStepsFile, "utf-8");
      const parsed = JSON.parse(progressStepsData);
      if (!Array.isArray(parsed)) {
        console.warn("Progress steps file contained non-array data. Re-initializing from template.");
        shouldSeedFromTemplate = true;
      } else if (parsed.length === 0) {
        console.warn("Progress steps file is empty. Re-initializing from template.");
        shouldSeedFromTemplate = true;
      } else {
        loadedSteps = parsed;
        console.log("Progress steps loaded. Count:", loadedSteps.length);
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        console.log("Progress steps file not found, initializing from template.");
        shouldSeedFromTemplate = true;
      } else {
        console.error("Error loading progress steps:", error);
        shouldSeedFromTemplate = true;
      }
    }

    if (shouldSeedFromTemplate) {
      try {
        const templatePath = config.paths.progressStepsTemplateFile;
        const templateData = await fs.readFile(templatePath, "utf-8");
        const templateSteps = JSON.parse(templateData);
        if (Array.isArray(templateSteps) && templateSteps.length > 0) {
          const initializedSteps = templateSteps.map((step) => ({
            ...step,
            done: false,
            done_on: null,
          }));
          await fs.mkdir(path.join(config.paths.baseDir, config.dataDir), { recursive: true });
          await fs.writeFile(config.paths.progressStepsFile, JSON.stringify(initializedSteps, null, 2));
          loadedSteps = initializedSteps;
          console.log(`Progress steps file created for this AI from template: ${config.paths.progressStepsFile}`);
        } else {
          console.warn("Progress step template contained no steps. Starting with empty progress steps list.");
          loadedSteps = [];
        }
      } catch (templateError) {
        console.error("Error reading progress step template:", templateError);
        loadedSteps = [];
      }
    }

    state.progressSteps = loadedSteps;
    console.log("Progress steps loaded. Count:", state.progressSteps.length);
  }

  try {
    const lastVisitedMapsData = await fs.readFile(config.paths.lastVisitedMapsFile, "utf-8");
    state.lastVisitedMaps = JSON.parse(lastVisitedMapsData);
    if (!Array.isArray(state.lastVisitedMaps)) {
      console.warn("Last visited maps file contained non-array data. Resetting.");
      state.lastVisitedMaps = [];
    }
    console.log("Last visited maps loaded. Count:", state.lastVisitedMaps.length);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("Last visited maps file not found, starting with empty list.");
    } else {
      console.error("Error loading last visited maps:", error);
    }
    state.lastVisitedMaps = [];
  }

  try {
    const playerReasoningData = await fs.readFile(config.paths.playerReasoningArchiveFile, "utf-8");
    state.playerReasoning = sanitizePlayerReasoningState(JSON.parse(playerReasoningData));
    console.log(
      "Player reasoning loaded. Recent:",
      state.playerReasoning.recent.length,
      "Archive:",
      state.playerReasoning.archive.length
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("Player reasoning archive file not found, starting with empty episodic reasoning.");
    } else {
      console.error("Error loading player reasoning archive:", error);
    }
    state.playerReasoning = { recent: [], archive: [] };
  }

  sanitizeModelOwnedPersistence();

  // Ensure directories exist
  try {
    const dataDirPath = path.join(config.paths.baseDir, config.dataDir);
    if (!fsSync.existsSync(dataDirPath)) {
      fsSync.mkdirSync(dataDirPath, { recursive: true });
    }

    // Ensure the all_summaries file exists so data sync doesn't spam failures on a fresh run.
    if (!fsSync.existsSync(config.paths.allSummariesSaveFile)) {
      await fs.writeFile(config.paths.allSummariesSaveFile, JSON.stringify(state.allSummaries, null, 2));
    }
  } catch (e) {
    console.warn("Failed to ensure dataDir exists:", e);
  }
}

async function savePersistentState() {
  try {
    sanitizeModelOwnedPersistence();
    await fs.writeFile(config.paths.historySaveFile, JSON.stringify(state.history, null, 2));
    await fs.writeFile(config.paths.memorySaveFile, JSON.stringify(state.memory, null, 2));
    await fs.writeFile(config.paths.objectivesSaveFile, JSON.stringify(state.objectives, null, 2));
    await fs.writeFile(config.paths.markersSaveFile, JSON.stringify(state.markers, null, 2));
    await fs.writeFile(config.paths.countersSaveFile, JSON.stringify(state.counters, null, 2));
    await fs.writeFile(config.paths.badgesSaveFile, JSON.stringify(state.badgeHistory, null, 2));
    await fs.writeFile(config.paths.mapVisitsSaveFile, JSON.stringify(state.mapVisitHistory, null, 2));
    await fs.writeFile(config.paths.summariesSaveFile, JSON.stringify(state.summaries, null, 2));
    await fs.writeFile(config.paths.allSummariesSaveFile, JSON.stringify(state.allSummaries, null, 2));
    await fs.writeFile(config.paths.progressStepsFile, JSON.stringify(state.progressSteps, null, 2));
    await fs.writeFile(config.paths.lastVisitedMapsFile, JSON.stringify(state.lastVisitedMaps, null, 2));
    await fs.writeFile(config.paths.playerReasoningArchiveFile, JSON.stringify(state.playerReasoning, null, 2));
  } catch (error) {
    console.error("Error saving persistent state:", error);
  }
}

module.exports = {
  state,
  attachBroadcast,
  setIsThinking,
  loadPersistentState,
  savePersistentState,
  recordPlayerReasoningTurn,
  recallPlayerReasoningArchive,
  PLAYER_REASONING_RECENT_LIMIT,
};
