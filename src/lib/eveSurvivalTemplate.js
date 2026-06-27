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
  };
}

function buildObjectiveHints(mission) {
  if (!mission.blitz) return [];
  return [{ kind: "blitz", text: mission.blitz, source: "eve-survival" }];
}

// Patch an EXISTING eve-survival template: replace spawn-bearing rooms + counts, preserve everything else.
function patchExistingTemplate(target, mission) {
  const rooms = buildRooms(mission);
  target.rooms = rooms;
  target.populationHints = buildPopulationHints(rooms, mission);
  target.objectiveHints = buildObjectiveHints(mission);
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
    spaceType: { kind: "unknown", hasAccelerationGates: null, allowsMwd: null, raw: mission.spaceType || "" },
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
      gateProfiles: [],
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
  spawnRaw,
};
