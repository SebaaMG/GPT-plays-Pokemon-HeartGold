const fs = require('fs').promises;
const path = require('path');
const { z } = require('zod');
const { zodToJsonSchema } = require('zod-to-json-schema');
const { config } = require('../config');
const { state, recallPlayerReasoningArchive } = require('../state/stateManager');
const { broadcast } = require('../core/socketHub');
const { sendCommandsToPythonServer, requestConsoleRestart, fetchGameData } = require('../services/pythonService');
const { minimapToMarkdown } = require('../formatters/markdownFormatter');
const { recordReasoning: recordReasoningTime, recordToolBatch } = require('../utils/timeTracker');
const { findHeartGoldPath } = require('./heartgoldPathfinder');
const { recordActionBatch, recordHarnessFailure } = require('../benchmark/metrics');
const { fieldIsValidated, navigationValidation, validatedRuntimeObjectEntries } = require('./observationContract');
const { sanitizeModelText, sanitizeModelValue } = require('./modelSurfaceSanitizer');

function trunc(text, maxLen = 120) {
    if (text == null) return "";
    const s = String(text);
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 1) + "…";
}

function formatTraceTranscriptEntry(entry) {
    if (entry == null) return "";
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
        return sanitizeModelText(String(entry));
    }
    if (typeof entry !== "object") return sanitizeModelText(String(entry));
    const parts = [];
    if (entry.phase != null) parts.push(`phase=${entry.phase}`);
    if (entry.frame != null) parts.push(`frame=${entry.frame}`);
    if (entry.frames != null) parts.push(`frames=${entry.frames}`);
    if (entry.changed != null) parts.push(`changed=${entry.changed === true ? "true" : "false"}`);
    if (entry.dialogVisible != null) parts.push(`dialogVisible=${entry.dialogVisible === true ? "true" : "false"}`);
    if (entry.currentVisibleText && typeof entry.currentVisibleText === "object") {
        const text = trunc(entry.currentVisibleText.text, 220);
        const surface = entry.currentVisibleText.surface ? ` surface=${entry.currentVisibleText.surface}` : "";
        if (text) parts.push(`visibleRamText${surface}: "${text}"`);
    }
    if (typeof entry.screenshotHash === "string" && entry.screenshotHash) {
        parts.push(`screenshotHash=${entry.screenshotHash.slice(0, 12)}`);
    }
    if (parts.length) return sanitizeModelText(parts.join(", "));
    try {
        return sanitizeModelText(JSON.stringify(entry));
    } catch {
        return sanitizeModelText(String(entry));
    }
}

function heartGoldExposeAllDecodedRam() {
    return Boolean(config.isHeartGold && config.observation?.exposeAllDecodedRam === true && config.observation?.mode === "ram_assisted");
}

function heartGoldHasDecodedNavigation(gameDataJson) {
    if (!config.isHeartGold) return true;
    const pos = gameDataJson?.current_trainer_data?.position || {};
    return (
        pos.map_id != null &&
        Number.isFinite(Number(pos.x)) &&
        Number.isFinite(Number(pos.y))
    );
}

function heartGoldDecodedNavigationAllowed(gameDataJson) {
    const validation = navigationValidation(gameDataJson);
    if (validation.validated) return { allowed: true, validated: true, validation };
    if (heartGoldExposeAllDecodedRam() && heartGoldHasDecodedNavigation(gameDataJson)) {
        return { allowed: true, validated: false, validation };
    }
    return { allowed: false, validated: false, validation };
}

function heartGoldDecodedCollisionAllowed(gameDataJson) {
    if (fieldIsValidated(gameDataJson, "romCollision")) return true;
    return Boolean(heartGoldExposeAllDecodedRam() && gameDataJson?.ram_assisted?.pathfinding?.available === true);
}

function xmlEscape(text) {
    return String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&apos;");
}

function xmlAttr(value) {
    return xmlEscape(value).replaceAll("\n", " ").trim();
}

function firstActionTraceResult(response) {
    if (!response || typeof response !== "object") return null;
    if (Array.isArray(response.results) && response.results.length > 0) {
        return response.results.find((item) => item && typeof item === "object") || null;
    }
    return response;
}

function booleanAttr(value) {
    if (value === true) return "true";
    if (value === false) return "false";
    return "unknown";
}

function actionResultSemanticAttributes(res) {
    const trace = firstActionTraceResult(res?.response || res?.pythonResponse || null);
    const lowStallTrace = trace?.low_stall_trace === true || trace?.screenChangedUnknown === true;
    const traceInputDelivered =
        typeof trace?.inputDelivered === "boolean" ? trace.inputDelivered :
        typeof res?.response?.inputDelivered === "boolean" ? res.response.inputDelivered :
        null;
    const inputDelivered = res?.skipped === true || res?.action_type === "setup_error"
        ? false
        : traceInputDelivered != null
          ? traceInputDelivered
          : (res?.response && typeof res.response === "object") || (res?.pythonResponse && typeof res.pythonResponse === "object")
            ? ((res.response || res.pythonResponse).status !== false && (res.response || res.pythonResponse).ok !== false)
            : null;
    const visibleEffect = lowStallTrace ? null :
        typeof res?.visible_effect === "boolean" ? res.visible_effect :
        typeof res?.visibleEffect === "boolean" ? res.visibleEffect :
        typeof trace?.visibleEffectObserved === "boolean" ? trace.visibleEffectObserved :
        typeof trace?.screenChanged === "boolean" ? trace.screenChanged :
        typeof res?.response?.screenChanged === "boolean" ? res.response.screenChanged :
        null;
    const semanticOutcomeRaw =
        res?.semantic_outcome ||
        res?.semanticOutcome ||
        trace?.semantic_outcome ||
        trace?.semanticOutcome ||
        trace?.actionOutcome ||
        null;
    const axisOrTargetUnverified =
        trace?.axisEchoReliable === false ||
        trace?.axisEchoMatched === false ||
        trace?.touchAxisEchoWarning === true ||
        semanticOutcomeRaw === "verified_visible_effect_with_unreliable_axis_echo" ||
        semanticOutcomeRaw === "input_delivered_visible_effect_semantic_unverified";
    let semanticTargetVerified =
        typeof res?.semantic_target_verified === "boolean" ? res.semantic_target_verified :
        typeof res?.semanticTargetVerified === "boolean" ? res.semanticTargetVerified :
        typeof trace?.semanticTargetVerified === "boolean" ? trace.semanticTargetVerified :
        axisOrTargetUnverified ? false :
        null;
    let semanticOutcome = semanticOutcomeRaw;
    if (inputDelivered === false) {
        semanticTargetVerified = false;
        semanticOutcome = "input_not_delivered";
    }
    if (axisOrTargetUnverified && inputDelivered !== false) {
        semanticOutcome = "unverified";
    }
    if (!semanticOutcome && res?.action_type === "wait" && res?.success === true && inputDelivered === true) {
        semanticOutcome = "wait_completed";
    }
    if (!semanticOutcome && lowStallTrace && inputDelivered === true) {
        semanticOutcome = "low_stall_input_delivered";
    }
    if (!semanticOutcome) {
        if (res?.success === false) semanticOutcome = "failed";
        else if (semanticTargetVerified === true) semanticOutcome = "completed";
        else if (visibleEffect === true) semanticOutcome = "visible_effect";
        else if (visibleEffect === false) semanticOutcome = "no_visible_effect";
        else semanticOutcome = "unknown";
    }
    return {
        inputDelivered,
        visibleEffect,
        semanticTargetVerified,
        semanticOutcome: String(semanticOutcome),
    };
}

const SEMANTIC_SUCCESS_OUTCOME_RE =
    /^(completed|verified|semantic_completed|semantic_target_verified|target_verified|wait_completed|low_stall_input_delivered)$/;
const GENERIC_VISIBLE_EFFECT_ACTION_TYPES = new Set([
    "key_press",
    "button_sequence",
    "a_until_end_of_dialog",
    "touch",
]);

function heartGoldActionSemanticSuccess(actionResult, semantic = null) {
    const attrs = semantic || actionResultSemanticAttributes(actionResult);
    if (actionResult?.success !== true) return false;
    if (attrs?.inputDelivered !== true) return false;
    if (attrs?.semanticTargetVerified === true) return true;
    const outcome = String(attrs?.semanticOutcome || "").toLowerCase();
    if (SEMANTIC_SUCCESS_OUTCOME_RE.test(outcome)) return true;
    const actionType = String(actionResult?.action_type || actionResult?.type || "").toLowerCase();
    const visibleProgress = attrs?.visibleEffect === true || outcome === "visible_effect";
    if (!visibleProgress || !GENERIC_VISIBLE_EFFECT_ACTION_TYPES.has(actionType)) return false;
    if (attrs?.semanticTargetVerified === false && actionType !== "touch") return false;
    return true;
}

function sanitizeHeartGoldKeyboardText(value) {
    return String(value ?? "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 7);
}

function heartGoldActionReliability(response) {
    const results = Array.isArray(response?.results) ? response.results : [];
    const scan = results.length ? results : [response].filter(Boolean);
    const staleTrace = scan
        .map((item) => {
            const afterScreenshot = item?.after?.screenshot;
            if (!afterScreenshot || typeof afterScreenshot !== "object") return null;
            if (afterScreenshot.fresh === false) return "after_screenshot_stale";
            if (!afterScreenshot.sha256) return "after_screenshot_hash_missing";
            return null;
        })
        .find(Boolean);
    if (staleTrace) {
        return {
            verified: false,
            unreliable: true,
            reason: staleTrace,
        };
    }
    const inputDeliveryFailure = scan.find((item) => {
        const trace = firstActionTraceResult(item);
        return item?.inputDelivered === false || item?.response?.inputDelivered === false || trace?.inputDelivered === false;
    });
    if (inputDeliveryFailure) {
        return {
            verified: false,
            unreliable: true,
            reason: "input_not_delivered",
        };
    }
    const afterScreenshotProblem = scan.find((item) => {
        const claimsProgress =
            item?.screenChanged === true ||
            item?.effectVerified === true ||
            item?.visibleEffectObserved === true ||
            item?.observedPositionUpdated === true ||
            item?.mapChanged === true;
        if (!claimsProgress) return false;
        const screenshot = item?.after?.screenshot;
        if (!screenshot || typeof screenshot !== "object") return "missing";
        if (screenshot.fresh === false) return "stale";
        if (!screenshot.sha256 && !screenshot.hash && !screenshot.screenshotHash) return "hash_missing";
        return false;
    });
    if (afterScreenshotProblem) {
        const screenshot = afterScreenshotProblem?.after?.screenshot;
        return {
            verified: false,
            unreliable: true,
            reason: !screenshot || typeof screenshot !== "object"
                ? "after_screenshot_missing"
                : screenshot.fresh === false
                    ? "after_screenshot_stale"
                    : "after_screenshot_hash_missing",
        };
    }
    const remaining = remainingCommandsFromPayload(response);
    const interruptedAtIndex = typeof response?.interruptedAtIndex === "number" ? response.interruptedAtIndex : null;
    const hadEarlierStepsBeforeStop = interruptedAtIndex == null || interruptedAtIndex > 0;
    const mapTransitionObserved =
        response?.interruptedByMapTransition === true ||
        response?.mapChanged === true ||
        scan.some((item) => item?.mapChanged === true);
    const progressedInterruption =
        remaining.length > 0 &&
        (
            response?.interruptedByDialog === true ||
            response?.interruptedByBattle === true ||
            response?.interruptedByMenu === true ||
            response?.interruptedByLoading === true ||
            mapTransitionObserved ||
            scan.some((item) => item?.interruptedByDialog === true || item?.interruptedByBattle === true || item?.interruptedByMenu === true || item?.interruptedByLoading === true)
        ) &&
        scan.some((item) => item?.screenChanged === true || item?.effectVerified === true);
    if (progressedInterruption) {
        const reason =
            response?.interruptedByDialog === true || scan.some((item) => item?.interruptedByDialog === true)
                ? "sequence_interrupted_by_dialogue_after_progress"
                : response?.interruptedByBattle === true || scan.some((item) => item?.interruptedByBattle === true)
                  ? "sequence_interrupted_by_battle_after_progress"
                  : mapTransitionObserved
                    ? "sequence_interrupted_by_map_transition_after_progress"
                    : "sequence_interrupted_after_progress";
        return { verified: true, unreliable: false, reason };
    }
    const progressedCollision =
        remaining.length > 0 &&
        (
            response?.interruptedByCollision === true ||
            scan.some((item) => item?.interruptedByCollision === true)
        ) &&
        hadEarlierStepsBeforeStop &&
        scan.some((item) => item?.screenChanged === true || item?.effectVerified === true || item?.observedPositionUpdated === true);
    if (progressedCollision) {
        return {
            verified: true,
            unreliable: false,
            reason: "partial_sequence_stopped_by_collision_after_progress",
        };
    }
    if (remaining.length > 0) {
        return {
            verified: false,
            unreliable: true,
            reason: "command_sequence_interrupted_with_remaining_commands",
        };
    }
    const interrupted = scan.find(
        (item) =>
            item?.interruptedByDialog === true ||
            item?.interruptedByCollision === true ||
            item?.interruptedByBattle === true ||
            item?.interruptedByMenu === true ||
            item?.interruptedByLoading === true ||
            item?.mapChanged === true
    );
    if (interrupted) {
        const madeVisibleProgress = scan.some((item) => item?.screenChanged === true || item?.effectVerified === true || item?.observedPositionUpdated === true);
        const stoppedAfterEarlierSteps = interruptedAtIndex != null && interruptedAtIndex > 0;
        if (madeVisibleProgress && interrupted.interruptedByDialog === true) {
            return {
                verified: true,
                unreliable: false,
                reason: "interaction_opened_dialogue",
            };
        }
        if (madeVisibleProgress && interrupted.interruptedByBattle === true) {
            return {
                verified: true,
                unreliable: false,
                reason: "interaction_opened_battle",
            };
        }
        if (madeVisibleProgress && interrupted.mapChanged === true) {
            return {
                verified: true,
                unreliable: false,
                reason: "interaction_changed_map",
            };
        }
        if (madeVisibleProgress && interrupted.interruptedByCollision === true && stoppedAfterEarlierSteps) {
            return {
                verified: true,
                unreliable: false,
                reason: "sequence_ended_by_collision_after_progress",
            };
        }
        return {
            verified: false,
            unreliable: true,
            reason:
                interrupted.interruptedByCollision === true
                    ? "movement_interrupted_by_collision"
                    : interrupted.interruptedByDialog === true
                      ? "sequence_interrupted_by_dialogue"
                      : interrupted.interruptedByBattle === true
                        ? "sequence_interrupted_by_battle"
                        : interrupted.mapChanged === true
                          ? "sequence_interrupted_by_map_transition"
                          : "sequence_interrupted",
        };
    }
    const unreliable = scan.find((item) => item?.unreliable === true);
    if (unreliable) {
        return {
            verified: false,
            unreliable: true,
            reason: unreliable.harnessFailureReason || unreliable.actionOutcome || "action_unverified_by_harness",
        };
    }
    const allWaits = scan.length > 0 && scan.every((item) => item?.type === "wait");
    if (allWaits && response?.status === true && scan.every((item) => item?.ok === true)) {
        const missingFreshAfter = scan.find((item) => {
            const screenshot = item?.after?.screenshot;
            return !screenshot || screenshot.fresh === false || !(screenshot.sha256 || screenshot.hash || screenshot.screenshotHash);
        });
        if (!missingFreshAfter) {
            return { verified: true, unreliable: false, reason: "wait_completed" };
        }
    }
    const observedEffect = scan.some(
        (item) => item?.screenChanged === true || item?.effectVerified === true || item?.observedPositionUpdated === true
    );
    const allLowStallDelivered =
        scan.length > 0 &&
        scan.every((item) => item?.low_stall_trace === true && item?.inputDelivered === true && item?.ok !== false && item?.status !== false);
    if (allLowStallDelivered) {
        return { verified: true, unreliable: false, reason: "low_stall_input_delivered" };
    }
    const explicitNoEffect = scan.some(
        (item) =>
            item?.screenChangedUnknown !== true &&
            (item?.screenChanged === false || item?.effectVerified === false || item?.observedPositionUpdated === false)
    );
    if (!observedEffect && explicitNoEffect) {
        return {
            verified: false,
            unreliable: true,
            reason: "no_visible_effect",
        };
    }
    const failed = scan.find((item) => item?.ok === false || item?.status === false);
    if (failed) {
        return {
            verified: false,
            unreliable: false,
            reason: failed.error || failed.harnessFailureReason || "bridge_action_failed",
        };
    }
    return { verified: true, unreliable: false, reason: null };
}

function heartGoldRawActionSuccess(response) {
    if (!response || typeof response !== "object") return false;
    if (response.status === false || response.ok === false) return false;
    const results = Array.isArray(response.results) ? response.results : [];
    return !results.some((item) => item?.ok === false || item?.status === false);
}

function heartGoldPrimitiveMessage(rawSuccess, verified, successText, unverifiedText, failureText) {
    if (!rawSuccess) return failureText;
    if (verified) return successText;
    return `${successText} ${unverifiedText}`;
}

const ALLOWED_KEYPRESS_KEYS = [
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
];

const AVATAR_EMOTIONS = [
    "default",
    "sad",
    "angry",
    "surprised",
    "confused",
    "excited",
    "bored",
    "fierce",
    "cry",
    "happy",
    "scared",
    "disappointed",
    "embarrassed",
    "hurt",
    "thinking",
    "wink",
    "kawai",
    "disgusted",
    "annoyed",
    "confident",
    "nervous",
    "shocked",
    "curious",
    "sleepy",
    "loving",
    "sick",
    "playful",
    "guilty",
    "proud",
    "suspicious",
    "overwhelmed",
    "frustrated",
    "relieved",
    "super_saiyen",
    "nostalgic",
    "smug",
    "tired",
    "mischievous",
    "reading",
    "throwing_pokeball",
    "reading_minimap",
    "cosplay_prof_oak",
    "cosplay_mewtwo",
    "cosplay_pikachu",
    "cosplay_gyarados",
    "cosplay_magikarp",
    "cosplay_missingno",
    "cosplay_zubat",
    "cosplay_blastoise",
    "cosplay_geodude",
    "cosplay_abra",
    "cosplay_pidgeotto",
    "cosplay_pidgeot",
    "cosplay_pidgey",
    "cosplay_team_rocket_member",
    "cosplay_nurse_joy",
    "cosplay_bulbasaur",
    "cosplay_ivysaur",
    "cosplay_venusaur",
    "cosplay_charizard",
    "cosplay_charmeleon",
    "cosplay_charmander",
    "cosplay_snorlax",
    "cosplay_lapras",
];

const DIRECTION_KEYS = new Set(["up", "down", "left", "right", "face_up", "face_down", "face_left", "face_right"]);
const FACE_KEY_TO_DIRECTION = new Map([
    ["face_up", "up"],
    ["face_down", "down"],
    ["face_left", "left"],
    ["face_right", "right"],
]);

function normalizeKeyName(key) {
    return String(key ?? "").trim().toLowerCase();
}

function keyListProblem(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return "'keys' are missing, empty, or not an array.";
    const normalized = keys.map(normalizeKeyName).filter(Boolean);
    const unique = new Set(normalized);
    if (unique.size !== normalized.length) {
        return "key_press keys are simultaneous, not a sequence; duplicate keys are invalid. Use button_sequence for repeated movement.";
    }
    const directionCount = normalized.filter((key) => DIRECTION_KEYS.has(key)).length;
    if (directionCount > 1) {
        return "key_press keys are simultaneous, not a sequence; multiple directional keys are invalid. Use button_sequence for movement sequences.";
    }
    if (normalized.includes("a_until_end_of_dialog") && normalized.length > 1) {
        return "a_until_end_of_dialog must be used alone as its own action or as the sole pseudo-key.";
    }
    return null;
}

function normalizedButtonSequenceSteps(action) {
    if (Array.isArray(action?.sequence)) {
        return { sequence: action.sequence, normalized: false, reason: null };
    }
    const alias = Array.isArray(action?.buttons)
        ? action.buttons
        : Array.isArray(action?.keys)
          ? action.keys
          : null;
    if (!alias) return { sequence: [], normalized: false, reason: null };
    if (alias.every((item) => Array.isArray(item))) {
        return {
            sequence: alias.map((keys) => ({ keys, frames: action.frames })),
            normalized: true,
            reason: "button_sequence_nested_buttons_alias",
        };
    }
    return {
        sequence: alias.map((key) => ({ keys: [key], frames: action.frames })),
        normalized: true,
        reason: "button_sequence_buttons_alias",
    };
}

function heartGoldCommandFromSequenceStep(step) {
    const frames = Math.min(120, Math.max(1, Math.trunc(Number(step?.frames) || 8)));
    if (step?.type === "wait") {
        return { command: { type: "wait", frames }, problem: null };
    }
    const rawKeys = step?.keys;
    const normalizedKeys = Array.isArray(rawKeys)
        ? rawKeys.map(normalizeKeyName).filter(Boolean)
        : [normalizeKeyName(rawKeys)].filter(Boolean);
    if (normalizedKeys.length === 0 || (normalizedKeys.length === 1 && normalizedKeys[0] === "wait")) {
        return { command: { type: "wait", frames }, problem: null };
    }
    const problem = keyListProblem(normalizedKeys);
    if (problem) return { command: null, problem };
    return { command: heartGoldPressCommandFromKeys(normalizedKeys, frames), problem: null };
}

function heartGoldPressCommandFromKeys(keys, frames) {
    const normalizedKeys = Array.isArray(keys) ? keys.map(normalizeKeyName) : [];
    const faceKey = normalizedKeys.length === 1 ? FACE_KEY_TO_DIRECTION.get(normalizedKeys[0]) : null;
    const commandFrames = faceKey ? Math.min(2, Math.max(1, Math.trunc(Number(frames) || 2))) : frames;
    return {
        type: normalizedKeys.includes("a_until_end_of_dialog") ? "a_until_end_of_dialog" : "press",
        buttons: faceKey ? [faceKey] : normalizedKeys,
        frames: commandFrames,
        ...(faceKey ? { allow_collision: true, intent: "face", no_step_intent: true } : {}),
    };
}

function touchResultMessage(action, response) {
    const first = Array.isArray(response?.results) ? response.results[0] : null;
    const command = first?.command || {};
    const normalizedX = command.normalized_x ?? first?.normalized_x;
    const normalizedY = command.normalized_y ?? first?.normalized_y;
    const normalized =
        Number.isFinite(Number(normalizedX)) && Number.isFinite(Number(normalizedY))
            ? ` normalized to DS bottom/full raw (${Number(normalizedX)}, ${Number(normalizedY)})`
            : "";
    const coordinateSpace = action.coordinate_space || "bottom";
    const warnings = [];
    if (first?.axisEchoReliable === false || first?.axisEchoMatched === false || first?.touchAxisEchoWarning) {
        warnings.push("BizHawk touch-axis echo is unreliable for this core");
    }
    if (first?.actionOutcome === "verified_visible_effect_with_unreliable_axis_echo") {
        warnings.push("visible effect was observed, but the harness did not verify the intended UI target semantically");
    }
    if (first?.semanticTargetVerified === false) {
        warnings.push("the intended semantic touch target was not independently verified");
    }
    if (first?.before?.dialog?.inDialog || first?.after?.dialog?.inDialog) {
        warnings.push("dialog/menu touch should be verified on the next screenshot before confirming irreversible choices");
    }
    const suffix = warnings.length ? ` Warning: ${Array.from(new Set(warnings)).join("; ")}.` : "";
    const inputDelivered = first?.inputDelivered === true ? "input delivered" : "input delivery not independently confirmed";
    const visibleEffect = first?.visibleEffectObserved === true ? "visible effect observed" : "no visible effect observed";
    const semantic =
        first?.semanticTargetVerified === true
            ? "semantic target verified"
            : first?.semanticTargetVerified === false
              ? "semantic target unverified"
              : "semantic target not claimed";
    return `Touched requested ${coordinateSpace} coordinate (${action.x}, ${action.y})${normalized} for ${action.frames || 8} frames: ${inputDelivered}, ${visibleEffect}, ${semantic}.${suffix}`;
}

function heartGoldPathExecutionOutcome({ response, reliability, finalKeysList, path }) {
    const safeFinalKeys = Array.isArray(finalKeysList) ? finalKeysList : [];
    const safePathKeys = Array.isArray(path?.keys) ? path.keys : [];
    const remaining = remainingCommandsFromPayload(response);
    const executedCount = Math.max(0, safeFinalKeys.length - remaining.length);
    const generatedKeyCount = safePathKeys.length;
    const responseOk = Boolean(response?.status);
    const verified = Boolean(reliability?.verified) && !reliability?.unreliable;
    const finalCollisionAfterProgress = reliability?.reason === "sequence_ended_by_collision_after_progress";
    const mapTransitionAfterProgress = reliability?.reason === "sequence_interrupted_by_map_transition_after_progress";
    if (!responseOk || !verified) {
        return {
            success: false,
            remaining,
            message: `Path execution was not verified by the bridge: ${response?.semanticTargetReason || reliability?.reason || "Failed to send keys."}`,
        };
    }
    if (mapTransitionAfterProgress) {
        return {
            success: false,
            remaining,
            partialProgress: true,
            transitionObserved: true,
            message: `Partial path progress: input triggered a map transition after ${executedCount}/${safeFinalKeys.length} generated key(s); ${remaining.length} queued key(s) were skipped. This is not target completion until the next fresh observation verifies the new map/position. Explanation: ${path?.explanation || ""} generated_key_count=${generatedKeyCount}`,
        };
    }
    if (remaining.length) {
        return {
            success: false,
            remaining,
            message: `Partial path progress: executed ${executedCount}/${safeFinalKeys.length} generated key(s), then stopped with ${remaining.length} queued key(s) remaining. Explanation: ${path?.explanation || ""} generated_key_count=${generatedKeyCount}`,
        };
    }
    if (finalCollisionAfterProgress) {
        return {
            success: false,
            remaining,
            message: `Partial path progress: executed ${safeFinalKeys.length}/${safeFinalKeys.length} generated key(s), but the final generated key collided, so target completion is not verified. Explanation: ${path?.explanation || ""} generated_key_count=${generatedKeyCount}`,
        };
    }
    if (response?.semanticTargetVerified === false) {
        return {
            success: false,
            remaining,
            message: `Partial path progress: executed ${safeFinalKeys.length}/${safeFinalKeys.length} generated key(s), but the requested target was not reached (${response.semanticTargetReason || "target mismatch"}). Explanation: ${path?.explanation || ""} generated_key_count=${generatedKeyCount}`,
        };
    }
    return {
        success: true,
        remaining,
        message: `Path completed: executed ${safeFinalKeys.length}/${safeFinalKeys.length} generated key(s). Explanation: ${path?.explanation || ""} generated_key_count=${generatedKeyCount}`,
    };
}

function sameHeartGoldMapId(left, right) {
    const a = String(left ?? "").trim();
    const b = String(right ?? "").trim();
    if (!a || !b) return false;
    return a === b || `0-${a}` === b || a === `0-${b}`;
}

function heartGoldStaticGridSignature(gameDataJson) {
    const minimap = gameDataJson?.minimap_data || {};
    const grid = Array.isArray(minimap.static_grid) ? minimap.static_grid : null;
    if (!grid || grid.length === 0) return null;
    const width = Array.isArray(grid[0]) ? grid[0].length : 0;
    const height = grid.length;
    return {
        originX: Number(minimap.static_origin_x) || 0,
        originY: Number(minimap.static_origin_y) || 0,
        width,
        height,
    };
}

function sameHeartGoldGridSignature(left, right) {
    if (!left || !right) return false;
    return (
        Number(left.originX) === Number(right.originX) &&
        Number(left.originY) === Number(right.originY) &&
        Number(left.width) === Number(right.width) &&
        Number(left.height) === Number(right.height)
    );
}

function heartGoldFreshDynamicBlockerTiles(gameDataJson) {
    const blockers = new Set();
    const validated = fieldIsValidated(gameDataJson, "npcs");
    if (!validated) {
        return { validated: false, blockers };
    }
    for (const npc of validatedRuntimeObjectEntries(gameDataJson, { requireBlocking: true })) {
        const x = Number(npc.x);
        const y = Number(npc.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        blockers.add(`${Math.trunc(x)},${Math.trunc(y)}`);
    }
    return { validated: true, blockers };
}

function heartGoldPathPreflight(gameDataJson, plannedPath = null) {
    if (!config.isHeartGold) {
        return { ok: true };
    }
    if (gameDataJson?.is_talking_to_npc === true) {
        return {
            ok: false,
            message:
                "Pathfinding is blocked because dialogue/text is active. Read the current screenshot/RAM text and explicitly advance it with A or a_until_end_of_dialog before path_to_location.",
        };
    }
    const navigation = heartGoldDecodedNavigationAllowed(gameDataJson);
    if (!navigation.allowed) {
        return {
            ok: false,
            message: "Pathfinding is blocked because the fresh pre-execution navigation snapshot is unavailable.",
        };
    }
    if (!heartGoldDecodedCollisionAllowed(gameDataJson)) {
        return {
            ok: false,
            message: "Pathfinding is blocked because the fresh pre-execution ROM collision grid is unavailable.",
        };
    }
    const pathfindingContract = gameDataJson?.ram_assisted?.pathfinding;
    if (pathfindingContract?.available !== true) {
        return {
            ok: false,
            message: `Pathfinding is blocked by the fresh pre-execution pathfinding contract: ${pathfindingContract?.disabledReason || "not available"}.`,
        };
    }
    if (plannedPath?.start && plannedPath?.mapId != null) {
        const current = gameDataJson?.current_trainer_data?.position || {};
        const currentX = Number(current.x);
        const currentY = Number(current.y);
        if (
            !sameHeartGoldMapId(current.map_id, plannedPath.mapId) ||
            !Number.isFinite(currentX) ||
            !Number.isFinite(currentY) ||
            Math.trunc(currentX) !== Number(plannedPath.start.x) ||
            Math.trunc(currentY) !== Number(plannedPath.start.y)
        ) {
            return {
                ok: false,
                message:
                    `Pathfinding is blocked because the fresh pre-execution RAM position changed from the planned start ` +
                    `(${plannedPath.start.x}, ${plannedPath.start.y}) on map ${plannedPath.mapId} to ` +
                    `(${current.x ?? "unknown"}, ${current.y ?? "unknown"}) on map ${current.map_id ?? "unknown"}. Re-observe and replan.`,
            };
        }
    }
    if (plannedPath?.staticGridSignature) {
        const freshGridSignature = heartGoldStaticGridSignature(gameDataJson);
        if (!sameHeartGoldGridSignature(freshGridSignature, plannedPath.staticGridSignature)) {
            return {
                ok: false,
                message:
                    "Pathfinding is blocked because the fresh pre-execution ROM collision grid changed since planning. Re-observe and replan.",
            };
        }
    }
    if (Array.isArray(plannedPath?.routeCells) && plannedPath.routeCells.length > 0) {
        const dynamicBlockers = heartGoldFreshDynamicBlockerTiles(gameDataJson);
        if (dynamicBlockers.validated) {
            for (const cell of plannedPath.routeCells) {
                const key = `${Number(cell.x)},${Number(cell.y)}`;
                if (dynamicBlockers.blockers.has(key)) {
                    return {
                        ok: false,
                        message:
                            `Pathfinding is blocked because a fresh RAM runtime object now blocks planned route tile (${cell.x}, ${cell.y}). Re-observe and replan.`,
                    };
                }
            }
        }
    }
    return { ok: true };
}

function heartGoldButtonSequenceOutcome({ response, reliability, commandCount }) {
    const count = Math.max(0, Number(commandCount) || 0);
    const remaining = remainingCommandsFromPayload(response);
    const executedCount = Math.max(0, count - remaining.length);
    const responseOk = Boolean(response?.status);
    const verified = Boolean(reliability?.verified) && !reliability?.unreliable;
    const finalCollisionAfterProgress = reliability?.reason === "sequence_ended_by_collision_after_progress";
    const mapTransitionAfterProgress = reliability?.reason === "sequence_interrupted_by_map_transition_after_progress";
    if (!responseOk || !verified) {
        return {
            success: false,
            remaining,
            message: `Button sequence was not verified by the bridge: ${reliability?.reason || "bridge did not confirm the sequence"}.`,
        };
    }
    if (mapTransitionAfterProgress) {
        return {
            success: false,
            remaining,
            partialProgress: true,
            transitionObserved: true,
            message: `Partial button sequence: triggered a map transition after ${executedCount}/${count} step${executedCount === 1 ? "" : "s"}; ${remaining.length} queued step${remaining.length === 1 ? "" : "s"} were skipped. This is not target completion until the next fresh observation verifies the new map/position.`,
        };
    }
    if (remaining.length) {
        return {
            success: false,
            remaining,
            message: `Partial button sequence: executed ${executedCount}/${count} sequential button steps; ${remaining.length} queued step${remaining.length === 1 ? "" : "s"} remained after interruption.`,
        };
    }
    if (finalCollisionAfterProgress) {
        return {
            success: false,
            remaining,
            message: `Partial button sequence: executed ${count}/${count} sequential button step${count === 1 ? "" : "s"}, but the final command collided and did not move as intended.`,
        };
    }
    return {
        success: true,
        remaining,
        message: `Executed ${count}/${count} sequential button step${count === 1 ? "" : "s"}.`,
    };
}

function heartGoldDialogAdvanceOutcome({ response, reliability, frames }) {
    const responseOk = Boolean(response?.status);
    const verified = Boolean(reliability?.verified) && !reliability?.unreliable;
    if (!responseOk || !verified) {
        return {
            success: false,
            message: `Dialogue advance was not verified by the bridge: ${reliability?.reason || "bridge did not confirm dialogue advancement"}.`,
        };
    }
    const results = Array.isArray(response?.results) ? response.results : [];
    const lastResult = results.length ? results[results.length - 1] : null;
    const dialogStillVisible =
        response?.after?.dialog?.inDialog === true ||
        lastResult?.after?.dialog?.inDialog === true ||
        response?.dialog?.inDialog === true;
    const stopReason = response?.trace?.stopReason || lastResult?.trace?.stopReason || null;
    if (dialogStillVisible && stopReason !== "dialog_cleared") {
        return {
            success: false,
            message: `Partial dialogue advance: A advanced text within ${frames} frames, but dialogue/menu text is still visible. Fetch a fresh observation before deciding the next input.`,
        };
    }
    return {
        success: true,
        message: `Pressed A until dialogue advanced or ended within ${frames} frames.`,
    };
}

async function resolveMapBounds(gameDataJson, mapId) {
    if (typeof mapId !== "string" || !mapId.trim()) return null;

    const minimapData = gameDataJson?.minimap_data;
    if (minimapData && minimapData.map_id === mapId) {
        const width = Number(minimapData.width);
        const height = Number(minimapData.height);
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
            return { width, height, source: "minimap_data" };
        }
    }

    // Fallback: fog-of-war minimap cache files live at repo root `minimaps/<map_id>.json`
    const minimapsPath = path.join(config.paths.baseDir, "..", "minimaps", `${mapId}.json`);
    try {
        const raw = await fs.readFile(minimapsPath, "utf8");
        const grid = JSON.parse(raw);
        if (Array.isArray(grid) && grid.length > 0 && Array.isArray(grid[0])) {
            const height = grid.length;
            const width = grid[0].length;
            if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
                return { width, height, source: "minimaps_file" };
            }
        }
    } catch (error) {
        // ignore (missing file or invalid JSON)
    }

    return null;
}

function mapIdFromTraceState(st) {
    const g = st?.map?.group;
    const n = st?.map?.number;
    if (typeof g !== "number" || typeof n !== "number") return null;
    return `${g}-${n}`;
}

function mapKeyFromTraceState(st) {
    const mapId = mapIdFromTraceState(st);
    const mapName = st?.map?.name;
    if (!mapId && !mapName) return null;
    return `${mapId || ""}|${mapName || ""}`;
}

function formatMapLabel(mapId, mapName) {
    const id = typeof mapId === "string" ? mapId.trim() : "";
    const name = typeof mapName === "string" ? mapName.trim() : "";
    if (id && name) return `${id} — ${name}`;
    return id || name || "unknown";
}

function traceStateMarkdownLines(st, { includeMap = true } = {}) {
    const lines = [];

    const mapId = mapIdFromTraceState(st);
    const mapName = st?.map?.name;
    if (includeMap && (mapId || mapName)) {
        if (mapId && mapName) lines.push(`- Map: ${mapId} — ${mapName}`);
        else if (mapId) lines.push(`- Map: ${mapId}`);
        else lines.push(`- Map: ${mapName}`);
    }

    if (typeof st?.phase === "string" && st.phase) {
        lines.push(`- Phase: ${st.phase}`);
    }

    const pos = st?.player?.position;
    const x = Array.isArray(pos) && pos.length > 0 ? pos[0] : null;
    const y = Array.isArray(pos) && pos.length > 1 ? pos[1] : null;
    const facing = st?.player?.facing;
    const elevation = st?.player?.elevation;
    if (x != null && y != null) {
        const extras = [];
        if (facing) extras.push(`facing ${facing}`);
        if (typeof elevation === "number" && Number.isFinite(elevation)) extras.push(`elevation ${elevation}`);
        const extraText = extras.length ? `, ${extras.join(", ")}` : "";
        lines.push(`- Position: (${x},${y})${extraText}`);
    }

    const inDialog = !!st?.dialog?.inDialog;
    if (inDialog) {
        const menuType = st?.dialog?.menuType || "dialog";
        const text = st?.dialog?.visibleText;
        lines.push(`- Dialog (${menuType}): ${String(text ?? "")}`);
    }

    if (st?.menu?.inMenu === true) {
        if (st?.battle?.in_battle === true || inDialog) {
            lines.push("- Lower-screen prompt/context: active during battle/dialogue");
        } else {
            lines.push("- Modal menu/touch prompt: active");
        }
    }

    if (st?.battle?.in_battle === true) {
        lines.push("- Battle: active");
    }

    const screenshot = st?.screenshot;
    if (screenshot && typeof screenshot === "object") {
        const screenshotParts = [];
        if (typeof screenshot.fresh === "boolean") screenshotParts.push(`fresh=${screenshot.fresh ? "true" : "false"}`);
        if (typeof screenshot.ageMs === "number" && Number.isFinite(screenshot.ageMs)) screenshotParts.push(`ageMs=${screenshot.ageMs}`);
        if (typeof screenshot.sha256 === "string" && screenshot.sha256) screenshotParts.push(`hash=${screenshot.sha256.slice(0, 12)}`);
        if (screenshotParts.length) lines.push(`- Screenshot: ${screenshotParts.join(", ")}`);
    }

    return lines;
}

function cmdLabelFromStep(step) {
    const t = step?.type ?? "?";
    if (config.isHeartGold) {
        if (t === "control") return "control";
        if (t === "hold") return "hold_input";
        if (t === "press") return "press_input";
        if (t === "wait") return "wait_input";
        if (t === "controlStatus") return "controlStatus";
        return String(t || "input");
    }
    const c = step?.command || {};
    if (t === "control") return String(c.command || "");
    if (t === "hold") return `hold:${c.button || "?"}:${c.frames || "?"}`;
    if (t === "press") return `press:${(c.buttons || []).join("+")}`;
    if (t === "wait") return `wait:${c.frames || "?"}`;
    if (t === "controlStatus") return "controlStatus";
    return t;
}

function remainingCommandsFromPayload(payload) {
    const rem = Array.isArray(payload?.remaining_keys) ? payload.remaining_keys : [];
    return rem.map((c) => {
        if (c?.type === "control") return c.command;
        if (c?.type === "hold") return `hold:${c.button || "?"}:${c.frames || "?"}`;
        if (c?.type === "press") return `press:${(c.buttons || []).join("+")}`;
        if (c?.type === "wait") return `wait:${c.frames || "?"}`;
        return c?.type || "?";
    });
}

function remainingCommandsSummaryLine(remaining) {
    const count = Array.isArray(remaining) ? remaining.length : 0;
    if (count <= 0) return null;
    return `- remainingCommandCount: ${count}`;
}

function actionTraceSummaryForBroadcast(actionType, payload) {
    if (!payload || typeof payload !== "object") return null;
    const results = Array.isArray(payload.results)
        ? payload.results.filter((item) => item && typeof item === "object")
        : [];
    const remaining = remainingCommandsFromPayload(payload);
    const firstResult = results[0] || null;
    const visibleEffect =
        typeof payload.visibleEffectObserved === "boolean" ? payload.visibleEffectObserved :
        typeof payload.screenChanged === "boolean" ? payload.screenChanged :
        results.some((item) => item.visibleEffectObserved === true || item.screenChanged === true) ? true :
        results.some((item) => item.visibleEffectObserved === false || item.screenChanged === false) ? false :
        null;
    const inputDelivered =
        typeof payload.inputDelivered === "boolean" ? payload.inputDelivered :
        results.some((item) => item.inputDelivered === true) ? true :
        results.some((item) => item.inputDelivered === false) ? false :
        null;
    const semanticTargetVerified =
        typeof payload.semanticTargetVerified === "boolean" ? payload.semanticTargetVerified :
        results.some((item) => item.semanticTargetVerified === true) ? true :
        results.some((item) => item.semanticTargetVerified === false) ? false :
        null;
    const frameDeltas = results
        .map((item) => Number(item.frameDelta ?? item.frame_delta ?? item.framesAdvanced))
        .filter((value) => Number.isFinite(value));
    const screenshotHash =
        payload.screenshotHash ||
        payload.after?.screenshot?.sha256 ||
        firstResult?.after?.screenshot?.sha256 ||
        firstResult?.screenshotHash ||
        null;
    return {
        surface_class: "dashboard_only",
        redaction: "generated_route_commands_omitted",
        actionType: actionType || null,
        ok: payload.ok === true,
        status: payload.status === true,
        resultCount: results.length,
        remainingCommandCount: remaining.length,
        inputDelivered,
        visibleEffect,
        semanticTargetVerified,
        semanticOutcome: payload.semanticOutcome || payload.semantic_outcome || firstResult?.semanticOutcome || firstResult?.semantic_outcome || firstResult?.actionOutcome || null,
        interruptedByDialog: payload.interruptedByDialog === true,
        interruptedByCollision: payload.interruptedByCollision === true,
        mapTransition: payload.interruptedByMapTransition === true || payload.mapChanged === true || results.some((item) => item.mapChanged === true),
        maxFrameDelta: frameDeltas.length ? Math.max(...frameDeltas) : null,
        screenshotHash: screenshotHash ? sanitizeModelText(String(screenshotHash).slice(0, 12)) : null,
    };
}

function actionTraceForBroadcast(actionType, payload) {
    if (!config.isHeartGold) {
        return { trace: payload || null, trace_summary: null };
    }
    return {
        trace: null,
        trace_summary: actionTraceSummaryForBroadcast(actionType, payload),
    };
}

function summarizeVisualTracePayloadMarkdown(payload) {
    const remaining = remainingCommandsFromPayload(payload);
    const interrupted = payload?.interruptedByDialog === true;
    const interruptedByCollision = payload?.interruptedByCollision === true;
    const interruptedByMapTransition = payload?.interruptedByMapTransition === true;
    const collisionStreak = typeof payload?.collisionStreak === "number" ? payload.collisionStreak : null;
    const startedInDialog = payload?.startedInDialog === true;
    const interruptedAtIndex = typeof payload?.interruptedAtIndex === "number" ? payload.interruptedAtIndex : null;
    const ok = payload?.ok === true;
    const status = payload?.status === true;
    const results = Array.isArray(payload?.results) ? payload.results : [];

    const lines = [];
    lines.push("Run:");
    lines.push(`- ok: ${ok ? "true" : "false"}`);
    lines.push(`- status: ${status ? "true" : "false"}`);
    const remainingLine = remainingCommandsSummaryLine(remaining);
    if (remainingLine) lines.push(remainingLine);
    const outcomeNotes = [];
    if (startedInDialog) outcomeNotes.push("Action began while visible dialogue/text appeared active.");
    if (interrupted) outcomeNotes.push("Action sequence stopped when visible dialogue/text appeared.");
    if (interruptedByCollision) outcomeNotes.push("Movement was blocked by repeated collision/no-movement.");
    if (interruptedByMapTransition) outcomeNotes.push("Action sequence stopped because a map transition occurred; fetch a fresh observation before continuing.");
    if (interruptedAtIndex != null) outcomeNotes.push("Some queued commands were not executed after the interruption.");
    if (collisionStreak != null && interruptedByCollision) outcomeNotes.push("Repeated blocked movement was detected.");
    if (outcomeNotes.length) {
        lines.push("");
        lines.push("Outcome notes:");
        for (const note of outcomeNotes) lines.push(`- ${note}`);
    }

    for (let i = 0; i < results.length; i++) {
        const step = results[i];
        const btn = cmdLabelFromStep(step);
        const okAttrVal = step?.ok === true ? "true" : "false";
        const msAttrVal = typeof step?.ms === "number" ? String(step.ms) : "";
        const typeAttrVal = step?.type ?? "?";
        lines.push("");
        lines.push(`### Step ${i + 1} - ${btn} (type=${typeAttrVal}, ok=${okAttrVal}${msAttrVal ? `, ms=${msAttrVal}` : ""})`);

        const effectLines = [];
        if (typeof step?.visibleEffectObserved === "boolean") {
            effectLines.push(`- visibleEffect: ${step.visibleEffectObserved ? "observed" : "not observed"}`);
        } else if (typeof step?.screenChanged === "boolean") {
            effectLines.push(`- visibleEffect: ${step.screenChanged ? "observed" : "not observed"}`);
        }
        if (typeof step?.screenChanged === "boolean") effectLines.push(`- screenChanged: ${step.screenChanged ? "true" : "false"}`);
        if (typeof step?.frameDelta === "number" && Number.isFinite(step.frameDelta)) effectLines.push(`- frameDelta: ${step.frameDelta}`);
        if (step?.after?.battle?.in_battle === true || step?.after?.battle?.active === true) effectLines.push("- Battle: active");
        if (step?.before?.dialog?.inDialog === true || step?.before?.dialog?.visible === true) effectLines.push("- beforeDialog: visible");
        if (step?.after?.dialog?.inDialog === true || step?.after?.dialog?.visible === true) effectLines.push("- afterDialog: visible");
        if (step?.harnessFailureReason) effectLines.push(`- harnessIssue: ${sanitizeModelText(String(step.harnessFailureReason))}`);
        if (step?.harnessWarning) effectLines.push(`- harnessWarning: ${sanitizeModelText(String(step.harnessWarning))}`);
        if (step?.touchAxisEchoWarning) effectLines.push("- touchAxisEcho: unreliable");
        if (step?.unreliable === true) effectLines.push("- unreliable: true");
        if (typeof step?.inputDelivered === "boolean") effectLines.push(`- inputDelivered: ${step.inputDelivered ? "true" : "false"}`);
        if (typeof step?.semanticTargetVerified === "boolean") effectLines.push(`- semanticTarget: ${step.semanticTargetVerified ? "verified" : "unverified"}`);
        if (step?.semanticTargetLabel) effectLines.push(`- semanticTargetLabel: ${sanitizeModelText(String(step.semanticTargetLabel))}`);
        if (step?.acceptedStringMatchesRequested === true || step?.acceptedStringMatchesRequested === false) effectLines.push(`- acceptedStringMatchesRequested: ${step.acceptedStringMatchesRequested ? "true" : "false"}`);
        if (step?.acceptedString) effectLines.push(`- acceptedString: ${sanitizeModelText(String(step.acceptedString))}`);
        const afterScreenshot = step?.after?.screenshot;
        if (afterScreenshot && typeof afterScreenshot === "object") {
            if (afterScreenshot.fresh === false) {
                effectLines.push("- afterScreenshot: stale");
            } else {
                const screenshotBits = [`fresh=${afterScreenshot.fresh === true ? "true" : "unknown"}`];
                if (typeof afterScreenshot.ageMs === "number") screenshotBits.push(`ageMs=${afterScreenshot.ageMs}`);
                if (afterScreenshot.sha256) screenshotBits.push(`hash=${sanitizeModelText(String(afterScreenshot.sha256).slice(0, 12))}`);
                effectLines.push(`- afterScreenshot: ${screenshotBits.join(", ")}`);
            }
        }
        if (effectLines.length) {
            lines.push("");
            lines.push("Effect:");
            lines.push(...effectLines);
        }

        const trace = step?.trace || {};
        const stopReason = trace?.stopReason;
        const presses = typeof trace?.pressCount === "number" ? trace.pressCount : null;
        const autoPresses = typeof trace?.autoPressCount === "number" ? trace.autoPressCount : null;
        const dur = typeof trace?.durationMs === "number" ? trace.durationMs : null;
        const timedOut = trace?.timedOut === true;
        const maxPressesHit = trace?.maxPressesHit === true;
        if (stopReason || presses != null || autoPresses != null || dur != null || timedOut || maxPressesHit) {
            lines.push("");
            lines.push("Trace:");
            if (stopReason) lines.push(`- stopReason: ${String(stopReason)}`);
            if (presses != null) lines.push(`- pressCount: ${presses}`);
            if (autoPresses != null) lines.push(`- autoPressCount: ${autoPresses}`);
            if (dur != null) lines.push(`- durationMs: ${dur}`);
            if (timedOut) lines.push("- timedOut: true");
            if (maxPressesHit) lines.push("- maxPressesHit: true");
        }

        const transcript = Array.isArray(trace?.transcript) ? trace.transcript : [];
        if (transcript.length) {
            lines.push("");
            lines.push("Transcript:");
            for (const t of transcript) {
                const formatted = formatTraceTranscriptEntry(t);
                if (formatted) lines.push(`- ${formatted}`);
            }
        }

        const safeEvents = (Array.isArray(trace?.events) ? trace.events : [])
            .map((event) => String(event ?? "").trim())
            .filter(Boolean)
            .filter((event) => !/(map|minimap|tile|position|coordinate|wall|ground|grid|rom|ram)/i.test(event));
        if (safeEvents.length) {
            lines.push("");
            lines.push("Events:");
            for (const event of safeEvents) lines.push(`- ${event}`);
        }

        if (step?.wait) {
            const w = step.wait;
            lines.push("");
            lines.push("Wait:");
            lines.push(`- ok: ${w?.ok ? "true" : "false"}`);
            lines.push(`- timedOut: ${w?.timedOut ? "true" : "false"}`);
        }

        if (step?.error) {
            lines.push("");
            lines.push("Error:");
            lines.push(sanitizeModelText(String(step.error)));
        }
    }

    return lines.join("\n").trim();
}

function summarizeTracePayloadMarkdown(payload) {
    if (!payload) {
        return "No payload";
    }
    if (config.isHeartGold) {
        const navigation = state.gameDataJsonRef ? heartGoldDecodedNavigationAllowed(state.gameDataJsonRef) : { allowed: false };
        if (config.observation.mode === "visual" || navigation.allowed !== true) {
            return summarizeVisualTracePayloadMarkdown(payload);
        }
    }
    if (config.isHeartGold && config.observation.mode === "visual") {
        return summarizeVisualTracePayloadMarkdown(payload);
    }

    const results = Array.isArray(payload.results) ? payload.results : [];
    const remaining = remainingCommandsFromPayload(payload);
    const interrupted = payload.interruptedByDialog === true;
    const interruptedByCollision = payload.interruptedByCollision === true;
    const interruptedByMapTransition = payload.interruptedByMapTransition === true;
    const collisionStreak = typeof payload.collisionStreak === "number" ? payload.collisionStreak : null;
    const startedInDialog = payload.startedInDialog === true;
    const interruptedAtIndex = typeof payload.interruptedAtIndex === "number" ? payload.interruptedAtIndex : null;
    const ok = payload.ok === true;
    const status = payload.status === true;

    const lines = [];
    lines.push(`Run:`);
    lines.push(`- ok: ${ok ? "true" : "false"}`);
    lines.push(`- status: ${status ? "true" : "false"}`);
    lines.push(`- startedInDialog: ${startedInDialog ? "true" : "false"}`);
    lines.push(`- interruptedByDialog: ${interrupted ? "true" : "false"}`);
    lines.push(`- interruptedByMapTransition: ${interruptedByMapTransition ? "true" : "false"}`);
    if (interruptedAtIndex != null) {
        lines.push(`- interruptedAtIndex: ${interruptedAtIndex}`);
    }
    lines.push(`- interruptedByCollision: ${interruptedByCollision ? "true" : "false"}`);
    if (collisionStreak != null) {
        lines.push(`- collisionStreak: ${collisionStreak}`);
    }

    const notes = [];
    if (interrupted) {
        notes.push("Dialog detected while executing commands, stopping sequence");
    }
    if (interruptedByCollision) {
        notes.push(
            `WARNING: Command sequence interrupted due to ${collisionStreak != null ? collisionStreak : 5} collisions in a row`
        );
    }
    if (interruptedByMapTransition) {
        notes.push("Map transition detected; remaining queued inputs were skipped so the next decision uses a fresh observation.");
    }

    const remainingLine = remainingCommandsSummaryLine(remaining);
    if (remainingLine) lines.push(remainingLine);

    if (notes.length) {
        lines.push("");
        lines.push("Notes:");
        for (const note of notes) {
            lines.push(`- ${note}`);
        }
    }

    let lastMapKey = null;
    for (let i = 0; i < results.length; i++) {
        const step = results[i];
        const stepIndex = i + 1;
        const btn = cmdLabelFromStep(step);
        const okAttrVal = step?.ok === true ? "true" : "false";
        const msAttrVal = typeof step?.ms === "number" ? String(step.ms) : "";
        const typeAttrVal = step?.type ?? "?";

        lines.push("");
        lines.push(
            `### Step ${stepIndex} — ${btn}${typeAttrVal || okAttrVal || msAttrVal ? ` (type=${typeAttrVal}, ok=${okAttrVal}${msAttrVal ? `, ms=${msAttrVal}` : ""})` : ""}`
        );

        if (typeof step?.settleFrames === "number" || step?.low_stall_trace === true) {
            const timingBits = [];
            if (typeof step.settleFrames === "number") timingBits.push(`settleFrames=${step.settleFrames}`);
            if (step.low_stall_trace === true) timingBits.push("lowStallTrace=true");
            lines.push(`- timing: ${timingBits.join(", ")}`);
        }

        if (typeof step?.screenChanged === "boolean" || typeof step?.visibleEffectObserved === "boolean") {
            lines.push("");
            lines.push("Effect:");
            const observed = typeof step.visibleEffectObserved === "boolean" ? step.visibleEffectObserved : step.screenChanged;
            lines.push(`- visibleEffect: ${observed ? "observed" : "not observed"}`);
            const afterScreenshot = step?.after?.screenshot;
            if (afterScreenshot && typeof afterScreenshot === "object") {
                const screenshotBits = [`fresh=${afterScreenshot.fresh === true ? "true" : afterScreenshot.fresh === false ? "false" : "unknown"}`];
                if (typeof afterScreenshot.ageMs === "number") screenshotBits.push(`ageMs=${afterScreenshot.ageMs}`);
                if (afterScreenshot.sha256) screenshotBits.push(`hash=${sanitizeModelText(String(afterScreenshot.sha256).slice(0, 12))}`);
                lines.push(`- afterScreenshot: ${screenshotBits.join(", ")}`);
            }
        }

        const beforeState = step?.before || {};
        const afterState = step?.after || {};
        const beforeMapKey = mapKeyFromTraceState(beforeState);
        const afterMapKey = mapKeyFromTraceState(afterState);
        const includeMapBefore = beforeMapKey != null && (lastMapKey == null || beforeMapKey !== lastMapKey);
        const includeMapAfter = afterMapKey != null && afterMapKey !== beforeMapKey;

        lines.push("");
        lines.push("Before:");
        const beforeLines = traceStateMarkdownLines(beforeState, { includeMap: includeMapBefore });
        lines.push(...(beforeLines.length ? beforeLines : ["- (no data)"]));

        lines.push("");
        lines.push("After:");
        const afterLines = traceStateMarkdownLines(afterState, { includeMap: includeMapAfter });
        lines.push(...(afterLines.length ? afterLines : ["- (no data)"]));

        // Custom trace payloads (ex: a_until_end_of_dialog transcript)
        const trace = step?.trace;
        const transcript = Array.isArray(trace?.transcript) ? trace.transcript : [];
        const evts = Array.isArray(trace?.events) ? trace.events : [];
        const stopReason = trace?.stopReason;
        const presses = typeof trace?.pressCount === "number" ? trace.pressCount : null;
        const autoPresses = typeof trace?.autoPressCount === "number" ? trace.autoPressCount : null;
        const dur = typeof trace?.durationMs === "number" ? trace.durationMs : null;
        const timedOut = trace?.timedOut === true;
        const maxPressesHit = trace?.maxPressesHit === true;

        if (stopReason || presses != null || autoPresses != null || dur != null || timedOut || maxPressesHit) {
            lines.push("");
            lines.push("Trace:");
            if (stopReason) lines.push(`- stopReason: ${String(stopReason)}`);
            if (presses != null) lines.push(`- pressCount: ${presses}`);
            if (autoPresses != null) lines.push(`- autoPressCount: ${autoPresses}`);
            if (dur != null) lines.push(`- durationMs: ${dur}`);
            if (timedOut) lines.push(`- timedOut: true`);
            if (maxPressesHit) lines.push(`- maxPressesHit: true`);
        }

        const groundWallChanged = trace?.groundWallChanged;
        const rawWallsToFree = Array.isArray(groundWallChanged?.wallsToFree) ? groundWallChanged.wallsToFree : [];
        const wallsToFree = rawWallsToFree
            .map((p) => {
                if (!Array.isArray(p) || p.length < 2) return null;
                const x = Number(p[0]);
                const y = Number(p[1]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                return [Math.trunc(x), Math.trunc(y)];
            })
            .filter((p) => Array.isArray(p) && p.length === 2);

        const rawFreeToWalls = Array.isArray(groundWallChanged?.freeToWalls) ? groundWallChanged.freeToWalls : [];
        const freeToWalls = rawFreeToWalls
            .map((p) => {
                if (!Array.isArray(p) || p.length < 2) return null;
                const x = Number(p[0]);
                const y = Number(p[1]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                return [Math.trunc(x), Math.trunc(y)];
            })
            .filter((p) => Array.isArray(p) && p.length === 2);

        const stepEvents = evts
            .map((e) => (e == null ? "" : String(e)))
            .map((e) => e.trim())
            .filter(Boolean);
        const mapUpdates = [];

        if (wallsToFree.length || freeToWalls.length) {
            const mapId =
                (typeof groundWallChanged?.mapId === "string" && groundWallChanged.mapId.trim())
                    ? groundWallChanged.mapId.trim()
                    : (mapIdFromTraceState(step?.after || {}) || mapIdFromTraceState(step?.before || {}));
            const mapName =
                (typeof groundWallChanged?.mapName === "string" && groundWallChanged.mapName.trim())
                    ? groundWallChanged.mapName.trim()
                    : (step?.after?.map?.name || step?.before?.map?.name);
            const mapIdText = mapId || "unknown";
            stepEvents.push(`Free Ground/Collision tiles changed on map ${mapIdText}`);
            if (wallsToFree.length) {
                const posAttr = wallsToFree.map(([x, y]) => `${x},${y}`).join("|");
                mapUpdates.push(
                    `- collision_to_free (${formatMapLabel(mapId, mapName)}): ${posAttr}`
                );
            }
            if (freeToWalls.length) {
                const posAttr = freeToWalls.map(([x, y]) => `${x},${y}`).join("|");
                mapUpdates.push(
                    `- free_to_collision (${formatMapLabel(mapId, mapName)}): ${posAttr}`
                );
            }
        }

        const tilesDiscovered = trace?.tilesDiscovered;
        const rawPositions = Array.isArray(tilesDiscovered?.positions) ? tilesDiscovered.positions : [];
        const positions = rawPositions
            .map((p) => {
                if (!Array.isArray(p) || p.length < 2) return null;
                const x = Number(p[0]);
                const y = Number(p[1]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                return [Math.trunc(x), Math.trunc(y)];
            })
            .filter((p) => Array.isArray(p) && p.length === 2);

        if (positions.length) {
            const mapId =
                (typeof tilesDiscovered?.mapId === "string" && tilesDiscovered.mapId.trim())
                    ? tilesDiscovered.mapId.trim()
                    : (mapIdFromTraceState(step?.after || {}) || mapIdFromTraceState(step?.before || {}));
            const mapName =
                (typeof tilesDiscovered?.mapName === "string" && tilesDiscovered.mapName.trim())
                    ? tilesDiscovered.mapName.trim()
                    : (step?.after?.map?.name || step?.before?.map?.name);
            const posAttr = positions.map(([x, y]) => `${x},${y}`).join("|");
            const msg =
                'You discovered new tiles on the minimap after executing your commands, some "?" are now visible.';
            stepEvents.push(msg);
            mapUpdates.push(
                `- tiles_discovered (${formatMapLabel(mapId, mapName)}): ${posAttr}`
            );
        }

        if (transcript.length) {
            lines.push("");
            lines.push("Transcript:");
            for (const t of transcript) {
                if (t == null) continue;
                const formatted = formatTraceTranscriptEntry(t);
                if (formatted) lines.push(`- ${formatted}`);
            }
        }

        if (stepEvents.length) {
            lines.push("");
            lines.push("Events:");
            for (const e of stepEvents) {
                lines.push(`- ${e}`);
            }
        }

        if (mapUpdates.length) {
            lines.push("");
            lines.push("Map updates:");
            lines.push(...mapUpdates);
        }

        if (step?.wait) {
            const w = step.wait;
            const okW = w?.ok ? "true" : "false";
            const toW = w?.timedOut ? "true" : "false";
            const activeW = w?.parsed?.active ?? "";
            const queueW = w?.parsed?.queue ?? "";
            lines.push("");
            lines.push("Wait:");
            lines.push(`- ok: ${okW}`);
            lines.push(`- timedOut: ${toW}`);
            if (activeW) lines.push(`- active: ${activeW}`);
            if (queueW) lines.push(`- queue: ${queueW}`);
        }

        if (step?.error) {
            lines.push("");
            lines.push("Error:");
            lines.push(String(step.error));
        }

        const newLastMapKey = mapKeyFromTraceState(afterState) || mapKeyFromTraceState(beforeState);
        if (newLastMapKey != null) lastMapKey = newLastMapKey;
    }

    return lines.join("\n").trim();
}

function defineTools() {
    // Individual schemas for each action type.
    const keyPressActionSchema = z.object({
        type: z.literal("key_press").describe("Action of pressing one key or a deliberate simultaneous button combo. It is not a sequence."),
        keys: z.array(z.enum(ALLOWED_KEYPRESS_KEYS)).describe("Simultaneous keys to send (e.g., 'up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'). Do not put repeated movement steps here; use button_sequence for sequential movement. Use 'face_up', 'face_down', 'face_left', 'face_right' to change orientation without moving."),
        frames: z.number().min(1).max(1800).optional().describe("HeartGold only: optional hold/advance duration. Use 8-24 for taps and up to 1800 for long dialog advance windows."),
    });

    const buttonSequenceStepSchema = z.union([
        z.object({
            keys: z.union([
                z.array(z.enum(ALLOWED_KEYPRESS_KEYS)).min(1),
                z.literal(""),
                z.literal("wait"),
            ]).describe("Simultaneous keys for this one step; normally a single key. Use an empty string or 'wait' only for an intentional wait step."),
            frames: z.number().min(1).max(120).nullable().optional().describe("Frames for this step. Use 8-16 for tile/menu taps."),
        }),
        z.object({
            type: z.literal("wait").describe("Explicit wait step marker for a pause inside a button sequence."),
            frames: z.number().min(1).max(120).nullable().optional().describe("Frames to wait."),
        }),
    ]);

    const buttonSequenceActionSchema = z.object({
        type: z.literal("button_sequence").describe("HeartGold-only sequential button presses. Use this when you intend Down, Down, Left as separate presses rather than simultaneous keys."),
        sequence: z.array(buttonSequenceStepSchema).min(1).max(24),
        explanation: z.string().nullable().optional().describe("Why this exact sequence is appropriate."),
    });

    const waitActionSchema = z.object({
        type: z.literal("wait").describe("HeartGold-only explicit wait. Use when the game is animating/loading or when waiting is the intended action after observing the current state."),
        frames: z.number().min(1).max(1800).optional().describe("Frames to wait."),
        explanation: z.string().nullable().optional().describe("Why waiting is appropriate."),
    });

    const touchActionSchema = z.object({
        type: z.literal("touch").describe("Nintendo DS touch action. Use only when a visible lower-screen UI is the right control; the top screen is visual-only and rejected for touch. A successful touch means input was delivered and/or visible effect was observed; it does not prove the intended semantic target was selected. For starter choices, naming, YES/NO, and other irreversible UI, verify the next screenshot before confirming."),
        x: z.number().describe("Touch X coordinate in the declared coordinate_space."),
        y: z.number().describe("Touch Y coordinate in the declared coordinate_space."),
        target_label: z.string().nullable().optional().describe("Optional human label for the intended visible target. The harness records it for attribution, but success still requires a later observation to prove the game state changed as intended."),
        coordinate_space: z.enum(["bottom", "full_raw", "model_scaled"]).nullable().optional().describe("bottom means DS bottom-screen local 256x192, x=0..255 and y=0..191. full_raw means full vertical 256x384 DS screenshot, with touchable bottom-screen y=192..383. model_scaled requires source_width/source_height from the attached model_input.image and resolves from the full vertical screenshot; the top screen is visual-only and rejected for touch."),
        screen: z.enum(["bottom", "full"]).nullable().optional().describe("Use bottom with bottom coordinate_space. Use full when x/y are full vertical screenshot or model_scaled coordinates."),
        source_width: z.number().min(1).nullable().optional().describe("Required for model_scaled coordinates; must match the current attached model_input.image width."),
        source_height: z.number().min(1).nullable().optional().describe("Required for model_scaled coordinates; must match the current attached model_input.image height."),
        frames: z.number().min(1).max(120).describe("How many frames to hold the stylus touch."),
        explanation: z.string().describe("Why this touch target is correct."),
    });

    const typeTextActionSchema = z.object({
        type: z.literal("type_text").describe("HeartGold text-entry helper for naming keyboards. Preferred for player/rival/Pokemon naming screens because it clears existing text, enters the requested A-Z/0-9 value with deterministic D-pad input, and confirms with Start only after recording the current naming RAM entry buffer."),
        value: z.string().min(1).max(7).regex(/^[A-Za-z0-9]+$/).nullable().optional().describe("Preferred text to enter, A-Z/0-9 only, e.g. GPT."),
        text: z.string().min(1).max(7).regex(/^[A-Za-z0-9]+$/).nullable().optional().describe("Accepted alias for value. Prefer value in new actions."),
        explanation: z.string().describe("Why this text is being entered."),
    }).refine((action) => Boolean(action.value || action.text), {
        message: "type_text requires value or text",
    });

    const advanceDialogActionSchema = z.object({
        type: z.literal("a_until_end_of_dialog").describe("HeartGold helper that presses A until the visible dialogue/text advances or free control returns. Use for long intro dialogue when repeated A is the intended action."),
        frames: z.number().min(1).max(1800).nullable().optional().describe("Maximum frame budget for dialogue advancement."),
        max_presses: z.number().min(1).max(40).nullable().optional().describe("Accepted Codex Desktop alias for a bounded number of A presses. Converted to an approximate frame budget when frames is omitted."),
        explanation: z.string().nullable().optional().describe("Why repeated A is appropriate here."),
    });

    const addMarkerActionSchema = z.object({
        type: z.literal("add_marker").describe("Action to create a custom marker on the minimap."),
        map_name: z.string().describe("Name of the map where to place the marker."),
        map_id: z.string().describe("ID of the map where to place the marker."),
        x: z.number().describe("X coordinate of the marker."),
        y: z.number().describe("Y coordinate of the marker."),
        emoji: z.string().describe("Emoji representing the marker. Choose a relevant emoji for the type of place."),
        label: z.string().describe("Detailed description of the marker. Make it as long as needed to be informative, do not be concise when it's needed."),
    });

    const writeMemoryActionSchema = z.object({
        type: z.literal("write_memory").describe("Action to write / update state.memory."),
        key: z.string().describe("Key for the information to memorize. Use prefixes to organize (e.g., 'location_', 'quest_', 'item_', 'tips_')."),
        value: z.string().describe("Value to memorize. Be precise and concise. Do not use for trivial information."),
    });

    const deleteMemoryActionSchema = z.object({
        type: z.literal("delete_memory").describe("Action to delete from state.memory."),
        key: z.string().describe("Key for the information to delete."),
    });

    const recallReasoningArchiveActionSchema = z.object({
        type: z.literal("recall_reasoning_archive").describe("HeartGold-only consult action for retrieving your own older player reasoning that fell out of the 12-turn short-term window. This does not press emulator buttons."),
        query: z.string().nullable().optional().describe("Optional exact text query. Matching archived records are returned verbatim without summaries or importance ranking."),
        turn_start: z.number().nullable().optional().describe("Optional first archived step number to include."),
        turn_end: z.number().nullable().optional().describe("Optional last archived step number to include."),
        offset: z.number().min(0).nullable().optional().describe("Optional zero-based offset into matching archived records."),
        limit: z.number().min(1).max(50).nullable().optional().describe("Maximum archived records to return; records themselves are not shortened or summarized."),
    });

    const updateObjectivesActionSchema = z.object({
        type: z.literal("update_objectives").describe("Action to update the current game state.objectives."),
        primary: z.object({
            short_description: z.string().describe("The short description of the objective, must be a complete sentence. Do not be concise, resume the description in one sentence."),
            description: z.string().describe("Detailed data about the objective (Why / How etc ...)."),
        }).describe("The main objective. Use both short_description and description. Do not leave empty."),
        secondary: z.object({
            short_description: z.string().describe("The short description of the objective, must be a complete sentence. Do not be concise, resume the description in one sentence."),
            description: z.string().describe("Detailed data about the objective (Why / How etc ...)."),
        }).describe("The secondary objective. Use both short_description and description. Do not leave empty."),
        third: z.object({
            short_description: z.string().describe("The short description of the objective, must be a complete sentence. Do not be concise, resume the description in one sentence."),
            description: z.string().describe("Detailed data about the objective (Why / How etc ...)."),
        }).describe("The third objective. Use both short_description and description. Do not leave empty."),
        others: z.array(z.object({
            short_description: z.string().describe("The short description of the objective, must be a complete sentence. Do not be concise, resume the description in one sentence."),
            description: z.string().describe("Detailed data about the objective (Why / How etc ...)."),
        })).describe("List of other state.objectives. Each must have a short_description and description. Do not leave empty."),
    });

    // Schema for deleting a marker
    const deleteMarkerActionSchema = z.object({
        type: z.literal("delete_marker").describe("Action to delete a custom marker from the map."),
        map_id: z.string().describe("ID of the map where the marker is located."),
        x: z.number().describe("X coordinate of the marker to delete."),
        y: z.number().describe("Y coordinate of the marker to delete."),
    });

    // Pathfinding schema
    const pathfindingActionSchema = z.object({
        type: z.literal("path_to_location").describe("HeartGold same-map movement actuator, not a walkthrough, story guide, or cross-map pathfinder. Use only when the prompt marks path_to_location enabled and exposes current map_id/coordinates."),
        x: z.number().describe("X coordinate of the destination."),
        y: z.number().describe("Y coordinate of the destination."),
        map_id: z.string().describe("ID of the current map where the same-map destination is located."),
        explanation: z.string().describe(
            "Brief description of the movement plan including: " +
            "• Starting point and destination " +
            "• Purpose of the movement " +
            "- Any same-map movement constraints (e.g., 'Avoid tall grass if possible', 'Stop at the door tile shown on this map')"
        ),
    });

    // Restart console schema
    const restartConsoleActionSchema = z.object({
        type: z.literal("restart_console").describe("Action to reboot the emulator back to the title screen. BE SURE TO HAVE SAVED THE GAME BEFORE USING THIS TOOL. In HeartGold mode this only requests the restart; it must not auto-advance dialogue or title screens."),
    });

    // Union of possible action schemas
    const actionSchemas = [
        keyPressActionSchema,
        ...(config.isHeartGold ? [buttonSequenceActionSchema, waitActionSchema, touchActionSchema, typeTextActionSchema, advanceDialogActionSchema] : []),
        ...(config.isHeartGold && config.observation.mode === "visual" ? [] : [addMarkerActionSchema]),
        writeMemoryActionSchema,
        deleteMemoryActionSchema,
        ...(config.isHeartGold ? [recallReasoningArchiveActionSchema] : []),
        updateObjectivesActionSchema,
        ...(config.isHeartGold && config.observation.mode === "visual" ? [] : [deleteMarkerActionSchema, pathfindingActionSchema]),
        restartConsoleActionSchema,
    ];
    const actionUnionSchema = z.union(actionSchemas);

    // Main schema for the execute_action tool
    const executeActionSchema = z.object({
        step_details: z.string().nullable().describe("Optional player-authored continuity for this action batch. Use it when it helps preserve useful gameplay context; otherwise use null."),
        actions: actionUnionSchema.array().min(1).describe("One or multiple action(s) to execute"),
        chat_message: z.string().nullable().describe("Optional player-authored gameplay commentary. Use it when there is a meaningful intent, reaction, or event to express; otherwise use null."),
        avatar_emotion: z.enum(AVATAR_EMOTIONS).nullable().describe("Optional player-authored expression for this turn. Choose a mood from the current gameplay beat when useful; otherwise use null."),
    });

    // Definition of the unique tool
    return [
        {
            type: "function",
            name: "execute_action",
            description: "Executes an action in the game: movement, interaction, or memorizing information. Adapt the action to the context (dialogue or free movement).",
            parameters: zodToJsonSchema(executeActionSchema),
            strict: config.tools.strict,
        },
    ];
}

/**
 * Handles the call of a specific tool requested by the AI.
 * @param {object} toolCall - The toolCall object from the OpenAI response.
 * @param {object} gameDataJson - The current game data
 * @returns {Promise<object>} The result of the function call for the history.
 */
async function handleToolCall(toolCall, gameDataJson, options = {}) {
    const { name, arguments: argsString, call_id } = toolCall;
    const toolBatchStart = Date.now();
    let allActionResults = [];
    let metricActionResults = [];
    let overallSuccess = true;
    let keyPressExecutedThisTurn = false;
    let pathfindingExecutedThisTurn = false;
    let normalizedActionSchemaCount = Math.max(0, Number(options.normalizedActionSchemaCount) || 0);

    if (name !== "execute_action") {
        console.error(`Error: Received unexpected tool call '${name}'.`);
        state.skipNextUserMessage = true;
        return {
            type: "function_call_output",
            call_id: call_id,
            output: [{ type: "input_text", text: `Error: Unexpected tool name '${name}'. Expected 'execute_action'.` }],
        };
    }

    let args;
    try {
        args = JSON.parse(argsString);
        args.step_details = typeof args.step_details === "string" ? args.step_details : "";
        args.chat_message = typeof args.chat_message === "string" ? args.chat_message : "";
        args.avatar_emotion = typeof args.avatar_emotion === "string" && args.avatar_emotion ? args.avatar_emotion : "thinking";
        if (args?._codex_desktop_normalization?.actionCount != null) {
            normalizedActionSchemaCount = Math.max(
                normalizedActionSchemaCount,
                Number(args._codex_desktop_normalization.actionCount) || 0
            );
        }
        console.log(`---> Tool Call Start: ${name} (ID: ${call_id})`);
        console.log(`Step Details: ${args.step_details}`);
        console.log(`Chat Message: ${args.chat_message}`);
        console.log(`Avatar Emotion: ${args.avatar_emotion}`);

        if (!args.actions || !Array.isArray(args.actions)) {
            throw new Error("'actions' argument is missing or is not an array.");
        }
        if (args.actions.length === 0) {
            console.error("ERROR: Tool call received with no actions to execute, it's forbidden to send an empty action.");
            state.skipNextUserMessage = true;
            console.log("Setting state.skipNextUserMessage = true due to empty action tool call.");
            return {
                type: "function_call_output",
                call_id: call_id,
                output: [{ type: "input_text", text: "ERROR: Tool call received with no actions to execute, it's forbidden to send an empty action." }],
            };
        }

        const restartConsolePresent = args.actions.some((action) => action.type === "restart_console");
        if (restartConsolePresent && args.actions.length > 1) {
            const errorText = "Error: 'restart_console' must be the ONLY action in the list. Remove all other actions and try again. (And be sure to have saved the game before using this tool.)";
            console.error(errorText);
            return {
                type: "function_call_output",
                call_id: call_id,
                output: [{ type: "input_text", text: errorText }],
            };
        }

        const batchActionStartPayload = {
            call_id: call_id,
            step_details: args.step_details,
            chat_message: args.chat_message,
            avatar_emotion: args.avatar_emotion,
            actions: args.actions,
        };
        broadcast({ type: 'action_start', payload: batchActionStartPayload });
        console.log(`---> Batch Action Start (ID: ${call_id}) - ${args.actions.length} actions`);

        for (let i = 0; i < args.actions.length; i++) {
            const individualAction = args.actions[i];
            const actionCallId = `${call_id}_${i}`;
            let actionResult = {
                action_type: individualAction.type,
                success: false,
                message: "",
                details: "",
            };

            console.log(`---> Executing Action ${i + 1}/${args.actions.length}: ${individualAction.type} (Sub-ID: ${actionCallId})`);
            try {
                switch (individualAction.type) {
                    case "key_press":
                        {
                        const normalizedKeys = Array.isArray(individualAction.keys) ? individualAction.keys.map(normalizeKeyName) : [];
                        const keyProblem = keyListProblem(individualAction.keys);
                        if (keyProblem) {
                            actionResult.message = `Error: ${keyProblem}`;
                            actionResult.success = false;
                            overallSuccess = false;
                        }
                        else if (normalizedKeys.includes('start') && normalizedKeys.length > 1) {
                            actionResult.message = "Error: 'start' button cannot be used with other keys.";
                            actionResult.success = false;
                            overallSuccess = false;
                        }
                        else if (!config.isHeartGold && keyPressExecutedThisTurn) {
                            actionResult.success = false;
                            actionResult.message = "Error: Only one 'key_press' action is allowed per turn. Include all your keys inside one key_press action. You can send as many actions as you want, but only one key_press action in the list of actions is allowed.";
                            actionResult.details = "Skipping subsequent key_press actions.";
                            overallSuccess = false;
                            console.warn(`WARN: Skipping key_press action ${i + 1} as one was already executed this turn.`);
                        } else {
                            const requestedFrames = Number(individualAction.frames);
                            const usesDialogAdvance = normalizedKeys.includes("a_until_end_of_dialog");
                            const maxFrames = config.isHeartGold ? 1800 : 600;
                            const frames = Number.isFinite(requestedFrames) && requestedFrames > 0
                                ? Math.min(maxFrames, Math.trunc(requestedFrames))
                                : (config.isHeartGold && usesDialogAdvance ? 300 : 8);
                            const commandPayload = config.isHeartGold
                                ? [heartGoldPressCommandFromKeys(normalizedKeys, frames)]
                                : individualAction.keys;
                            const response = await sendCommandsToPythonServer(commandPayload);
                            actionResult.pythonResponse = response;
                            const reliability = config.isHeartGold ? heartGoldActionReliability(response) : { verified: Boolean(response.status), unreliable: false, reason: null };
                            const rawSuccess = config.isHeartGold ? heartGoldRawActionSuccess(response) : Boolean(response.status);
                            const verified = Boolean(reliability.verified) && !reliability.unreliable;
                            actionResult.raw_success = rawSuccess;
                            actionResult.benchmark_verified = verified;
                            actionResult.success = rawSuccess;
                            actionResult.message = config.isHeartGold
                                ? heartGoldPrimitiveMessage(
                                    rawSuccess,
                                    verified,
                                    `Keys sent: ${normalizedKeys.join(', ')} for ${frames} frames.`,
                                    `Benchmark semantic verification is still open: ${reliability.reason || "not independently verified"}.`,
                                    `Button input failed at the bridge: ${reliability.reason || "bridge did not confirm the action"}.`
                                )
                                : actionResult.success
                                  ? `Keys sent: ${individualAction.keys.join(', ')}`
                                  : "Failed to send keys.";
                            actionResult.details_for_ai = summarizeTracePayloadMarkdown(response);
                            actionResult.details = "";
                            if (actionResult.success) {
                                if (!config.isHeartGold) {
                                    keyPressExecutedThisTurn = true;
                                }
                            } else {
                                overallSuccess = false;
                            }
                        }
                        break;
                        }

                    case "button_sequence": {
                        if (!config.isHeartGold) {
                            actionResult.success = false;
                            actionResult.message = "Error: button_sequence actions are only available in the HeartGold DS profile.";
                            overallSuccess = false;
                            break;
                        }
                        const normalizedSequence = normalizedButtonSequenceSteps(individualAction);
                        const sequence = normalizedSequence.sequence;
                        if (normalizedSequence.normalized) {
                            normalizedActionSchemaCount += 1;
                            actionResult.normalization_applied = true;
                            actionResult.normalization_reason = normalizedSequence.reason;
                        }
                        const commands = [];
                        let sequenceProblem = null;
                        for (const step of sequence) {
                            const { command, problem } = heartGoldCommandFromSequenceStep(step);
                            if (problem) {
                                sequenceProblem = problem;
                                break;
                            }
                            commands.push(command);
                        }
                        if (!commands.length || sequenceProblem) {
                            actionResult.success = false;
                            actionResult.message = `Error: invalid button_sequence. ${sequenceProblem || "sequence is empty."}`;
                            overallSuccess = false;
                            break;
                        }
                        const response = await sendCommandsToPythonServer(commands);
                        actionResult.pythonResponse = response;
                        const reliability = heartGoldActionReliability(response);
                        const outcome = heartGoldButtonSequenceOutcome({ response, reliability, commandCount: commands.length });
                        actionResult.success = outcome.success;
                        actionResult.message = outcome.message;
                        actionResult.details_for_ai = summarizeTracePayloadMarkdown(response);
                        actionResult.details = "";
                        if (!actionResult.success) overallSuccess = false;
                        break;
                    }

                    case "wait": {
                        if (!config.isHeartGold) {
                            actionResult.success = false;
                            actionResult.message = "Error: wait is only available as a top-level action in the HeartGold DS profile.";
                            overallSuccess = false;
                            break;
                        }
                        const requestedFrames = Number(individualAction.frames);
                        const frames = Number.isFinite(requestedFrames) && requestedFrames > 0
                            ? Math.min(1800, Math.trunc(requestedFrames))
                            : 30;
                        const response = await sendCommandsToPythonServer([{ type: "wait", frames }]);
                        actionResult.pythonResponse = response;
                        const reliability = heartGoldActionReliability(response);
                        const rawSuccess = heartGoldRawActionSuccess(response);
                        const verified = Boolean(reliability.verified) && !reliability.unreliable;
                        actionResult.raw_success = rawSuccess;
                        actionResult.benchmark_verified = verified;
                        actionResult.success = rawSuccess;
                        actionResult.message = heartGoldPrimitiveMessage(
                            rawSuccess,
                            verified,
                            `Waited for ${frames} frames.`,
                            `Benchmark semantic verification is still open: ${reliability.reason || "not independently verified"}.`,
                            `Wait failed at the bridge: ${reliability.reason || "bridge did not confirm the action"}.`
                        );
                        actionResult.details_for_ai = summarizeTracePayloadMarkdown(response);
                        actionResult.details = "";
                        if (!actionResult.success) overallSuccess = false;
                        break;
                    }

                    case "touch": {
                        if (!config.isHeartGold) {
                            actionResult.success = false;
                            actionResult.message = "Error: touch actions are only available in the HeartGold DS profile.";
                            overallSuccess = false;
                            break;
                        }
                        const response = await sendCommandsToPythonServer([
                            {
                                type: "touch",
                                x: individualAction.x,
                                y: individualAction.y,
                                coordinate_space: individualAction.coordinate_space || "bottom",
                                screen: individualAction.screen || (individualAction.coordinate_space && individualAction.coordinate_space !== "bottom" ? "full" : "bottom"),
                                target_label: individualAction.target_label || null,
                                source_width: individualAction.source_width,
                                source_height: individualAction.source_height,
                                frames: individualAction.frames || 8,
                            },
                        ]);
                        actionResult.pythonResponse = response;
                        const reliability = heartGoldActionReliability(response);
                        const rawSuccess = heartGoldRawActionSuccess(response);
                        const verified = Boolean(reliability.verified) && !reliability.unreliable;
                        actionResult.raw_success = rawSuccess;
                        actionResult.benchmark_verified = verified;
                        actionResult.success = rawSuccess;
                        actionResult.message = heartGoldPrimitiveMessage(
                            rawSuccess,
                            verified,
                            touchResultMessage(individualAction, response),
                            `Benchmark semantic verification is still open: ${reliability.reason || "unverified effect"}.`,
                            `Touch input failed at the bridge: ${reliability.reason || "unverified effect"}.`
                        );
                        actionResult.details_for_ai = summarizeTracePayloadMarkdown(response);
                        actionResult.details = "";
                        if (!actionResult.success) overallSuccess = false;
                        break;
                    }

                    case "type_text": {
                        if (!config.isHeartGold) {
                            actionResult.success = false;
                            actionResult.message = "Error: type_text actions are only available in the HeartGold DS profile.";
                            overallSuccess = false;
                            break;
                        }
                        const rawText = individualAction.value ?? individualAction.text;
                        const rawTextString = String(rawText || "").trim();
                        const text = sanitizeHeartGoldKeyboardText(rawTextString);
                        if (!text) {
                            actionResult.success = false;
                            actionResult.message = "Error: type_text requires A-Z/0-9 text in the 'value' field. 'text' is accepted as a backward-compatible alias.";
                            overallSuccess = false;
                            break;
                        }
                        if (text !== rawTextString.toUpperCase()) {
                            actionResult.success = false;
                            actionResult.message = `Error: type_text accepts only A-Z/0-9 and at most 7 characters. Sanitized candidate would be '${text}', so the action was rejected instead of silently changing the name.`;
                            overallSuccess = false;
                            break;
                        }
                        const response = await sendCommandsToPythonServer([{ type: "type_text", text }]);
                        actionResult.pythonResponse = response;
                        const reliability = heartGoldActionReliability(response);
                        const rawSuccess = heartGoldRawActionSuccess(response);
                        const verified = Boolean(reliability.verified) && !reliability.unreliable;
                        actionResult.raw_success = rawSuccess;
                        actionResult.benchmark_verified = verified;
                        actionResult.success = rawSuccess;
                        const firstTypeText = Array.isArray(response?.results) ? response.results.find((item) => item?.type === "type_text") : null;
                        const acceptedString = firstTypeText?.acceptedString || response?.acceptedString || text;
                        const acceptedMatches = firstTypeText?.acceptedStringMatchesRequested === true || response?.acceptedStringMatchesRequested === true;
                        const typeTextSuccessMessage = acceptedMatches
                            ? `Typed text: ${acceptedString}. Accepted text matched the requested string in the current HeartGold naming RAM entry buffer before confirm; verify the next observation before treating any story/menu state as advanced.`
                            : `Typed text: ${text}. The input was delivered, but accepted string was not independently matched; verify from the next observation.`;
                        actionResult.message = heartGoldPrimitiveMessage(
                            rawSuccess,
                            verified,
                            typeTextSuccessMessage,
                            `Benchmark semantic verification is still open: ${reliability.reason || "unverified keyboard entry"}.`,
                            `type_text failed at the bridge: ${reliability.reason || "unverified keyboard entry"}.`
                        );
                        actionResult.details_for_ai = summarizeTracePayloadMarkdown(response);
                        actionResult.details = "";
                        if (!actionResult.success) overallSuccess = false;
                        break;
                    }

                    case "a_until_end_of_dialog": {
                        if (!config.isHeartGold) {
                            actionResult.success = false;
                            actionResult.message = "Error: a_until_end_of_dialog is only available in the HeartGold DS profile.";
                            overallSuccess = false;
                            break;
                        }
                        const requestedFrames = Number(individualAction.frames);
                        const requestedMaxPresses = Number(individualAction.max_presses);
                        const frameBudget =
                            Number.isFinite(requestedFrames) && requestedFrames > 0 ? requestedFrames : null;
                        const pressBudget =
                            Number.isFinite(requestedMaxPresses) && requestedMaxPresses > 0 ? requestedMaxPresses * 48 : null;
                        const derivedFrames =
                            frameBudget != null && pressBudget != null
                                ? Math.max(frameBudget, pressBudget)
                                : frameBudget != null
                                  ? frameBudget
                                  : pressBudget != null
                                    ? pressBudget
                                    : 300;
                        const frames = Math.min(1800, Math.max(1, Math.trunc(derivedFrames)));
                        const response = await sendCommandsToPythonServer([{ type: "a_until_end_of_dialog", frames }]);
                        actionResult.pythonResponse = response;
                        const reliability = heartGoldActionReliability(response);
                        const outcome = heartGoldDialogAdvanceOutcome({ response, reliability, frames });
                        actionResult.success = outcome.success;
                        actionResult.message = outcome.message;
                        actionResult.details_for_ai = summarizeTracePayloadMarkdown(response);
                        actionResult.details = "";
                        if (!actionResult.success) overallSuccess = false;
                        break;
                    }

                    case "add_marker":
                        const { map_id, map_name, x, y, emoji, label } = individualAction;
                        const safeMapId = sanitizeModelText(String(map_id || ""));
                        const safeMapName = sanitizeModelText(String(map_name || ""));
                        const safeEmoji = sanitizeModelText(String(emoji || ""));
                        const safeLabel = sanitizeModelText(String(label || ""));
                        const xNum = Number(x);
                        const yNum = Number(y);
                        const xInt = Math.trunc(xNum);
                        const yInt = Math.trunc(yNum);
                        const markerKey = `${xInt}_${yInt}`;
                        // Check if the player is in a dialog, if so, don't add the marker
                        if (gameDataJson.is_talking_to_npc) {
                            actionResult.success = false;
                            actionResult.message = "Error: Player is in a dialog, cannot add a marker. Try again when the dialog is over.";
                            actionResult.details = "Marker not added.";
                            console.log(`INFO: Player is in a dialog, cannot add a marker.`);
                            break;
                        }

                        if (config.isHeartGold) {
                            const navigation = heartGoldDecodedNavigationAllowed(gameDataJson);
                            if (!navigation.allowed) {
                                actionResult.success = false;
                                actionResult.message =
                                    "Error: Cannot add coordinate marker because current map identity/position is not available. Use memory notes instead.";
                                actionResult.details = "Marker not added.";
                                break;
                            }
                        }

                        if (!state.markers[safeMapId]) {
                            state.markers[safeMapId] = {};
                        }

                        // Validate coordinates
                        if (!Number.isFinite(xNum) || !Number.isFinite(yNum)) {
                            actionResult.success = false;
                            actionResult.message = `Error: Invalid marker coordinates. x/y must be finite numbers (received x=${x}, y=${y}).`;
                            actionResult.details = "Marker not added.";
                            break;
                        }
                        if (xInt !== xNum || yInt !== yNum) {
                            actionResult.success = false;
                            actionResult.message = `Error: Invalid marker coordinates. x/y must be integers (received x=${x}, y=${y}).`;
                            actionResult.details = "Marker not added.";
                            break;
                        }

                        // Bounds check: prevent out-of-bounds markers on the map.
                        if (xInt < 0 || yInt < 0) {
                            actionResult.success = false;
                            actionResult.message = `Error: Marker (${xInt}, ${yInt}) is out of bounds for map ${safeMapId}. Coordinates must be >= 0.`;
                            actionResult.details = "Marker not added.";
                            break;
                        }
                        const bounds = await resolveMapBounds(gameDataJson, safeMapId);
                        if (bounds && (xInt >= bounds.width || yInt >= bounds.height)) {
                            actionResult.success = false;
                            actionResult.message =
                                `Error: Marker (${xInt}, ${yInt}) is out of bounds for map ${safeMapId} (${bounds.width}x${bounds.height}).`;
                            actionResult.details =
                                `Valid ranges: x=0..${bounds.width - 1}, y=0..${bounds.height - 1}.`;
                            break;
                        }

                        // Check if the marker already exists
                        if (state.markers[safeMapId][markerKey]) {
                            actionResult.success = false;
                            actionResult.message = `Marker already exists on map ${safeMapId} at (${xInt}, ${yInt}). Delete it before adding a new one.`;
                            actionResult.details = "Marker not added.";
                            console.log(`INFO: Marker already exists on map ${safeMapId} at ${markerKey}`);
                            break;
                        }
                        // No static MAP_NAMES table here: map names come from the Python bridge.
                        // We accept the provided map_id/map_name as-is.
                        // Attach NPC/object UID automatically when the marker falls on a known npc_entries position for the current map
                        let markerUid = null;
                        const npcEntries = Array.isArray(gameDataJson?.npc_entries_visible) ? gameDataJson.npc_entries_visible : null;
                        const playerMapId = gameDataJson?.current_trainer_data?.position?.map_id;
                        if (npcEntries && playerMapId === safeMapId) {
                            for (const entry of npcEntries) {
                                if (!entry || typeof entry !== "object") continue;
                                if (Number(entry.x) === xInt && Number(entry.y) === yInt) {
                                    markerUid = typeof entry.uid === "string" ? entry.uid : null;
                                    break;
                                }
                            }
                        }

                        const markerPayload = markerUid ? { emoji: safeEmoji, label: safeLabel, map_name: safeMapName, uid: sanitizeModelText(markerUid) } : { emoji: safeEmoji, label: safeLabel, map_name: safeMapName };
                        state.markers[safeMapId][markerKey] = markerPayload;
                        actionResult.success = true;
                        actionResult.message = `Marker added on map ${safeMapId} at (${xInt}, ${yInt}): ${safeEmoji} ${safeLabel}`;
                        actionResult.details = "Marker stored.";
                        console.log(`INFO: Marker stored for map ${safeMapId} at ${markerKey}`);
                        if (actionResult.success) {
                            broadcast({ type: 'markers_update', payload: state.markers });
                        }
                        break;

                    case "write_memory":
                        if (individualAction.key && typeof individualAction.key === 'string' && typeof individualAction.value === 'string') {
                            const safeKey = sanitizeModelText(individualAction.key).slice(0, 200);
                            const safeValue = sanitizeModelText(individualAction.value);
                            state.memory[safeKey] = safeValue;
                            actionResult.success = true;
                            actionResult.message = `Information memorized: ${safeKey}`;
                            console.log(`INFO: Memorization: { ${safeKey}: \"${safeValue}\" }`);
                            if (actionResult.success) {
                                broadcast({ type: 'memory_update', payload: state.memory });
                            }
                        } else {
                            actionResult.message = "Error: 'key' or 'value' missing or not strings.";
                            actionResult.success = false;
                        }
                        break;

                    case "delete_memory":
                        if (individualAction.key && typeof individualAction.key === 'string') {
                            const safeKey = sanitizeModelText(individualAction.key).slice(0, 200);
                            if (state.memory.hasOwnProperty(safeKey)) {
                                delete state.memory[safeKey];
                                actionResult.success = true;
                                actionResult.message = `Memory deleted: ${safeKey}`;
                                broadcast({ type: 'memory_update', payload: state.memory });
                            } else {
                                actionResult.success = false;
                                actionResult.message = `Error: Key '${safeKey}' not found in state.memory.`;
                            }
                        } else {
                            actionResult.message = "Error: 'key' missing or not a string.";
                            actionResult.success = false;
                        }
                        break;
                    case "recall_reasoning_archive":
                        if (!config.isHeartGold) {
                            actionResult.success = false;
                            actionResult.message = "Error: recall_reasoning_archive is only available in the HeartGold profile.";
                            overallSuccess = false;
                            break;
                        }
                        {
                            const recall = recallPlayerReasoningArchive({
                                query: individualAction.query || "",
                                limit: individualAction.limit || 12,
                                offset: individualAction.offset || 0,
                                turnStart: individualAction.turn_start,
                                turnEnd: individualAction.turn_end,
                            });
                            actionResult.success = true;
                            actionResult.semantic_target_verified = true;
                            actionResult.semantic_outcome = "completed";
                            actionResult.visible_effect = true;
                            actionResult.response = { status: true, ok: true, inputDelivered: true };
                            actionResult.message = `Recalled ${recall.returned.length}/${recall.total_matched} archived reasoning record(s).`;
                            actionResult.details_for_ai = JSON.stringify({ recalled_reasoning_archive: recall.returned });
                        }
                        break;
                    case "update_objectives":
                        let updates = [];
                        let errorOccurred = false;
                        if (individualAction.hasOwnProperty('primary')) {
                            if (typeof individualAction.primary === 'object' && individualAction.primary.short_description && individualAction.primary.description) {
                                state.objectives.primary = sanitizeModelValue(individualAction.primary);
                                updates.push(`Primary set.`);
                            } else {
                                actionResult.message = "Error: 'primary' objective must be an object with a short_description and description.";
                                errorOccurred = true;
                            }
                        }
                        if (!errorOccurred && individualAction.hasOwnProperty('secondary')) {
                            if (typeof individualAction.secondary === 'object' && individualAction.secondary.short_description && individualAction.secondary.description) {
                                state.objectives.secondary = sanitizeModelValue(individualAction.secondary);
                                updates.push(`Secondary set.`);
                            } else {
                                actionResult.message = "Error: 'secondary' objective must be an object with a short_description and description.";
                                errorOccurred = true;
                            }
                        }

                        if (!errorOccurred && individualAction.hasOwnProperty('third')) {
                            if (typeof individualAction.third === 'object' && individualAction.third.short_description && individualAction.third.description) {
                                state.objectives.third = sanitizeModelValue(individualAction.third);
                                updates.push(`Third set.`);
                            } else {
                                actionResult.message = "Error: 'third' objective must be an object with a short_description and description.";
                                errorOccurred = true;
                            }
                        }
                        if (!errorOccurred && individualAction.hasOwnProperty('others')) {
                            if (Array.isArray(individualAction.others) && individualAction.others.every(item => typeof item === 'object' && item.short_description && item.description)) {
                                state.objectives.others = sanitizeModelValue(individualAction.others);
                                updates.push(`Others set.`);
                            } else {
                                actionResult.message = "Error: 'others' state.objectives must be an array of objects with a short_description and description.";
                                errorOccurred = true;
                            }
                        }

                        if (!errorOccurred) {
                            if (updates.length > 0) {
                                actionResult.success = true;
                                actionResult.message = "Objectives updated successfully.";
                                actionResult.details = updates.join(" ");
                                console.log(`INFO: Objectives updated. Details: ${actionResult.details}`);
                                broadcast({ type: 'objectives_update', payload: state.objectives });
                            } else {
                                actionResult.success = true;
                                actionResult.message = "No objective fields provided to update.";
                                actionResult.details = "No changes made.";
                            }
                        } else {
                            actionResult.success = false;
                        }
                        break;

                    case "delete_marker":
                        const { map_id: del_map_id, x: del_x, y: del_y } = individualAction;
                        const safeDelMapId = sanitizeModelText(String(del_map_id || ""));
                        const del_markerKey = `${del_x}_${del_y}`;
                        
                        // Check if the player is in a dialog, if so, don't delete the marker
                        if (gameDataJson.is_talking_to_npc) {
                            actionResult.success = false;
                            actionResult.message = "Error: Player is in a dialog, cannot delete a marker. Try again when the dialog is over.";
                            actionResult.details = "Marker not deleted.";
                            console.log(`INFO: Player is in a dialog, cannot delete a marker.`);
                            break;
                        }

                        if (config.isHeartGold) {
                            const navigation = heartGoldDecodedNavigationAllowed(gameDataJson);
                            if (!navigation.allowed) {
                                actionResult.success = false;
                                actionResult.message =
                                    "Error: Cannot delete coordinate marker because current map identity/position is not available.";
                                actionResult.details = "Marker not deleted.";
                                break;
                            }
                        }

                        if (state.markers[safeDelMapId] && state.markers[safeDelMapId][del_markerKey]) {
                            delete state.markers[safeDelMapId][del_markerKey];
                            if (Object.keys(state.markers[safeDelMapId]).length === 0) {
                                delete state.markers[safeDelMapId];
                            }
                            actionResult.success = true;
                            actionResult.message = `Marker deleted from map ${safeDelMapId} at (${del_x}, ${del_y})`;
                            actionResult.details = "Marker removed.";
                            console.log(`INFO: Marker deleted from map ${safeDelMapId} at ${del_markerKey}`);
                            broadcast({ type: 'markers_update', payload: state.markers });
                        } else {
                            actionResult.success = false;
                            actionResult.message = `Marker not found on map ${safeDelMapId} at (${del_x}, ${del_y})`;
                            actionResult.details = "No marker existed.";
                            console.log(`INFO: Attempted to delete non-existent marker at map ${safeDelMapId}, coords ${del_x}, ${del_y}`);
                        }
                        break;

                    case "path_to_location":
                        const { x: path_x, y: path_y, map_id: path_map_id, explanation: path_explanation } = individualAction;
                        let path = null;
                        let findPathError = null;
                        const maxRetries = 5;
                        console.log(`INFO: Finding path to (${path_x}, ${path_y}) on map ${path_map_id} with explanation: ${path_explanation}`);

                        if (config.isHeartGold) {
                            const navigation = heartGoldDecodedNavigationAllowed(gameDataJson);
                            if (!navigation.allowed) {
                                actionResult.success = false;
                                actionResult.message =
                                    "path_to_location disabled: current map identity/position is not available. Use screenshot-guided key_press/touch actions.";
                                actionResult.details = "Pathfinding was not attempted because navigation state is unavailable.";
                                overallSuccess = false;
                                break;
                            }
                            const pathfindingContract = gameDataJson?.ram_assisted?.pathfinding;
                            if (pathfindingContract?.available !== true) {
                                actionResult.success = false;
                                actionResult.message =
                                    `path_to_location disabled: ${pathfindingContract?.disabledReason || "ROM-derived static collision grid is not available"}. Use screenshot-guided key_press/touch actions until current map geometry is available.`;
                                actionResult.details = "Pathfinding was not attempted because HeartGold path_to_location requires current RAM position plus decoded static collision geometry.";
                                overallSuccess = false;
                                break;
                            }
                            if (!heartGoldDecodedCollisionAllowed(gameDataJson)) {
                                actionResult.success = false;
                                actionResult.message =
                                    "path_to_location disabled: ROM collision grid is not available. Use screenshot-guided key_press/touch actions until map geometry is available.";
                                actionResult.details = "Pathfinding was not attempted because HeartGold path_to_location requires decoded static collision geometry.";
                                overallSuccess = false;
                                break;
                            }
                        }



                        // Check if the path_to_location action was already executed this turn
                        if (pathfindingExecutedThisTurn) {
                            actionResult.success = false;
                            actionResult.message = "Error: 'path_to_location' action was already executed this turn. Only one 'path_to_location' action is allowed per turn.";
                            actionResult.details = "Skipping subsequent path_to_location actions.";
                            overallSuccess = false; // Mark overall success as false
                            break;
                        }

                        for (let attempt = 1; attempt <= maxRetries; attempt++) {
                            try {
                                console.log(`INFO: Attempt ${attempt}/${maxRetries} to find path to (${path_x}, ${path_y}) on map ${path_map_id}`);
                                path = await findPath(path_x, path_y, path_map_id, path_explanation);
                                console.log(`INFO: Path found on attempt ${attempt}: ${path.keys}`);
                                findPathError = null; // Clear error on success
                                break; // Exit loop if path found successfully
                            } catch (error) {
                                console.error(`ERROR: Attempt ${attempt} failed for findPath(${path_x}, ${path_y}):`, error.message);
                                findPathError = error; // Store the last error
                                // Check if the error message contains "Player is not on map"
                                if (error.message.includes("Player is not on map")) {
                                    console.error(`ERROR: Player is not on map ${path_map_id}.`);
                                    actionResult.success = false;
                                    actionResult.message = `Player is not on map ${path_map_id}.`;
                                    break;
                                }
                                if (attempt === maxRetries) {
                                    console.error(`ERROR: findPath failed after ${maxRetries} attempts.`);
                                } else {
                                    // Optional: Add a small delay before retrying
                                    // await new Promise(resolve => setTimeout(resolve, 500));
                                }
                            }
                        }

                        if (path && path.keys && (path.keys.length > 0 || path.atTarget === true)) {
                            pathfindingExecutedThisTurn = true;

                            const gameDataJson = await fetchGameData();
                            const pathPreflight = heartGoldPathPreflight(gameDataJson, path);
                            if (!pathPreflight.ok) {
                                actionResult.success = false;
                                actionResult.message = pathPreflight.message;
                                actionResult.details =
                                    "path_to_location does not auto-advance dialogue in HeartGold mode.";
                                overallSuccess = false;
                                break;
                            }

                            if (path.atTarget === true && path.keys.length === 0) {
                                actionResult.success = true;
                                actionResult.message = `Explanation: ${path.explanation} \nNo keys needed; already at target.`;
                                actionResult.details = "Pathfinding returned atTarget=true.";
                                break;
                            }
                            let finalKeysList = path.keys.map((key) => {
                                if (key && typeof key === "object" && !Array.isArray(key)) {
                                    return {
                                        ...key,
                                        target_x: path_x,
                                        target_y: path_y,
                                        target_map_id: path_map_id,
                                        target_label: path_explanation || "path_to_location target",
                                    };
                                }
                                return {
                                    type: "press",
                                    buttons: [key],
                                    frames: 8,
                                    target_x: path_x,
                                    target_y: path_y,
                                    target_map_id: path_map_id,
                                    target_label: path_explanation || "path_to_location target",
                                };
                            });
                            const response = await sendCommandsToPythonServer(finalKeysList);
                            actionResult.pythonResponse = response;
                            const reliability = config.isHeartGold ? heartGoldActionReliability(response) : { verified: Boolean(response.status), unreliable: false, reason: null };
                            const outcome = config.isHeartGold
                                ? heartGoldPathExecutionOutcome({ response, reliability, finalKeysList, path })
                                : {
                                    success: Boolean(response.status) && reliability.verified && !reliability.unreliable,
                                    message: Boolean(response.status) && reliability.verified && !reliability.unreliable
                                        ? `Path completed: executed ${finalKeysList.length}/${finalKeysList.length} generated key(s). Explanation: ${path.explanation} generated_key_count=${Array.isArray(path.keys) ? path.keys.length : 0}`
                                        : `Path execution was not verified by the bridge: ${reliability.reason || "Failed to send keys."}`,
                                };
                            actionResult.success = outcome.success;
                            actionResult.message = outcome.message;
                            const logs = summarizeTracePayloadMarkdown(response);
                            actionResult.details = `Keys execution result: ${logs || ""}`;
                        } else {
                            actionResult.success = false;
                            actionResult.message = findPathError
                                ? `Failed to find path to (${path_x}, ${path_y}) after ${maxRetries} attempts. Last error: ${findPathError.message}`
                                : `No path found or path was empty to (${path_x}, ${path_y}) \nExplanation: ${path.explanation}`;
                            actionResult.details = findPathError ? findPathError.stack : "Pathfinding logic returned empty path.";
                        }
                        break;
                    case "restart_console":
                        const restartResponse = await requestConsoleRestart();
                        actionResult.pythonResponse = restartResponse;
                        if (restartResponse?.status) {
                            actionResult.success = true;
                            actionResult.message = restartResponse.message || "Console restart requested successfully. Observe the next screen before sending any input.";
                            actionResult.details = restartResponse.details || "";
                        } else {
                            actionResult.success = false;
                            actionResult.message = restartResponse?.message || "Error: Failed to restart the console.";
                            actionResult.details = restartResponse?.details || "";
                            overallSuccess = false;
                        }
                        break;
                    default:
                        actionResult.success = false;
                        actionResult.message = `Error: Unknown action type '${individualAction.type}'.`;
                }
            } catch (actionError) {
                // Catch errors specific to executing this single action
                console.error(`Error executing action type ${individualAction.type}:`, actionError);
                actionResult.success = false;
                actionResult.message = `Execution error for ${individualAction.type}: ${actionError.message}`;
                actionResult.details = actionError.stack;
            }
            // --- End Action Execution Logic ---

            const actionSemantics = actionResultSemanticAttributes(actionResult);
            const semanticSuccess = heartGoldActionSemanticSuccess(actionResult, actionSemantics);
            const actionDetails = actionResult.details_for_ai != null ? actionResult.details_for_ai : actionResult.details;
            const safeActionMessage = sanitizeModelText(actionResult.message || "");
            const safeActionDetails = actionDetails ? sanitizeModelText(actionDetails) : "";
            const actionResultPayload = {
                call_id: actionCallId,
                action_type: individualAction.type,
                success: actionResult.success,
                raw_success: actionResult.raw_success === undefined ? actionResult.success === true : actionResult.raw_success === true,
                benchmark_verified: actionResult.benchmark_verified === undefined ? null : actionResult.benchmark_verified === true,
                input_delivered: actionSemantics.inputDelivered,
                visible_effect: actionSemantics.visibleEffect,
                semantic_target_verified: actionSemantics.semanticTargetVerified,
                semantic_outcome: actionSemantics.semanticOutcome,
                semantic_success: semanticSuccess,
                message: safeActionMessage,
                details: safeActionDetails,
                ...actionTraceForBroadcast(individualAction.type, actionResult.pythonResponse || null),
            };
            broadcast({ type: 'action_executed', payload: actionResultPayload });
            const rawSuccessForLog = actionResult.raw_success === undefined ? actionResult.success === true : actionResult.raw_success === true;
            console.log(`<--- Action ${i + 1}/${args.actions.length} End: ${individualAction.type} (Sub-ID: ${actionCallId}) - Raw Success: ${rawSuccessForLog}; Semantic Success: ${semanticSuccess}; Outcome: ${actionSemantics.semanticOutcome || "unknown"} ---`);


            // Store the result and update overall success
            allActionResults.push(actionResult);
            metricActionResults.push({
                action_type: individualAction.type,
                success: actionResult.success,
                raw_success: actionResult.raw_success === undefined ? actionResult.success === true : actionResult.raw_success === true,
                benchmark_verified: actionResult.benchmark_verified === undefined ? null : actionResult.benchmark_verified === true,
                semantic_success: semanticSuccess,
                semantic_outcome: actionSemantics.semanticOutcome,
                semantic_target_verified: actionSemantics.semanticTargetVerified,
                input_delivered: actionSemantics.inputDelivered,
                visible_effect: actionSemantics.visibleEffect,
                message: safeActionMessage,
                details: safeActionDetails,
                response: actionResult.pythonResponse || null,
            });
            if (!actionResult.success) {
                overallSuccess = false;
                const skippedCount = Math.max(0, args.actions.length - i - 1);
                if (config.isHeartGold && skippedCount > 0) {
                    console.warn(`Action ${i + 1} (${individualAction.type}) failed at the raw bridge layer. Skipping ${skippedCount} remaining HeartGold action(s).`);
                    for (let j = i + 1; j < args.actions.length; j++) {
                        const skippedAction = args.actions[j];
                        const skippedResult = {
                            action_type: skippedAction.type,
                            success: false,
                            skipped: true,
                            message: "Skipped because an earlier HeartGold action failed at the raw bridge layer.",
                            details: "",
                        };
                        allActionResults.push(skippedResult);
                        metricActionResults.push(skippedResult);
                    }
                    break;
                }
                console.warn(`Action ${i + 1} (${individualAction.type}) failed. Subsequent actions in this step will still be attempted.`);
            }
        }

    } catch (error) {
        // Catch errors from JSON parsing or initial validation before the loop
        overallSuccess = false;
        const errorMessage = `Tool call processing error (pre-execution): ${error.message}`;
        console.error(errorMessage, error);
        recordHarnessFailure("tool_error", errorMessage, { stack: error.stack });
        broadcast({ type: 'error_message', payload: errorMessage });
        // Add a placeholder result if no actions were even attempted
        if (allActionResults.length === 0) {
            allActionResults.push({
                action_type: 'setup_error',
                success: false,
                message: errorMessage,
                details: error.stack
            });
        }
    } finally {
        const durationMs = Date.now() - toolBatchStart;
        recordToolBatch({ callId: call_id, durationMs });
        recordActionBatch({
            callId: call_id,
            step: state.counters.currentStep,
            actions: args?.actions || [],
            results: metricActionResults,
            durationMs,
            normalizedActionSchemaCount,
            stepDetails: args?.step_details || "",
            chatMessage: args?.chat_message || "",
        });
    }

    console.log(`<--- Tool Call End: ${name} (ID: ${call_id}) - Action Batch Success: ${overallSuccess} ---`);

    // Summarize the full action batch for the OpenAI history entry.
    const output = allActionResults
        .map((res) => {
            const details = res.details_for_ai != null ? res.details_for_ai : res.details;
            const safeMessage = sanitizeModelText(res.message || "");
            const safeDetails = details ? sanitizeModelText(details) : "";
            const semantic = actionResultSemanticAttributes(res);
            const semanticSuccess = heartGoldActionSemanticSuccess(res, semantic);
            const rawSuccess = res.raw_success === undefined ? res.success === true : res.raw_success === true;
            return `
    <action_result type="${xmlAttr(res.action_type)}" semantic_success="${semanticSuccess ? "true" : "false"}" raw_success="${rawSuccess ? "true" : "false"}" input_delivered="${booleanAttr(semantic.inputDelivered)}" visible_effect="${booleanAttr(semantic.visibleEffect)}" semantic_target_verified="${booleanAttr(semantic.semanticTargetVerified)}" semantic_outcome="${xmlAttr(semantic.semanticOutcome)}">
      <message>${xmlEscape(safeMessage)}</message>
      ${safeDetails ? `<details>${xmlEscape(safeDetails)}</details>` : ""}
    </action_result>
    `.trim();
        })
        .join("\n");

    // Return the formatted result for the OpenAI history
    return {
        type: "function_call_output",
        call_id: call_id, // Use the original call_id here too
        output: [{ type: "input_text", text: output.trim() }],
    };
}

async function findPath(x, y, map_id, explanation) {
    const gameDataJson = await fetchGameData();
    if (!config.isHeartGold) {
        throw new Error("Pathfinding is available only for the HeartGold harness.");
    }
    return findHeartGoldPath(gameDataJson, x, y, map_id, explanation);
}

/**
 * Updates progress steps based on current game state
 * @param {object} gameDataJson - The current game data
 */

module.exports = {
    defineTools,
    handleToolCall,
    findPath,
    _private: {
        summarizeTracePayloadMarkdown,
        actionResultSemanticAttributes,
        heartGoldActionSemanticSuccess,
        actionTraceSummaryForBroadcast,
        heartGoldActionReliability,
        touchResultMessage,
        heartGoldPathExecutionOutcome,
        heartGoldPathPreflight,
        heartGoldButtonSequenceOutcome,
        heartGoldDialogAdvanceOutcome,
    },
};
