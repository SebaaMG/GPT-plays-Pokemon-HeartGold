const path = require("path");

const dictionary = require(path.join(
  __dirname,
  "..",
  "..",
  "..",
  "heartgold_benchmark",
  "ram_auditor",
  "dictionary",
  "model_visible_surfaces.json"
));

function canonicalSurfaceName(field) {
  const key = String(field || "").trim();
  return dictionary.aliases?.[key] || key;
}

function surfacePolicy(field) {
  return dictionary.surfaces?.[canonicalSurfaceName(field)] || null;
}

function stringList(value) {
  return Array.isArray(value) ? value.map(String).filter((item) => item.trim().length > 0) : [];
}

function allowedContractsForField(field) {
  return new Set(stringList(surfacePolicy(field)?.allowed_contracts));
}

function allowedDecoderContractsForField(field) {
  return new Set(stringList(surfacePolicy(field)?.allowed_decoder_contracts));
}

function contractsForObservationField(field) {
  return allowedContractsForField(field);
}

function requiredModelVisibleSurfaces(sourceDictionary = dictionary) {
  const configured = stringList(sourceDictionary?.required_model_visible_surfaces);
  if (configured.length > 0) return configured;
  return Object.entries(sourceDictionary?.surfaces || {})
    .filter(([, policy]) => policy?.model_visible !== false && policy?.monitor_only !== true)
    .map(([name]) => name);
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

function stringMatchesPattern(pattern, value) {
  try {
    return new RegExp(String(pattern.pattern || ""), String(pattern.flags || "")).test(String(value ?? ""));
  } catch {
    return false;
  }
}

function forbiddenPatternFailures(value, patterns, defaultReason) {
  const failures = [];
  const seen = new Set();
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    if (!pattern || typeof pattern !== "object") continue;
    const reason = String(pattern.reason || defaultReason);
    if (!seen.has(reason) && stringMatchesPattern(pattern, value)) {
      seen.add(reason);
      failures.push({ reason });
    }
  }
  return failures;
}

function stringHasForbiddenMarker(value) {
  const text = lower(value);
  return stringList(dictionary.global_forbidden_markers).some((marker) => text.includes(lower(marker)));
}

function fieldPolicyForPath(pathParts) {
  for (let index = pathParts.length - 1; index >= 0; index -= 1) {
    const policy = surfacePolicy(pathParts[index]);
    if (policy) return policy;
  }
  return null;
}

function auditValue(value, pathParts = [], failures = []) {
  if (pathParts[0] === "decoded_ram") return failures;

  const policy = fieldPolicyForPath(pathParts);
  const forbiddenKeys = new Set([
    ...stringList(dictionary.global_forbidden_player_visible_keys),
    ...stringList(policy?.forbidden_keys),
  ].map(lower));
  const globalPatterns = dictionary.global_forbidden_player_visible_patterns || [];
  const valuePatterns = [
    ...(dictionary.global_forbidden_model_visible_value_patterns || []),
    ...(Array.isArray(policy?.forbidden_value_patterns) ? policy.forbidden_value_patterns : []),
  ];

  if (typeof value === "string") {
    if (stringHasForbiddenMarker(value)) {
      failures.push({ path: pathParts.join("."), reason: "monitor_only_marker_visible" });
    }
    for (const failure of forbiddenPatternFailures(value, globalPatterns, "player_visible_forbidden_pattern")) {
      failures.push({ path: pathParts.join("."), ...failure });
    }
    for (const failure of forbiddenPatternFailures(value, valuePatterns, "player_visible_forbidden_value_pattern")) {
      failures.push({ path: pathParts.join("."), ...failure });
    }
    return failures;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => auditValue(item, [...pathParts, String(index)], failures));
    return failures;
  }

  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...pathParts, key];
      if (forbiddenKeys.has(lower(key))) {
        failures.push({ path: childPath.join("."), reason: "monitor_only_key_visible", key });
        continue;
      }
      auditValue(child, childPath, failures);
    }
  }

  return failures;
}

function auditPlayerVisiblePayload(payload) {
  const failures = auditValue(payload);
  return {
    schema: "heartgold_player_visible_payload_audit_v2",
    result: failures.length === 0 ? "pass" : "fail",
    failures,
  };
}

function applyManifestEntryGate(entry) {
  if (!isPlainObject(entry)) return entry;

  const field = canonicalSurfaceName(entry.field || entry.surface);
  const out = { ...entry, field };
  const hide = (reason) => ({
    ...out,
    visible: false,
    value: null,
    value_hash: null,
    unavailable_reason: out.unavailable_reason || reason,
  });

  const policy = surfacePolicy(field);
  if (!field || !policy) return hide("surface_policy_missing");
  if (policy.monitor_only === true || policy.model_visible === false) {
    return hide("surface_not_model_visible");
  }

  const contract = String(out.contract || "");
  const allowedContracts = allowedContractsForField(field);
  if (out.visible === true && contract && allowedContracts.size > 0 && !allowedContracts.has(contract)) {
    return hide("contract_not_allowed");
  }

  const source = lower(out.source);
  const forbiddenSources = stringList(policy.forbidden_sources).map(lower);
  if (out.visible === true && source && forbiddenSources.some((forbidden) => source.includes(forbidden))) {
    return hide("source_not_allowed");
  }

  if (out.visible === true && auditValue(out.value, [field]).length > 0) {
    return hide("value_audit_failed");
  }

  return out;
}

function auditManifestEntry(entry) {
  const failures = [];
  if (!isPlainObject(entry)) {
    failures.push({ reason: "manifest_entry_not_object" });
  } else {
    const field = canonicalSurfaceName(entry.field || entry.surface);
    const visible = entry.visible === true;
    const policy = surfacePolicy(field);
    if (!field || !policy) {
      if (visible) failures.push({ field, reason: "surface_policy_missing" });
      return {
        schema: "heartgold_manifest_entry_audit_v2",
        result: failures.length === 0 ? "pass" : "fail",
        failures,
      };
    }
    const contract = String(entry.contract || "");
    const allowed = allowedContractsForField(field);
    if (visible && contract && allowed.size > 0 && !allowed.has(contract)) {
      failures.push({ field, reason: "contract_not_allowed", contract });
    }
    if (visible) {
      for (const failure of auditValue(entry.value, [field || "manifest_value"])) {
        failures.push({ field, ...failure });
      }
    }
  }
  return {
    schema: "heartgold_manifest_entry_audit_v2",
    result: failures.length === 0 ? "pass" : "fail",
    failures,
  };
}

function auditModelVisibleManifest(manifest) {
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : Array.isArray(manifest) ? manifest : [];
  const failures = [];
  for (const entry of entries) {
    failures.push(...auditManifestEntry(entry).failures);
  }
  return {
    schema: "heartgold_model_visible_manifest_audit_v2",
    result: failures.length === 0 ? "pass" : "fail",
    failures,
  };
}

function auditObservationArtifact(artifact) {
  const failures = [];
  if (!isPlainObject(artifact)) {
    return {
      schema: "heartgold_observation_artifact_audit_v2",
      result: "fail",
      failures: [{ reason: "artifact_not_object" }],
    };
  }

  if (artifact.model_input) {
    failures.push(...auditPlayerVisiblePayload(artifact.model_input).failures);
  }
  if (artifact.model_visible_manifest) {
    failures.push(...auditModelVisibleManifest(artifact.model_visible_manifest).failures);
  }

  return {
    schema: "heartgold_observation_artifact_audit_v2",
    result: failures.length === 0 ? "pass" : "fail",
    failures,
  };
}

function auditActionArtifact(artifact) {
  const failures = [];
  if (!isPlainObject(artifact)) {
    return {
      schema: "heartgold_action_artifact_audit_v2",
      result: "fail",
      failures: [{ reason: "artifact_not_object" }],
    };
  }

  if (artifact.artifact_kind && artifact.artifact_kind !== "action") {
    failures.push({ reason: "action_artifact_kind_missing_or_wrong" });
  }
  if (artifact.request) {
    failures.push(...auditPlayerVisiblePayload(artifact.request).failures);
  }
  if (artifact.result) {
    failures.push(...auditPlayerVisiblePayload(artifact.result).failures);
  }

  return {
    schema: "heartgold_action_artifact_audit_v2",
    result: failures.length === 0 ? "pass" : "fail",
    failures,
  };
}

function auditArtifact(artifact) {
  if (artifact?.artifact_kind === "action") return { artifactType: "action", ...auditActionArtifact(artifact) };
  return { artifactType: "observation", ...auditObservationArtifact(artifact) };
}

function auditArtifactCollection(items) {
  const entries = Array.isArray(items) ? items : [];
  const failures = [];
  for (const [index, artifact] of entries.entries()) {
    const audit = auditArtifact(artifact);
    for (const failure of audit.failures || []) {
      failures.push({ index, ...failure });
    }
  }
  return {
    schema: "heartgold_artifact_collection_audit_v2",
    result: failures.length === 0 ? "pass" : "fail",
    artifactCount: entries.length,
    failures,
  };
}

function auditDictionaryCoverage(sourceDictionary = dictionary) {
  const surfaces = sourceDictionary?.surfaces || {};
  const failures = [];
  for (const surface of requiredModelVisibleSurfaces(sourceDictionary)) {
    const policy = surfaces[surface];
    if (!policy) {
      failures.push({ surface, reason: "surface_policy_missing" });
    } else if (policy.monitor_only === true || policy.model_visible === false) {
      failures.push({ surface, reason: "surface_not_in_current_observation" });
    }
  }
  return {
    schema: "heartgold_dictionary_coverage_audit_v2",
    result: failures.length === 0 ? "pass" : "fail",
    requiredModelVisibleSurfaces: requiredModelVisibleSurfaces(sourceDictionary),
    failures,
  };
}

module.exports = {
  allowedContractsForField,
  allowedDecoderContractsForField,
  applyManifestEntryGate,
  auditActionArtifact,
  auditArtifact,
  auditArtifactCollection,
  auditDictionaryCoverage,
  auditManifestEntry,
  auditModelVisibleManifest,
  auditObservationArtifact,
  auditPlayerVisiblePayload,
  canonicalSurfaceName,
  contractsForObservationField,
  dictionary,
  requiredModelVisibleSurfaces,
  stringHasForbiddenMarker,
  surfacePolicy,
};
