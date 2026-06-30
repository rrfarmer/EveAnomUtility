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

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function spawnRaw(spawn) {
  if (spawn && spawn.raw) return spawn.raw;
  return `${spawn.count}x ${spawn.shipClass} (${(spawn.shipNames || []).join("/")})`;
}

function buildSpawnEntry(spawn, distance) {
  const count = Math.max(1, Number(spawn.count) || 1);
  const entry = {
    raw: spawnRaw(spawn),
    count: { min: count, max: count },
    entityKind: spawn.entityKind || "npc",
    label: spawn.label || spawn.shipClass || "",
    candidateNames: uniqueStrings([
      ...(Array.isArray(spawn.candidateNames) ? spawn.candidateNames : []),
      ...(Array.isArray(spawn.shipNames) ? spawn.shipNames : []),
    ]),
    tags: Array.isArray(spawn.tags) ? spawn.tags.slice() : [],
    distance: distance || spawn.distance || null,
  };

  const passthroughFields = [
    "key",
    "typeID",
    "typeNameCandidates",
    "objective",
    "objectiveTarget",
    "completionRole",
    "killableStructure",
    "blocksEncounterProgress",
    "blocksWaveProgress",
    "blocksObjectiveProgress",
    "positionOffset",
    "source",
    "sourceEvidence",
    "dunObjectID",
    "dunObjectNameID",
    "nameID",
    "ownerID",
    "suppressSlimName",
    "slimName",
    "objectiveTargetGroup",
  ];
  for (const field of passthroughFields) {
    if (Object.prototype.hasOwnProperty.call(spawn || {}, field)) entry[field] = clone(spawn[field]);
  }
  if (Array.isArray(spawn.shipNames)) entry.shipNames = spawn.shipNames.slice();
  if (spawn.shipClass) entry.shipClass = spawn.shipClass;
  return entry;
}

// Normalized mission -> EveJS template `rooms[]`.
function listObjectiveStructures(mission) {
  return (Array.isArray(mission && mission.objectiveStructures) ? mission.objectiveStructures : [])
    .filter((entry) => entry && typeof entry === "object");
}

function expandedObjectiveStructures(mission) {
  const expanded = [];
  for (const structure of listObjectiveStructures(mission)) {
    const count = Math.max(1, Number(structure.count) || 1);
    for (let index = 0; index < count; index += 1) {
      expanded.push({
        ...clone(structure),
        count: 1,
        key: count === 1 ? structure.key : `${structure.key || "objective"}:${index + 1}`,
      });
    }
  }
  return expanded;
}

function roomHasSpawnContent(room) {
  return Boolean(
    (Array.isArray(room && room.spawnEntries) && room.spawnEntries.length > 0) ||
      (Array.isArray(room && room.groups) && room.groups.some((group) =>
        Array.isArray(group && group.spawnEntries) && group.spawnEntries.length > 0)),
  );
}

function firstContentRoomIndexFromBuiltRooms(rooms) {
  const index = (Array.isArray(rooms) ? rooms : []).findIndex(roomHasSpawnContent);
  return index >= 0 ? index : 0;
}

function roomIndexForObjectiveStructure(rooms, structure) {
  const requestedIndex = Number(structure && structure.roomIndex);
  if (Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < rooms.length) {
    return requestedIndex;
  }
  return firstContentRoomIndexFromBuiltRooms(rooms);
}

function appendObjectiveStructuresToRooms(rooms, mission) {
  const structures = expandedObjectiveStructures(mission);
  if (structures.length <= 0 || rooms.length <= 0) return rooms;
  const byRoom = new Map();
  for (const structure of structures) {
    const roomIndex = roomIndexForObjectiveStructure(rooms, structure);
    if (!byRoom.has(roomIndex)) byRoom.set(roomIndex, []);
    byRoom.get(roomIndex).push(structure);
  }
  for (const [roomIndex, roomStructures] of byRoom.entries()) {
    const labels = uniqueStrings(roomStructures.map((entry) => entry.label || entry.shipClass || "Objective Structure"));
    rooms[roomIndex].groups.push({
      groupId: "objective_structures",
      title: "Objective Structures",
      headingLevel: 4,
      distance: roomStructures[0].distance || null,
      objective: true,
      spawnEntries: roomStructures.map((structure) => buildSpawnEntry(structure, structure.distance || null)),
      notes: labels.map((label) => `Mission objective: destroy ${label}`),
    });
  }
  return rooms;
}

function buildRooms(mission) {
  const rooms = (mission.rooms || []).map((room, roomIndex) => ({
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
      notes: Array.isArray(group.notes) ? group.notes.slice() : [],
    })),
    notes: Array.isArray(room.notes) ? room.notes.slice() : [],
  }));
  return appendObjectiveStructuresToRooms(rooms, mission);
}

function countSpawnEntries(rooms) {
  let npc = 0;
  let structure = 0;
  let total = 0;
  for (const room of rooms) {
    for (const entry of room.spawnEntries || []) {
      total += 1;
      if (entry.entityKind === "npc") npc += 1;
      else if (/structure/i.test(entry.entityKind || "")) structure += 1;
    }
    for (const group of room.groups || []) {
      for (const entry of group.spawnEntries || []) {
        total += 1;
        if (entry.entityKind === "npc") npc += 1;
        else if (/structure/i.test(entry.entityKind || "")) structure += 1;
      }
    }
  }
  return { total, npc, structure };
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

function roomKeyForIndex(rooms, index) {
  const room = rooms[index] || rooms[0];
  return room ? `room:${room.roomId}` : "room:entry";
}

function gateDestinationRoomIndex(rooms, mission) {
  if (!missionHasAccelerationGate(mission) || rooms.length <= 0) return -1;
  return firstContentRoomIndexFromBuiltRooms(rooms);
}

function triggerForRoomIndex(rooms, mission, roomIndex) {
  if (missionHasAccelerationGate(mission) && roomIndex === gateDestinationRoomIndex(rooms, mission)) {
    return "on_room_active";
  }
  return roomIndex <= 0 ? "on_load" : "wave_cleared";
}

function buildObjectiveStructureEncounters(rooms, mission) {
  const structures = expandedObjectiveStructures(mission)
    .filter((entry) => Number(entry.typeID) > 0);
  if (structures.length <= 0 || rooms.length <= 0) return [];

  const byRoom = new Map();
  for (const structure of structures) {
    const roomIndex = roomIndexForObjectiveStructure(rooms, structure);
    if (!byRoom.has(roomIndex)) byRoom.set(roomIndex, []);
    byRoom.get(roomIndex).push(structure);
  }

  return [...byRoom.entries()].map(([roomIndex, roomStructures], index) => {
    const labels = uniqueStrings(roomStructures.map((entry) => entry.label || entry.shipClass || "Objective Structure"));
    return {
      key: `objective_structures:${rooms[roomIndex].roomId}`,
      label: labels.length === 1 ? `Destroy ${labels[0]}` : "Destroy mission objective structures",
      supported: true,
      spawnQuery: "mission_objective_structure",
      amount: roomStructures.length,
      spawnEntries: roomStructures.map((structure) => buildSpawnEntry(structure, structure.distance || null)),
      exact: true,
      deadspace: true,
      trigger: triggerForRoomIndex(rooms, mission, roomIndex),
      waveIndex: index + 1,
      roomKey: roomKeyForIndex(rooms, roomIndex),
      objective: true,
      completionRole: "objective",
      notes: labels.map((label) => `Mission objective: destroy ${label}`),
    };
  });
}

function buildCompletion(mission) {
  if (mission && mission.completion && typeof mission.completion === "object") {
    return clone(mission.completion);
  }
  const structures = expandedObjectiveStructures(mission);
  if (structures.length <= 0) return null;
  return {
    mode: "objective_target_destroyed",
    completeObjectiveOnEncounterClear: false,
    objectiveTargets: structures.map((structure) => ({
      key: structure.key || null,
      label: structure.label || structure.shipClass || "Objective Structure",
      typeID: Number(structure.typeID) || null,
    })),
    despawnDelaySeconds: 0,
  };
}

function buildObjectiveMarkers(mission) {
  const structures = expandedObjectiveStructures(mission);
  if (structures.length > 0) {
    return structures.map((structure) => ({
      role: "objective",
      key: structure.key || undefined,
      label: `Destroy ${structure.label || structure.shipClass || "objective structure"}`,
    }));
  }
  return mission && mission.objectiveText
    ? [{ role: "objective", key: "mission_objective", label: mission.objectiveText }]
    : [];
}

function buildObjectiveVisualProfiles(rooms, mission) {
  return expandedObjectiveStructures(mission).map((structure) => {
    const roomIndex = roomIndexForObjectiveStructure(rooms, structure);
    return {
      role: "objective",
      key: structure.key || undefined,
      label: structure.label || structure.shipClass || "Objective Structure",
      typeID: Number(structure.typeID) || null,
      typeNameCandidates: Array.isArray(structure.typeNameCandidates) ? structure.typeNameCandidates.slice() : [],
      roomKey: roomKeyForIndex(rooms, roomIndex),
      positionOffset: structure.positionOffset ? clone(structure.positionOffset) : null,
      source: structure.source || "eve_anom_utility",
    };
  });
}

function buildPopulationHints(rooms, mission) {
  const counts = countSpawnEntries(rooms);
  const encounters = buildObjectiveStructureEncounters(rooms, mission);
  const completion = buildCompletion(mission);
  const objectiveMarkers = buildObjectiveMarkers(mission);
  const objectiveHints = buildObjectiveHints(mission);
  return {
    source: "eve_anom_utility",
    roomCount: rooms.length,
    spawnEntryCount: counts.total,
    npcEntryCount: counts.npc,
    structureEntryCount: Math.max(counts.structure, (mission.structures || []).length),
    objectiveHintCount: objectiveHints.length,
    triggerHintCount: 0,
    ...(encounters.length > 0 ? { encounters } : {}),
    ...(completion ? { completion } : {}),
    ...(objectiveMarkers.length > 0 ? { objectiveMarkers } : {}),
    ...buildMiningHints(mission),
  };
}

function buildObjectiveHints(mission) {
  const hints = [];
  if (mission.objectiveText) hints.push({ kind: "objective", text: mission.objectiveText, source: "eve-university" });
  if (mission.blitz) {
    hints.push({
      kind: "blitz",
      text: mission.blitz,
      source: mission.source && String(mission.source).includes("eve-university") ? "eve-university" : "eve-survival",
    });
  }
  const seen = new Set();
  return hints.filter((hint) => {
    const key = `${hint.kind}:${String(hint.text || "").toLowerCase()}`;
    if (!hint.text || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
// first content-bearing pocket. EveJS marks gate-destination rooms `on_room_active`, so the player
// warps in to just the gate, activates it, and the pocket content spawns on the far side.
function buildGateProfiles(rooms, mission) {
  if (!missionHasAccelerationGate(mission) || rooms.length === 0) return [];
  const destinationIndex = gateDestinationRoomIndex(rooms, mission);
  return [{
    gateKey: "gate:entry",
    label: "Acceleration Gate",
    typeID: ACCELERATION_GATE_TYPE_ID,
    typeNameCandidates: ["Acceleration Gate"],
    source: "eve_anom_utility",
    destinationRoomKey: roomKeyForIndex(rooms, destinationIndex),
    fromObjectID: null,
    toObjectID: null,
  }];
}

function buildRoomProfiles(rooms, mission) {
  const gated = missionHasAccelerationGate(mission);
  const profiles = [];
  if (gated) {
    profiles.push({
      roomKey: "room:entry",
      label: "Entry Pocket",
      source: "eve_anom_utility",
      initialState: "active",
      objectiveKeys: [],
    });
  }
  rooms.forEach((room, index) => {
    const objectiveKeys = expandedObjectiveStructures(mission)
      .filter((structure) => roomIndexForObjectiveStructure(rooms, structure) === index)
      .map((structure) => structure.key)
      .filter(Boolean);
    profiles.push({
      roomKey: `room:${room.roomId}`,
      label: room.title || `Pocket ${index + 1}`,
      source: "mission_room",
      initialState: gated || index > 0 ? "pending" : "active",
      objectiveKeys,
    });
  });
  return profiles;
}

// Patch an EXISTING eve-survival template: replace spawn-bearing rooms + counts, preserve everything else.
function patchExistingTemplate(target, mission) {
  const rooms = buildRooms(mission);
  target.source = mission.source || target.source || "eve-survival";
  target.sourceMissionID = mission.wakka ? `eve-survival:${mission.wakka}` : target.sourceMissionID;
  target.title = mission.title || target.title;
  target.missionLevel = mission.level || target.missionLevel || null;
  target.rooms = rooms;
  target.populationHints = buildPopulationHints(rooms, mission);
  target.objectiveHints = buildObjectiveHints(mission);
  // Author the acceleration gate (or clear it) so the gate-first flow matches the scrape.
  target.siteSceneProfile = {
    ...(target.siteSceneProfile || {}),
    roomProfiles: buildRoomProfiles(rooms, mission),
    gateProfiles: buildGateProfiles(rooms, mission),
    objectiveVisualProfiles: buildObjectiveVisualProfiles(rooms, mission),
  };
  if (target.spaceType) target.spaceType.hasAccelerationGates = missionHasAccelerationGate(mission);
  if (mission.faction) target.faction = mission.faction;
  if (mission.damageToDeal || mission.ewar || mission.recommendedShip || mission.bestDamageToDeal || mission.damageToResist) {
    target.advisory = {
      ...(target.advisory || {}),
      damageToDeal: mission.damageToDeal || (target.advisory && target.advisory.damageToDeal) || "",
      bestDamageToDeal: mission.bestDamageToDeal || (target.advisory && target.advisory.bestDamageToDeal) || "",
      damageToResist: mission.damageToResist || (target.advisory && target.advisory.damageToResist) || "",
      ewar: mission.ewar || (target.advisory && target.advisory.ewar) || "",
      recommendedShip: mission.recommendedShip || (target.advisory && target.advisory.recommendedShip) || "",
    };
  }
  target.adminMetadata = {
    ...(target.adminMetadata || {}),
    authoredBy: "eve_anom_utility",
    authoredAt: new Date().toISOString(),
    sourceUrl: mission.url || "",
    sourceUrls: Array.isArray(mission.sourceLinks) ? mission.sourceLinks : undefined,
    sourceMerge: mission.sourceMerge || undefined,
  };
  return target;
}

// Build a full template from scratch (for missions EveJS does not already have).
function buildTemplate(mission) {
  const wakka = mission.wakka || "Mission";
  const rooms = buildRooms(mission);
  return {
    templateID: `eve-survival:${wakka}`,
    source: mission.source || "eve-survival",
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
      reasons: [
        mission.source && String(mission.source).includes("eve-university")
          ? "Authored by EveAnomUtility from Eve-Survival topology plus Eve University objective data"
          : "Authored by EveAnomUtility from eve-survival scrape",
      ],
      flags: [],
    },
    rooms,
    missionParts: [],
    objectiveHints: buildObjectiveHints(mission),
    triggerHints: [],
    advisory: {
      damageToDeal: mission.damageToDeal || "",
      bestDamageToDeal: mission.bestDamageToDeal || "",
      damageToResist: mission.damageToResist || "",
      ewar: mission.ewar || "",
      recommendedShip: mission.recommendedShip || "",
    },
    populationHints: buildPopulationHints(rooms, mission),
    siteSceneProfile: {
      source: "eve_anom_utility",
      roomProfiles: buildRoomProfiles(rooms, mission),
      gateProfiles: buildGateProfiles(rooms, mission),
      structureProfiles: [],
      objectiveVisualProfiles: buildObjectiveVisualProfiles(rooms, mission),
    },
    adminMetadata: {
      authoredBy: "eve_anom_utility",
      authoredAt: new Date().toISOString(),
      sourceUrl: mission.url || "",
      sourceUrls: Array.isArray(mission.sourceLinks) ? mission.sourceLinks : undefined,
      sourceMerge: mission.sourceMerge || undefined,
    },
  };
}

module.exports = {
  buildRooms,
  buildPopulationHints,
  buildRoomProfiles,
  buildTemplate,
  patchExistingTemplate,
  missionHasAccelerationGate,
  spawnRaw,
};
