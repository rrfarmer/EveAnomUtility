/**
 * eveSurvivalTemplate.js
 *
 * Maps a normalized mission (from missionScraper) into the EveJS `eve-survival:<Wakka>` dungeon-authority
 * template shape, and patches an existing template's spawn data.
 *
 * EveJS reads NPC spawns from `rooms[].spawnEntries` AND `rooms[].groups[].spawnEntries`
 * (server/src/services/dungeon/dungeonUniverseSiteService.js), resolving `candidateNames` -> NPC profiles.
 * We author the group-nested form, which mirrors the eve-survival source pages.
 */

function spawnRaw(spawn) {
  return `${spawn.count}x ${spawn.shipClass} (${(spawn.shipNames || []).join("/")})`;
}

function buildSpawnEntry(spawn, distance) {
  const count = Math.max(1, Number(spawn.count) || 1);
  return {
    raw: spawnRaw(spawn),
    count: { min: count, max: count },
    entityKind: spawn.entityKind || "npc",
    label: spawn.shipClass || "",
    candidateNames: Array.isArray(spawn.shipNames) ? spawn.shipNames.slice() : [],
    tags: [],
    distance: distance || null,
  };
}

// Normalized mission -> EveJS template `rooms[]`.
function buildRooms(mission) {
  return (mission.rooms || []).map((room, roomIndex) => ({
    roomId: `room_${roomIndex + 1}`,
    title: room.title || `Pocket ${roomIndex + 1}`,
    source: "pocket",
    gateHint: room.gateHint || null,
    spawnEntries: [],
    groups: (room.groups || []).map((group, groupIndex) => ({
      groupId: `group_${groupIndex + 1}`,
      title: group.title || `Group ${groupIndex + 1}`,
      headingLevel: 4,
      distance: group.distance || null,
      objective: group.objective === true,
      spawnEntries: (group.spawns || []).map((spawn) => buildSpawnEntry(spawn, null)),
      notes: [],
    })),
    notes: [],
  }));
}

function countSpawnEntries(rooms) {
  let npc = 0;
  let total = 0;
  for (const room of rooms) {
    for (const entry of room.spawnEntries || []) { total += 1; if (entry.entityKind === "npc") npc += 1; }
    for (const group of room.groups || []) {
      for (const entry of group.spawnEntries || []) { total += 1; if (entry.entityKind === "npc") npc += 1; }
    }
  }
  return { total, npc };
}

// Mining-mission hints (Plan C3 fallback): from authored mining params
// (mission.mining = { oreTypeID|objectiveTypeID, quantity, rockCount? }) emit the special mineable
// asteroids + the objective quantity that EveJS reads (populationHints.miningRocks/objectiveQuantity).
// The per-rock yield is the objective spread across the rocks with a buffer so it's completable.
function buildMiningHints(mission) {
  const mining = mission && mission.mining;
  const oreTypeID = mining ? Number(mining.oreTypeID || mining.objectiveTypeID) || 0 : 0;
  const quantity = mining ? Math.max(0, Math.trunc(Number(mining.quantity) || 0)) : 0;
  if (oreTypeID <= 0 || quantity <= 0) return {};
  const rockCount = Math.max(1, Math.trunc(Number(mining.rockCount) || 8));
  const perRock = Math.max(1, Math.ceil((quantity * 1.5) / rockCount));
  return {
    objectiveTypeID: oreTypeID,
    objectiveQuantity: quantity,
    miningRocks: [{ typeID: oreTypeID, count: rockCount, quantity: perRock }],
  };
}

function buildPopulationHints(rooms, mission) {
  const counts = countSpawnEntries(rooms);
  return {
    source: "eve_anom_utility",
    roomCount: rooms.length,
    spawnEntryCount: counts.total,
    npcEntryCount: counts.npc,
    structureEntryCount: (mission.structures || []).length,
    objectiveHintCount: mission.blitz ? 1 : 0,
    triggerHintCount: 0,
    ...buildMiningHints(mission),
  };
}

function buildObjectiveHints(mission) {
  if (!mission.blitz) return [];
  return [{ kind: "blitz", text: mission.blitz, source: "eve-survival" }];
}

// "Acceleration Gate" item type (EveJS spawns it from siteSceneProfile.gateProfiles).
const ACCELERATION_GATE_TYPE_ID = 17831;

// True when the mission has any NPC spawns, i.e. it is a combat/encounter mission (as opposed to
// a courier/objective-only one). Combat missions are the ones that gate-start.
function missionLooksCombat(mission) {
  return (mission.rooms || []).some((room) =>
    (room.spawns || []).length > 0 ||
    (room.groups || []).some((group) => (group.spawns || []).length > 0));
}

// Acceleration-gate policy: combat/security missions gate-start BY DEFAULT (warp in to the gate,
// activate, fight the pocket). Non-combat missions and anomalies do not. An explicit
// `hasAccelerationGate` (e.g. scrape-apply --gate/--no-gate, or a Mission Designer toggle) always
// wins; `spaceType.hasAccelerationGates`/`gateDetected` are softer hints.
function missionHasAccelerationGate(mission) {
  if (mission.hasAccelerationGate === true) return true;
  if (mission.hasAccelerationGate === false) return false;
  if (mission.spaceType && mission.spaceType.hasAccelerationGates === true) return true;
  if (mission.gateDetected === true) return true;
  return missionLooksCombat(mission);
}

// When the mission has an acceleration gate, emit one gate from the warp-in landing into the
// first pocket. EveJS marks gate-destination rooms `on_room_active`, so the player warps in to
// just the gate, activates it, and the pocket's NPCs spawn on the far side — retail flow.
function buildGateProfiles(rooms, mission) {
  if (!missionHasAccelerationGate(mission) || rooms.length === 0) return [];
  return [{
    gateKey: "gate:entry",
    label: "Acceleration Gate",
    typeID: ACCELERATION_GATE_TYPE_ID,
    typeNameCandidates: ["Acceleration Gate"],
    source: "eve_anom_utility",
    destinationRoomKey: `room:${rooms[0].roomId}`,
    fromObjectID: null,
    toObjectID: null,
  }];
}

// Patch an EXISTING eve-survival template: replace spawn-bearing rooms + counts, preserve everything else.
function patchExistingTemplate(target, mission) {
  const rooms = buildRooms(mission);
  target.rooms = rooms;
  target.populationHints = buildPopulationHints(rooms, mission);
  target.objectiveHints = buildObjectiveHints(mission);
  // Author the acceleration gate (or clear it) so the gate-first flow matches the scrape.
  target.siteSceneProfile = {
    ...(target.siteSceneProfile || {}),
    gateProfiles: buildGateProfiles(rooms, mission),
  };
  if (target.spaceType) target.spaceType.hasAccelerationGates = missionHasAccelerationGate(mission);
  if (mission.faction) target.faction = mission.faction;
  if (mission.damageToDeal || mission.ewar || mission.recommendedShip) {
    target.advisory = {
      ...(target.advisory || {}),
      damageToDeal: mission.damageToDeal || (target.advisory && target.advisory.damageToDeal) || "",
      ewar: mission.ewar || (target.advisory && target.advisory.ewar) || "",
      recommendedShip: mission.recommendedShip || (target.advisory && target.advisory.recommendedShip) || "",
    };
  }
  target.adminMetadata = {
    ...(target.adminMetadata || {}),
    authoredBy: "eve_anom_utility",
    authoredAt: new Date().toISOString(),
    sourceUrl: mission.url || "",
  };
  return target;
}

// Build a full template from scratch (for missions EveJS does not already have).
function buildTemplate(mission) {
  const wakka = mission.wakka || "Mission";
  const rooms = buildRooms(mission);
  return {
    templateID: `eve-survival:${wakka}`,
    source: "eve-survival",
    siteFamily: "mission",
    siteKind: "encounter",
    siteOrigin: "eve_anom_utility",
    title: mission.title || wakka,
    faction: mission.faction || "",
    missionLevel: mission.level || null,
    sourceMissionID: `eve-survival:${wakka}`,
    spaceType: { kind: "unknown", hasAccelerationGates: missionHasAccelerationGate(mission), allowsMwd: null, raw: mission.spaceType || "" },
    classification: {
      pageKind: "combat_structured",
      confidence: "authored",
      reasons: ["Authored by EveAnomUtility from eve-survival scrape"],
      flags: [],
    },
    rooms,
    missionParts: [],
    objectiveHints: buildObjectiveHints(mission),
    triggerHints: [],
    advisory: {
      damageToDeal: mission.damageToDeal || "",
      ewar: mission.ewar || "",
      recommendedShip: mission.recommendedShip || "",
    },
    populationHints: buildPopulationHints(rooms, mission),
    siteSceneProfile: {
      source: "eve_anom_utility",
      roomProfiles: rooms.map((room) => ({ key: `room:${room.roomId}`, label: room.title })),
      gateProfiles: buildGateProfiles(rooms, mission),
      structureProfiles: [],
      objectiveVisualProfiles: [],
    },
    adminMetadata: { authoredBy: "eve_anom_utility", authoredAt: new Date().toISOString(), sourceUrl: mission.url || "" },
  };
}

module.exports = {
  buildRooms,
  buildPopulationHints,
  buildTemplate,
  patchExistingTemplate,
  missionHasAccelerationGate,
  spawnRaw,
};
