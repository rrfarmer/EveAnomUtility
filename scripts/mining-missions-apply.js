#!/usr/bin/env node
/**
 * mining-missions-apply.js
 *
 * Enrich the Level-1 special mining mission dungeon templates with the mining mechanics EveJS needs,
 * writing the DatabaseCreator static-table source of truth (then a full `CreateDatabase --force` builds it).
 *
 * The missions already exist in EveJS as exact client extracts (mission records + dungeon templates), but
 * their dungeon populationHints were mis-derived as COMBAT (4x npc_deadspace_hostiles, no miningRocks)
 * because siteFamily was mislabeled "combat". This is data-driven: it finds EVERY agent mining mission
 * (contentTemplate "...BasicMiningMission"), and for each whose objective is an ORE asteroid (categoryID 25)
 * injects the real mining content into its dungeon template:
 *   - miningRocks: the special-ore asteroid holding the objective quantity. The 5 missions we have TQ logs
 *     for get their EXACT retail dunPosition; the rest are placed procedurally (still playable).
 *   - objectiveTypeID + objectiveQuantity (from missionAuthority.killMission) so C2 completes the site.
 *   - clears the bogus combat encounter / derived combat props (peaceful basic mining baseline).
 * Cytoserocin GAS missions (categoryID 2) are skipped -- they need gas-harvesting mechanics, not mining.
 *
 * A L1 mining agent offers these naturally (no force flag) -- they share the BasicMiningMission template,
 * and listMissionIDsForAgent expands a preferred mining mission to all missions of that template.
 *
 * See memory l1-mining-missions. Usage: node scripts/mining-missions-apply.js [--sandbox|--live|--static]
 */

const fs = require("fs");
const path = require("path");
const {
  resolveApplyTarget,
  readDungeonAuthority,
  writeDungeonAuthority,
} = require("../src/lib/sandbox");
const { resolveEveRoot, getLiveDataDir } = require("../src/lib/dataStore");

const MINING_TEMPLATE = "BasicMiningMission";
const ORE_CATEGORY_ID = 25; // Asteroid (ore + mission ice); gas clouds are categoryID 2 (skipped).

// Exact retail asteroid dunPositions decoded from the TQ Mining logs (DoBallsAdded slimItem reprs),
// keyed by dungeonID. Other dungeons fall back to procedural placement.
const LOG_POSITIONS = {
  2449: { x: 9602.21484375,   y: -188.84097290039062, z: -6616.1640625 },      // Starting Simple
  2456: { x: 2970.525634765625, y: 1719.3551025390625, z: -11732.9990234375 }, // Bountiful Banidine
  2450: { x: -17288.51171875, y: -14128.806640625,    z: -1341.41943359375 },  // Asteroid Catastrophe
  2451: { x: 19497.19140625,  y: -8388.244140625,     z: 6668.2099609375 },     // Burnt Traces
  2454: { x: 6068.9169921875, y: -1699.62939453125,   z: 2848.41455078125 },    // Mercium Experiments
};

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function buildTypeCategoryMap(liveDir) {
  const items = loadJson(path.join(liveDir, "itemTypes", "data.json"));
  const arr = items.itemTypes || items.types || items.rows || (Array.isArray(items) ? items : Object.values(items)[0]);
  const cat = new Map();
  const name = new Map();
  for (const it of arr) {
    if (it && it.typeID != null) {
      cat.set(Number(it.typeID), Number(it.categoryID));
      name.set(Number(it.typeID), it.typeName || it.name || String(it.typeID));
    }
  }
  return { cat, name };
}

// Collapse the agent mission pool to one entry per dungeon: { dungeonID, oreTypeID, quantity, name }.
function collectMiningDungeons(liveDir) {
  const missions = loadJson(path.join(liveDir, "missionAuthority", "data.json")).missionsByID || {};
  const byDungeon = new Map();
  for (const rec of Object.values(missions)) {
    if (!rec || !String(rec.contentTemplate || "").includes(MINING_TEMPLATE)) continue;
    const obj = rec.killMission || {};
    const dungeonID = Number(obj.dungeonID || 0);
    const oreTypeID = Number(obj.objectiveTypeID || 0);
    const quantity = Number(obj.objectiveQuantity || 0);
    if (!dungeonID || !oreTypeID || !quantity) continue;
    const name = (rec.localizedName && rec.localizedName.text) || `mission ${rec.missionID}`;
    const prev = byDungeon.get(dungeonID);
    // same dungeon across faction variants -> keep the largest objective quantity to be safe.
    if (!prev || quantity > prev.quantity) byDungeon.set(dungeonID, { dungeonID, oreTypeID, quantity, name });
  }
  return [...byDungeon.values()].sort((a, b) => a.dungeonID - b.dungeonID);
}

function applyMiningHints(template, spec) {
  const ph = (template.populationHints && typeof template.populationHints === "object")
    ? template.populationHints
    : (template.populationHints = {});
  const rock = { oreTypeID: spec.oreTypeID, count: 1, quantity: spec.quantity, label: spec.oreName };
  const pos = LOG_POSITIONS[spec.dungeonID];
  if (pos) rock.positionOffset = { x: pos.x, y: pos.y, z: pos.z };
  ph.miningRocks = [rock];
  ph.objectiveTypeID = spec.oreTypeID;
  ph.objectiveQuantity = spec.quantity;
  ph.completeObjectiveOnEncounterClear = false;
  ph.encounter = null;
  ph.encounters = [];
  ph.environmentProps = [];
  ph.containers = [];
  ph.hazards = [];
  ph.lootProfiles = [];
  ph.source = "mining_mission_authored";
  ph.siteFamily = "mining";
  ph.siteKind = "mining";
}

async function main() {
  const argv = process.argv.slice(2);
  const target = argv.includes("--sandbox") ? "sandbox" : argv.includes("--live") ? "live" : "static";

  const eveRoot = resolveEveRoot();
  const liveDir = getLiveDataDir(eveRoot);
  const { cat, name } = buildTypeCategoryMap(liveDir);
  const dungeons = collectMiningDungeons(liveDir);

  const applyTarget = await resolveApplyTarget({ target });
  const dungeon = await readDungeonAuthority(applyTarget.dataDir);
  dungeon.templatesByID = dungeon.templatesByID || {};

  const applied = [];
  const skippedGas = [];
  const skippedNoTemplate = [];
  for (const spec of dungeons) {
    spec.oreName = name.get(spec.oreTypeID) || String(spec.oreTypeID);
    if (cat.get(spec.oreTypeID) !== ORE_CATEGORY_ID) { skippedGas.push(spec); continue; }
    const templateID = `client-dungeon:${spec.dungeonID}`;
    const template = dungeon.templatesByID[templateID];
    if (!template) { skippedNoTemplate.push(spec); continue; }
    applyMiningHints(template, spec);
    applied.push({ ...spec, templateID, exact: Boolean(LOG_POSITIONS[spec.dungeonID]) });
  }

  await writeDungeonAuthority(applyTarget.dataDir, dungeon);

  process.stdout.write(`\nApplied ${applied.length} ore mining dungeons to ${applyTarget.target.toUpperCase()} (${applied.filter((a) => a.exact).length} with exact log positions)\n`);
  process.stdout.write(`  data dir: ${applyTarget.dataDir}\n\n`);
  for (const a of applied) {
    process.stdout.write(`  OK  ${a.templateID.padEnd(20)} mine ${String(a.quantity).padStart(6)} ${a.oreName.padEnd(18)} ${a.exact ? "[exact pos]" : "[procedural]"}  ${a.name}\n`);
  }
  if (skippedGas.length) {
    process.stdout.write(`\n  Skipped ${skippedGas.length} GAS (Cytoserocin) missions -- need gas-harvesting mechanics:\n`);
    for (const s of skippedGas) process.stdout.write(`    - ${s.name} (dungeon ${s.dungeonID}, ${s.oreName})\n`);
  }
  if (skippedNoTemplate.length) {
    process.stdout.write(`\n  Skipped ${skippedNoTemplate.length} with no dungeon template: ${skippedNoTemplate.map((s) => s.dungeonID).join(", ")}\n`);
  }
  process.stdout.write(
    applyTarget.target === "static"
      ? "\nWrote the static-table source of truth. Build it:\n  cd <eve.js> && CreateDatabase.bat /force   (or the node form with --sde-dir/--out/--build/--force)\nThen any Level-1 mining agent offers these naturally (no force flag).\n"
      : "\nRestart the EveJS server to load it.\n",
  );
}

main().catch((error) => {
  process.stderr.write(`mining-missions-apply failed: ${error.message}\n`);
  process.exit(1);
});
