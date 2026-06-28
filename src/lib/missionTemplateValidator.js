/**
 * missionTemplateValidator.js
 *
 * Pre-apply validation (Plan E1): check a dungeon-authority template against the mechanics EveJS
 * actually supports, so authored/scraped missions don't ship triggers/objectives that silently never
 * fire. Returns { errors, warnings }. Errors mean the template is structurally unusable; warnings mean
 * it will load but a mechanic may not behave (EveJS falls back). Callers warn, they don't hard-block.
 */

// Encounter triggers EveJS honors (dungeonUniverseSiteService). Anything else falls back to on_load
// at resolve time / is not processed by the tick.
const SUPPORTED_TRIGGERS = new Set([
  "on_load",
  "on_room_active",
  "proximity",
  "wave_cleared",
  "timer",
  "visible_countdown",
  "battleships_destroyed",
]);

function text(value) {
  return String(value == null ? "" : value).trim();
}

function encounterHasSpawnIdentity(encounter) {
  if (!encounter || typeof encounter !== "object") return false;
  if (text(encounter.spawnQuery) || text(encounter.baseProfileID) || text(encounter.profileID)) return true;
  return Array.isArray(encounter.spawnEntries) && encounter.spawnEntries.length > 0;
}

function validateMissionTemplate(template) {
  const errors = [];
  const warnings = [];
  if (!template || typeof template !== "object") {
    return { errors: ["template is not an object"], warnings };
  }
  if (!text(template.templateID)) errors.push("templateID is missing");
  if (!text(template.siteFamily)) warnings.push("siteFamily is missing");

  const populationHints = template.populationHints;
  if (!populationHints || typeof populationHints !== "object") {
    errors.push("populationHints is missing");
    return { errors, warnings };
  }

  const encounters = Array.isArray(populationHints.encounters) ? populationHints.encounters : [];
  const gateProfiles =
    (template.siteSceneProfile && Array.isArray(template.siteSceneProfile.gateProfiles)
      ? template.siteSceneProfile.gateProfiles
      : []);
  const gateDestinations = new Set(
    gateProfiles.map((gate) => text(gate && gate.destinationRoomKey)).filter(Boolean),
  );

  encounters.forEach((encounter, index) => {
    const key = text(encounter && encounter.key) || `encounter[${index}]`;
    const trigger = text(encounter && encounter.trigger) || "on_load";
    if (!SUPPORTED_TRIGGERS.has(trigger)) {
      warnings.push(`${key}: unsupported trigger "${trigger}" (EveJS treats unknown triggers as on_load).`);
    }
    if (!encounterHasSpawnIdentity(encounter)) {
      warnings.push(`${key}: no spawnQuery/baseProfileID/spawnEntries -> dropped at resolve time.`);
    }
    if (trigger === "proximity" && !text(encounter && encounter.proximityTargetKey)) {
      warnings.push(`${key}: proximity trigger without proximityTargetKey -> falls back to the site center.`);
    }
    if (trigger === "on_room_active") {
      if (gateDestinations.size === 0) {
        warnings.push(`${key}: on_room_active but the template has no acceleration gate -> it will not fire.`);
      } else {
        const roomKey = text(encounter && encounter.roomKey);
        if (roomKey && !gateDestinations.has(roomKey)) {
          warnings.push(`${key}: on_room_active roomKey "${roomKey}" is not a gate destination -> may not fire.`);
        }
      }
    }
  });

  const miningRocks = Array.isArray(populationHints.miningRocks) ? populationHints.miningRocks : [];
  const objectiveQuantity = Number(populationHints.objectiveQuantity) || 0;
  miningRocks.forEach((rock, index) => {
    if (!(rock && (rock.typeID || rock.oreTypeID || rock.objectiveTypeID))) {
      warnings.push(`miningRocks[${index}]: no ore typeID/oreTypeID/objectiveTypeID.`);
    }
  });
  if (miningRocks.length > 0 && objectiveQuantity <= 0) {
    warnings.push("miningRocks present but objectiveQuantity is 0 -> the mining objective never completes.");
  }
  if (objectiveQuantity > 0 && miningRocks.length === 0) {
    warnings.push("objectiveQuantity set but no miningRocks -> nothing to mine.");
  }

  const objectiveMode = text(populationHints.objectiveMode);
  if (objectiveMode && encounters.length === 0 && miningRocks.length === 0) {
    warnings.push(`objectiveMode "${objectiveMode}" but no encounters or mining rocks -> may never complete.`);
  }

  return { errors, warnings };
}

module.exports = { validateMissionTemplate, SUPPORTED_TRIGGERS };
