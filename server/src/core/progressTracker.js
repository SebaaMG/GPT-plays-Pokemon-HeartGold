const { state } = require("../state/stateManager");
const { buildObservationExposure } = require("../ai/observationContract");
const { sanitizeModelText } = require("../ai/modelSurfaceSanitizer");

function exposureFor(gameDataJson) {
  return buildObservationExposure(gameDataJson || {});
}

function eventIsValidated(trigger, exposure) {
  if (!exposure?.heartgold) return true;
  const progressEvents = new Set([
    "EVENT_GOT_STARTER",
    "EVENT_GOT_POKEDEX",
    "EVENT_GOT_POKEGEAR",
    "EVENT_GOT_BAG",
  ]);
  if (progressEvents.has(trigger)) {
    return exposure?.fields?.progress?.validated === true || (
      trigger === "EVENT_GOT_STARTER" && exposure?.fields?.party?.validated === true
    );
  }
  return false;
}

function updateProgressSteps(gameDataJson) {
  if (!Array.isArray(state.progressSteps) || state.progressSteps.length === 0) {
    return false;
  }

  const currentTimestamp = new Date().toISOString();
  let hasUpdates = false;
  const exposure = exposureFor(gameDataJson);
  const navigationValidated = exposure.navigation?.validated === true;
  const badgesValidated = exposure.fields?.badges?.validated === true;
  const partyValidated = exposure.fields?.party?.validated === true;

  for (const step of state.progressSteps) {
    if (step.done) continue;

    let shouldMarkDone = false;

    if (step.type === "map_visit") {
      const currentMapName = gameDataJson?.current_trainer_data?.position?.map_name;
      if (navigationValidated && currentMapName && currentMapName === step.trigger) {
        console.log(`>>> PROGRESS: Map visit step "${step.label}" completed (${step.trigger}) <<<`);
        shouldMarkDone = true;
      }
    } else if (step.type === "map_id_visit") {
      const currentMapId = gameDataJson?.current_trainer_data?.position?.map_id;
      if (navigationValidated && currentMapId != null && String(currentMapId) === String(step.trigger)) {
        console.log(`>>> PROGRESS: Map id step "${step.label}" completed (${step.trigger}) <<<`);
        shouldMarkDone = true;
      }
    } else if (step.type === "badge") {
      const currentBadges = gameDataJson?.current_trainer_data?.badges || {};
      if (badgesValidated && currentBadges && typeof currentBadges === "object" && currentBadges[step.trigger] === true) {
        console.log(`>>> PROGRESS: Badge step "${step.label}" completed (${step.trigger}) <<<`);
        shouldMarkDone = true;
      }
    } else if (step.type === "badge_count_at_least") {
      const badgeCount = Number(gameDataJson?.current_trainer_data?.badge_count);
      const triggerCount = Number(step.trigger);
      if (badgesValidated && Number.isFinite(badgeCount) && Number.isFinite(triggerCount) && badgeCount >= triggerCount) {
        console.log(`>>> PROGRESS: Badge count step "${step.label}" completed (${badgeCount}/${triggerCount}) <<<`);
        shouldMarkDone = true;
      }
    } else if (step.type === "party_count_at_least") {
      const partyCount = Array.isArray(gameDataJson?.current_pokemon_data)
        ? gameDataJson.current_pokemon_data.length
        : 0;
      const effectivePartyCount = partyCount;
      const triggerCount = Number(step.trigger);
      const starterEventFallback =
        step.id === "starter_pokemon" &&
        gameDataJson?.important_events?.EVENT_GOT_STARTER === true &&
        eventIsValidated("EVENT_GOT_STARTER", exposure);
      if (Number.isFinite(triggerCount) && ((partyValidated && effectivePartyCount >= triggerCount) || starterEventFallback)) {
        console.log(`>>> PROGRESS: Party count step "${step.label}" completed (${effectivePartyCount}/${triggerCount}) <<<`);
        shouldMarkDone = true;
      }
    } else if (step.type === "event") {
      const importantEvents = gameDataJson?.important_events || {};
      if (
        eventIsValidated(step.trigger, exposure) &&
        importantEvents &&
        typeof importantEvents === "object" &&
        importantEvents[step.trigger] === true
      ) {
        console.log(`>>> PROGRESS: Event step "${step.label}" completed (${step.trigger}) <<<`);
        shouldMarkDone = true;
      }
    } else {
      console.warn(`Unknown progress step type: ${step.type} for step ${step.id}`);
    }

    if (shouldMarkDone) {
      step.done = true;
      step.done_on = currentTimestamp;
      hasUpdates = true;
    }
  }

  return hasUpdates;
}

function updateLastVisitedMaps(currentMapId, currentMapName, gameDataJson = null) {
  const exposure = exposureFor(gameDataJson);
  if (exposure.heartgold && exposure.navigation?.validated !== true) {
    return false;
  }
  const safeMapId = sanitizeModelText(String(currentMapId ?? "")).slice(0, 120);
  if (!safeMapId || safeMapId === "0-0") {
    return false;
  }
  const safeMapName = sanitizeModelText(String(currentMapName || `Unknown Map (${safeMapId})`)).slice(0, 200);

  if (state.lastVisitedMaps.length > 0 && state.lastVisitedMaps[0].map_id === safeMapId) {
    return false;
  }

  const mapEntry = {
    map_id: safeMapId,
    map_name: safeMapName,
    timestamp: new Date().toISOString(),
    step: state.counters.currentStep,
  };

  state.lastVisitedMaps = state.lastVisitedMaps.filter((entry) => entry.map_id !== safeMapId);
  state.lastVisitedMaps.unshift(mapEntry);
  state.lastVisitedMaps = state.lastVisitedMaps.slice(0, 7);

  console.log(`>>> LAST VISITED MAPS UPDATED: Now visiting ${safeMapName} (${safeMapId}) <<<`);
  return true;
}

module.exports = { updateProgressSteps, updateLastVisitedMaps };
