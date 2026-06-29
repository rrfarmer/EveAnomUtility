#!/usr/bin/env node
/**
 * mining-missions-apply.js
 *
 * Enrich the 5 Level-1 special mining mission dungeon templates with the mining mechanics EveJS needs,
 * writing the DatabaseCreator static-table source of truth (then a full `CreateDatabase --force` builds it).
 *
 * The 5 missions already exist in EveJS as exact client extracts (mission records + dungeon templates), but
 * their populationHints were mis-derived as COMBAT (4x npc_deadspace_hostiles, no miningRocks) because
 * siteFamily was mislabeled "combat". This injects the real mining content per template:
 *   - miningRocks: the single special-ore asteroid at its EXACT retail dunPosition (decoded from the TQ
 *     logs' DoBallsAdded slimItem reprs), holding the objective quantity of ore.
 *   - objectiveTypeID + objectiveQuantity: so C2 (processMiningObjective) completes the site when mined.
 *   - clears the bogus combat encounter / derived combat props (these are peaceful basic mining missions —
 *     confirmed by the logs: 0 pirate spawns, mining-only).
 *
 * Data source: EveJS missionAuthority.killMission (ore + quantity + dungeon) + the TQ Mining logs
 * (exact asteroid dunPosition). See memory l1-mining-missions.
 *
 * Usage: node scripts/mining-missions-apply.js [--sandbox|--live|--static]   (default: static)
 */

const {
  resolveApplyTarget,
  readDungeonAuthority,
  writeDungeonAuthority,
} = require("../src/lib/sandbox");

// missionID is informative (the agent mission that uses this dungeon); the dungeon templateID is the key.
const MINING_MISSIONS = [
  { name: "Starting Simple",      missionID: 4801, templateID: "client-dungeon:2449", ore: 28617, oreName: "Banidine", qty: 20000, pos: { x: 9602.21484375,   y: -188.84097290039062, z: -6616.1640625 } },
  { name: "Bountiful Banidine",   missionID: 4802, templateID: "client-dungeon:2456", ore: 28617, oreName: "Banidine", qty: 20000, pos: { x: 2970.525634765625, y: 1719.3551025390625,  z: -11732.9990234375 } },
  { name: "Asteroid Catastrophe", missionID: 4804, templateID: "client-dungeon:2450", ore: 28618, oreName: "Augumene", qty: 3600,  pos: { x: -17288.51171875,  y: -14128.806640625,    z: -1341.41943359375 } },
  { name: "Burnt Traces",         missionID: 4805, templateID: "client-dungeon:2451", ore: 28618, oreName: "Augumene", qty: 3600,  pos: { x: 19497.19140625,   y: -8388.244140625,     z: 6668.2099609375 } },
  { name: "Mercium Experiments",  missionID: 4814, templateID: "client-dungeon:2454", ore: 28619, oreName: "Mercium",  qty: 1800,  pos: { x: 6068.9169921875,  y: -1699.62939453125,   z: 2848.41455078125 } },
];

function applyMiningHints(template, mission) {
  const ph = (template.populationHints && typeof template.populationHints === "object")
    ? template.populationHints
    : (template.populationHints = {});
  // The single special-ore asteroid at its exact retail position, holding the full objective quantity.
  ph.miningRocks = [
    {
      oreTypeID: mission.ore,
      count: 1,
      quantity: mission.qty,
      positionOffset: { x: mission.pos.x, y: mission.pos.y, z: mission.pos.z },
      label: mission.oreName,
    },
  ];
  // Mining objective: complete once objectiveQuantity ore has been extracted (Plan C2).
  ph.objectiveTypeID = mission.ore;
  ph.objectiveQuantity = mission.qty;
  // Peaceful basic mining mission: no hostiles, and never auto-complete via encounter-clear.
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
  return ph;
}

async function main() {
  const argv = process.argv.slice(2);
  const target = argv.includes("--sandbox") ? "sandbox" : argv.includes("--live") ? "live" : "static";

  const applyTarget = await resolveApplyTarget({ target });
  const dungeon = await readDungeonAuthority(applyTarget.dataDir);
  dungeon.templatesByID = dungeon.templatesByID || {};

  const results = [];
  for (const mission of MINING_MISSIONS) {
    const template = dungeon.templatesByID[mission.templateID];
    if (!template) {
      results.push({ mission, ok: false, reason: "template not found" });
      continue;
    }
    applyMiningHints(template, mission);
    results.push({ mission, ok: true });
  }

  const applied = results.filter((r) => r.ok);
  await writeDungeonAuthority(applyTarget.dataDir, dungeon);

  process.stdout.write(`\nApplied ${applied.length}/${MINING_MISSIONS.length} mining missions to ${applyTarget.target.toUpperCase()}\n`);
  process.stdout.write(`  data dir: ${applyTarget.dataDir}\n\n`);
  for (const r of results) {
    const m = r.mission;
    if (r.ok) {
      process.stdout.write(`  OK  ${m.name.padEnd(22)} ${m.templateID}  mine ${m.qty} ${m.oreName} (type ${m.ore}) @ (${Math.round(m.pos.x)}, ${Math.round(m.pos.y)}, ${Math.round(m.pos.z)})\n`);
    } else {
      process.stderr.write(`  !!  ${m.name.padEnd(22)} ${m.templateID}  ${r.reason}\n`);
    }
  }
  process.stdout.write(
    applyTarget.target === "static"
      ? "\nWrote the static-table source of truth. Build it:\n  cd <eve.js> && node tools/DatabaseCreator/database-creator.js --force\nThen start the server; force a mission with e.g. EVEJS_FORCE_MISSION_ID=4802 (Bountiful Banidine).\n"
      : "\nRestart the EveJS server to load it.\n",
  );
  if (applied.length !== MINING_MISSIONS.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`mining-missions-apply failed: ${error.message}\n`);
  process.exit(1);
});
