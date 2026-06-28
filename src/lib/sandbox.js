/**
 * sandbox.js
 *
 * Manages a disposable copy of the EveJS gameStore so authored content can be applied and tested without
 * ever touching the live database. The emulator/harness reads the sandbox via EVEJS_GAMESTORE_DATA_DIR.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { getLiveDataDir, resolveEveRoot, getDirectoryStats, WORKSPACE_ROOT } = require("./dataStore");

function normalize(p) {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

function sandboxDataDir(eveRoot = resolveEveRoot()) {
  return path.join(eveRoot, "_local", "gameStore-test", "data");
}

async function ensureSandbox({ eveRoot, reset = false } = {}) {
  const root = resolveEveRoot(eveRoot);
  const liveDataDir = getLiveDataDir(root);
  const sandbox = sandboxDataDir(root);
  if (!fs.existsSync(liveDataDir)) {
    throw new Error(`Live gameStore data dir not found: ${liveDataDir}`);
  }
  if (normalize(sandbox) === normalize(liveDataDir)) {
    throw new Error(`Refusing to use the live data dir as a sandbox: ${sandbox}`);
  }
  const exists = fs.existsSync(sandbox);
  if (exists && !reset) {
    return { copied: false, sandboxDataDir: sandbox, liveDataDir };
  }
  if (exists) {
    process.stdout.write(`Removing existing sandbox (${sandbox})...\n`);
    await fsp.rm(sandbox, { recursive: true, force: true });
  }
  const stats = await getDirectoryStats(liveDataDir);
  process.stdout.write(
    `Copying live gameStore -> sandbox (one-time, ~${(stats.bytes / 1e6).toFixed(0)} MB across ${stats.tables} tables)...\n`,
  );
  await fsp.mkdir(path.dirname(sandbox), { recursive: true });
  await fsp.cp(liveDataDir, sandbox, { recursive: true, dereference: false, force: true });
  return { copied: true, sandboxDataDir: sandbox, liveDataDir };
}

function dungeonAuthorityFile(sandbox) {
  return path.join(sandbox, "dungeonAuthority", "data.json");
}

async function readDungeonAuthority(sandbox) {
  const file = dungeonAuthorityFile(sandbox);
  if (!fs.existsSync(file)) throw new Error(`Sandbox missing dungeonAuthority/data.json: ${file}`);
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, filePath);
}

async function writeDungeonAuthority(sandbox, data) {
  await writeJsonAtomic(dungeonAuthorityFile(sandbox), data);
}

// Resolve where an apply should write: the live gameStore (default — the whole point of the tool) or a
// disposable sandbox copy (opt-in, for safe testing).
async function resolveApplyTarget({ target = "live", eveRoot, reset = false } = {}) {
  if (target === "sandbox") {
    const sb = await ensureSandbox({ eveRoot, reset });
    return { target: "sandbox", dataDir: sb.sandboxDataDir, copied: sb.copied };
  }
  const root = resolveEveRoot(eveRoot);
  const dir = getLiveDataDir(root);
  if (!fs.existsSync(dir)) throw new Error(`Live gameStore data dir not found: ${dir}`);
  return { target: "live", dataDir: dir, copied: false };
}

// Keep a one-time backup of an original template before the first overwrite, so live edits are reversible.
async function backupTemplateOnce(templateID, template) {
  if (!template) return null;
  const dir = path.join(WORKSPACE_ROOT, "backups", "dungeonAuthority");
  await fsp.mkdir(dir, { recursive: true });
  const safe = String(templateID).replace(/[^a-z0-9_.-]+/gi, "_");
  const file = path.join(dir, `${safe}.json`);
  if (fs.existsSync(file)) return null;
  await fsp.writeFile(file, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  return file;
}

module.exports = {
  ensureSandbox,
  sandboxDataDir,
  dungeonAuthorityFile,
  readDungeonAuthority,
  writeDungeonAuthority,
  writeJsonAtomic,
  resolveApplyTarget,
  backupTemplateOnce,
  normalize,
};
