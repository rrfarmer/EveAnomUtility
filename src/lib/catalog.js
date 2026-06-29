const fs = require("node:fs");

const {
  CLONE_DATA_DIR,
  getLiveDataDir,
  getStaticTableDir,
  readJsonFile,
  readTable,
  tablePath,
  writeJsonFileAtomic,
} = require("./dataStore");

const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 500;

let cache = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function normalizeSearch(value) {
  return normalizeText(value).toLowerCase();
}

function limitValue(value, fallback = DEFAULT_LIMIT) {
  return Math.max(1, Math.min(MAX_LIMIT, toInt(value, fallback)));
}

function activeDataDir() {
  return fs.existsSync(CLONE_DATA_DIR) ? CLONE_DATA_DIR : getLiveDataDir();
}

function readCatalogTable(dataDir, table, fallback = {}) {
  if (table === "dungeonAuthority" || table === "missionAuthority") {
    const staticTableDir = getStaticTableDir();
    const staticTableFile = tablePath(staticTableDir, table);
    if (fs.existsSync(staticTableFile)) {
      return readTable(staticTableDir, table, fallback);
    }
  }
  return readTable(dataDir, table, fallback);
}

function getRows(data, rowKey) {
  return Array.isArray(data && data[rowKey]) ? data[rowKey] : [];
}

function buildMap(rows, idField) {
  return new Map(
    rows
      .map((row) => [toInt(row && row[idField], 0), row])
      .filter(([id]) => id > 0),
  );
}

function getItemName(itemTypesByID, typeID, fallback = "") {
  const record = itemTypesByID.get(toInt(typeID, 0));
  return normalizeText(record && (record.name || record.typeName)) || fallback || String(typeID || "");
}

function displayedSecurity(system) {
  return Math.round(Math.max(0, Math.min(1, toNumber(system && system.security, 0))) * 10) / 10;
}

function inferSecurityBand(system) {
  const security = displayedSecurity(system);
  if (security >= 0.5) return "highsec";
  if (security > 0) return "lowsec";
  return "nullsec";
}

function normalizeSystem(row, stargatesBySystem) {
  const solarSystemID = toInt(row && row.solarSystemID, 0);
  return {
    solarSystemID,
    name: normalizeText(row && row.solarSystemName),
    security: toNumber(row && row.security, 0),
    displayedSecurity: displayedSecurity(row),
    securityClass: normalizeText(row && row.securityClass),
    securityBand: inferSecurityBand(row),
    regionID: toInt(row && row.regionID, 0),
    constellationID: toInt(row && row.constellationID, 0),
    factionID: toInt(row && row.factionID, 0),
    stargateCount: (stargatesBySystem.get(solarSystemID) || []).length,
  };
}

function normalizeStargate(row, systemsByID) {
  const destinationSolarSystemID = toInt(row && row.destinationSolarSystemID, 0);
  const destinationSystem = systemsByID.get(destinationSolarSystemID);
  return {
    itemID: toInt(row && row.itemID, 0),
    typeID: toInt(row && row.typeID, 0),
    name: normalizeText(row && row.itemName),
    solarSystemID: toInt(row && row.solarSystemID, 0),
    destinationID: toInt(row && row.destinationID, 0),
    destinationSolarSystemID,
    destinationName: normalizeText(row && row.destinationName),
    destinationSolarSystemName: normalizeText(destinationSystem && destinationSystem.solarSystemName),
    position: row && row.position ? clone(row.position) : null,
    radius: toNumber(row && row.radius, 0),
  };
}

function getTemplateName(template) {
  return normalizeText(
    template && (
      template.resolvedName ||
      template.title ||
      template.name ||
      template.templateID
    ),
  );
}

function classifyTemplate(template) {
  const populationHints = template && template.populationHints && typeof template.populationHints === "object"
    ? template.populationHints
    : {};
  const siteFamily = normalizeSearch(populationHints.siteFamily || template && template.siteFamily);
  const siteKind = normalizeSearch(
    populationHints.siteKind ||
    template && template.siteKind,
  );
  const name = normalizeSearch(getTemplateName(template));
  const source = normalizeSearch(template && template.source);
  const combined = `${siteFamily} ${siteKind} ${name} ${source}`;

  let contentFamily = "special";
  if (siteFamily === "mission" || siteKind === "encounter" || siteKind === "mining" || siteKind === "transport" || siteKind === "storyline") {
    contentFamily = "mission";
  } else if (siteFamily === "combat") {
    contentFamily = "combat";
  } else if (siteFamily === "ore" || siteFamily === "gas" || siteFamily === "ice") {
    contentFamily = "resource";
  } else if (siteFamily === "data" || siteFamily === "relic" || siteFamily === "combat_hacking") {
    contentFamily = "hacking";
  } else if (siteFamily === "mission") {
    contentFamily = "mission";
  } else if (siteFamily === "wormhole" || combined.includes("wormhole")) {
    contentFamily = "wormhole";
  } else if (siteFamily === "static" || combined.includes("landmark") || combined.includes("cosmos")) {
    contentFamily = "static_world";
  } else if (siteFamily === "ghost" || combined.includes("ghost") || combined.includes("sleeper cache")) {
    contentFamily = "special";
  }

  let delivery = "signature";
  if (contentFamily === "mission" || ["encounter", "mining", "transport", "storyline"].includes(siteKind)) {
    delivery = "mission_private";
  } else if (siteKind === "anomaly") {
    delivery = "anomaly";
  } else if (siteKind === "signature") {
    delivery = "signature";
  } else if (contentFamily === "static_world") {
    delivery = "static_beacon";
  } else if (combined.includes("escalation") || combined.includes("expedition")) {
    delivery = "escalation";
  }

  return {
    contentFamily,
    delivery,
  };
}

function normalizeTemplate(template, itemTypesByID) {
  const populationHints = template && template.populationHints && typeof template.populationHints === "object"
    ? template.populationHints
    : {};
  const resourceComposition = template && template.resourceComposition && typeof template.resourceComposition === "object"
    ? template.resourceComposition
    : {};
  const encounters = Array.isArray(populationHints.encounters)
    ? populationHints.encounters
    : populationHints.encounter ? [populationHints.encounter] : [];
  const resources = {
    oreTypeIDs: Array.isArray(resourceComposition.oreTypeIDs) ? resourceComposition.oreTypeIDs : [],
    gasTypeIDs: Array.isArray(resourceComposition.gasTypeIDs) ? resourceComposition.gasTypeIDs : [],
    iceTypeIDs: Array.isArray(resourceComposition.iceTypeIDs) ? resourceComposition.iceTypeIDs : [],
  };
  const resourceNames = [
    ...resources.oreTypeIDs.map((typeID) => ({ typeID, kind: "ore" })),
    ...resources.gasTypeIDs.map((typeID) => ({ typeID, kind: "gas" })),
    ...resources.iceTypeIDs.map((typeID) => ({ typeID, kind: "ice" })),
  ]
    .map((entry) => ({
      typeID: toInt(entry.typeID, 0),
      name: getItemName(itemTypesByID, entry.typeID),
      kind: entry.kind,
    }))
    .filter((entry) => entry.typeID > 0);
  const classification = classifyTemplate({
    ...template,
    siteFamily: normalizeText(populationHints.siteFamily || template && template.siteFamily),
    siteKind: normalizeText(populationHints.siteKind || template && template.siteKind),
  });
  return {
    templateID: normalizeText(template && template.templateID),
    name: getTemplateName(template),
    source: normalizeText(template && template.source),
    siteFamily: normalizeText(populationHints.siteFamily || template && template.siteFamily),
    rawSiteFamily: normalizeText(template && template.siteFamily),
    siteKind: normalizeText(populationHints.siteKind || template && template.siteKind),
    rawSiteKind: normalizeText(template && template.siteKind),
    contentFamily: classification.contentFamily,
    delivery: classification.delivery,
    sourceDungeonID: toInt(template && template.sourceDungeonID, 0),
    archetypeID: toInt(template && template.archetypeID, 0),
    dungeonNameID: toInt(template && template.dungeonNameID, 0),
    factionID: toInt(template && template.factionID, 0),
    difficulty: toInt(template && template.difficulty, 0),
    dangerousWarpIn: populationHints.dangerousWarpIn === true,
    safeFromNpc: populationHints.safeFromNpc === true,
    encounterCount: encounters.length,
    containerCount: Array.isArray(populationHints.containers) ? populationHints.containers.length : 0,
    gateCount: Array.isArray(template && template.siteSceneProfile && template.siteSceneProfile.gateProfiles)
      ? template.siteSceneProfile.gateProfiles.length
      : 0,
    resourceCount: resourceNames.length,
    resourceNames,
    raw: template,
  };
}

function missionName(mission) {
  return normalizeText(
    mission && mission.localizedName && mission.localizedName.text,
  ) || `Mission ${mission && mission.missionID}`;
}

function classifyMissionType(mission = {}) {
  const kind = normalizeSearch(mission.missionKind);
  const template = normalizeSearch(mission.contentTemplate);
  if (kind === "trade") return "trade";
  if (kind === "mining") return "mining";
  if (kind === "courier") return "courier";
  if (kind === "talktoagent") return "talk_to_agent";
  if (kind === "agentinteraction") return "agent_interaction";
  if (kind === "encounter") return "combat";
  if (template.includes("trade")) return "trade";
  if (template.includes("mining")) return "mining";
  if (template.includes("courier")) return "courier";
  if (template.includes("talktoagent")) return "talk_to_agent";
  if (template.includes("agentinteraction")) return "agent_interaction";
  if (/kill|encounter/.test(template) || mission.killMission) return "combat";
  if (mission.courierMission) return "courier";
  return "other";
}

function normalizeMissionObjective(mission = {}, itemTypesByID = new Map()) {
  const missionType = classifyMissionType(mission);
  if (mission.killMission && typeof mission.killMission === "object") {
    const dungeonID = toInt(mission.killMission.dungeonID, 0);
    return {
      kind: missionType,
      dungeonID,
      templateID: dungeonID ? `client-dungeon:${dungeonID}` : "",
      objectiveQuantity: toInt(mission.killMission.objectiveQuantity, 0),
    };
  }
  if (mission.courierMission && typeof mission.courierMission === "object") {
    const typeID = toInt(mission.courierMission.objectiveTypeID, 0);
    return {
      kind: classifyMissionType(mission),
      objectiveTypeID: typeID,
      objectiveTypeName: typeID ? getItemName(itemTypesByID, typeID) : "",
      objectiveQuantity: toInt(mission.courierMission.objectiveQuantity, 0),
      objectiveSingleton: toInt(mission.courierMission.objectiveSingleton, 0),
    };
  }
  return {
    kind: missionType,
  };
}

function normalizeMission(mission, itemTypesByID = new Map()) {
  const missionType = classifyMissionType(mission);
  const objective = normalizeMissionObjective(mission, itemTypesByID);
  return {
    missionID: toInt(mission && mission.missionID, 0),
    name: missionName(mission),
    contentTemplate: normalizeText(mission && mission.contentTemplate),
    missionType,
    missionKind: normalizeText(mission && mission.missionKind),
    missionFlavor: normalizeText(mission && mission.missionFlavor),
    factionID: toInt(mission && mission.factionID, 0),
    corporationID: toInt(mission && mission.corporationID, 0),
    agentTypeID: toInt(mission && mission.agentTypeID, 0),
    fixedLpRewardAlpha: toInt(mission && mission.fixedLpRewardAlpha, 0),
    hasStandingRewards: mission && mission.hasStandingRewards === true,
    hasKillMission: Boolean(mission && mission.killMission),
    hasCourierMission: Boolean(mission && mission.courierMission),
    isStoryline: mission && mission.isStoryline === true,
    isEpicArc: mission && mission.isEpicArc === true,
    objective,
    dungeonID: toInt(objective.dungeonID, 0),
    linkedTemplateID: normalizeText(objective.templateID),
    raw: mission,
  };
}

function normalizeNpcProfile(profile, itemTypesByID) {
  return {
    profileID: normalizeText(profile && profile.profileID),
    name: normalizeText(profile && profile.name),
    entityType: normalizeText(profile && profile.entityType),
    shipTypeID: toInt(profile && profile.shipTypeID, 0),
    shipTypeName: getItemName(itemTypesByID, profile && profile.shipTypeID),
    presentationTypeID: toInt(profile && profile.presentationTypeID, 0),
    presentationTypeName: getItemName(itemTypesByID, profile && profile.presentationTypeID),
    factionID: toInt(profile && profile.factionID, 0),
    corporationID: toInt(profile && profile.corporationID, 0),
    behaviorProfileID: normalizeText(profile && profile.behaviorProfileID),
    loadoutID: normalizeText(profile && profile.loadoutID),
    lootTableID: normalizeText(profile && profile.lootTableID),
    bounty: toInt(profile && profile.bounty, 0),
    raw: profile,
  };
}

function normalizeNpcLoadout(row) {
  const modules = Array.isArray(row && row.modules) ? row.modules : [];
  const charges = Array.isArray(row && row.charges) ? row.charges : [];
  const cargo = Array.isArray(row && row.cargo) ? row.cargo : [];
  return {
    id: normalizeText(row && row.loadoutID),
    name: normalizeText(row && row.name),
    modulesCount: modules.length,
    chargesCount: charges.length,
    cargoCount: cargo.length,
    raw: row,
  };
}

function normalizeNpcLootTable(row) {
  const entries = Array.isArray(row && row.entries) ? row.entries : [];
  const guaranteedEntries = Array.isArray(row && row.guaranteedEntries)
    ? row.guaranteedEntries
    : [];
  return {
    id: normalizeText(row && row.lootTableID),
    name: normalizeText(row && row.name),
    minEntries: toInt(row && row.minEntries, 0),
    maxEntries: toInt(row && row.maxEntries, 0),
    entriesCount: entries.length,
    guaranteedEntriesCount: guaranteedEntries.length,
    allowDuplicates: row && row.allowDuplicates === true,
    raw: row,
  };
}

function normalizeNpcSpawnPool(row) {
  const entries = Array.isArray(row && row.entries) ? row.entries : [];
  return {
    id: normalizeText(row && row.spawnPoolID),
    name: normalizeText(row && row.name),
    entityType: normalizeText(row && row.entityType),
    entriesCount: entries.length,
    totalWeight: entries.reduce((total, entry) => total + Math.max(0, Number(entry && entry.weight) || 0), 0),
    sampleProfiles: entries
      .slice(0, 5)
      .map((entry) => normalizeText(entry && entry.profileID))
      .filter(Boolean),
    raw: row,
  };
}

function normalizeNpcSpawnGroup(row) {
  const entries = Array.isArray(row && row.entries) ? row.entries : [];
  const memberCount = entries.reduce((total, entry) => {
    const count = toInt(entry && entry.count, 0);
    const minCount = toInt(entry && entry.minCount, 0);
    const maxCount = toInt(entry && entry.maxCount, 0);
    return total + Math.max(count, minCount, maxCount, 1);
  }, 0);
  return {
    id: normalizeText(row && row.spawnGroupID),
    name: normalizeText(row && row.name),
    entityType: normalizeText(row && row.entityType),
    entriesCount: entries.length,
    memberCount,
    sampleMembers: entries
      .slice(0, 5)
      .map((entry) => normalizeText(entry && (entry.profileID || entry.spawnPoolID)))
      .filter(Boolean),
    raw: row,
  };
}

function addResourceType(target, itemTypesByID, typeID, kind) {
  const id = toInt(typeID, 0);
  if (!id) return;
  const row = itemTypesByID.get(id);
  if (!row) return;
  const name = normalizeText(row.name || row.typeName);
  if (!name) return;
  if (/blueprint|compressed|batch compressed|mining crystal|non-interactable/i.test(name)) return;

  const existing = target.get(id);
  if (existing) {
    existing.kinds.add(kind);
    return;
  }
  target.set(id, {
    typeID: id,
    name,
    kind,
    kinds: new Set([kind]),
    groupID: toInt(row.groupID, 0),
    categoryID: toInt(row.categoryID, 0),
  });
}

function buildResourceTypes(templates, itemTypesByID) {
  const resourceMap = new Map();
  for (const template of templates) {
    const composition = template.raw && template.raw.resourceComposition && typeof template.raw.resourceComposition === "object"
      ? template.raw.resourceComposition
      : {};
    for (const typeID of Array.isArray(composition.oreTypeIDs) ? composition.oreTypeIDs : []) {
      addResourceType(resourceMap, itemTypesByID, typeID, "ore");
    }
    for (const typeID of Array.isArray(composition.gasTypeIDs) ? composition.gasTypeIDs : []) {
      addResourceType(resourceMap, itemTypesByID, typeID, "gas");
    }
    for (const typeID of Array.isArray(composition.iceTypeIDs) ? composition.iceTypeIDs : []) {
      addResourceType(resourceMap, itemTypesByID, typeID, "ice");
    }
  }

  const kindOrder = { ore: 1, ice: 2, gas: 3 };
  return [...resourceMap.values()]
    .map((entry) => ({
      typeID: entry.typeID,
      name: entry.name,
      kind: [...entry.kinds].sort((a, b) => (kindOrder[a] || 9) - (kindOrder[b] || 9)).join(","),
      groupID: entry.groupID,
      categoryID: entry.categoryID,
    }))
    .sort((a, b) => (kindOrder[a.kind] || 9) - (kindOrder[b.kind] || 9) || a.name.localeCompare(b.name));
}

function buildMissionTemplateTypeIndex(missions) {
  const index = new Map();
  for (const mission of missions) {
    if (!mission.linkedTemplateID || !mission.missionType) continue;
    if (!index.has(mission.linkedTemplateID)) {
      index.set(mission.linkedTemplateID, new Map());
    }
    const counts = index.get(mission.linkedTemplateID);
    counts.set(mission.missionType, (counts.get(mission.missionType) || 0) + 1);
  }
  return index;
}

function annotateTemplatesWithMissionTypes(templates, missionTemplateTypeIndex) {
  const priority = ["combat", "mining", "courier", "trade", "talk_to_agent", "agent_interaction", "other"];
  return templates.map((template) => {
    const counts = missionTemplateTypeIndex.get(template.templateID);
    if (!counts) {
      return {
        ...template,
        missionTypes: [],
        primaryMissionType: "",
      };
    }
    const missionTypes = [...counts.keys()].sort((a, b) => (
      (priority.indexOf(a) === -1 ? 99 : priority.indexOf(a)) -
      (priority.indexOf(b) === -1 ? 99 : priority.indexOf(b))
    ));
    return {
      ...template,
      contentFamily: "mission",
      delivery: "mission_private",
      missionTypes,
      primaryMissionType: missionTypes[0] || "",
      missionReferenceCount: [...counts.values()].reduce((sum, count) => sum + count, 0),
    };
  });
}

function buildCatalog(dataDir = activeDataDir()) {
  const solarSystems = getRows(readCatalogTable(dataDir, "solarSystems"), "solarSystems");
  const stargates = getRows(readCatalogTable(dataDir, "stargates"), "stargates");
  const itemTypes = getRows(readCatalogTable(dataDir, "itemTypes"), "types");
  const dungeonAuthority = readCatalogTable(dataDir, "dungeonAuthority");
  const missionAuthority = readCatalogTable(dataDir, "missionAuthority");
  const npcProfiles = getRows(readTable(dataDir, "npcProfiles"), "profiles");
  const npcLoadouts = getRows(readTable(dataDir, "npcLoadouts"), "loadouts");
  const npcBehaviorProfiles = getRows(readTable(dataDir, "npcBehaviorProfiles"), "behaviorProfiles");
  const npcLootTables = getRows(readTable(dataDir, "npcLootTables"), "lootTables");
  const npcSpawnPools = getRows(readTable(dataDir, "npcSpawnPools"), "spawnPools");
  const npcSpawnGroups = getRows(readTable(dataDir, "npcSpawnGroups"), "spawnGroups");
  const npcSpawnSites = getRows(readTable(dataDir, "npcSpawnSites"), "spawnSites");
  const npcStartupRules = getRows(readTable(dataDir, "npcStartupRules"), "startupRules");

  const systemsByID = buildMap(solarSystems, "solarSystemID");
  const itemTypesByID = buildMap(itemTypes, "typeID");
  const stargatesBySystem = new Map();
  for (const gate of stargates) {
    const systemID = toInt(gate && gate.solarSystemID, 0);
    if (!systemID) continue;
    if (!stargatesBySystem.has(systemID)) stargatesBySystem.set(systemID, []);
    stargatesBySystem.get(systemID).push(normalizeStargate(gate, systemsByID));
  }

  const systems = solarSystems.map((row) => normalizeSystem(row, stargatesBySystem));
  const rawTemplates = Object.entries(dungeonAuthority.templatesByID || {})
    .map(([templateID, template]) => normalizeTemplate({ ...template, templateID }, itemTypesByID));
  const missions = Object.values(missionAuthority.missionsByID || {})
    .map((mission) => normalizeMission(mission, itemTypesByID));
  const missionTemplateTypeIndex = buildMissionTemplateTypeIndex(missions);
  const templates = annotateTemplatesWithMissionTypes(rawTemplates, missionTemplateTypeIndex);
  const resourceTypes = buildResourceTypes(templates, itemTypesByID);
  const npc = {
    profiles: npcProfiles.map((profile) => normalizeNpcProfile(profile, itemTypesByID)),
    loadouts: npcLoadouts.map((row) => normalizeNpcLoadout(row)),
    behaviorProfiles: npcBehaviorProfiles.map((row) => ({ id: normalizeText(row && row.behaviorProfileID), name: normalizeText(row && row.name), raw: row })),
    lootTables: npcLootTables.map((row) => normalizeNpcLootTable(row)),
    spawnPools: npcSpawnPools.map((row) => normalizeNpcSpawnPool(row)),
    spawnGroups: npcSpawnGroups.map((row) => normalizeNpcSpawnGroup(row)),
    spawnSites: npcSpawnSites.map((row) => ({ id: normalizeText(row && row.spawnSiteID), name: normalizeText(row && row.name), raw: row })),
    startupRules: npcStartupRules.map((row) => ({ id: normalizeText(row && row.startupRuleID), name: normalizeText(row && row.name), raw: row })),
  };

  return {
    dataDir,
    builtAt: new Date().toISOString(),
    systems,
    systemsByID: new Map(systems.map((system) => [system.solarSystemID, system])),
    stargatesBySystem,
    stargatesByID: new Map(stargates.map((gate) => [toInt(gate && gate.itemID, 0), normalizeStargate(gate, systemsByID)])),
    itemTypes: itemTypes.map((row) => ({
      typeID: toInt(row && row.typeID, 0),
      name: normalizeText(row && (row.name || row.typeName)),
      groupID: toInt(row && row.groupID, 0),
      categoryID: toInt(row && row.categoryID, 0),
      raw: row,
    })),
    itemTypesByID: new Map(itemTypes.map((row) => [toInt(row && row.typeID, 0), row])),
    resourceTypes,
    resourceTypesByID: new Map(resourceTypes.map((row) => [row.typeID, row])),
    templates,
    templatesByID: new Map(templates.map((template) => [template.templateID, template])),
    missions,
    missionsByID: new Map(missions.map((mission) => [mission.missionID, mission])),
    npc,
    npcProfilesByID: new Map(npc.profiles.map((profile) => [profile.profileID, profile])),
    npcLoadoutsByID: new Map(npc.loadouts.map((row) => [row.id, row])),
    npcBehaviorProfilesByID: new Map(npc.behaviorProfiles.map((row) => [row.id, row])),
    npcLootTablesByID: new Map(npc.lootTables.map((row) => [row.id, row])),
    npcSpawnPoolsByID: new Map(npc.spawnPools.map((row) => [row.id, row])),
    npcSpawnGroupsByID: new Map(npc.spawnGroups.map((row) => [row.id, row])),
    summary: {
      systemCount: systems.length,
      stargateCount: stargates.length,
      itemTypeCount: itemTypes.length,
      resourceTypeCount: resourceTypes.length,
      templateCount: templates.length,
      combatAnomalyCount: templates.filter((template) => template.siteFamily === "combat" && template.siteKind === "anomaly").length,
      oreAnomalyCount: templates.filter((template) => template.siteFamily === "ore" && template.siteKind === "anomaly").length,
      missionCount: missions.length,
      missionCombatCount: missions.filter((mission) => mission.missionType === "combat").length,
      missionCourierCount: missions.filter((mission) => mission.missionType === "courier").length,
      missionMiningCount: missions.filter((mission) => mission.missionType === "mining").length,
      missionTradeCount: missions.filter((mission) => mission.missionType === "trade").length,
      npcProfileCount: npc.profiles.length,
      npcLoadoutCount: npc.loadouts.length,
      npcBehaviorProfileCount: npc.behaviorProfiles.length,
      npcSpawnGroupCount: npc.spawnGroups.length,
      npcStartupRuleCount: npc.startupRules.length,
    },
  };
}

function getCatalog(options = {}) {
  const dataDir = options.dataDir || activeDataDir();
  if (!cache || cache.dataDir !== dataDir || options.force === true) {
    cache = buildCatalog(dataDir);
  }
  return cache;
}

function searchRows(rows, query, fields, limit) {
  const needle = normalizeSearch(query);
  const capped = limitValue(limit);
  const filtered = needle
    ? rows.filter((row) => fields.some((field) => normalizeSearch(row && row[field]).includes(needle)))
    : rows;
  return filtered.slice(0, capped).map((row) => {
    const next = { ...row };
    delete next.raw;
    return next;
  });
}

function legacyKindToTemplateFilters(kind) {
  const normalized = normalizeSearch(kind);
  if (normalized === "combat" || normalized === "combat_anomaly") {
    return { contentFamily: "combat", delivery: "anomaly" };
  }
  if (normalized === "ore" || normalized === "ore_anomaly") {
    return { contentFamily: "resource", delivery: "anomaly" };
  }
  if (normalized === "mission-combat" || normalized === "mission_combat") {
    return { contentFamily: "mission", delivery: "mission_private" };
  }
  return {};
}

function searchResourceRows(rows, query, limit) {
  const needle = normalizeSearch(query);
  const capped = limitValue(limit);
  const scored = rows
    .map((row) => {
      if (!needle) return { row, score: 10 };
      const name = normalizeSearch(row.name);
      const typeID = String(row.typeID || "");
      const kind = normalizeSearch(row.kind);
      if (typeID === needle) return { row, score: 0 };
      if (name === needle) return { row, score: 1 };
      if (name.startsWith(needle)) return { row, score: 2 };
      if (kind === needle) return { row, score: 3 };
      if (name.includes(needle)) return { row, score: 4 };
      if (typeID.includes(needle)) return { row, score: 5 };
      if (kind.includes(needle)) return { row, score: 6 };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score || a.row.name.localeCompare(b.row.name));
  return scored.slice(0, capped).map((entry) => ({ ...entry.row }));
}

function listSystems(query, limit) {
  return searchRows(getCatalog().systems, query, ["name", "solarSystemID", "securityBand"], limit);
}

function getSystem(systemID) {
  const catalog = getCatalog();
  const system = catalog.systemsByID.get(toInt(systemID, 0));
  if (!system) return null;
  return {
    ...system,
    stargates: clone(catalog.stargatesBySystem.get(system.solarSystemID) || []),
  };
}

function listTemplates(filters = {}, query, limit) {
  const catalog = getCatalog();
  let rows = catalog.templates;
  const normalizedFilters = typeof filters === "string"
    ? legacyKindToTemplateFilters(filters)
    : {
      ...legacyKindToTemplateFilters(filters && filters.kind),
      ...filters,
    };
  const contentFamily = normalizeSearch(normalizedFilters.contentFamily);
  const delivery = normalizeSearch(normalizedFilters.delivery);
  const missionType = normalizeSearch(normalizedFilters.missionType);
  if (contentFamily === "mission" && delivery === "mission_private" && missionType && missionType !== "all") {
    rows = rows.filter((row) => Array.isArray(row.missionTypes) && row.missionTypes.includes(missionType));
    return searchRows(rows, query, ["name", "templateID", "siteFamily", "siteKind", "contentFamily", "delivery", "primaryMissionType", "missionTypes"], limit);
  }
  if (contentFamily) {
    rows = rows.filter((row) => row.contentFamily === contentFamily);
  }
  if (delivery) {
    rows = rows.filter((row) => row.delivery === delivery);
  }
  if (contentFamily === "mission" && missionType && missionType !== "all") {
    rows = rows.filter((row) => Array.isArray(row.missionTypes) && row.missionTypes.includes(missionType));
  }
  return searchRows(rows, query, ["name", "templateID", "siteFamily", "siteKind", "contentFamily", "delivery", "primaryMissionType", "missionTypes"], limit);
}

function getTemplateByID(templateID) {
  const template = getCatalog().templatesByID.get(normalizeText(templateID));
  return template ? clone(template) : null;
}

async function deleteTemplateFromClone(templateID) {
  const requestedID = normalizeText(templateID);
  if (!requestedID) {
    return {
      success: false,
      errorMsg: "TEMPLATE_ID_REQUIRED",
      error: "Template ID is required.",
    };
  }
  if (!fs.existsSync(CLONE_DATA_DIR)) {
    return {
      success: false,
      errorMsg: "CLONE_REQUIRED",
      error: "Server-template deletion is only allowed after cloning the EveJS database into the utility workspace.",
    };
  }

  const filePath = tablePath(CLONE_DATA_DIR, "dungeonAuthority");
  const authority = readJsonFile(filePath);
  const templatesByID = authority.templatesByID && typeof authority.templatesByID === "object"
    ? authority.templatesByID
    : {};
  const templateKey = Object.prototype.hasOwnProperty.call(templatesByID, requestedID)
    ? requestedID
    : Object.keys(templatesByID).find((key) => normalizeText(key) === requestedID);
  if (!templateKey) {
    return {
      success: false,
      errorMsg: "TEMPLATE_NOT_FOUND",
      error: `Template ${requestedID} was not found in the cloned server catalog.`,
    };
  }

  const deletedRaw = templatesByID[templateKey];
  delete templatesByID[templateKey];
  if (authority.counts && typeof authority.counts === "object") {
    authority.counts.templateCount = Object.keys(templatesByID).length;
  }
  await writeJsonFileAtomic(filePath, authority);
  getCatalog({ dataDir: CLONE_DATA_DIR, force: true });

  return {
    success: true,
    deletedTemplate: {
      templateID: templateKey,
      name: getTemplateName({ ...deletedRaw, templateID: templateKey }),
      siteFamily: normalizeText(deletedRaw && deletedRaw.siteFamily),
      siteKind: normalizeText(
        deletedRaw && deletedRaw.siteKind ||
        deletedRaw && deletedRaw.populationHints && deletedRaw.populationHints.siteKind,
      ),
    },
  };
}

function listMissions(query, limit, filters = {}) {
  let rows = getCatalog().missions;
  const missionType = normalizeSearch(
    typeof filters === "string" ? filters : filters && filters.missionType,
  );
  if (missionType && missionType !== "all") {
    rows = rows.filter((mission) => mission.missionType === missionType);
  }
  return searchRows(rows, query, ["name", "missionID", "contentTemplate", "missionType", "missionKind", "missionFlavor", "linkedTemplateID"], limit);
}

function listNpc(kind, query, limit) {
  const catalog = getCatalog();
  const key = normalizeText(kind || "profiles");
  const rows = catalog.npc[key] || catalog.npc.profiles;
  const fieldsByKind = {
    profiles: ["profileID", "name", "shipTypeName", "entityType", "loadoutID", "lootTableID"],
    loadouts: ["id", "name"],
    behaviorProfiles: ["id", "name"],
    lootTables: ["id", "name"],
    spawnPools: ["id", "name", "entityType", "sampleProfiles"],
    spawnGroups: ["id", "name", "entityType", "sampleMembers"],
    spawnSites: ["id", "name"],
    startupRules: ["id", "name"],
  };
  const fields = fieldsByKind[key] || ["id", "name"];
  return searchRows(rows, query, fields, limit);
}

function getRawNpc(kind, id) {
  const catalog = getCatalog();
  const key = normalizeText(kind || "profiles");
  const rows = catalog.npc[key] || [];
  const row = rows.find((entry) => {
    if (key === "profiles") return entry.profileID === id;
    return entry.id === id;
  });
  return row ? clone(row.raw || row) : null;
}

// Resolve NPC source IDs (profile / spawn pool / spawn group) to display info for the editor.
function resolveNpc(ids) {
  const catalog = getCatalog();
  const list = Array.isArray(ids) ? ids : [ids];
  const out = [];
  const seen = new Set();
  list.forEach((rawID) => {
    const id = normalizeText(rawID);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const profile = catalog.npcProfilesByID.get(id);
    if (profile) {
      out.push({
        id,
        kind: "profile",
        name: profile.name || id,
        shipTypeName: profile.shipTypeName || "",
        presentationTypeName: profile.presentationTypeName || "",
        bounty: profile.bounty || 0,
      });
      return;
    }
    const pool = catalog.npcSpawnPoolsByID.get(id);
    if (pool) {
      out.push({
        id,
        kind: "pool",
        name: pool.name || id,
        shipTypeName: "",
        sampleProfiles: Array.isArray(pool.sampleProfiles) ? pool.sampleProfiles : [],
      });
      return;
    }
    const group = catalog.npcSpawnGroupsByID.get(id);
    if (group) {
      out.push({
        id,
        kind: "group",
        name: group.name || id,
        shipTypeName: "",
        sampleMembers: Array.isArray(group.sampleMembers) ? group.sampleMembers : [],
      });
      return;
    }
    out.push({ id, kind: "unknown", name: id, shipTypeName: "" });
  });
  return out;
}

function resolveNames(payload = {}) {
  const catalog = getCatalog();
  const spawnScope = payload.spawnScope && typeof payload.spawnScope === "object"
    ? payload.spawnScope
    : {};
  const systemID = toInt(spawnScope.solarSystemID || payload.solarSystemID, 0);
  const anchorID = toInt(
    spawnScope.stargateID ||
    payload && payload.placement && payload.placement.anchorID,
    0,
  );
  const baseTemplateID = normalizeText(payload.baseTemplateID);
  return {
    solarSystem: systemID ? catalog.systemsByID.get(systemID) || null : null,
    stargate: anchorID ? catalog.stargatesByID.get(anchorID) || null : null,
    baseTemplate: baseTemplateID ? catalog.templatesByID.get(baseTemplateID) || null : null,
  };
}

function listResourceTypes(query, limit) {
  return searchResourceRows(getCatalog().resourceTypes, query, limit)
    .map((row) => ({
      typeID: row.typeID,
      name: row.name,
      kind: row.kind,
    }));
}

module.exports = {
  activeDataDir,
  deleteTemplateFromClone,
  getCatalog,
  getRawNpc,
  getSystem,
  getTemplateByID,
  listMissions,
  listNpc,
  listResourceTypes,
  listSystems,
  listTemplates,
  resolveNames,
  resolveNpc,
};
