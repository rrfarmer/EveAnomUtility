const {
  getCatalog,
  resolveNames,
} = require("./catalog");

const CONTENT_KINDS = new Set([
  "combat_anomaly",
  "ore_anomaly",
  "mission_combat",
  "combat_signature",
  "resource_signature",
  "hacking_signature",
  "wormhole_signature",
  "special_signature",
  "static_world",
  "npc_presence",
]);
const CONTENT_FAMILIES = new Set([
  "combat",
  "resource",
  "hacking",
  "mission",
  "wormhole",
  "special",
  "static_world",
  "npc_presence",
]);
const DELIVERY_MODES = new Set([
  "anomaly",
  "signature",
  "mission_private",
  "static_beacon",
  "startup_rule",
  "runtime_response",
  "escalation",
]);
const MISSION_TYPES = new Set(["combat", "courier", "mining", "trade", "talk_to_agent", "agent_interaction", "other"]);
const ANCHOR_KINDS = new Set(["system", "stargate", "station", "celestial", "coordinate"]);
const SPAWN_SCOPE_MODES = new Set(["any_eligible", "security_bands", "specific_system", "specific_stargate"]);
const SECURITY_BANDS = new Set(["highsec", "lowsec", "nullsec", "wormhole"]);
const FORBIDDEN_KEYS = new Set([
  "typeDogma",
  "dogmaAttributes",
  "shipDogmaAttributes",
  "shipAttributes",
  "typeDefinition",
  "clientPatch",
  "clientDataPatch",
  "newTypeID",
  "newShipTypeID",
]);

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function text(value) {
  return String(value || "").trim();
}

function contentFamilyFromKind(kind) {
  if (kind === "combat_anomaly" || kind === "combat_signature") return "combat";
  if (kind === "ore_anomaly" || kind === "resource_signature") return "resource";
  if (kind === "mission_combat") return "mission";
  if (kind === "hacking_signature") return "hacking";
  if (kind === "wormhole_signature") return "wormhole";
  if (kind === "special_signature") return "special";
  if (kind === "static_world") return "static_world";
  if (kind === "npc_presence") return "npc_presence";
  return "";
}

function deliveryFromKind(kind) {
  if (kind === "combat_anomaly" || kind === "ore_anomaly") return "anomaly";
  if (kind === "mission_combat") return "mission_private";
  if (kind === "static_world") return "static_beacon";
  if (kind === "npc_presence") return "startup_rule";
  if (kind.endsWith("_signature")) return "signature";
  return "";
}

function expectedScannerVisibility(delivery) {
  return {
    anomaly: "anomaly",
    signature: "signature",
    mission_private: "private_mission",
    static_beacon: "static",
    startup_rule: "startup_rule",
    runtime_response: "runtime_response",
    escalation: "escalation",
  }[delivery] || "";
}

function walkForbiddenKeys(value, path = "$", findings = []) {
  if (!value || typeof value !== "object") {
    return findings;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_KEYS.has(key)) {
      findings.push({
        level: "error",
        path: childPath,
        message: `Forbidden client/SDE-owned edit key: ${key}`,
      });
    }
    walkForbiddenKeys(child, childPath, findings);
  }
  return findings;
}

function validateOverlay(input = {}) {
  const catalog = getCatalog();
  const findings = walkForbiddenKeys(input);
  const kind = text(input.kind);
  const contentFamily = text(input.contentFamily) || contentFamilyFromKind(kind);
  const delivery = text(input.delivery) || deliveryFromKind(kind);

  if (kind && !CONTENT_KINDS.has(kind)) {
    findings.push({
      level: "error",
      path: "$.kind",
      message: "Content kind is not recognized by the authoring utility.",
    });
  }

  if (!CONTENT_FAMILIES.has(contentFamily)) {
    findings.push({
      level: "error",
      path: "$.contentFamily",
      message: "Select a valid content family.",
    });
  }

  if (!DELIVERY_MODES.has(delivery)) {
    findings.push({
      level: "error",
      path: "$.delivery",
      message: "Select a valid delivery mode.",
    });
  }

  const missionType = text(input.missionType || input.mission && input.mission.type);
  if (contentFamily === "mission" && missionType && !MISSION_TYPES.has(missionType)) {
    findings.push({
      level: "error",
      path: "$.missionType",
      message: "Mission category must be combat, courier, mining, trade, talk_to_agent, agent_interaction, or other.",
    });
  }

  const templateID = text(input.templateID) || text(input.baseTemplateID);
  if (!templateID) {
    findings.push({
      level: "error",
      path: "$.templateID",
      message: "Choose an existing template ID or enter a new custom template ID.",
    });
  }

  if (!text(input.title)) {
    findings.push({
      level: "error",
      path: "$.title",
      message: "A user-facing title is required.",
    });
  }

  const spawnScope = input.spawnScope && typeof input.spawnScope === "object" ? input.spawnScope : {};
  const placement = input.placement && typeof input.placement === "object" ? input.placement : {};
  const scopeMode = text(spawnScope.mode || (input.solarSystemID ? "specific_system" : "any_eligible"));
  if (!SPAWN_SCOPE_MODES.has(scopeMode)) {
    findings.push({
      level: "error",
      path: "$.spawnScope.mode",
      message: "Spawn scope must be any eligible system, security bands, specific system, or specific stargate.",
    });
  }
  const securityBands = Array.isArray(spawnScope.securityBands) ? spawnScope.securityBands : [];
  if ((scopeMode === "any_eligible" || scopeMode === "security_bands") && securityBands.length === 0) {
    findings.push({
      level: "error",
      path: "$.spawnScope.securityBands",
      message: "At least one security band is required for generic spawn rules.",
    });
  }
  securityBands.forEach((band, index) => {
    if (!SECURITY_BANDS.has(text(band))) {
      findings.push({
        level: "error",
        path: `$.spawnScope.securityBands[${index}]`,
        message: "Security band must be highsec, lowsec, nullsec, or wormhole.",
      });
    }
  });
  const maxConcurrentPerSystem = toInt(spawnScope.maxConcurrentPerSystem, 1);
  if (maxConcurrentPerSystem < 1 || maxConcurrentPerSystem > 100) {
    findings.push({
      level: "error",
      path: "$.spawnScope.maxConcurrentPerSystem",
      message: "Max per system must be between 1 and 100.",
    });
  }
  const slotCount = toInt(spawnScope.slotCount, 1);
  if (slotCount < 1 || slotCount > 1000) {
    findings.push({
      level: "error",
      path: "$.spawnScope.slotCount",
      message: "Slot count must be between 1 and 1000.",
    });
  }

  const gateID = toInt(placement.anchorID || spawnScope.stargateID, 0);
  const stargate = catalog.stargatesByID.get(gateID);
  const systemID = toInt(
    spawnScope.solarSystemID || input.solarSystemID || stargate && stargate.solarSystemID,
    0,
  );
  const needsSpecificSystem =
    scopeMode === "specific_system" ||
    scopeMode === "specific_stargate";
  if (needsSpecificSystem && (!systemID || !catalog.systemsByID.has(systemID))) {
    findings.push({
      level: "error",
      path: "$.spawnScope.solarSystemID",
      message: "This spawn scope requires a valid solar system from EveJS static data.",
    });
  } else if (systemID && !catalog.systemsByID.has(systemID)) {
    findings.push({
      level: "error",
      path: "$.spawnScope.solarSystemID",
      message: "Solar system ID does not exist in EveJS static data.",
    });
  }

  const baseTemplateID = text(input.baseTemplateID);
  if (baseTemplateID && !catalog.templatesByID.has(baseTemplateID)) {
    findings.push({
      level: "warning",
      path: "$.baseTemplateID",
      message: "Base template is not in the active EveJS catalog; this overlay will be standalone.",
    });
  }

  const anchorKind = text(placement.anchorKind || placement.kind || "system");
  if (!ANCHOR_KINDS.has(anchorKind)) {
    findings.push({
      level: "error",
      path: "$.placement.anchorKind",
      message: "Placement anchor must be system, stargate, station, celestial, or coordinate.",
    });
  }

  if (anchorKind === "stargate" || scopeMode === "specific_stargate") {
    if (scopeMode === "specific_stargate" && !stargate) {
      findings.push({
        level: "error",
        path: "$.placement.anchorID",
        message: "Specific stargate scope requires a selected EveJS stargate.",
      });
    } else if (stargate && systemID && stargate.solarSystemID !== systemID) {
      findings.push({
        level: "error",
        path: "$.placement.anchorID",
        message: "Selected stargate is not in the selected solar system.",
      });
    }
  }

  if (anchorKind === "coordinate") {
    if (!systemID || !catalog.systemsByID.has(systemID)) {
      findings.push({
        level: "error",
        path: "$.placement.position",
        message: "Fixed coordinate placement requires a specific solar system.",
      });
    }
    const position = placement.position && typeof placement.position === "object" ? placement.position : {};
    for (const axis of ["x", "y", "z"]) {
      if (!Number.isFinite(Number(position[axis]))) {
        findings.push({
          level: "error",
          path: `$.placement.position.${axis}`,
          message: "Coordinate placement requires numeric x, y, and z values.",
        });
      }
    }
  }

  const scannerVisibility = text(input.scanner && input.scanner.visibility);
  const expectedVisibility = expectedScannerVisibility(delivery);
  if (expectedVisibility && scannerVisibility && scannerVisibility !== expectedVisibility) {
    findings.push({
      level: "error",
      path: "$.scanner.visibility",
      message: `Delivery mode ${delivery} requires scanner visibility ${expectedVisibility}.`,
    });
  }

  const encounters = Array.isArray(input.encounters) ? input.encounters : [];
  if (contentFamily === "combat" || contentFamily === "mission") {
    if (encounters.length === 0) {
      findings.push({
        level: "warning",
        path: "$.encounters",
        message: "Combat content has no NPC encounter waves yet.",
      });
    }
  }
  encounters.forEach((encounter, index) => {
    const count = toInt(encounter && encounter.count, 0);
    if (count < 1 || count > 250) {
      findings.push({
        level: "error",
        path: `$.encounters[${index}].count`,
        message: "Encounter count must be between 1 and 250.",
      });
    }
    const profileID = text(encounter && encounter.profileID);
    const spawnGroupID = text(encounter && encounter.spawnGroupID);
    const spawnPoolID = text(encounter && encounter.spawnPoolID);
    const spawnQuery = text(encounter && encounter.spawnQuery);
    if (profileID && !catalog.npcProfilesByID.has(profileID)) {
      findings.push({
        level: "error",
        path: `$.encounters[${index}].profileID`,
        message: `NPC profile not found: ${profileID}`,
      });
    }
    if (spawnGroupID && !catalog.npcSpawnGroupsByID.has(spawnGroupID)) {
      findings.push({
        level: "error",
        path: `$.encounters[${index}].spawnGroupID`,
        message: `NPC spawn group not found: ${spawnGroupID}`,
      });
    }
    if (spawnPoolID && !catalog.npcSpawnPoolsByID.has(spawnPoolID)) {
      findings.push({
        level: "error",
        path: `$.encounters[${index}].spawnPoolID`,
        message: `NPC spawn pool not found: ${spawnPoolID}`,
      });
    }
    if (!profileID && !spawnGroupID && !spawnPoolID && !spawnQuery) {
      findings.push({
        level: "error",
        path: `$.encounters[${index}]`,
        message: "Encounter needs an NPC profile, spawn group, spawn pool, or EveJS spawnQuery.",
      });
    }
  });

  const rooms = Array.isArray(input.rooms) ? input.rooms : [];
  const gates = Array.isArray(input.gates) ? input.gates : [];
  if (contentFamily === "mission" && missionType === "combat") {
    if (rooms.length === 0) {
      findings.push({
        level: "warning",
        path: "$.rooms",
        message: "Security mission drafts should define at least an entry room.",
      });
    }
    if (rooms.length > 1 && gates.length === 0) {
      findings.push({
        level: "warning",
        path: "$.gates",
        message: "Multi-room Security mission drafts should define an acceleration gate.",
      });
    }
  }

  const resources = Array.isArray(input.resources) ? input.resources : [];
  if (contentFamily === "resource" && resources.length === 0) {
    findings.push({
      level: "warning",
      path: "$.resources",
      message: "Ore anomaly has no resource asteroids yet.",
    });
  }
  resources.forEach((resource, index) => {
    const typeID = toInt(resource && resource.typeID, 0);
    if (!typeID || !catalog.itemTypesByID.has(typeID)) {
      findings.push({
        level: "error",
        path: `$.resources[${index}].typeID`,
        message: "Resource type must be an existing client/SDE type ID.",
      });
    }
    const quantity = toNumber(resource && resource.quantity, 0);
    if (quantity <= 0) {
      findings.push({
        level: "error",
        path: `$.resources[${index}].quantity`,
        message: "Resource quantity must be greater than zero.",
      });
    }
  });

  const npcOverrides = Array.isArray(input.npcOverrides) ? input.npcOverrides : [];
  npcOverrides.forEach((override, index) => {
    const profileID = text(override && override.profileID);
    if (profileID && !catalog.npcProfilesByID.has(profileID)) {
      findings.push({
        level: "error",
        path: `$.npcOverrides[${index}].profileID`,
        message: `NPC profile not found: ${profileID}`,
      });
    }
    const loadoutID = text(override && override.loadoutID);
    if (loadoutID && !catalog.npcLoadoutsByID.has(loadoutID)) {
      findings.push({
        level: "error",
        path: `$.npcOverrides[${index}].loadoutID`,
        message: `NPC loadout not found: ${loadoutID}`,
      });
    }
    const behaviorProfileID = text(override && override.behaviorProfileID);
    if (behaviorProfileID && !catalog.npcBehaviorProfilesByID.has(behaviorProfileID)) {
      findings.push({
        level: "error",
        path: `$.npcOverrides[${index}].behaviorProfileID`,
        message: `NPC behavior profile not found: ${behaviorProfileID}`,
      });
    }
    const lootTableID = text(override && override.lootTableID);
    if (lootTableID && !catalog.npcLootTablesByID.has(lootTableID)) {
      const authoredLootTables = Array.isArray(input.lootTables) ? input.lootTables : [];
      const authoredMatch = authoredLootTables.some((lootTable) => text(lootTable && lootTable.lootTableID) === lootTableID);
      if (!authoredMatch) {
        findings.push({
          level: "error",
          path: `$.npcOverrides[${index}].lootTableID`,
          message: `NPC loot table not found: ${lootTableID}`,
        });
      }
    }
    const damageMultiplier = toNumber(override && override.damageMultiplier, 1);
    if (damageMultiplier <= 0 || damageMultiplier > 25) {
      findings.push({
        level: "error",
        path: `$.npcOverrides[${index}].damageMultiplier`,
        message: "Damage multiplier must be greater than 0 and no higher than 25.",
      });
    }
    if (
      Object.prototype.hasOwnProperty.call(override || {}, "moduleOverrides")
      && !Array.isArray(override.moduleOverrides)
    ) {
      findings.push({
        level: "error",
        path: `$.npcOverrides[${index}].moduleOverrides`,
        message: "Module overrides must be a JSON array.",
      });
    }
  });

  const authoredLootTables = Array.isArray(input.lootTables) ? input.lootTables : [];
  const authoredLootTableIDs = new Set();
  authoredLootTables.forEach((lootTable, index) => {
    const lootTableID = text(lootTable && lootTable.lootTableID);
    if (!lootTableID) {
      findings.push({
        level: "error",
        path: `$.lootTables[${index}].lootTableID`,
        message: "Authored loot table needs a lootTableID.",
      });
    } else if (authoredLootTableIDs.has(lootTableID)) {
      findings.push({
        level: "error",
        path: `$.lootTables[${index}].lootTableID`,
        message: `Duplicate authored loot table ID: ${lootTableID}`,
      });
    } else {
      authoredLootTableIDs.add(lootTableID);
      if (catalog.npcLootTablesByID.has(lootTableID)) {
        findings.push({
          level: "warning",
          path: `$.lootTables[${index}].lootTableID`,
          message: `Authored loot table ${lootTableID} overrides an existing EveJS loot table ID in generated output.`,
        });
      }
    }

    const minEntries = toInt(lootTable && lootTable.minEntries, 0);
    const maxEntries = toInt(lootTable && lootTable.maxEntries, minEntries);
    if (minEntries < 0 || maxEntries < minEntries) {
      findings.push({
        level: "error",
        path: `$.lootTables[${index}]`,
        message: "Loot table maxEntries must be greater than or equal to minEntries.",
      });
    }

    for (const entryKey of ["guaranteedEntries", "entries"]) {
      const entries = lootTable && lootTable[entryKey];
      if (entries !== undefined && !Array.isArray(entries)) {
        findings.push({
          level: "error",
          path: `$.lootTables[${index}].${entryKey}`,
          message: "Loot entries must be a JSON array.",
        });
        continue;
      }
      (Array.isArray(entries) ? entries : []).forEach((entry, entryIndex) => {
        const typeID = toInt(entry && entry.typeID, 0);
        if (!typeID || !catalog.itemTypesByID.has(typeID)) {
          findings.push({
            level: "error",
            path: `$.lootTables[${index}].${entryKey}[${entryIndex}].typeID`,
            message: "Loot entry typeID must be an existing client/SDE type ID.",
          });
        }
        if (entryKey === "entries" && toNumber(entry && entry.weight, 0) <= 0) {
          findings.push({
            level: "error",
            path: `$.lootTables[${index}].entries[${entryIndex}].weight`,
            message: "Weighted loot entries need a weight greater than zero.",
          });
        }
        const minQuantity = toInt(entry && entry.minQuantity, 0);
        const maxQuantity = toInt(entry && entry.maxQuantity, minQuantity);
        const quantity = toInt(entry && entry.quantity, 0);
        if (quantity < 0 || minQuantity < 0 || maxQuantity < minQuantity) {
          findings.push({
            level: "error",
            path: `$.lootTables[${index}].${entryKey}[${entryIndex}]`,
            message: "Loot quantities must be non-negative and maxQuantity must be at least minQuantity.",
          });
        }
      });
    }
  });

  const names = resolveNames(input);
  if (names.baseTemplate) {
    if (names.baseTemplate.contentFamily && names.baseTemplate.contentFamily !== contentFamily) {
      findings.push({
        level: "warning",
        path: "$.baseTemplateID",
        message: "Base template content family differs from this draft. It can still be used as a reference, but verify runtime behavior.",
      });
    }
    if (names.baseTemplate.delivery && names.baseTemplate.delivery !== delivery) {
      findings.push({
        level: "warning",
        path: "$.baseTemplateID",
        message: "Base template delivery mode differs from this draft. Verify scanner/mission/static visibility before applying.",
      });
    }
  }

  return {
    ok: findings.every((finding) => finding.level !== "error"),
    findings,
    names: {
      solarSystem: names.solarSystem ? { ...names.solarSystem } : null,
      stargate: names.stargate ? { ...names.stargate } : null,
      baseTemplate: names.baseTemplate
        ? {
          templateID: names.baseTemplate.templateID,
          name: names.baseTemplate.name,
          siteFamily: names.baseTemplate.siteFamily,
          siteKind: names.baseTemplate.siteKind,
          contentFamily: names.baseTemplate.contentFamily,
          delivery: names.baseTemplate.delivery,
        }
        : null,
    },
  };
}

module.exports = {
  CONTENT_KINDS,
  CONTENT_FAMILIES,
  DELIVERY_MODES,
  validateOverlay,
};
