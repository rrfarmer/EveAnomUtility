const { loadCachedEveUniversityMission, groupNumber, normalizeKey, parseDistanceMeters } = require("./eveUniversityMission");

const STRUCTURE_TYPE_RULES = [
  {
    pattern: /\bhabitat\b|\bhabitation\b/i,
    typeID: 19559,
    typeNameCandidates: ["Habitation Module", "Habitation Module - Residential", "Habitat"],
  },
];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function slug(value, fallback = "objective") {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || fallback;
}

function mergeUniqueNames(...lists) {
  const result = [];
  const seen = new Set();
  for (const list of lists) {
    for (const name of Array.isArray(list) ? list : []) {
      const key = normalizeKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(name);
    }
  }
  return result;
}

function structureTypeForLabel(label) {
  const rule = STRUCTURE_TYPE_RULES.find((entry) => entry.pattern.test(String(label || "")));
  return rule ? { typeID: rule.typeID, typeNameCandidates: rule.typeNameCandidates.slice() } : { typeID: null, typeNameCandidates: [] };
}

function firstContentRoomIndex(rooms) {
  const index = (Array.isArray(rooms) ? rooms : []).findIndex((room) =>
    (Array.isArray(room && room.spawnEntries) && room.spawnEntries.length > 0) ||
    (Array.isArray(room && room.groups) && room.groups.some((group) =>
      Array.isArray(group && group.spawns) && group.spawns.length > 0)));
  return index >= 0 ? index : Math.max(0, (rooms || []).length - 1);
}

function inferObjectiveDistance(mission, universityStructure) {
  const labelKey = normalizeKey(universityStructure && universityStructure.label);
  const candidates = [];
  const pushCandidate = (text, priority) => {
    if (!text) return;
    const textKey = normalizeKey(text);
    const objectiveish = /mission\s*objective|objective/i.test(String(text || "")) ||
      (labelKey && textKey.includes(labelKey));
    candidates.push({ text, priority: objectiveish ? priority : priority + 10 });
  };

  pushCandidate(universityStructure && universityStructure.raw, 0);
  pushCandidate(mission && mission.objectiveText, 1);
  for (const room of Array.isArray(mission && mission.rooms) ? mission.rooms : []) {
    for (const note of room.notes || []) pushCandidate(note, 2);
    for (const group of room.groups || []) {
      for (const note of group.notes || []) pushCandidate(note, 2);
      pushCandidate(group.title, 8);
    }
  }

  for (const { text } of candidates.sort((left, right) => left.priority - right.priority)) {
    const distance = parseDistanceMeters(text);
    if (distance) return distance;
  }
  return null;
}

function positionOffsetForDistance(distance) {
  if (!distance) return null;
  const meters = Math.round((Number(distance.minMeters) + Number(distance.maxMeters || distance.minMeters)) / 2);
  return Number.isFinite(meters) && meters > 0 ? { x: meters, y: 0, z: 0 } : null;
}

function objectiveStructureFromUniversity(mission, structure, index) {
  const label = structure.label || "Objective Structure";
  const type = structureTypeForLabel(label);
  const distance = inferObjectiveDistance(mission, structure);
  const key = `objective:${slug(label)}:${index + 1}`;
  return {
    raw: structure.raw || `${structure.count || 1} x ${label}`,
    key,
    count: Math.max(1, Number(structure.count) || 1),
    entityKind: "killableStructure",
    killableStructure: true,
    objective: true,
    objectiveTarget: true,
    completionRole: "objective",
    blocksEncounterProgress: true,
    label,
    shipClass: label,
    shipNames: [label],
    candidateNames: [label],
    typeID: type.typeID,
    typeNameCandidates: type.typeNameCandidates,
    distance,
    positionOffset: positionOffsetForDistance(distance),
    source: "eve-university",
    sourceEvidence: {
      objectiveOnDestruction: structure.objectiveOnDestruction === true,
      raw: structure.raw || "",
      url: mission && mission.sourceMerge && mission.sourceMerge.eveUniversityUrl || "",
    },
  };
}

function sourceSpawnRowsFromUniversity(university) {
  const rows = [];
  for (const group of Array.isArray(university && university.groups) ? university.groups : []) {
    for (const spawn of Array.isArray(group.spawns) ? group.spawns : []) {
      rows.push({
        group: group.title,
        groupNumber: groupNumber(group.title),
        count: spawn.count,
        shipClass: spawn.shipClass,
        shipNames: spawn.shipNames || spawn.candidateNames || [],
        distance: group.distance,
        raw: spawn.raw,
      });
    }
  }
  return rows;
}

function mergeNpcCandidateNames(mission, university) {
  const universityRows = sourceSpawnRowsFromUniversity(university);
  const byGroup = new Map();
  for (const row of universityRows) {
    const number = row.groupNumber;
    if (!number) continue;
    if (!byGroup.has(number)) byGroup.set(number, []);
    byGroup.get(number).push(row);
  }

  for (const room of Array.isArray(mission.rooms) ? mission.rooms : []) {
    for (const group of Array.isArray(room.groups) ? room.groups : []) {
      const number = groupNumber(group.title);
      const universityGroupRows = byGroup.get(number) || [];
      if (!number || universityGroupRows.length <= 0) continue;
      if (!group.distance && universityGroupRows[0].distance) group.distance = clone(universityGroupRows[0].distance);
      for (let index = 0; index < (group.spawns || []).length; index += 1) {
        const spawn = group.spawns[index];
        const match = universityGroupRows[index] || universityGroupRows.find((row) =>
          Number(row.count) === Number(spawn.count) &&
          normalizeKey(row.shipClass) === normalizeKey(spawn.shipClass));
        if (!match) continue;
        spawn.shipNames = mergeUniqueNames(spawn.shipNames, match.shipNames);
        spawn.candidateNames = mergeUniqueNames(spawn.candidateNames || spawn.shipNames, match.shipNames);
        spawn.sourceEvidence = {
          ...(spawn.sourceEvidence || {}),
          eveUniversity: match.raw,
        };
      }
    }
  }
}

function appendUniqueNote(notes, note) {
  if (!note) return notes;
  const normalized = normalizeKey(note);
  if (!normalized) return notes;
  if ((notes || []).some((existing) => normalizeKey(existing) === normalized)) return notes;
  return [...(notes || []), note];
}

function mergeMissionSources(eveSurvivalMission, eveUniversityMission) {
  const mission = clone(eveSurvivalMission);
  if (!eveUniversityMission) return mission;

  mission.source = "eve-survival+eve-university";
  mission.sourceMerge = {
    strategy: "eve_survival_topology_eve_university_objectives",
    sources: ["eve-survival", "eve-university"],
    eveSurvivalUrl: mission.url || "",
    eveUniversityUrl: eveUniversityMission.url || "",
    eveUniversityPageKey: eveUniversityMission.pageKey || "",
  };

  mergeNpcCandidateNames(mission, eveUniversityMission);

  const contentRoomIndex = firstContentRoomIndex(mission.rooms || []);
  if (mission.rooms && mission.rooms[contentRoomIndex] && eveUniversityMission.pocketNote) {
    mission.rooms[contentRoomIndex].notes = appendUniqueNote(mission.rooms[contentRoomIndex].notes, eveUniversityMission.pocketNote);
  }

  const objectiveUniversityStructures = (eveUniversityMission.structures || [])
    .filter((structure) => structure.objectiveOnDestruction === true);
  const objectiveStructures = objectiveUniversityStructures
    .map((structure, index) => objectiveStructureFromUniversity(mission, structure, index));

  if (objectiveStructures.length > 0) {
    for (const structure of objectiveStructures) {
      structure.roomIndex = contentRoomIndex;
      structure.roomTitle = mission.rooms && mission.rooms[contentRoomIndex] ? mission.rooms[contentRoomIndex].title : "";
    }
    for (const room of mission.rooms || []) {
      for (const group of room.groups || []) group.objective = false;
    }
    mission.objectiveStructures = objectiveStructures;
    mission.structures = [
      ...(Array.isArray(mission.structures) ? mission.structures : []),
      ...objectiveStructures,
    ];
    mission.completion = {
      mode: "objective_target_destroyed",
      completeObjectiveOnEncounterClear: false,
      objectiveTargets: objectiveStructures.map((structure) => ({
        key: structure.key,
        label: structure.label,
        typeID: structure.typeID || null,
      })),
      despawnDelaySeconds: 0,
    };
  }

  mission.objectiveText = eveUniversityMission.objectiveText || mission.objectiveText || "";
  mission.blitz = mission.blitz || eveUniversityMission.blitz || "";
  mission.bestDamageToDeal = eveUniversityMission.details && eveUniversityMission.details["Best damage to deal"] || "";
  mission.damageToResist = eveUniversityMission.details && eveUniversityMission.details["Damage to resist"] || "";
  mission.sourceLinks = [
    { label: "Eve-Survival", url: mission.url || "" },
    { label: "Eve University", url: eveUniversityMission.url || "" },
  ].filter((entry) => entry.url);

  return mission;
}

function enrichMissionFromLocalSources(mission, options = {}) {
  if (options.mergeSources === false) return mission;
  const university = options.eveUniversityMission || loadCachedEveUniversityMission(mission, options);
  if (!university) return mission;
  return mergeMissionSources(mission, university);
}

module.exports = {
  enrichMissionFromLocalSources,
  firstContentRoomIndex,
  mergeMissionSources,
  sourceSpawnRowsFromUniversity,
  structureTypeForLabel,
};
