const path = require("node:path");

const {
  OVERLAY_DIR,
  writeJsonFileAtomic,
} = require("./dataStore");
const { getCatalog } = require("./catalog");
const { listAuthoredLootTables } = require("./npcAuthoringStore");
const { listOverlays } = require("./overlayStore");
const { validateOverlay } = require("./validator");

const PACK_FILE = path.join(OVERLAY_DIR, "generated-template-pack.json");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function text(value) {
  return String(value || "").trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getSystemName(catalog, systemID) {
  const system = catalog.systemsByID.get(toInt(systemID, 0));
  return text(system && system.name);
}

function getGateName(catalog, gateID) {
  const gate = catalog.stargatesByID.get(toInt(gateID, 0));
  return text(gate && gate.name);
}

function getTemplateBase(catalog, templateID) {
  const template = catalog.templatesByID.get(text(templateID));
  if (!template) return null;
  return {
    templateID: template.templateID,
    name: template.name,
    siteFamily: template.siteFamily,
    siteKind: template.siteKind,
    contentFamily: template.contentFamily,
    delivery: template.delivery,
    sourceDungeonID: template.sourceDungeonID,
    archetypeID: template.archetypeID,
    dungeonNameID: template.dungeonNameID,
    factionID: template.factionID,
    difficulty: template.difficulty,
  };
}

function generatedTemplateID(overlay) {
  const explicitTemplateID = text(overlay.templateID);
  if (explicitTemplateID) {
    return explicitTemplateID;
  }
  const baseTemplateID = text(overlay.baseTemplateID);
  if (baseTemplateID) {
    return baseTemplateID;
  }
  const prefix = overlay.kind === "mission_combat"
    ? "admin-mission"
    : overlay.kind === "ore_anomaly"
      ? "admin-ore"
      : "admin-combat";
  return `${prefix}:${overlay.id}`;
}

function generatedAssignmentID(overlay) {
  return `assignment:${overlay.id}`;
}

function inferLegacyFamily(overlay) {
  if (overlay.kind === "ore_anomaly") return "resource";
  if (overlay.kind === "mission_combat") return "mission";
  if (overlay.kind === "combat_anomaly") return "combat";
  return "";
}

function inferLegacyDelivery(overlay) {
  if (overlay.kind === "mission_combat") return "mission_private";
  if (overlay.kind === "combat_anomaly" || overlay.kind === "ore_anomaly") return "anomaly";
  return "";
}

function resolveContentFamily(overlay) {
  return text(overlay.contentFamily) || inferLegacyFamily(overlay) || "combat";
}

function resolveDelivery(overlay) {
  return text(overlay.delivery) || inferLegacyDelivery(overlay) || "anomaly";
}

function resolveMissionType(overlay) {
  if (resolveContentFamily(overlay) !== "mission") return null;
  return text(overlay.missionType || overlay.mission && overlay.mission.type) || "combat";
}

function resolveSiteFamily(catalog, overlay) {
  const base = catalog.templatesByID.get(text(overlay.baseTemplateID));
  if (base && base.siteFamily) return base.siteFamily;
  const contentFamily = resolveContentFamily(overlay);
  const missionType = resolveMissionType(overlay);
  if (contentFamily === "mission" && missionType === "mining") return "mining";
  if (contentFamily === "resource") {
    const resources = Array.isArray(overlay.resources) ? overlay.resources : [];
    const hasGas = resources.some((resource) => {
      const resourceType = catalog.resourceTypesByID.get(toInt(resource && resource.typeID, 0));
      return resourceType && String(resourceType.kind || "").includes("gas");
    });
    return hasGas || resolveDelivery(overlay) === "signature" ? "gas" : "ore";
  }
  if (contentFamily === "hacking") return "data";
  if (contentFamily === "static_world") return "static";
  if (contentFamily === "npc_presence") return "npc_presence";
  return contentFamily;
}

function resolveSiteKind(catalog, overlay) {
  const base = catalog.templatesByID.get(text(overlay.baseTemplateID));
  if (base && base.siteKind) return base.siteKind;
  const delivery = resolveDelivery(overlay);
  const missionType = resolveMissionType(overlay);
  if (delivery === "mission_private" && missionType === "mining") return "mining";
  if (delivery === "mission_private") return "encounter";
  if (delivery === "static_beacon") return "static";
  if (delivery === "startup_rule") return "startup_rule";
  if (delivery === "runtime_response") return "response";
  if (delivery === "escalation") return "escalation";
  return delivery;
}

function normalizePlacement(catalog, overlay) {
  const placement = overlay.placement && typeof overlay.placement === "object"
    ? overlay.placement
    : {};
  const anchorKind = text(placement.anchorKind || placement.kind || "system");
  const spawnScope = overlay.spawnScope && typeof overlay.spawnScope === "object"
    ? overlay.spawnScope
    : {};
  const anchorID = toInt(placement.anchorID || spawnScope.stargateID, 0);
  return {
    anchorKind,
    anchorID: anchorID || null,
    anchorName: anchorKind === "stargate"
      ? getGateName(catalog, anchorID)
      : null,
    position: placement.position && typeof placement.position === "object"
      ? clone(placement.position)
      : null,
    distanceFromSurfaceMeters: Number(placement.distanceFromSurfaceMeters) || null,
    spreadMeters: Number(placement.spreadMeters) || null,
  };
}

function normalizeSpawnScope(catalog, overlay) {
  const raw = overlay.spawnScope && typeof overlay.spawnScope === "object"
    ? overlay.spawnScope
    : {};
  const placement = overlay.placement && typeof overlay.placement === "object"
    ? overlay.placement
    : {};
  const legacyMode = placement.anchorKind === "stargate" && placement.anchorID
    ? "specific_stargate"
    : toInt(overlay.solarSystemID, 0) > 0
      ? "specific_system"
      : "any_eligible";
  const mode = text(raw.mode) || legacyMode;
  const stargateID = toInt(raw.stargateID || placement.anchorID, 0);
  const stargate = stargateID ? catalog.stargatesByID.get(stargateID) : null;
  const solarSystemID = toInt(
    raw.solarSystemID || overlay.solarSystemID || stargate && stargate.solarSystemID,
    0,
  );
  const securityBands = Array.isArray(raw.securityBands) && raw.securityBands.length > 0
    ? raw.securityBands.map(text).filter(Boolean)
    : ["highsec", "lowsec", "nullsec", "wormhole"];
  return {
    mode,
    securityBands,
    maxConcurrentPerSystem: Math.max(1, toInt(raw.maxConcurrentPerSystem, 1)),
    weight: Math.max(0, Number(raw.weight) || 0),
    respawnMinutes: Math.max(1, toInt(raw.respawnMinutes, 60)),
    slotCount: Math.max(1, toInt(raw.slotCount, 1)),
    solarSystemID: mode === "specific_system" || mode === "specific_stargate"
      ? solarSystemID || null
      : null,
    solarSystemName: mode === "specific_system" || mode === "specific_stargate"
      ? getSystemName(catalog, solarSystemID) || null
      : null,
    stargateID: mode === "specific_stargate" ? stargateID || null : null,
    stargateName: mode === "specific_stargate" ? getGateName(catalog, stargateID) || null : null,
  };
}

function normalizeEncounter(catalog, encounter, index) {
  const profileID = text(encounter && encounter.profileID);
  const spawnGroupID = text(encounter && encounter.spawnGroupID);
  const spawnPoolID = text(encounter && encounter.spawnPoolID);
  const spawnQuery = text(encounter && encounter.spawnQuery) || spawnGroupID || profileID || spawnPoolID;
  const profile = profileID ? catalog.npcProfilesByID.get(profileID) : null;
  const spawnGroup = spawnGroupID ? catalog.npcSpawnGroupsByID.get(spawnGroupID) : null;
  const spawnPool = spawnPoolID ? catalog.npcSpawnPoolsByID.get(spawnPoolID) : null;
  const amount = Math.max(1, toInt(encounter && (encounter.amount || encounter.count), 1));
  return {
    key: text(encounter && encounter.key) || `wave_${index + 1}`,
    label: text(encounter && encounter.label) || `Wave ${index + 1}`,
    trigger: text(encounter && encounter.trigger) || (index === 0 ? "on_load" : "wave_cleared"),
    count: amount,
    amount,
    spawnQuery: spawnQuery || null,
    profileID: profileID || null,
    profileName: profile ? profile.name : null,
    spawnGroupID: spawnGroupID || null,
    spawnGroupName: spawnGroup ? spawnGroup.name : null,
    spawnPoolID: spawnPoolID || null,
    spawnPoolName: spawnPool ? spawnPool.name : null,
    delaySeconds: Math.max(0, Number(encounter && encounter.delaySeconds) || 0),
    countdownSeconds: Math.max(0, Number(encounter && (encounter.countdownSeconds || encounter.delaySeconds)) || 0) || null,
    orbitDistanceMeters: Number(encounter && encounter.orbitDistanceMeters) || null,
    distanceMeters: Number(encounter && encounter.distanceMeters) || null,
    leashRangeMeters: Number(encounter && encounter.leashRangeMeters) || null,
    targetPolicy: text(encounter && encounter.targetPolicy) || "nearest_player",
    roomKey: text(encounter && encounter.roomKey) || null,
    waveIndex: Math.max(1, toInt(encounter && encounter.waveIndex, index + 1)),
    prerequisiteKey: text(encounter && encounter.prerequisiteKey) || null,
    objective: encounter && encounter.objective === true,
    completionRole: text(encounter && encounter.completionRole) || null,
    sourceGroup: text(encounter && encounter.sourceGroup) || null,
    variantNames: Array.isArray(encounter && encounter.variantNames) ? clone(encounter.variantNames) : [],
    notes: text(encounter && encounter.notes),
  };
}

function normalizeRoom(room, index) {
  return {
    roomKey: text(room && room.roomKey) || (index === 0 ? "room:entry" : `room:mission_${index + 1}`),
    label: text(room && room.label) || (index === 0 ? "Entry Pocket" : `Mission Room ${index + 1}`),
    source: text(room && room.source) || "eve_anom_utility",
    role: text(room && room.role) || null,
    stage: text(room && room.stage) || (index === 0 ? "entry" : "room"),
    initialState: text(room && room.initialState) || text(room && room.state) || (index === 0 ? "active" : "pending"),
    pocketID: toInt(room && room.pocketID, 0) || null,
    notes: text(room && room.notes) || null,
  };
}

function normalizeGate(gate, index) {
  return {
    gateKey: text(gate && gate.gateKey) || `gate:${index + 1}`,
    label: text(gate && gate.label) || "Acceleration Gate",
    typeID: toInt(gate && gate.typeID, 17831) || 17831,
    typeNameCandidates: Array.isArray(gate && gate.typeNameCandidates)
      ? clone(gate.typeNameCandidates)
      : ["Acceleration Gate"],
    source: text(gate && gate.source) || "eve_anom_utility",
    fromObjectID: toInt(gate && gate.fromObjectID, 0) || null,
    toObjectID: toInt(gate && gate.toObjectID, 0) || null,
    destinationRoomKey: text(gate && gate.destinationRoomKey) || "room:entry",
    initialState: text(gate && gate.initialState) || text(gate && gate.state) || "locked",
    allowedShipsList: toInt(gate && gate.allowedShipsList, 0) || null,
    allowedRaces: Array.isArray(gate && gate.allowedRaces) ? clone(gate.allowedRaces) : [],
    keyLock: toInt(gate && gate.keyLock, 0) || null,
    requiredItemTypeID: toInt(gate && gate.requiredItemTypeID, 0) || null,
    requiredItemQuantity: toInt(gate && gate.requiredItemQuantity, 0) || null,
  };
}

function normalizeResource(catalog, resource) {
  const typeID = toInt(resource && resource.typeID, 0);
  const itemType = catalog.itemTypesByID.get(typeID);
  const resourceType = catalog.resourceTypesByID.get(typeID);
  return {
    typeID,
    typeName: text(itemType && (itemType.name || itemType.typeName)),
    kind: text(resource && resource.kind) || text(resourceType && resourceType.kind) || "ore",
    quantity: Math.max(0, Number(resource && resource.quantity) || 0),
    radiusMeters: Number(resource && resource.radiusMeters) || null,
    cluster: text(resource && resource.cluster) || "main",
  };
}

function normalizePosition(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

function normalizeRotation(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const rotation = value.map((entry) => Number(entry));
  return rotation.every(Number.isFinite) ? rotation : null;
}

function normalizeMiningRock(rock) {
  if (!rock || typeof rock !== "object") return null;
  const oreTypeID = toInt(rock.oreTypeID || rock.typeID || rock.objectiveTypeID, 0);
  const quantity = toInt(rock.quantity || rock.remainingQuantity || rock.quantityPerRock, 0);
  if (!oreTypeID || quantity <= 0) return null;
  const normalized = {
    oreTypeID,
    count: Math.max(1, toInt(rock.count, 1)),
    quantity,
  };
  if (text(rock.label)) normalized.label = text(rock.label);
  const positionOffset = normalizePosition(rock.positionOffset);
  if (positionOffset) normalized.positionOffset = positionOffset;
  const dunObjectID = toInt(rock.dunObjectID, 0);
  if (dunObjectID > 0) normalized.dunObjectID = dunObjectID;
  const dunRotation = normalizeRotation(rock.dunRotation);
  if (dunRotation) normalized.dunRotation = dunRotation;
  return normalized;
}

function normalizeEnvironmentProp(prop, index) {
  if (!prop || typeof prop !== "object") return null;
  const typeID = toInt(prop.typeID, 0);
  if (!typeID) return null;
  const normalized = {
    key: text(prop.key) || `authored:${typeID}:${index + 1}`,
    exact: prop.exact === true,
    typeID,
  };
  if (text(prop.label)) normalized.label = text(prop.label);
  const ownerID = toInt(prop.ownerID, 0);
  if (ownerID > 0) normalized.ownerID = ownerID;
  const dunObjectID = toInt(prop.dunObjectID, 0);
  if (dunObjectID > 0) normalized.dunObjectID = dunObjectID;
  const positionOffset = normalizePosition(prop.positionOffset);
  if (positionOffset) normalized.positionOffset = positionOffset;
  const dunRotation = normalizeRotation(prop.dunRotation);
  if (dunRotation) normalized.dunRotation = dunRotation;
  if (Object.prototype.hasOwnProperty.call(prop, "dunObjectNameID")) {
    normalized.dunObjectNameID = prop.dunObjectNameID;
  }
  if (Object.prototype.hasOwnProperty.call(prop, "objectiveTargetGroup")) {
    normalized.objectiveTargetGroup = prop.objectiveTargetGroup;
  }
  if (prop.suppressSlimName === true) normalized.suppressSlimName = true;
  if (prop.suppressSlimGraphicID === true) normalized.suppressSlimGraphicID = true;
  return normalized;
}

function resourceKindForSite(resource, siteFamily) {
  const explicitKind = text(resource && resource.kind).toLowerCase();
  if (explicitKind.includes("gas")) return "gas";
  if (explicitKind.includes("ice")) return "ice";
  if (explicitKind.includes("ore")) return "ore";
  if (siteFamily === "gas" || siteFamily === "ice" || siteFamily === "ore") return siteFamily;
  return "ore";
}

function buildResourceComposition(resources, siteFamily) {
  const composition = {
    oreTypeIDs: [],
    gasTypeIDs: [],
    iceTypeIDs: [],
  };
  for (const resource of Array.isArray(resources) ? resources : []) {
    const typeID = toInt(resource && resource.typeID, 0);
    if (!typeID) continue;
    const kind = resourceKindForSite(resource, siteFamily);
    if (kind === "gas") {
      composition.gasTypeIDs.push(typeID);
    } else if (kind === "ice") {
      composition.iceTypeIDs.push(typeID);
    } else {
      composition.oreTypeIDs.push(typeID);
    }
  }
  for (const key of Object.keys(composition)) {
    composition[key] = [...new Set(composition[key])].sort((left, right) => left - right);
  }
  return {
    ...composition,
    hasAnyResources:
      composition.oreTypeIDs.length > 0 ||
      composition.gasTypeIDs.length > 0 ||
      composition.iceTypeIDs.length > 0,
  };
}

function buildObjectiveMarkers(siteFamily, encounters, resourceComposition) {
  if (siteFamily === "ore") {
    return [
      { role: "objective", label: "Mine resource deposits", key: "mine_resource_deposits", icon: null, analyzer: null },
      { role: "task", label: "Extract mineable resources", key: "extract_mineable_resources", icon: null, analyzer: null },
    ];
  }
  if (siteFamily === "gas") {
    return [
      { role: "objective", label: "Harvest gas clouds", key: "harvest_gas_clouds", icon: null, analyzer: null },
    ];
  }
  if (siteFamily === "ice") {
    return [
      { role: "objective", label: "Harvest ice field", key: "harvest_ice_field", icon: null, analyzer: null },
    ];
  }
  if (Array.isArray(encounters) && encounters.length > 0) {
    return [
      { role: "objective", label: "Eliminate hostile defenders", key: "eliminate_hostile_defenders", icon: null, analyzer: null },
    ];
  }
  if (resourceComposition && resourceComposition.hasAnyResources) {
    return [
      { role: "task", label: "Extract mineable resources", key: "extract_mineable_resources", icon: null, analyzer: null },
    ];
  }
  return [];
}

function normalizeNpcOverride(catalog, override) {
  const profileID = text(override && override.profileID);
  const profile = profileID ? catalog.npcProfilesByID.get(profileID) : null;
  const loadoutID = text(override && override.loadoutID);
  const behaviorProfileID = text(override && override.behaviorProfileID);
  const lootTableID = text(override && override.lootTableID);
  return {
    profileID,
    profileName: profile ? profile.name : null,
    loadoutID: loadoutID || null,
    behaviorProfileID: behaviorProfileID || null,
    lootTableID: lootTableID || null,
    damageMultiplier: Number(override && override.damageMultiplier) || 1,
    bounty: Number.isFinite(Number(override && override.bounty)) ? Number(override.bounty) : null,
    preferredTargetMode: text(override && override.preferredTargetMode) || null,
    moduleOverrides: Array.isArray(override && override.moduleOverrides)
      ? clone(override.moduleOverrides)
      : [],
  };
}

function normalizeLootEntry(catalog, entry) {
  const typeID = toInt(entry && entry.typeID, 0);
  const itemType = catalog.itemTypesByID.get(typeID);
  const weight = Math.max(0, Number(entry && entry.weight) || 0);
  const quantity = toInt(entry && entry.quantity, 0);
  const minQuantity = toInt(entry && entry.minQuantity, 0);
  const maxQuantity = toInt(entry && entry.maxQuantity, 0);
  return {
    typeID,
    name: text(itemType && (itemType.name || itemType.typeName)) || null,
    ...(weight > 0 ? { weight } : {}),
    ...(quantity > 0 ? { quantity } : {}),
    ...(minQuantity > 0 ? { minQuantity } : {}),
    ...(maxQuantity > 0 ? { maxQuantity } : {}),
    ...(entry && entry.singleton === true ? { singleton: true } : {}),
  };
}

function normalizeAuthoredLootTable(catalog, lootTable, index) {
  const lootTableID = text(lootTable && lootTable.lootTableID) || `admin_loot_table_${index + 1}`;
  const minEntries = Math.max(0, toInt(lootTable && lootTable.minEntries, 0));
  const maxEntries = Math.max(minEntries, toInt(lootTable && lootTable.maxEntries, minEntries));
  const entries = Array.isArray(lootTable && lootTable.entries)
    ? lootTable.entries.map((entry) => normalizeLootEntry(catalog, entry)).filter((entry) => entry.typeID > 0)
    : [];
  const guaranteedEntries = Array.isArray(lootTable && lootTable.guaranteedEntries)
    ? lootTable.guaranteedEntries.map((entry) => normalizeLootEntry(catalog, entry)).filter((entry) => entry.typeID > 0)
    : [];
  return {
    lootTableID,
    name: text(lootTable && lootTable.name) || lootTableID,
    source: "eve_anom_utility",
    minEntries,
    maxEntries,
    ...(lootTable && lootTable.allowDuplicates === true ? { allowDuplicates: true } : {}),
    ...(toInt(lootTable && lootTable.stackableMinQuantity, 0) > 0
      ? { stackableMinQuantity: toInt(lootTable && lootTable.stackableMinQuantity, 0) }
      : {}),
    ...(toInt(lootTable && lootTable.stackableMaxQuantity, 0) > 0
      ? { stackableMaxQuantity: toInt(lootTable && lootTable.stackableMaxQuantity, 0) }
      : {}),
    guaranteedEntries,
    entries,
    notes: text(lootTable && lootTable.notes) || null,
  };
}

function authoredLootTablesForOverlay(catalog, overlay) {
  return (Array.isArray(overlay.lootTables) ? overlay.lootTables : [])
    .map((lootTable, index) => normalizeAuthoredLootTable(catalog, lootTable, index))
    .filter((lootTable) => text(lootTable.lootTableID));
}

function collectAuthoredLootTables(catalog, overlays, globalLootTables = []) {
  const byID = new Map();
  for (const lootTable of Array.isArray(globalLootTables) ? globalLootTables : []) {
    const normalized = normalizeAuthoredLootTable(catalog, lootTable, byID.size);
    byID.set(normalized.lootTableID, normalized);
  }
  for (const overlay of overlays) {
    for (const lootTable of authoredLootTablesForOverlay(catalog, overlay)) {
      byID.set(lootTable.lootTableID, lootTable);
    }
  }
  return [...byID.values()].sort((left, right) => left.lootTableID.localeCompare(right.lootTableID));
}

function buildGeneratedTemplate(catalog, overlay) {
  const contentFamily = resolveContentFamily(overlay);
  const delivery = resolveDelivery(overlay);
  const missionType = resolveMissionType(overlay);
  const siteFamily = resolveSiteFamily(catalog, overlay);
  const siteKind = resolveSiteKind(catalog, overlay);
  const baseTemplate = getTemplateBase(catalog, overlay.baseTemplateID);
  const baseRaw = catalog.templatesByID.get(text(overlay.baseTemplateID));
  const encounters = (Array.isArray(overlay.encounters) ? overlay.encounters : [])
    .map((encounter, index) => normalizeEncounter(catalog, encounter, index));
  const authoredRooms = (Array.isArray(overlay.rooms) ? overlay.rooms : [])
    .map((room, index) => normalizeRoom(room, index))
    .filter((room) => text(room.roomKey));
  const roomProfiles = authoredRooms.length > 0
    ? authoredRooms
    : [{ roomKey: "room:entry", label: "Entry Pocket", source: "eve_anom_utility", initialState: "active" }];
  const authoredGates = (Array.isArray(overlay.gates) ? overlay.gates : [])
    .map((gate, index) => normalizeGate(gate, index))
    .filter((gate) => text(gate.gateKey));
  const authoredResources = (Array.isArray(overlay.resources) ? overlay.resources : [])
    .map((resource) => normalizeResource(catalog, resource))
    .filter((resource) => resource.typeID > 0);
  const authoredMiningRocks = (Array.isArray(overlay.miningRocks) ? overlay.miningRocks : [])
    .map((rock) => normalizeMiningRock(rock))
    .filter(Boolean);
  const authoredEnvironmentProps = (Array.isArray(overlay.environmentProps) ? overlay.environmentProps : [])
    .map((prop, index) => normalizeEnvironmentProp(prop, index))
    .filter(Boolean);
  const authoredLootTables = authoredLootTablesForOverlay(catalog, overlay);
  const resourceComposition = buildResourceComposition(authoredResources, siteFamily);
  const objectiveMarkers = buildObjectiveMarkers(siteFamily, encounters, resourceComposition);
  const isMiningMission = contentFamily === "mission" && missionType === "mining";
  const objectiveTypeID = toInt(overlay.objectiveTypeID, 0) ||
    toInt(overlay.completion && overlay.completion.objectiveTypeID, 0);
  const objectiveQuantity = toInt(overlay.objectiveQuantity, 0) ||
    toInt(overlay.completion && overlay.completion.objectiveQuantity, 0);
  return {
    templateID: generatedTemplateID(overlay),
    source: "eve_anom_utility",
    sourcePriority: 120,
    sourceConfidence: {
      label: "Admin Authored Override",
      score: 95,
    },
    siteFamily,
    siteKind,
    siteOrigin: delivery === "mission_private" ? "admin_mission" : "admin_dungeon",
    resolvedName: text(overlay.title) || generatedTemplateID(overlay),
    sourceDungeonID: toInt(baseTemplate && baseTemplate.sourceDungeonID, 0) || null,
    archetypeID: toInt(baseTemplate && baseTemplate.archetypeID, 0) || null,
    dungeonNameID: toInt(baseTemplate && baseTemplate.dungeonNameID, 0) || null,
    factionID: toInt(baseTemplate && baseTemplate.factionID, 0) || null,
    difficulty: toInt(baseTemplate && baseTemplate.difficulty, 0) || null,
    entryObjectTypeID: toInt(baseRaw && baseRaw.raw && baseRaw.raw.entryObjectTypeID, 0) || null,
    rooms: roomProfiles,
    gates: authoredGates,
    connections: authoredGates.map((gate, index) => ({
      connectionKey: text(gate.gateKey) || `gate:${index + 1}`,
      gateKey: text(gate.gateKey) || `gate:${index + 1}`,
      fromObjectID: toInt(gate.fromObjectID, 0) || null,
      toObjectID: toInt(gate.toObjectID, 0) || null,
      destinationRoomKey: text(gate.destinationRoomKey) || null,
      allowedShipsList: toInt(gate.allowedShipsList, 0) || null,
      allowedRaces: Array.isArray(gate.allowedRaces) ? clone(gate.allowedRaces) : [],
      initialState: text(gate.initialState) || null,
      keyLock: toInt(gate.keyLock, 0) || null,
      requiredItemTypeID: toInt(gate.requiredItemTypeID, 0) || null,
      requiredItemQuantity: toInt(gate.requiredItemQuantity, 0) || null,
    })),
    resourceComposition,
    populationHints: {
      source: "eve_anom_utility",
      siteFamily,
      siteKind,
      encounter: encounters[0] || null,
      encounters,
      completion: overlay.completion || {},
      containers: [],
      hazards: [],
      environmentProps: authoredEnvironmentProps,
      ...(isMiningMission ? {
        miningRocks: authoredMiningRocks,
        objectiveTypeID: objectiveTypeID || null,
        objectiveQuantity: objectiveQuantity || 0,
        completeObjectiveOnEncounterClear: false,
      } : {}),
      lootProfiles: authoredLootTables.map((lootTable) => ({
        lootTableID: lootTable.lootTableID,
        name: lootTable.name,
        entries: lootTable.entries.length,
        guaranteedEntries: lootTable.guaranteedEntries.length,
      })),
      resources: {
        oreTypeIDs: resourceComposition.oreTypeIDs,
        gasTypeIDs: resourceComposition.gasTypeIDs,
        iceTypeIDs: resourceComposition.iceTypeIDs,
      },
      dangerousWarpIn: false,
      safeFromNpc: siteFamily === "ore" || siteFamily === "gas" || siteFamily === "ice",
      objectiveMarkers,
      npcOverrides: (Array.isArray(overlay.npcOverrides) ? overlay.npcOverrides : [])
        .map((override) => normalizeNpcOverride(catalog, override)),
    },
    siteSceneProfile: {
      source: "eve_anom_utility",
      confidence: {
        label: "Admin Authored Override",
        score: 95,
      },
      evidence: ["eve_anom_utility_template_pack"],
      roomProfiles,
      gateProfiles: authoredGates,
      structureProfiles: [],
      objectiveVisualProfiles: objectiveMarkers.map((marker) => ({
        role: marker.role,
        label: marker.label,
        key: marker.key,
        icon: marker.icon || null,
        analyzer: marker.analyzer || null,
      })),
    },
    resourceHints: {
      oreTypesByDungeonIDAvailable: resourceComposition.oreTypeIDs.length > 0,
      gasTypesByDungeonIDAvailable: resourceComposition.gasTypeIDs.length > 0,
      iceTypesByDungeonIDAvailable: resourceComposition.iceTypeIDs.length > 0,
    },
    adminMetadata: {
      title: overlay.title,
      contentFamily,
      delivery,
      ...(missionType ? { missionType } : {}),
      baseTemplate,
      scanner: overlay.scanner,
      authoredResources,
      authoredMiningRocks,
      authoredEnvironmentProps,
      objectiveTypeID: objectiveTypeID || null,
      objectiveQuantity: objectiveQuantity || 0,
      authoredRooms: roomProfiles,
      authoredGates,
      authoredLootTables,
      missionSecurity: overlay.missionSecurity || null,
      sourceLinks: Array.isArray(overlay.sourceLinks) ? clone(overlay.sourceLinks) : [],
      completion: overlay.completion || {},
      notes: overlay.notes || "",
      authoredBy: "EveAnomUtility",
      authoredAt: overlay.updatedAt,
    },
    // Deprecated utility-native fields retained for older import experiments.
    title: overlay.title,
    contentFamily,
    delivery,
    ...(missionType ? { missionType } : {}),
    baseTemplate,
    scanner: overlay.scanner,
    rooms: roomProfiles,
    gates: authoredGates,
    miningRocks: authoredMiningRocks,
    environmentProps: authoredEnvironmentProps,
    objectiveTypeID: objectiveTypeID || null,
    objectiveQuantity: objectiveQuantity || 0,
    missionSecurity: overlay.missionSecurity || null,
    sourceLinks: Array.isArray(overlay.sourceLinks) ? clone(overlay.sourceLinks) : [],
    completion: overlay.completion || {},
    npcAuthoring: {
      lootTables: authoredLootTables,
    },
    lootTables: authoredLootTables,
    notes: overlay.notes || "",
    authoredBy: "EveAnomUtility",
    authoredAt: overlay.updatedAt,
  };
}

function buildAssignment(catalog, overlay) {
  const spawnScope = normalizeSpawnScope(catalog, overlay);
  return {
    assignmentID: generatedAssignmentID(overlay),
    templateID: generatedTemplateID(overlay),
    kind: overlay.kind,
    contentFamily: resolveContentFamily(overlay),
    delivery: resolveDelivery(overlay),
    ...(resolveMissionType(overlay) ? { missionType: resolveMissionType(overlay) } : {}),
    title: overlay.title,
    spawnScope,
    solarSystemID: spawnScope.solarSystemID,
    solarSystemName: spawnScope.solarSystemName,
    placement: normalizePlacement(catalog, overlay),
    enabled: overlay.status !== "disabled",
    status: overlay.status || "draft",
  };
}

async function buildTemplatePack(options = {}) {
  const catalog = getCatalog();
  const [overlays, globalLootTables] = await Promise.all([
    listOverlays(),
    listAuthoredLootTables(),
  ]);
  const selected = overlays.filter((overlay) => {
    if (options.includeDrafts === false && overlay.status === "draft") return false;
    return validateOverlay(overlay).ok;
  });
  const invalid = overlays
    .map((overlay) => ({ overlay, validation: validateOverlay(overlay) }))
    .filter((entry) => !entry.validation.ok);

  const pack = {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: "EveAnomUtility",
    purpose: "Server-side EveJS playable content template pack. This file is generated output, not a live database mutation.",
    sourceDataDir: catalog.dataDir,
    scope: [
      "combat",
      "resource",
      "hacking",
      "mission",
      "wormhole",
      "special",
      "static_world",
      "npc_presence",
    ],
    templates: selected.map((overlay) => buildGeneratedTemplate(catalog, overlay)),
    assignments: selected.map((overlay) => buildAssignment(catalog, overlay)),
    npcLootTables: collectAuthoredLootTables(catalog, selected, globalLootTables),
    validation: {
      validOverlayCount: selected.length,
      invalidOverlayCount: invalid.length,
      invalidOverlays: invalid.map((entry) => ({
        id: entry.overlay.id,
        title: entry.overlay.title,
        findings: entry.validation.findings,
      })),
    },
  };

  if (options.write !== false) {
    await writeJsonFileAtomic(PACK_FILE, pack);
  }
  return pack;
}

module.exports = {
  PACK_FILE,
  buildGeneratedTemplate,
  buildTemplatePack,
};
