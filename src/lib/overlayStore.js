const crypto = require("node:crypto");
const path = require("node:path");

const {
  OVERLAY_DIR,
  ensureDirectory,
  readJsonFile,
  writeJsonFileAtomic,
} = require("./dataStore");
const { validateOverlay } = require("./validator");

const OVERLAY_FILE = path.join(OVERLAY_DIR, "content-overlays.json");

function nowIso() {
  return new Date().toISOString();
}

function createDefaultState() {
  return {
    version: 1,
    generatedBy: "EveAnomUtility",
    updatedAt: nowIso(),
    overlays: [],
  };
}

async function ensureOverlayStore() {
  await ensureDirectory(OVERLAY_DIR);
  try {
    return readJsonFile(OVERLAY_FILE);
  } catch (error) {
    const state = createDefaultState();
    await writeJsonFileAtomic(OVERLAY_FILE, state);
    return state;
  }
}

async function writeState(state) {
  state.updatedAt = nowIso();
  await writeJsonFileAtomic(OVERLAY_FILE, state);
  return state;
}

function stableId(title, kind) {
  const seed = `${kind}:${title}:${nowIso()}:${crypto.randomBytes(4).toString("hex")}`;
  return `overlay_${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12)}`;
}

function normalizeSpawnScope(input = {}, legacy = {}) {
  const scope = input && typeof input === "object" ? input : {};
  const legacyPlacement = legacy.placement && typeof legacy.placement === "object"
    ? legacy.placement
    : {};
  const legacyMode = legacyPlacement.anchorKind === "stargate" && legacyPlacement.anchorID
    ? "specific_stargate"
    : Number(legacy.solarSystemID) > 0
      ? "specific_system"
      : "any_eligible";
  const securityBands = Array.isArray(scope.securityBands) && scope.securityBands.length > 0
    ? scope.securityBands
    : ["highsec", "lowsec", "nullsec", "wormhole"];
  return {
    mode: String(scope.mode || legacyMode).trim() || "any_eligible",
    securityBands: securityBands
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
    maxConcurrentPerSystem: Math.max(1, Number(scope.maxConcurrentPerSystem) || 1),
    weight: Math.max(0, Number(scope.weight) || 0),
    respawnMinutes: Math.max(1, Number(scope.respawnMinutes) || 60),
    slotCount: Math.max(1, Number(scope.slotCount) || 1),
    solarSystemID: Number(scope.solarSystemID || legacy.solarSystemID) || 0,
    stargateID: Number(scope.stargateID || legacyPlacement.anchorID) || 0,
  };
}

function sanitizeOverlay(input = {}) {
  const now = nowIso();
  const spawnScope = normalizeSpawnScope(input.spawnScope, input);
  return {
    id: String(input.id || "").trim() || stableId(input.title || "untitled", input.kind || "content"),
    title: String(input.title || "").trim(),
    templateID: String(input.templateID || "").trim(),
    contentFamily: String(input.contentFamily || "").trim(),
    delivery: String(input.delivery || "").trim(),
    kind: String(input.kind || "").trim(),
    missionType: String(input.missionType || input.mission && input.mission.type || "").trim(),
    status: String(input.status || "draft").trim() || "draft",
    baseTemplateID: String(input.baseTemplateID || "").trim(),
    spawnScope,
    solarSystemID: Number(spawnScope.solarSystemID) || Number(input.solarSystemID) || 0,
    placement: input.placement && typeof input.placement === "object"
      ? input.placement
      : { anchorKind: "system" },
    scanner: input.scanner && typeof input.scanner === "object"
      ? input.scanner
      : { visibility: input.kind === "mission_combat" ? "private_mission" : "anomaly", signalStrength: 100 },
    rooms: Array.isArray(input.rooms) ? input.rooms : [],
    gates: Array.isArray(input.gates) ? input.gates : [],
    encounters: Array.isArray(input.encounters) ? input.encounters : [],
    resources: Array.isArray(input.resources) ? input.resources : [],
    miningRocks: Array.isArray(input.miningRocks) ? input.miningRocks : [],
    environmentProps: Array.isArray(input.environmentProps) ? input.environmentProps : [],
    objectiveTypeID: Number(input.objectiveTypeID) || 0,
    objectiveQuantity: Number(input.objectiveQuantity) || 0,
    npcOverrides: Array.isArray(input.npcOverrides) ? input.npcOverrides : [],
    lootTables: Array.isArray(input.lootTables) ? input.lootTables : [],
    completion: input.completion && typeof input.completion === "object"
      ? input.completion
      : { mode: "manual", despawnDelaySeconds: 0 },
    missionSecurity: input.missionSecurity && typeof input.missionSecurity === "object"
      ? input.missionSecurity
      : null,
    missionRecord: input.missionRecord && typeof input.missionRecord === "object" && !Array.isArray(input.missionRecord)
      ? input.missionRecord
      : null,
    sourceLinks: Array.isArray(input.sourceLinks) ? input.sourceLinks : [],
    notes: String(input.notes || "").trim(),
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
}

async function listOverlays() {
  const state = await ensureOverlayStore();
  return state.overlays.map((overlay) => ({
    ...overlay,
    validation: validateOverlay(overlay),
  }));
}

async function getOverlay(id) {
  const state = await ensureOverlayStore();
  return state.overlays.find((overlay) => overlay.id === id) || null;
}

async function saveOverlay(input = {}) {
  const overlay = sanitizeOverlay(input);
  const validation = validateOverlay(overlay);
  if (!validation.ok) {
    return {
      success: false,
      errorMsg: "VALIDATION_FAILED",
      validation,
      overlay,
    };
  }

  const state = await ensureOverlayStore();
  const index = state.overlays.findIndex((entry) => entry.id === overlay.id);
  if (index >= 0) {
    overlay.createdAt = state.overlays[index].createdAt || overlay.createdAt;
    state.overlays[index] = overlay;
  } else {
    state.overlays.push(overlay);
  }
  await writeState(state);
  return {
    success: true,
    overlay,
    validation,
  };
}

async function deleteOverlay(id) {
  const state = await ensureOverlayStore();
  const before = state.overlays.length;
  state.overlays = state.overlays.filter((overlay) => overlay.id !== id);
  if (state.overlays.length === before) {
    return {
      success: false,
      errorMsg: "OVERLAY_NOT_FOUND",
    };
  }
  await writeState(state);
  return {
    success: true,
  };
}

module.exports = {
  OVERLAY_FILE,
  deleteOverlay,
  ensureOverlayStore,
  getOverlay,
  listOverlays,
  saveOverlay,
};
