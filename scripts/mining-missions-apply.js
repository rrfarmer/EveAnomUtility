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
 * See memory l1-mining-missions. Usage: node scripts/mining-missions-apply.js [--sandbox|--live|--static] [--all]
 */

const fs = require("fs");
const path = require("path");
const {
  resolveApplyTarget,
  readDungeonAuthority,
  writeDungeonAuthority,
} = require("../src/lib/sandbox");
const { resolveEveRoot, getLiveDataDir, getStaticTableDir } = require("../src/lib/dataStore");

const MINING_TEMPLATE = "BasicMiningMission";
const ORE_CATEGORY_ID = 25; // Asteroid (ore + mission ice); gas clouds are categoryID 2 (skipped).
const VERIFIED_L1_DUNGEON_IDS = new Set([2449, 2450, 2451, 2454, 2456]);

// Authoritative mission LEVEL by dungeon resolvedName (from the canonical mining-mission table). Only the
// 5 Level-1 missions are the verified, in-scope set; the rest are a kept HEAD-START at their true level
// (peaceful single-rock baseline -- some higher-level missions may really have ambushes/multi-rock layouts).
// Names not in the table (faction variants / the "(N of 5)" storyline arc) get level null = unverified.
const LEVEL_BY_NAME = {
  // Level 1 (the only verified in-scope set)
  "Starting Simple": 1, "Asteroid Catastrophe": 1, "Burnt Traces": 1, "Mercium Experiments": 1, "Bountiful Banidine": 1,
  // Level 2
  "Claimjumpers": 2, "Mercium Belt": 2, "Down and Dirty": 2, "Unknown Events": 2, "Understanding Augumene": 2, "Data Mining": 2,
  // Level 3
  "Beware They Live": 3, "Persistent Pests": 3, "Drone Distribution": 3, "Pile of Pithix": 3,
  "Coming 'Round the Mountain": 3, "A Better World": 3, "Stay Frosty": 3,
  // Level 4
  "Mother Lode": 4, "Ice Installation": 4, "Feeding the Giant": 4, "Arisite Envy": 4,
  "Not Gneiss at All": 4, "Cheap Chills": 4, "Geodite and Gemology": 4,
};

// Exact retail asteroid dunPositions decoded from the TQ Mining logs (DoBallsAdded slimItem reprs),
// keyed by dungeonID. Other dungeons fall back to procedural placement.
const LOG_POSITIONS = {
  2449: { x: 9602.21484375,   y: -188.84097290039062, z: -6616.1640625 },      // Starting Simple
  2456: { x: 2970.525634765625, y: 1719.3551025390625, z: -11732.9990234375 }, // Bountiful Banidine
  2450: { x: -17288.51171875, y: -14128.806640625,    z: -1341.41943359375 },  // Asteroid Catastrophe
  2451: { x: 19497.19140625,  y: -8388.244140625,     z: 6668.2099609375 },     // Burnt Traces
  2454: { x: 6068.9169921875, y: -1699.62939453125,   z: 2848.41455078125 },    // Mercium Experiments
};

// Exact dungeon-object IDs of the special-ore asteroid (from the TQ logs' slimItem reprs), keyed by
// dungeonID. The retail client needs a dunObjectID to render the ore-type asteroid as a dungeon object;
// without it the client crashes on approach (integer divide-by-zero on a modelless asteroid).
const LOG_DUN_OBJECT_IDS = {
  2449: 867587, // Starting Simple
  2456: 886465, // Bountiful Banidine
  2450: 867589, // Asteroid Catastrophe
  2451: 867528, // Burnt Traces
  2454: 867621, // Mercium Experiments
};

const LOG_ROTATIONS = {
  2456: [267.1401062011719, -59.988616943359375, 0.000013655673683388159],
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
  const dunObjectID = LOG_DUN_OBJECT_IDS[spec.dungeonID];
  if (dunObjectID) rock.dunObjectID = dunObjectID;
  const dunRotation = LOG_ROTATIONS[spec.dungeonID];
  if (dunRotation) rock.dunRotation = dunRotation;
  ph.miningRocks = [rock];
  ph.objectiveTypeID = spec.oreTypeID;
  ph.objectiveQuantity = spec.quantity;
  ph.completeObjectiveOnEncounterClear = false;
  ph.encounter = null;
  ph.encounters = [];
  const hasExactEnvironmentProps = Array.isArray(ph.environmentProps) &&
    ph.environmentProps.some((prop) => prop && prop.exact === true);
  if (!hasExactEnvironmentProps) ph.environmentProps = [];
  ph.containers = [];
  ph.hazards = [];
  ph.lootProfiles = [];
  ph.source = "mining_mission_authored";
  ph.siteFamily = "mining";
  ph.siteKind = "mining";
  // True mission level (1 = verified in-scope; 2-4 = kept head-start; null = unverified variant/storyline).
  const level = LEVEL_BY_NAME[normalizeText(template.resolvedName)];
  ph.missionLevel = level || null;
  return level || null;
}

function normalizeText(value) {
  return String(value || "").trim();
}

async function main() {
  const argv = process.argv.slice(2);
  const target = argv.includes("--sandbox") ? "sandbox" : argv.includes("--live") ? "live" : "static";
  const applyAllMiningDungeons = argv.includes("--all");

  const eveRoot = resolveEveRoot();
  const liveDir = getLiveDataDir(eveRoot);
  const staticDir = getStaticTableDir(eveRoot);
  const authorityReadDir = fs.existsSync(path.join(staticDir, "missionAuthority", "data.json"))
    ? staticDir
    : liveDir;
  const { cat, name } = buildTypeCategoryMap(liveDir);
  const dungeons = collectMiningDungeons(authorityReadDir)
    .filter((spec) => applyAllMiningDungeons || VERIFIED_L1_DUNGEON_IDS.has(spec.dungeonID));

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
    const level = applyMiningHints(template, spec);
    applied.push({ ...spec, templateID, exact: Boolean(LOG_POSITIONS[spec.dungeonID]), level });
  }

  await writeDungeonAuthority(applyTarget.dataDir, dungeon);

  process.stdout.write(`\nApplied ${applied.length} ore mining dungeons to ${applyTarget.target.toUpperCase()} (${applied.filter((a) => a.exact).length} with exact log positions)\n`);
  process.stdout.write(`  data dir: ${applyTarget.dataDir}\n`);
  process.stdout.write(`  missionAuthority read dir: ${authorityReadDir}\n`);
  if (!applyAllMiningDungeons) {
    process.stdout.write("  scope: verified L1 mining dungeons only (pass --all for the old broad enrichment pass)\n");
  }
  const levelLabel = (lvl) => (lvl ? `LEVEL ${lvl}${lvl === 1 ? " (verified, in-scope)" : " (head-start)"}` : "LEVEL ? (unverified variant/storyline)");
  for (const lvl of [1, 2, 3, 4, null]) {
    const group = applied.filter((a) => (a.level || null) === lvl);
    if (!group.length) continue;
    process.stdout.write(`\n  ${levelLabel(lvl)} — ${group.length}:\n`);
    for (const a of group) {
      process.stdout.write(`    ${a.templateID.padEnd(20)} mine ${String(a.quantity).padStart(6)} ${a.oreName.padEnd(18)} ${a.exact ? "[exact pos]" : "[procedural]"}  ${a.name}\n`);
    }
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
