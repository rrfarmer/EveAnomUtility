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

  const gallente = parseEveSurvival(`
    <h1>The Score, level 1</h1>
    Faction: Gallente Federation<br>
    Damage dealt: Therm, Kin<br>
    <h3>Pocket</h3>
    <h4>Group 1 - 40km</h4>
    6x Federation Clavis (Atron)<br>
    2x Federation Hoplon (Incursus)<br>
    <h4>Group 2 - 45km</h4>
    1x Federation Libertus (Atron) (Damp)<br>
    1x Federation Manicu (Atron) (Damp)<br>
    1x Federation Pelekus (Catalyst)<br>
    Group 1+2 aggro together<br>
    <h5>Blitz</h5>
    Kill Group 1 and 2
  `, "Score1ga");
  assert(gallente.rooms[0].groups[0].distance.minMeters === 40000, "Gallente Group 1 @40km, not 1-40km");
  assert(gallente.rooms[0].groups[0].spawns.length === 2, "Gallente direct NPC-name rows become group spawns");
  assert(gallente.rooms[0].groups[0].spawns[0].entityKind === "npc", "Gallente direct NPC-name row is NPC");
  assert(gallente.rooms[0].groups[0].spawns[0].shipNames.includes("Federation Clavis"), "Gallente NPC candidate keeps exact NPC name");
  assert(gallente.rooms[0].groups[1].spawns.length === 3, "Gallente annotated NPC rows are parsed");
  assert(gallente.rooms[0].groups[1].spawns[0].tags.includes("sensorDamp"), "Gallente Damp annotation becomes sensorDamp tag");
  assert(gallente.rooms[0].groups[1].notes.includes("Group 1+2 aggro together"), "Gallente free-text group note is preserved");
  const gallenteTemplate = buildTemplate(gallente);
  assert(gallenteTemplate.populationHints.npcEntryCount === 5, `Gallente template count (${gallenteTemplate.populationHints.npcEntryCount})`);
  assert(gallenteTemplate.rooms[0].groups[1].spawnEntries[0].tags.includes("sensorDamp"), "Gallente template preserves Damp tag");
  assert(gallenteTemplate.rooms[0].groups[1].notes.includes("Group 1+2 aggro together"), "Gallente template preserves group note");
  assert(gallenteTemplate.siteSceneProfile.roomProfiles.some((room) => room.roomKey === "room:room_1"), "Gallente template emits roomKey profiles");
  assert(gallente.structures.length === 0, "Gallente group NPC rows are not structures");

  process.stdout.write("Scrape test passed (eve-survival Score1gu fixture).\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
