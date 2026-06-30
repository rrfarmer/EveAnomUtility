const {
  getCatalog,
} = require("./catalog");

const THE_SCORE_GURISTAS_SOURCE_URL = "https://wiki.eveuniversity.org/The_Score_(Guristas_Pirates)_(Level_1)";

function text(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function slug(value) {
  return text(value, "mission")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "mission";
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function findMission(missionID) {
  const catalog = getCatalog();
  const id = toInt(missionID, 0);
  return id > 0 ? catalog.missionsByID.get(id) || null : null;
}

function firstBaseGate(baseTemplate) {
  const raw = baseTemplate && baseTemplate.raw && typeof baseTemplate.raw === "object"
    ? baseTemplate.raw
    : {};
  const gateProfile = Array.isArray(raw.siteSceneProfile && raw.siteSceneProfile.gateProfiles)
    ? raw.siteSceneProfile.gateProfiles[0]
    : null;
  const connection = Array.isArray(raw.connections) ? raw.connections[0] : null;
  const fromObjectID = toInt(
    gateProfile && gateProfile.fromObjectID,
    connection && connection.fromObjectID,
  );
  return {
    gateKey: text(gateProfile && gateProfile.gateKey) || `gate:${fromObjectID || "combat"}`,
    label: text(gateProfile && gateProfile.label) || "Acceleration Gate",
    typeID: toInt(gateProfile && gateProfile.typeID, 17831) || 17831,
    fromObjectID: fromObjectID || null,
    allowedShipsList: toInt(gateProfile && gateProfile.allowedShipsList, 0) || null,
  };
}

function defaultMissionPrivateFields() {
  return {
    spawnScope: {
      mode: "any_eligible",
      securityBands: ["highsec", "lowsec", "nullsec", "wormhole"],
      maxConcurrentPerSystem: 1,
      weight: 1,
      respawnMinutes: 60,
      slotCount: 1,
    },
    placement: {
      anchorKind: "system",
    },
    scanner: {
      visibility: "private_mission",
      signalStrength: null,
    },
  };
}

function buildTheScoreGuristasDraft(mission, baseTemplate) {
  // EveJS client-dungeon:921 models this mission as one combat pocket ("room:entry",
  // "Entry Pocket") reached through an acceleration gate at the warp-in beacon. Warp in,
  // activate the gate, then fight the three Guristas groups in the pocket.
  const gate = firstBaseGate(baseTemplate);
  const rooms = [
    {
      roomKey: "room:entry",
      label: "Entry Pocket",
      role: "combat",
      initialState: "active",
      notes: "Single combat pocket reached through the warp-in acceleration gate.",
    },
  ];
  const encounters = [
    {
      key: "group_1_frigates",
      label: "Group 1",
      profileID: "parity_guristas_missile_frigate",
      count: 3,
      amount: 3,
      trigger: "on_room_active",
      roomKey: "room:entry",
      waveIndex: 1,
      distanceMeters: 40000,
      sourceGroup: "Group 1",
      variantNames: ["Pithi Saboteur", "Pithi Despoiler"],
      notes: "3 frigates at about 40 km. Target jamming.",
    },
    {
      key: "group_2_frigates",
      label: "Group 2",
      profileID: "parity_guristas_missile_frigate",
      count: 3,
      amount: 3,
      trigger: "on_room_active",
      roomKey: "room:entry",
      waveIndex: 1,
      distanceMeters: 50000,
      objective: true,
      completionRole: "objective",
      sourceGroup: "Group 2",
      variantNames: ["Pithi Saboteur", "Pithi Despoiler", "Pithi Wrecker"],
      notes: "Blitz: destroy Group 2 to complete the mission. Target jamming.",
    },
    {
      key: "group_2_destroyer",
      label: "Group 2",
      profileID: "parity_guristas_missile_destroyer",
      count: 1,
      amount: 1,
      trigger: "on_room_active",
      roomKey: "room:entry",
      waveIndex: 1,
      distanceMeters: 50000,
      objective: true,
      completionRole: "objective",
      sourceGroup: "Group 2",
      variantNames: ["Pithior Renegade", "Pithior Anarchist"],
      notes: "Objective group destroyer.",
    },
    {
      key: "group_3_frigates",
      label: "Group 3",
      profileID: "parity_guristas_missile_frigate",
      count: 3,
      amount: 3,
      trigger: "on_room_active",
      roomKey: "room:entry",
      waveIndex: 1,
      distanceMeters: 40000,
      sourceGroup: "Group 3",
      variantNames: ["Pithi Plunderer", "Pithi Wrecker", "Pithi Destructor"],
      notes: "3 frigates at about 40 km.",
    },
  ];

  return {
    ...defaultMissionPrivateFields(),
    title: "The Score - Guristas Security",
    templateID: "admin:mission-security:the-score-l1-guristas",
    baseTemplateID: text(mission.linkedTemplateID) || "client-dungeon:921",
    contentFamily: "mission",
    delivery: "mission_private",
    kind: "mission_combat",
    missionType: "combat",
    missionRecord: clone(mission.raw || null),
    status: "draft",
    rooms,
    gates: [
      {
        ...gate,
        destinationRoomKey: "room:entry",
        initialState: "unlocked",
        source: "client_dungeon_921",
      },
    ],
    encounters,
    completion: {
      mode: "encounter_group_cleared",
      encounterKeys: ["group_2_frigates", "group_2_destroyer"],
      despawnDelaySeconds: 0,
    },
    missionSecurity: {
      missionID: mission.missionID,
      dungeonID: mission.dungeonID,
      faction: "Guristas Pirates",
      level: 1,
      objectiveSummary: "Destroy Group 2 to complete the mission.",
      damageProfile: "Deal Kinetic/Thermal; resist Kinetic/Thermal.",
      ewar: "Target jamming (Groups 1 and 2).",
      recommendedShip: "Destroyer",
      sourceName: "EVE University Wiki",
      sourceUrl: THE_SCORE_GURISTAS_SOURCE_URL,
      sourceConfidence: 70,
      baseTemplateID: text(mission.linkedTemplateID) || "client-dungeon:921",
    },
    sourceLinks: [
      {
        label: "EVE University: The Score (Guristas Pirates) (Level 1)",
        url: THE_SCORE_GURISTAS_SOURCE_URL,
      },
    ],
    notes: [
      "Security mission draft from EVE University spawn notes.",
      "One combat pocket (room:entry) reached through the warp-in acceleration gate, per EveJS client-dungeon:921.",
      "Completion is authored to Group 2 because the source blitz says destroying that group completes the objective.",
    ].join("\n"),
  };
}

function buildGenericSecurityDraft(mission, baseTemplate) {
  const raw = baseTemplate && baseTemplate.raw && typeof baseTemplate.raw === "object"
    ? baseTemplate.raw
    : {};
  const populationHints = raw.populationHints && typeof raw.populationHints === "object"
    ? raw.populationHints
    : {};
  const siteSceneProfile = raw.siteSceneProfile && typeof raw.siteSceneProfile === "object"
    ? raw.siteSceneProfile
    : {};
  const existingEncounters = Array.isArray(populationHints.encounters)
    ? populationHints.encounters
    : populationHints.encounter
      ? [populationHints.encounter]
      : [];
  const exactRooms = Array.isArray(siteSceneProfile.roomProfiles)
    ? clone(siteSceneProfile.roomProfiles)
    : [];
  const exactGates = Array.isArray(siteSceneProfile.gateProfiles)
    ? clone(siteSceneProfile.gateProfiles)
    : [];
  const hasGate = exactGates.length > 0;
  const rooms = exactRooms.length > 0
    ? exactRooms
    : hasGate
    ? [
      { roomKey: "room:entry", label: "Entry Gate", role: "gate_only", initialState: "active" },
      { roomKey: "room:combat", label: "Combat Pocket", role: "combat", initialState: "pending" },
    ]
    : [
      { roomKey: "room:entry", label: "Combat Pocket", role: "combat", initialState: "active" },
    ];
  const encounters = existingEncounters.map((encounter, index) => ({
    ...clone(encounter),
    key: text(encounter.key) || `encounter_${index + 1}`,
    label: text(encounter.label) || `Encounter ${index + 1}`,
    spawnQuery: text(encounter.spawnQuery),
    count: Math.max(1, toInt(encounter.amount || encounter.count, Array.isArray(encounter.spawnEntries) ? encounter.spawnEntries.length : 3)),
    amount: Math.max(1, toInt(encounter.amount || encounter.count, Array.isArray(encounter.spawnEntries) ? encounter.spawnEntries.length : 3)),
    trigger: text(encounter.trigger) || (hasGate ? "on_room_active" : "on_load"),
    roomKey: text(encounter.roomKey) || (hasGate ? "room:combat" : "room:entry"),
    waveIndex: Math.max(1, toInt(encounter.waveIndex, index + 1)),
    notes: text(encounter.notes),
  }));
  const gate = hasGate ? firstBaseGate(baseTemplate) : null;
  return {
    ...defaultMissionPrivateFields(),
    title: `${text(mission.name, `Mission ${mission.missionID}`)} Security`,
    templateID: `admin:mission-security:${slug(mission.name || mission.missionID)}`,
    baseTemplateID: text(mission.linkedTemplateID),
    contentFamily: "mission",
    delivery: "mission_private",
    kind: "mission_combat",
    missionType: "combat",
    missionRecord: clone(mission.raw || null),
    templateSeed: clone(raw),
    status: "draft",
    rooms,
    gates: exactGates.length > 0 ? exactGates : gate ? [{
      ...gate,
      destinationRoomKey: "room:combat",
      initialState: "unlocked",
      source: "linked_client_dungeon",
    }] : [],
    encounters,
    miningRocks: clone(populationHints.miningRocks || []),
    environmentProps: clone(populationHints.environmentProps || []),
    completion: populationHints.completion && typeof populationHints.completion === "object" ? clone(populationHints.completion) : {
      mode: encounters.length > 0 ? "encounters_cleared" : "mission_objective_complete",
      despawnDelaySeconds: 0,
    },
    missionSecurity: {
      missionID: mission.missionID,
      dungeonID: mission.dungeonID,
      sourceName: "Linked EveJS mission dungeon",
      sourceUrl: "",
      sourceConfidence: text(populationHints.source).includes("golden_log") ? 100 : 40,
      baseTemplateID: text(mission.linkedTemplateID),
      encounterCount: encounters.length,
      gateCount: exactGates.length,
      environmentPropCount: Array.isArray(populationHints.environmentProps) ? populationHints.environmentProps.length : 0,
      miningRockCount: Array.isArray(populationHints.miningRocks)
        ? populationHints.miningRocks.reduce((total, rock) => total + Math.max(1, toInt(rock && rock.count, 1)), 0)
        : 0,
    },
    sourceLinks: [],
    notes: text(populationHints.source).includes("golden_log")
      ? "Security mission draft from the linked golden-log EveJS dungeon. Preserve exact spawnEntries, gates, props, trigger messages, and completion metadata when editing."
      : "Generic Security mission draft from linked EveJS dungeon hints. Verify rooms, triggers, and NPC mix before marking ready.",
  };
}

function buildMiningMissionDraft(mission, baseTemplate) {
  const raw = baseTemplate && baseTemplate.raw && typeof baseTemplate.raw === "object"
    ? baseTemplate.raw
    : {};
  const populationHints = raw.populationHints && typeof raw.populationHints === "object"
    ? raw.populationHints
    : {};
  const objectiveTypeID = toInt(
    populationHints.objectiveTypeID ||
      mission.objective && mission.objective.objectiveTypeID,
    0,
  );
  const objectiveQuantity = toInt(
    populationHints.objectiveQuantity ||
      mission.objective && mission.objective.objectiveQuantity,
    0,
  );
  return {
    ...defaultMissionPrivateFields(),
    title: `${text(mission.name, `Mission ${mission.missionID}`)} Mining`,
    templateID: text(mission.linkedTemplateID) || `admin:mission-mining:${slug(mission.name || mission.missionID)}`,
    baseTemplateID: text(mission.linkedTemplateID),
    contentFamily: "mission",
    delivery: "mission_private",
    kind: "mission_combat",
    missionType: "mining",
    missionRecord: clone(mission.raw || null),
    templateSeed: clone(raw),
    status: "draft",
    rooms: [
      {
        roomKey: "room:entry",
        label: "Mining Site",
        role: "mining",
        initialState: "active",
      },
    ],
    gates: [],
    encounters: [],
    miningRocks: clone(populationHints.miningRocks || []),
    environmentProps: clone(populationHints.environmentProps || []),
    objectiveTypeID,
    objectiveQuantity,
    completion: {
      mode: "mine_quantity",
      objectiveTypeID,
      objectiveQuantity,
      despawnDelaySeconds: 0,
    },
    missionSecurity: {
      missionID: mission.missionID,
      dungeonID: mission.dungeonID,
      sourceName: "Linked EveJS mining dungeon",
      sourceUrl: "",
      sourceConfidence: 90,
      baseTemplateID: text(mission.linkedTemplateID),
      objectiveTypeID,
      objectiveQuantity,
      miningRockCount: Array.isArray(populationHints.miningRocks)
        ? populationHints.miningRocks.reduce((total, rock) => total + Math.max(1, toInt(rock && rock.count, 1)), 0)
        : 0,
      environmentPropCount: Array.isArray(populationHints.environmentProps)
        ? populationHints.environmentProps.length
        : 0,
    },
    sourceLinks: [],
    notes: "Mining mission draft from the linked EveJS client dungeon. Preserve exact miningRocks and environmentProps when editing.",
  };
}

function buildSecurityMissionDraft(missionID) {
  const mission = findMission(missionID);
  if (!mission) {
    return {
      success: false,
      errorMsg: "MISSION_NOT_FOUND",
      error: "Mission not found.",
    };
  }
  if (!["combat", "mining"].includes(mission.missionType) || !mission.linkedTemplateID) {
    return {
      success: false,
      errorMsg: "MISSION_NOT_SECURITY",
      error: "Mission drafts require a combat or mining mission with a linked dungeon template.",
      mission: clone(mission),
    };
  }
  const baseTemplate = getCatalog().templatesByID.get(mission.linkedTemplateID) || null;
  const draft = mission.missionType === "mining"
    ? buildMiningMissionDraft(mission, baseTemplate)
    : mission.missionID === 2391 || mission.dungeonID === 921
      ? buildTheScoreGuristasDraft(mission, baseTemplate)
      : buildGenericSecurityDraft(mission, baseTemplate);
  return {
    success: true,
    mission: clone(mission),
    baseTemplate: baseTemplate ? clone(baseTemplate) : null,
    draft,
  };
}

module.exports = {
  buildSecurityMissionDraft,
};
