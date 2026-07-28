"use strict";

/**
 * Shared turn-artifact selection: mode-switch / "Jarvis Mode" progress artifacts
 * must not clobber substantive tool artifacts (briefings, lists, charts, etc.).
 */

function isModeSwitchArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") return false;
  const title = String(artifact.title || "");
  const content = String(artifact.content || "");
  if (title === "Jarvis Mode") return true;
  if (artifact.kind === "progress" && /^Mode switched to\b/.test(content)) return true;
  return false;
}

/**
 * Prefer substantive artifacts from a turn. If none exist, keep the original list
 * (so a mode-only turn can still show the generic mode artifact).
 * @param {Array<{ title?: string, kind?: string, content?: string }|null|undefined>} artifacts
 */
function selectTurnArtifacts(artifacts) {
  const list = (Array.isArray(artifacts) ? artifacts : []).filter(Boolean);
  const substantive = list.filter((item) => !isModeSwitchArtifact(item));
  return substantive.length > 0 ? substantive : list;
}

/**
 * Pick the single artifact that should win for display (last after selection).
 */
function pickWinningTurnArtifact(artifacts) {
  const selected = selectTurnArtifacts(artifacts);
  if (!selected.length) return null;
  return selected[selected.length - 1];
}

/**
 * Centralized text-turn artifact delivery metadata for main → renderer.
 * @param {Array<object|null|undefined>} artifacts
 * @param {Array<{ name?: string }|null|undefined>} toolTrace
 */
function buildTurnArtifactDelivery(artifacts, toolTrace) {
  const list = (Array.isArray(artifacts) ? artifacts : []).filter(Boolean);
  const selected = selectTurnArtifacts(list);
  const substantive = list.filter((item) => !isModeSwitchArtifact(item));
  const toolNames = (Array.isArray(toolTrace) ? toolTrace : [])
    .map((item) => String(item?.name || "").trim())
    .filter(Boolean);
  const selectedArtifact = selected.length ? selected[selected.length - 1] : null;
  return {
    artifacts: selected,
    toolNames,
    artifactCount: selected.length,
    selectedArtifact,
    hasSubstantiveArtifact: substantive.length > 0,
  };
}

module.exports = {
  isModeSwitchArtifact,
  selectTurnArtifacts,
  pickWinningTurnArtifact,
  buildTurnArtifactDelivery,
};
