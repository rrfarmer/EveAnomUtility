const crypto = require("node:crypto");
const path = require("node:path");

const {
  OVERLAY_DIR,
  ensureDirectory,
  readJsonFile,
  writeJsonFileAtomic,
} = require("./dataStore");

const NPC_AUTHORING_FILE = path.join(OVERLAY_DIR, "npc-authoring.json");

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return String(value || "").trim();
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultState() {
  return {
    version: 1,
    generatedBy: "EveAnomUtility",
    updatedAt: nowIso(),
    lootTables: [],
  };
}

function stableLootTableID(input = {}) {
  const seed = `${input.name || "loot"}:${nowIso()}:${crypto.randomBytes(4).toString("hex")}`;
  return `admin_loot_${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 10)}`;
}

async function ensureNpcAuthoringStore() {
  await ensureDirectory(OVERLAY_DIR);
  try {
    const state = readJsonFile(NPC_AUTHORING_FILE);
    if (!state || typeof state !== "object") return defaultState();
    if (!Array.isArray(state.lootTables)) state.lootTables = [];
    return state;
  } catch (_error) {
    const state = defaultState();
    await writeJsonFileAtomic(NPC_AUTHORING_FILE, state);
    return state;
  }
}

async function writeState(state) {
  state.updatedAt = nowIso();
  await writeJsonFileAtomic(NPC_AUTHORING_FILE, state);
  return state;
}

function sanitizeLootEntry(entry = {}, options = {}) {
  const typeID = toInt(entry.typeID, 0);
  const quantity = toInt(entry.quantity, 0);
  const minQuantity = toInt(entry.minQuantity, 0);
  const maxQuantity = toInt(entry.maxQuantity, minQuantity);
  const weight = Math.max(0, Number(entry.weight) || 0);
  const next = {
    typeID,
  };
  if (options.weighted === true || weight > 0) next.weight = weight || 1;
  if (quantity > 0) next.quantity = quantity;
  if (minQuantity > 0) next.minQuantity = minQuantity;
  if (maxQuantity > 0) next.maxQuantity = Math.max(minQuantity, maxQuantity);
  if (entry.singleton === true) next.singleton = true;
  return next;
}

function sanitizeLootTable(input = {}) {
  const now = nowIso();
  const minEntries = Math.max(0, toInt(input.minEntries, 0));
  const maxEntries = Math.max(minEntries, toInt(input.maxEntries, minEntries));
  return {
    lootTableID: text(input.lootTableID) || stableLootTableID(input),
    name: text(input.name) || text(input.lootTableID) || "Admin Loot Table",
    source: text(input.source) || "eve_anom_utility",
    minEntries,
    maxEntries,
    stackableMinQuantity: Math.max(0, toInt(input.stackableMinQuantity, 0)),
    stackableMaxQuantity: Math.max(0, toInt(input.stackableMaxQuantity, 0)),
    allowDuplicates: input.allowDuplicates === true,
    guaranteedEntries: Array.isArray(input.guaranteedEntries)
      ? input.guaranteedEntries.map((entry) => sanitizeLootEntry(entry)).filter((entry) => entry.typeID > 0)
      : [],
    entries: Array.isArray(input.entries)
      ? input.entries.map((entry) => sanitizeLootEntry(entry, { weighted: true })).filter((entry) => entry.typeID > 0)
      : [],
    notes: text(input.notes),
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
}

async function listAuthoredLootTables() {
  const state = await ensureNpcAuthoringStore();
  return state.lootTables.map(clone);
}

async function getAuthoredLootTable(lootTableID) {
  const id = text(lootTableID);
  const state = await ensureNpcAuthoringStore();
  const row = state.lootTables.find((entry) => text(entry.lootTableID) === id);
  return row ? clone(row) : null;
}

async function saveAuthoredLootTable(input = {}) {
  const lootTable = sanitizeLootTable(input);
  const state = await ensureNpcAuthoringStore();
  const index = state.lootTables.findIndex((entry) => text(entry.lootTableID) === lootTable.lootTableID);
  if (index >= 0) {
    lootTable.createdAt = state.lootTables[index].createdAt || lootTable.createdAt;
    state.lootTables[index] = lootTable;
  } else {
    state.lootTables.push(lootTable);
  }
  state.lootTables.sort((left, right) => text(left.lootTableID).localeCompare(text(right.lootTableID)));
  await writeState(state);
  return {
    success: true,
    lootTable,
  };
}

async function deleteAuthoredLootTable(lootTableID) {
  const id = text(lootTableID);
  const state = await ensureNpcAuthoringStore();
  const before = state.lootTables.length;
  state.lootTables = state.lootTables.filter((entry) => text(entry.lootTableID) !== id);
  if (state.lootTables.length === before) {
    return {
      success: false,
      errorMsg: "LOOT_TABLE_NOT_FOUND",
    };
  }
  await writeState(state);
  return {
    success: true,
  };
}

module.exports = {
  NPC_AUTHORING_FILE,
  deleteAuthoredLootTable,
  getAuthoredLootTable,
  listAuthoredLootTables,
  saveAuthoredLootTable,
  sanitizeLootTable,
};
