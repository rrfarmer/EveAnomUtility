const path = require("node:path");

const {
  OVERLAY_DIR,
  writeJsonFileAtomic,
} = require("./dataStore");
const { getCatalog } = require("./catalog");
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
  const profile = profileID ? catalog.npcProfilesByID.get(profileID) : null;
  const spawnGroup = spawnGroupID ? catalog.npcSpawnGroupsByID.get(spawnGroupID) : null;
  return {
    key: text(encounter && encounter.key) || `wave_${index + 1}`,
    label: text(encounter && encounter.label) || `Wave ${index + 1}`,
    trigger: text(encounter && encounter.trigger) || (index === 0 ? "on_load" : "wave_cleared"),
    count: Math.max(1, toInt(encounter && encounter.count, 1)),
    profileID: profileID || null,
    profileName: profile ? profile.name : null,
    spawnGroupID: spawnGroupID || null,
    spawnGroupName: spawnGroup ? spawnGroup.name : null,
    spawnPoolID: text(encounter && encounter.spawnPoolID) || null,
    delaySeconds: Math.max(0, Number(encounter && encounter.delaySeconds) || 0),
    orbitDistanceMeters: Number(encounter && encounter.orbitDistanceMeters) || null,
    leashRangeMeters: Number(encounter && encounter.leashRangeMeters) || null,
    targetPolicy: text(encounter && encounter.targetPolicy) || "nearest_player",
    notes: text(encounter && encounter.notes),
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
  return {
    profileID,
    profileName: profile ? profile.name : null,
    loadoutID: loadoutID || null,
    behaviorProfileID: behaviorProfileID || null,
    damageMultiplier: Number(override && override.damageMultiplier) || 1,
    bounty: Number.isFinite(Number(override && override.bounty)) ? Number(override.bounty) : null,
    preferredTargetMode: text(override && override.preferredTargetMode) || null,
    moduleOverrides: Array.isArray(override && override.moduleOverrides)
      ? clone(override.moduleOverrides)
      : [],
  };
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
  const authoredResources = (Array.isArray(overlay.resources) ? overlay.resources : [])
    .map((resource) => normalizeResource(catalog, resource))
    .filter((resource) => resource.typeID > 0);
  const resourceComposition = buildResourceComposition(authoredResources, siteFamily);
  const objectiveMarkers = buildObjectiveMarkers(siteFamily, encounters, resourceComposition);
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
    resourceComposition,
    populationHints: {
      source: "eve_anom_utility",
      siteFamily,
      siteKind,
      encounter: encounters[0] || null,
      encounters,
      containers: [],
      hazards: [],
      environmentProps: [],
      lootProfiles: [],
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
      roomProfiles: [
        {
          roomKey: "room:entry",
          label: "Entry Pocket",
        },
      ],
      gateProfiles: [],
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
    completion: overlay.completion || {},
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
  const overlays = await listOverlays();
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
  buildTemplatePack,
};
