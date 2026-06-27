#!/usr/bin/env node
/**
 * scrape-test.js — offline, reproducible parser check against a saved eve-survival fixture.
 */
const fs = require("node:fs");
const path = require("node:path");
const { parseEveSurvival } = require("../src/lib/missionScraper");
const { buildRooms, buildTemplate } = require("../src/lib/eveSurvivalTemplate");

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function main() {
  const html = fs.readFileSync(path.join(__dirname, "..", "test", "fixtures", "Score1gu.html"), "utf8");
  const mission = parseEveSurvival(html, "Score1gu");

  assert(/The Score/i.test(mission.title), "title is The Score");
  assert(mission.faction === "Guristas", `faction Guristas (got ${mission.faction})`);
  assert(mission.level === 1, `level 1 (got ${mission.level})`);
  assert(/jamming/i.test(mission.ewar), "ewar mentions jamming");
  assert(mission.rooms.length === 1, `1 pocket (got ${mission.rooms.length})`);

  const groups = mission.rooms[0].groups;
  assert(groups.length === 3, `3 groups (got ${groups.length})`);

  const g1 = groups[0];
  assert(g1.objective === true, "Group 1 is objective (blitz)");
  assert(g1.distance && g1.distance.minMeters === 40000, "Group 1 @40km");
  assert(g1.spawns.length === 1 && g1.spawns[0].count === 3 && g1.spawns[0].shipClass === "Frigate", "Group 1 = 3x Frigate");
  assert(g1.spawns[0].shipNames.includes("Pithi Saboteur"), "Group 1 includes Pithi Saboteur");

  const g2 = groups[1];
  assert(g2.objective === true, "Group 2 is objective (blitz)");
  assert(g2.spawns.some((s) => s.shipClass === "Destroyer" && s.shipNames.includes("Pithior Renegade")), "Group 2 has Pithior Renegade destroyer");

  const g3 = groups[2];
  assert(g3.objective === false, "Group 3 is NOT objective");

  // Template builder produces group-nested spawnEntries with candidateNames.
  const rooms = buildRooms(mission);
  const entries = rooms[0].groups[0].spawnEntries;
  assert(entries.length === 1 && entries[0].count.min === 3 && entries[0].candidateNames.includes("Pithi Saboteur"), "template spawnEntry candidateNames");
  const full = buildTemplate(mission);
  assert(full.templateID === "eve-survival:Score1gu" && full.populationHints.npcEntryCount === 4, `full template (${full.populationHints.npcEntryCount} npc entries)`);

  process.stdout.write("Scrape test passed (eve-survival Score1gu fixture).\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
