/**
 * missionPack.js
 *
 * Loads a "TQ-log mission pack" — a folder decoded from a retail (Tranquility) client log that is the
 * ground-truth source for a mission. A pack contains:
 *   - manifest.json   provenance (packID, observed mission/dungeon IDs, source log)
 *   - dungeon.json    an EveJS dungeon-authority template (siteSceneProfile + populationHints): the
 *                     thing EveJS actually consumes. This is already in EveJS shape, so applying a pack
 *                     is mostly plumbing — see scripts/pack-apply.js.
 *   - mission.json    (optional) the agent mission record (missionID, killMission.dungeonID, ...)
 *   - nodegraph.json  (optional) the server objective flow (accepted -> site.entered -> ... -> turnIn)
 *   - timeline.json   (optional) observed event timeline (AddBalls2 / objective events) for validation
 *
 * The decoded template carries richer data than the eve-survival scrape: per-NPC spawnEntries with
 * typeID/position/AI, trigger families (proximity/gate/on_load/wave_cleared), objective mode, and the
 * environment props. EveJS now reads these (with fallbacks); this loader is the Utility side.
 */

const fs = require("fs");
const path = require("path");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonIfExists(file) {
  return fs.existsSync(file) ? readJson(file) : null;
}

// Throws with a readable list of problems if the decoded template is not a usable EveJS template.
function validateDungeonTemplate(dungeon) {
  const errors = [];
  if (!dungeon || typeof dungeon !== "object") {
    errors.push("dungeon.json is not an object");
  } else {
    if (!dungeon.templateID) errors.push("dungeon.templateID is missing");
    if (!dungeon.siteFamily) errors.push("dungeon.siteFamily is missing");
    if (!dungeon.populationHints || typeof dungeon.populationHints !== "object") {
      errors.push("dungeon.populationHints is missing");
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid mission pack dungeon template:\n  - ${errors.join("\n  - ")}`);
  }
  return dungeon;
}

function loadMissionPack(dir) {
  const resolvedDir = path.resolve(dir);
  if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
    throw new Error(`Mission pack folder not found: ${resolvedDir}`);
  }
  const dungeonPath = path.join(resolvedDir, "dungeon.json");
  if (!fs.existsSync(dungeonPath)) {
    throw new Error(`Mission pack is missing dungeon.json: ${resolvedDir}`);
  }
  const dungeon = validateDungeonTemplate(readJson(dungeonPath));
  return {
    dir: resolvedDir,
    manifest: readJsonIfExists(path.join(resolvedDir, "manifest.json")) || {},
    dungeon,
    mission: readJsonIfExists(path.join(resolvedDir, "mission.json")),
    nodegraph: readJsonIfExists(path.join(resolvedDir, "nodegraph.json")),
    timeline: readJsonIfExists(path.join(resolvedDir, "timeline.json")),
  };
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// The flags needed to play this pack's mission in-client via the temp force hooks. Derived from the
// pack so the user doesn't have to hand-assemble them: template id, mission id, client dungeon id.
function resolveForceFlags(pack) {
  const templateID = pack.dungeon.templateID;
  const missionID =
    toInt(pack.mission && pack.mission.missionID, 0) ||
    toInt(pack.manifest && pack.manifest.observedMissionID, 0) ||
    null;
  const dungeonID =
    toInt(pack.mission && pack.mission.killMission && pack.mission.killMission.dungeonID, 0) ||
    toInt(pack.manifest && pack.manifest.observedDungeonID, 0) ||
    toInt(pack.dungeon && pack.dungeon.sourceDungeonID, 0) ||
    null;
  return { templateID, missionID, dungeonID };
}

function summarizeMissionPack(pack) {
  const populationHints = pack.dungeon.populationHints || {};
  const encounters = Array.isArray(populationHints.encounters) ? populationHints.encounters : [];
  const triggers = {};
  let explicitSpawnEntries = 0;
  for (const encounter of encounters) {
    const trigger = (encounter && encounter.trigger) || "on_load";
    triggers[trigger] = (triggers[trigger] || 0) + 1;
    if (Array.isArray(encounter && encounter.spawnEntries)) {
      explicitSpawnEntries += encounter.spawnEntries.length;
    }
  }
  const gateProfiles =
    (pack.dungeon.siteSceneProfile && pack.dungeon.siteSceneProfile.gateProfiles) || [];
  return {
    ...resolveForceFlags(pack),
    title: pack.dungeon.title || pack.dungeon.templateID,
    siteFamily: pack.dungeon.siteFamily,
    siteKind: pack.dungeon.siteKind || null,
    objectiveMode: populationHints.objectiveMode || null,
    encounterCount: encounters.length,
    explicitSpawnEntries,
    triggers,
    gateCount: Array.isArray(gateProfiles) ? gateProfiles.length : 0,
    environmentPropCount: Array.isArray(populationHints.environmentProps)
      ? populationHints.environmentProps.length
      : 0,
    nodeGraphNodes: pack.nodegraph && pack.nodegraph.nodesByID
      ? Object.keys(pack.nodegraph.nodesByID).length
      : 0,
    sourceLog: (pack.manifest && pack.manifest.source && pack.manifest.source.log) || null,
  };
}

module.exports = {
  loadMissionPack,
  validateDungeonTemplate,
  resolveForceFlags,
  summarizeMissionPack,
};
