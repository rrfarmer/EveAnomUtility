const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_EVEJS_ROOT = "C:\\Users\\ryanf\\Documents\\GitHub\\eve.js";
const UTILITY_ROOT = path.resolve(__dirname, "..", "..");
const WORKSPACE_ROOT = path.resolve(process.env.EAU_WORKSPACE_ROOT || path.join(UTILITY_ROOT, "workspace"));
const CLONE_DATA_DIR = path.join(WORKSPACE_ROOT, "db-clone");
const OVERLAY_DIR = path.join(WORKSPACE_ROOT, "overlays");

function resolveEveRoot(candidate = process.env.EVEJS_ROOT || DEFAULT_EVEJS_ROOT) {
  return path.resolve(candidate);
}

function getLiveDataDir(eveRoot = resolveEveRoot()) {
  if (process.env.EVEJS_NEWDB_DATA_DIR) {
    return path.resolve(process.env.EVEJS_NEWDB_DATA_DIR);
  }

  const localDatabaseRoot = path.join(eveRoot, "_local", "newDatabase");
  const localDataDir = path.join(localDatabaseRoot, "data");
  if (
    fs.existsSync(path.join(localDatabaseRoot, "manifest.json")) ||
    fs.existsSync(localDataDir)
  ) {
    return localDataDir;
  }

  return getSourceDataDir(eveRoot);
}

function getSourceDataDir(eveRoot = resolveEveRoot()) {
  return path.join(eveRoot, "server", "src", "newDatabase", "data");
}

function normalizePathForCompare(value) {
  return path.resolve(value).toLowerCase();
}

function assertInsideWorkspace(targetPath) {
  const normalizedWorkspace = `${normalizePathForCompare(WORKSPACE_ROOT)}${path.sep}`;
  const normalizedTarget = normalizePathForCompare(targetPath);
  if (
    normalizedTarget !== normalizePathForCompare(WORKSPACE_ROOT) &&
    !normalizedTarget.startsWith(normalizedWorkspace)
  ) {
    throw new Error(`Refusing to write outside utility workspace: ${targetPath}`);
  }
}

async function ensureDirectory(directory) {
  assertInsideWorkspace(directory);
  await fsp.mkdir(directory, { recursive: true });
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (fallback !== null) {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonFileAtomic(filePath, value) {
  assertInsideWorkspace(filePath);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fsp.writeFile(tempPath, payload, "utf8");
  await fsp.rename(tempPath, filePath);
}

function getDataDir(mode = "clone") {
  if (mode === "live") {
    return getLiveDataDir();
  }
  return CLONE_DATA_DIR;
}

function tablePath(dataDir, table) {
  return path.join(dataDir, table, "data.json");
}

function readTable(dataDir, table, fallback = {}) {
  return readJsonFile(tablePath(dataDir, table), fallback);
}

async function getDirectoryStats(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return {
      exists: false,
      tables: 0,
      bytes: 0,
      updatedAt: null,
    };
  }

  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  let tables = 0;
  let bytes = 0;
  let updatedAt = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const filePath = tablePath(rootDir, entry.name);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const stat = await fsp.stat(filePath);
    tables += 1;
    bytes += stat.size;
    updatedAt = Math.max(updatedAt, stat.mtimeMs);
  }

  return {
    exists: true,
    tables,
    bytes,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
  };
}

async function cloneDatabase(options = {}) {
  const eveRoot = resolveEveRoot(options.eveRoot);
  const liveDataDir = getLiveDataDir(eveRoot);
  if (!fs.existsSync(liveDataDir)) {
    throw new Error(`EveJS data directory not found: ${liveDataDir}`);
  }

  await ensureDirectory(WORKSPACE_ROOT);
  assertInsideWorkspace(CLONE_DATA_DIR);

  if (fs.existsSync(CLONE_DATA_DIR)) {
    if (options.force !== true) {
      return {
        cloned: false,
        reason: "clone_exists",
        liveDataDir,
        cloneDataDir: CLONE_DATA_DIR,
        stats: await getDirectoryStats(CLONE_DATA_DIR),
      };
    }
    await fsp.rm(CLONE_DATA_DIR, { recursive: true, force: true });
  }

  await fsp.cp(liveDataDir, CLONE_DATA_DIR, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    force: true,
  });

  return {
    cloned: true,
    liveDataDir,
    cloneDataDir: CLONE_DATA_DIR,
    stats: await getDirectoryStats(CLONE_DATA_DIR),
  };
}

async function getStatus() {
  const eveRoot = resolveEveRoot();
  const liveDataDir = getLiveDataDir(eveRoot);
  const sourceDataDir = getSourceDataDir(eveRoot);
  const [liveStats, cloneStats] = await Promise.all([
    getDirectoryStats(liveDataDir),
    getDirectoryStats(CLONE_DATA_DIR),
  ]);
  return {
    utilityRoot: UTILITY_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
    eveRoot,
    liveDataDir,
    sourceDataDir,
    cloneDataDir: CLONE_DATA_DIR,
    overlayDir: OVERLAY_DIR,
    liveStats,
    cloneStats,
    activeReadMode: cloneStats.exists ? "clone" : "live-read-only",
    liveWritesAllowed: false,
  };
}

module.exports = {
  CLONE_DATA_DIR,
  DEFAULT_EVEJS_ROOT,
  OVERLAY_DIR,
  UTILITY_ROOT,
  WORKSPACE_ROOT,
  assertInsideWorkspace,
  cloneDatabase,
  ensureDirectory,
  getDataDir,
  getDirectoryStats,
  getLiveDataDir,
  getSourceDataDir,
  getStatus,
  readJsonFile,
  readTable,
  resolveEveRoot,
  tablePath,
  writeJsonFileAtomic,
};
