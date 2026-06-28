#!/usr/bin/env node
/**
 * pack-apply.js
 *
 * Apply a decoded TQ-log "mission pack" (see src/lib/missionPack.js) to the EveJS gameStore so an
 * agent will spawn it. The pack's dungeon.json is already an EveJS dungeon-authority template, so this
 * writes it into templatesByID[<templateID>] — the same backup/live-write path as scrape-apply.
 *
 * Targets LIVE by default (the original template, if any, is backed up first). Pass --sandbox for the
 * disposable copy used by the headless harness.
 *
 * Usage:
 *   node scripts/pack-apply.js --dir "D:\\path\\to\\13735-alluring-emanations"
 *   node scripts/pack-apply.js --dir <pack> --sandbox
 */

const path = require("path");
const { loadMissionPack, summarizeMissionPack } = require("../src/lib/missionPack");
const {
  resolveApplyTarget,
  backupTemplateOnce,
  readDungeonAuthority,
  writeDungeonAuthority,
} = require("../src/lib/sandbox");

function parseArgs(argv) {
  const args = { reset: false, target: "live" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--reset") args.reset = true;
    else if (token === "--sandbox") args.target = "sandbox";
    else if (token === "--live") args.target = "live";
    else if (token === "--target") args.target = String(argv[++i] || "live");
    else if (token === "--dir") args.dir = String(argv[++i] || "");
    else if (token === "--eve-root") args.eveRoot = String(argv[++i] || "");
  }
  return args;
}

function printSummary(summary) {
  const triggers = Object.entries(summary.triggers)
    .map(([trigger, count]) => `${count}x ${trigger}`)
    .join(", ") || "none";
  process.stdout.write(
    [
      "",
      `${summary.title}  [${summary.templateID}]`,
      `  family/kind:   ${summary.siteFamily} / ${summary.siteKind || "?"}`,
      `  objective:     ${summary.objectiveMode || "(kill)"}`,
      `  encounters:    ${summary.encounterCount} (triggers: ${triggers})`,
      `  spawnEntries:  ${summary.explicitSpawnEntries} explicit per-NPC entries`,
      `  gates:         ${summary.gateCount}`,
      `  env props:     ${summary.environmentPropCount}`,
      summary.sourceLog ? `  source log:    ${summary.sourceLog}` : "",
      "",
    ].filter((line) => line !== "").join("\n"),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    process.stderr.write("Usage: pack-apply --dir <mission pack folder> [--sandbox] [--reset]\n");
    process.exit(2);
  }

  process.stdout.write(`Loading mission pack: ${path.resolve(args.dir)}\n`);
  const pack = loadMissionPack(args.dir);
  const summary = summarizeMissionPack(pack);
  printSummary(summary);

  const templateID = pack.dungeon.templateID;
  const applyTarget = await resolveApplyTarget({
    target: args.target,
    eveRoot: args.eveRoot,
    reset: args.reset,
  });
  const dungeon = await readDungeonAuthority(applyTarget.dataDir);
  dungeon.templatesByID = dungeon.templatesByID || {};
  const existing = dungeon.templatesByID[templateID];

  let backup = null;
  if (existing && applyTarget.target === "live") {
    backup = await backupTemplateOnce(templateID, existing);
  }
  dungeon.templatesByID[templateID] = pack.dungeon;
  await writeDungeonAuthority(applyTarget.dataDir, dungeon);

  const forceFlags = [
    summary.missionID ? `EVEJS_FORCE_MISSION_ID=${summary.missionID}` : null,
    `EVEJS_FORCE_MISSION_TEMPLATE=${templateID}`,
    summary.dungeonID ? `EVEJS_FORCE_MISSION_DUNGEON_ID=${summary.dungeonID}` : null,
  ].filter(Boolean);

  process.stdout.write(
    [
      "",
      `Applied to ${applyTarget.target.toUpperCase()} (${existing ? "overwrote" : "inserted"} ${templateID}).`,
      `  data dir: ${applyTarget.dataDir}${applyTarget.copied ? " (freshly copied)" : ""}`,
      backup ? `  backup of original: ${backup}` : "",
      "",
      "Restart the EveJS server to load it. To play this mission via the temp force hooks, start with:",
      ...forceFlags.map((flag) => `  ${flag}`),
      "",
    ].filter((line) => line !== "").join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`pack-apply failed: ${error.message}\n`);
  process.exit(1);
});
