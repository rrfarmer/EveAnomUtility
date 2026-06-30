#!/usr/bin/env node
/**
 * scrape-apply.js
 *
 * On-demand: scrape an eve-survival.org mission and apply it to the EveJS gameStore *sandbox* so a Level 1
 * agent will spawn it. Never touches live data. EveJS does no scraping — this utility does, only when run.
 *
 * Usage:
 *   node scripts/scrape-apply.js --wakka Score1gu
 *   node scripts/scrape-apply.js --url "https://eve-survival.org/?wakka=Score1gu"
 *   node scripts/scrape-apply.js --wakka Score1gu --reset   # re-copy a clean sandbox first
 */

const { scrapeEveSurvival } = require("../src/lib/missionScraper");
const { patchExistingTemplate, buildTemplate, missionHasAccelerationGate } = require("../src/lib/eveSurvivalTemplate");
const { validateMissionTemplate } = require("../src/lib/missionTemplateValidator");
const { resolveApplyTarget, backupTemplateOnce, readDungeonAuthority, writeDungeonAuthority } = require("../src/lib/sandbox");

function parseArgs(argv) {
  const args = { reset: false, target: "static", mergeSources: true };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--reset") args.reset = true;
    else if (token === "--no-merge") args.mergeSources = false;
    else if (token === "--sandbox") args.target = "sandbox";
    else if (token === "--live") args.target = "live";
    else if (token === "--static") args.target = "static";
    else if (token === "--target") args.target = String(argv[++i] || "static");
    else if (token === "--wakka") args.wakka = String(argv[++i] || "");
    else if (token === "--url") args.url = String(argv[++i] || "");
    else if (token === "--eve-root") args.eveRoot = String(argv[++i] || "");
    else if (token === "--gate") args.gate = true;
    else if (token === "--no-gate") args.gate = false;
  }
  return args;
}

function printMission(mission) {
  process.stdout.write(`\n${mission.title} — ${mission.faction || "?"} (level ${mission.level ?? "?"})\n`);
  if (mission.ewar) process.stdout.write(`  EWAR: ${mission.ewar}\n`);
  if (mission.damageToDeal) process.stdout.write(`  Damage: ${mission.damageToDeal}\n`);
  if (mission.sourceMerge) {
    process.stdout.write(`  Merged source: ${mission.sourceMerge.eveUniversityPageKey || "Eve University"}\n`);
  }
  if (mission.objectiveText) process.stdout.write(`  Objective: ${mission.objectiveText}\n`);
  mission.rooms.forEach((room, i) => {
    process.stdout.write(`  Pocket ${i + 1}: ${room.title}\n`);
    room.groups.forEach((group) => {
      const dist = group.distance ? ` @${Math.round(group.distance.minMeters / 1000)}km` : "";
      const obj = group.objective ? " [objective]" : "";
      const spawns = group.spawns.map((s) => `${s.count}x ${s.shipClass} (${s.shipNames.join("/")})`).join("; ");
      process.stdout.write(`    ${group.title}${dist}${obj}: ${spawns}\n`);
    });
  });
  if (mission.structures.length) {
    process.stdout.write(`  Structures: ${mission.structures.map((s) => `${s.count}x ${s.shipClass}`).join(", ")}\n`);
  }
  if (Array.isArray(mission.objectiveStructures) && mission.objectiveStructures.length) {
    process.stdout.write(`  Objective structures: ${mission.objectiveStructures.map((s) => `${s.count}x ${s.label || s.shipClass} typeID=${s.typeID || "?"}`).join(", ")}\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.url || args.wakka;
  if (!target) {
    process.stderr.write("Usage: scrape-apply --wakka <Wakka> | --url <eve-survival url> [--reset]\n");
    process.exit(2);
  }

  process.stdout.write(`Scraping eve-survival: ${target}\n`);
  const mission = await scrapeEveSurvival(target, { mergeSources: args.mergeSources });
  // Combat missions gate-start by default; --gate / --no-gate is an explicit override.
  if (args.gate !== undefined) mission.hasAccelerationGate = args.gate;
  const gated = missionHasAccelerationGate(mission);
  const gateReason = args.gate !== undefined ? "explicit" : (mission.gateDetected ? "detected" : "combat default");
  process.stdout.write(`Acceleration gate: ${gated ? `yes (warp-in gate -> pocket spawns) [${gateReason}]` : `no (spawns on warp-in) [${args.gate === false ? "explicit --no-gate" : "non-combat"}]`}\n`);
  printMission(mission);
  const templateID = `eve-survival:${mission.wakka}`;

  const applyTarget = await resolveApplyTarget({ target: args.target, eveRoot: args.eveRoot, reset: args.reset });
  const dungeon = await readDungeonAuthority(applyTarget.dataDir);
  dungeon.templatesByID = dungeon.templatesByID || {};
  const existing = dungeon.templatesByID[templateID];

  let action;
  let backup = null;
  if (existing) {
    if (applyTarget.target !== "sandbox") backup = await backupTemplateOnce(templateID, existing);
    patchExistingTemplate(existing, mission);
    action = "patched existing";
  } else {
    dungeon.templatesByID[templateID] = buildTemplate(mission);
    action = "inserted new";
  }
  await writeDungeonAuthority(applyTarget.dataDir, dungeon);

  for (const warning of validateMissionTemplate(dungeon.templatesByID[templateID]).warnings) {
    process.stderr.write(`  warn: ${warning}\n`);
  }
  const npcSpawns = mission.rooms.reduce((n, r) => n + r.groups.reduce((m, g) => m + g.spawns.length, 0), 0);
  process.stdout.write(
    [
      "",
      `Applied to ${applyTarget.target.toUpperCase()} (${action} ${templateID}).`,
      `  data dir: ${applyTarget.dataDir}${applyTarget.copied ? " (freshly copied)" : ""}`,
      `  rooms / groups / npc spawn lines: ${mission.rooms.length} / ${mission.rooms.reduce((n, r) => n + r.groups.length, 0)} / ${npcSpawns}`,
      backup ? `  backup of original: ${backup}` : "",
      "",
      applyTarget.target === "static"
        ? "Wrote the static-table source of truth. Build it into the runtime:\n  tools/DatabaseCreator/CreateDatabase.bat   (or: node tools/DatabaseCreator/database-creator.js --force)\n  Then start the server with EVEJS_FORCE_MISSION_TEMPLATE=" + templateID
        : applyTarget.target === "live"
          ? "Restart the EveJS server to load the change (throwaway -- wiped on the next --force build). For a one-off test,\n  start with EVEJS_FORCE_MISSION_TEMPLATE=" + templateID
          : `Next: verify a Level 1 agent spawns it:\n  npm run emu-test -- --wakka ${mission.wakka}`,
      "",
    ].filter((l) => l !== "").join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`scrape-apply failed: ${error.message}\n`);
  process.exit(1);
});
