#!/usr/bin/env node
/**
 * apply-to-sandbox.js
 *
 * Writes authored mission content into a *sandbox* copy of the EveJS gameStore so it can be
 * tested without ever touching the live database.
 *
 *   1. Creates `<eveRoot>/_local/gameStore-test/data` as a one-time copy of the live
 *      `_local/gameStore/data` (idempotent; pass --reset to re-copy).
 *   2. Patches the linked dungeon template (default `client-dungeon:921` for The Score) inside the
 *      sandbox's `dungeonAuthority/data.json` with our authored spawn groups, rooms and gate.
 *
 * The live data dir is never written. The emulator/harness reads the sandbox via
 * EVEJS_GAMESTORE_DATA_DIR.
 *
 * Usage:
 *   node scripts/apply-to-sandbox.js --mission 2391
 *   node scripts/apply-to-sandbox.js --overlay <overlayId>
 *   node scripts/apply-to-sandbox.js --template client-dungeon:921 --reset
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { buildTemplatePack } = require("../src/lib/templatePack");
const { listOverlays } = require("../src/lib/overlayStore");
const { getLiveDataDir, resolveEveRoot, getDirectoryStats } = require("../src/lib/dataStore");

function parseArgs(argv) {
  const args = { reset: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--reset") args.reset = true;
    else if (token === "--mission") args.mission = Number(argv[++i]) || 0;
    else if (token === "--overlay") args.overlay = String(argv[++i] || "");
    else if (token === "--template") args.template = String(argv[++i] || "");
    else if (token === "--eve-root") args.eveRoot = String(argv[++i] || "");
  }
  return args;
}

function normalize(p) {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

function selectOverlay(overlays, args) {
  if (args.overlay) {
    return overlays.find((o) => o.id === args.overlay) || null;
  }
  if (args.mission) {
    return overlays
      .filter((o) => Number(o.missionSecurity && o.missionSecurity.missionID) === args.mission)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
  }
  if (args.template) {
    return overlays
      .filter((o) => o.baseTemplateID === args.template)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
  }
  const missionOverlays = overlays.filter((o) => o.contentFamily === "mission" || o.kind === "mission_combat");
  if (missionOverlays.length === 1) return missionOverlays[0];
  return null;
}

async function ensureSandbox(liveDataDir, sandboxDataDir, reset) {
  if (normalize(sandboxDataDir) === normalize(liveDataDir)) {
    throw new Error(`Refusing to use the live data dir as a sandbox: ${sandboxDataDir}`);
  }
  const exists = fs.existsSync(sandboxDataDir);
  if (exists && !reset) {
    return { copied: false };
  }
  if (exists) {
    process.stdout.write(`Removing existing sandbox (${sandboxDataDir})...\n`);
    await fsp.rm(sandboxDataDir, { recursive: true, force: true });
  }
  const liveStats = await getDirectoryStats(liveDataDir);
  process.stdout.write(
    `Copying live gameStore -> sandbox (one-time, ~${(liveStats.bytes / 1e6).toFixed(0)} MB across ${liveStats.tables} tables)...\n`,
  );
  await fsp.mkdir(path.dirname(sandboxDataDir), { recursive: true });
  await fsp.cp(liveDataDir, sandboxDataDir, { recursive: true, dereference: false, force: true });
  return { copied: true };
}

function patchTemplate(target, authored) {
  const ap = authored.populationHints || {};
  const as = authored.siteSceneProfile || {};
  target.populationHints = target.populationHints || {};
  target.siteSceneProfile = target.siteSceneProfile || {};
  // Override only the spawn-relevant fields; preserve archetype, objectives, structures, props, etc.
  target.populationHints.encounters = ap.encounters || [];
  target.populationHints.encounter = ap.encounter || (ap.encounters && ap.encounters[0]) || null;
  target.populationHints.completion = ap.completion || {};
  target.populationHints.source = "eve_anom_utility";
  target.siteSceneProfile.roomProfiles = as.roomProfiles || target.siteSceneProfile.roomProfiles || [];
  target.siteSceneProfile.gateProfiles = as.gateProfiles || target.siteSceneProfile.gateProfiles || [];
  target.adminMetadata = {
    ...(target.adminMetadata || {}),
    authoredBy: "eve_anom_utility",
    authoredAt: new Date().toISOString(),
  };
  return target;
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, filePath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const eveRoot = resolveEveRoot(args.eveRoot);
  const liveDataDir = getLiveDataDir(eveRoot);
  const sandboxDataDir = path.join(eveRoot, "_local", "gameStore-test", "data");

  if (!fs.existsSync(liveDataDir)) {
    throw new Error(`Live gameStore data dir not found: ${liveDataDir}`);
  }

  const overlays = await listOverlays();
  const overlay = selectOverlay(overlays, args);
  if (!overlay) {
    process.stderr.write(
      "Could not pick an overlay. Use --overlay <id>, --mission <id>, or --template <id>.\n" +
      `Saved overlays:\n${overlays.map((o) => `  - ${o.id} (templateID ${o.templateID}, base ${o.baseTemplateID}, mission ${o.missionSecurity && o.missionSecurity.missionID})`).join("\n") || "  (none)"}\n`,
    );
    process.exit(2);
  }

  const targetTemplateID = args.template || overlay.baseTemplateID;
  if (!targetTemplateID) {
    throw new Error(`Overlay ${overlay.id} has no baseTemplateID; pass --template <client-dungeon:id>.`);
  }
  if (overlay.validation && overlay.validation.ok === false) {
    throw new Error(`Overlay ${overlay.id} is invalid; fix it in the Mission Designer before applying.`);
  }

  // Build the authored template (reuses the same generator the pack uses).
  const pack = await buildTemplatePack({ write: false });
  const authored = pack.templates.find((t) => t.templateID === overlay.templateID);
  if (!authored) {
    throw new Error(`Overlay ${overlay.id} (${overlay.templateID}) did not produce a generated template (invalid?).`);
  }

  // Sandbox (copy live once, or --reset).
  const sandbox = await ensureSandbox(liveDataDir, sandboxDataDir, args.reset);

  // Patch the dungeon template inside the sandbox.
  const dungeonFile = path.join(sandboxDataDir, "dungeonAuthority", "data.json");
  if (!fs.existsSync(dungeonFile)) {
    throw new Error(`Sandbox is missing dungeonAuthority/data.json: ${dungeonFile}`);
  }
  const dungeon = JSON.parse(await fsp.readFile(dungeonFile, "utf8"));
  const templatesByID = dungeon.templatesByID || {};
  const target = templatesByID[targetTemplateID];
  if (!target) {
    throw new Error(`Template ${targetTemplateID} not found in sandbox dungeonAuthority.`);
  }
  patchTemplate(target, authored);
  await writeJsonAtomic(dungeonFile, dungeon);

  const encounters = (target.populationHints.encounters || []);
  process.stdout.write(
    [
      "",
      "Applied authored content to the gameStore sandbox.",
      `  overlay:        ${overlay.id} (${overlay.title || overlay.templateID})`,
      `  target template:${" "}${targetTemplateID}`,
      `  sandbox:        ${sandboxDataDir}${sandbox.copied ? " (freshly copied)" : " (existing)"}`,
      `  encounters:     ${encounters.length} (${encounters.map((e) => `${e.amount || 1}x ${e.spawnQuery}`).join(", ")})`,
      `  rooms / gates:  ${(target.siteSceneProfile.roomProfiles || []).length} / ${(target.siteSceneProfile.gateProfiles || []).length}`,
      "",
      "Next: run the harness against this sandbox:",
      `  npm run emu-test -- --mission ${overlay.missionSecurity && overlay.missionSecurity.missionID || 2391}`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`apply-to-sandbox failed: ${error.message}\n`);
  process.exit(1);
});
