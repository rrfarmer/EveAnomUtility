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
const { patchExistingTemplate, buildTemplate } = require("../src/lib/eveSurvivalTemplate");
const { ensureSandbox, readDungeonAuthority, writeDungeonAuthority } = require("../src/lib/sandbox");

function parseArgs(argv) {
  const args = { reset: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--reset") args.reset = true;
    else if (token === "--wakka") args.wakka = String(argv[++i] || "");
    else if (token === "--url") args.url = String(argv[++i] || "");
    else if (token === "--eve-root") args.eveRoot = String(argv[++i] || "");
  }
  return args;
}

function printMission(mission) {
  process.stdout.write(`\n${mission.title} — ${mission.faction || "?"} (level ${mission.level ?? "?"})\n`);
  if (mission.ewar) process.stdout.write(`  EWAR: ${mission.ewar}\n`);
  if (mission.damageToDeal) process.stdout.write(`  Damage: ${mission.damageToDeal}\n`);
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
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.url || args.wakka;
  if (!target) {
    process.stderr.write("Usage: scrape-apply --wakka <Wakka> | --url <eve-survival url> [--reset]\n");
    process.exit(2);
  }

  process.stdout.write(`Scraping eve-survival: ${target}\n`);
  const mission = await scrapeEveSurvival(target);
  printMission(mission);
  const templateID = `eve-survival:${mission.wakka}`;

  const sandbox = await ensureSandbox({ eveRoot: args.eveRoot, reset: args.reset });
  const dungeon = await readDungeonAuthority(sandbox.sandboxDataDir);
  dungeon.templatesByID = dungeon.templatesByID || {};
  const existing = dungeon.templatesByID[templateID];

  let action;
  if (existing) {
    patchExistingTemplate(existing, mission);
    action = "patched existing";
  } else {
    dungeon.templatesByID[templateID] = buildTemplate(mission);
    action = "inserted new";
  }
  await writeDungeonAuthority(sandbox.sandboxDataDir, dungeon);

  const npcSpawns = mission.rooms.reduce((n, r) => n + r.groups.reduce((m, g) => m + g.spawns.length, 0), 0);
  process.stdout.write(
    [
      "",
      `Applied to sandbox (${action} ${templateID}).`,
      `  sandbox: ${sandbox.sandboxDataDir}${sandbox.copied ? " (freshly copied)" : " (existing)"}`,
      `  rooms / groups / npc spawn lines: ${mission.rooms.length} / ${mission.rooms.reduce((n, r) => n + r.groups.length, 0)} / ${npcSpawns}`,
      "",
      "Next: verify a Level 1 agent spawns it:",
      `  npm run emu-test -- --wakka ${mission.wakka}`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`scrape-apply failed: ${error.message}\n`);
  process.exit(1);
});
