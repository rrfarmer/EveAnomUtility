#!/usr/bin/env node
/**
 * scrape-test.js — offline, reproducible parser check against a saved eve-survival fixture.
 */
const fs = require("node:fs");
const path = require("node:path");
const { parseEveSurvival } = require("../src/lib/missionScraper");
const { buildRooms, buildTemplate } = require("../src/lib/eveSurvivalTemplate");
const { parseEveUniversityMission } = require("../src/lib/eveUniversityMission");
const { mergeMissionSources } = require("../src/lib/missionSourceMerge");

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
  assert(full.populationHints.completion.mode === "encounter_groups_cleared", "Score fallback completes when encounters are cleared");
  assert(full.populationHints.completion.completeObjectiveOnEncounterClear === true, "Score fallback enables encounter-clear completion");
  assert(full.adminMetadata.playability.grade === "scraped_fallback_clear_all", "Score template is playable via clear-all fallback");
  assert(full.populationHints.playability.strategy === "fallback_clear_all_hostiles", "Score population hints expose fallback strategy");

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

  const avengeSurvival = parseEveSurvival(`
    <h1>Avenge a Fallen Comrade, Level 1</h1>
    Faction: Angel Cartel<br>
    <h3>First Pocket</h3>
    Acceleration gate.<br>
    <h3>Second Pocket</h3>
    <h4>Group 1</h4>
    2x Frigate (Gistii Hijacker)<br>
    <h4>Group 2</h4>
    3x Frigate (Gistii Rogue)<br>
    <h4>Group 3</h4>
    1x Frigate (Gistii Ambusher)<br>
    <h4>Group 4</h4>
    8x Frigate (Gistii Hijacker)<br>
    Mission objective: Habitat at about 75km<br>
  `, "AvengeaFallenComrade1an");
  const avengeUniversity = parseEveUniversityMission(`
    <table>
      <tr><td class="MssnDtls-label">Objective</td><td class="MssnDtls-data">Destroy the habitat of the pirate leaders.</td></tr>
      <tr><td class="MssnDtls-label">Best damage to deal</td><td class="MssnDtls-data">Explosive</td></tr>
      <tr><td class="MssnDtls-label">Damage to resist</td><td class="MssnDtls-data">Explosive / Kinetic</td></tr>
    </table>
    <b>Blitz:</b><ul><li>Destroy Habitat, warp out.</li></ul>
    <h3><span class="mw-headline" id="Pocket">Pocket</span></h3>
    <p>Warp in on top of Group 1. Group 2-4 aggro individually on attack, or when the habitat is engaged.</p>
    <div style="font-weight:bold">Structures</div>
    <table class="wikitable NPC">
      <tr><td></td><td>1 x Habitat</td><td>Mission completed on destruction</td></tr>
    </table>
    <div style="font-weight:bold">Pocket</div>
    <table class="wikitable NPC">
      <tr><th colspan="5">Group 2 (20km)</th></tr>
      <tr><td></td><td>3 x Frigate Gistii Hijacker/Rogue</td></tr>
      <tr><th colspan="5">Group 3 (35km)</th></tr>
      <tr><td></td><td>1 x Frigate Gistii Raider/Ambusher</td></tr>
    </table>
    <table class="navbox"></table>
  `, {
    page_key: "Avenge_a_Fallen_Comrade_(Angel_Cartel)_(Level_1)",
    url: "https://wiki.eveuniversity.org/Avenge_a_Fallen_Comrade_(Angel_Cartel)_(Level_1)",
    title: "Avenge a Fallen Comrade",
    level: 1,
    enemy_faction: "Angel Cartel",
  });
  const mergedAvenge = mergeMissionSources(avengeSurvival, avengeUniversity);
  assert(mergedAvenge.source === "eve-survival+eve-university", "Avenge merged both mission sources");
  assert(mergedAvenge.rooms[1].groups.every((group) => group.objective === false), "Avenge NPC groups are not the completion objective");
  assert(mergedAvenge.rooms[1].groups[1].spawns[0].shipNames.includes("Gistii Hijacker"), "Avenge Group 2 includes Hijacker variant");
  assert(mergedAvenge.rooms[1].groups[1].spawns[0].shipNames.includes("Gistii Rogue"), "Avenge Group 2 includes Rogue variant");
  assert(mergedAvenge.rooms[1].groups[2].spawns[0].shipNames.includes("Gistii Raider"), "Avenge Group 3 includes Raider variant");
  assert(mergedAvenge.objectiveStructures.length === 1 && mergedAvenge.objectiveStructures[0].typeID === 19559, "Avenge Habitat maps to killable structure typeID");
  assert(mergedAvenge.completion.mode === "objective_target_destroyed", "Avenge completes on objective structure destruction");

  const avengeTemplate = buildTemplate(mergedAvenge);
  assert(avengeTemplate.siteSceneProfile.gateProfiles[0].destinationRoomKey === "room:room_2", "Avenge gate skips empty gate pocket and targets combat pocket");
  assert(avengeTemplate.populationHints.completion.completeObjectiveOnEncounterClear === false, "Avenge does not complete from clearing NPC encounters");
  assert(avengeTemplate.populationHints.completion.objectiveTargets[0].typeID === 19559, "Avenge completion target has Habitat typeID");
  assert(avengeTemplate.adminMetadata.playability.strategy === "modeled_objective_target_destroyed", "Avenge playability uses modeled objective target");
  assert(avengeTemplate.populationHints.playability.strategy === "modeled_objective_target_destroyed", "Avenge population hints expose modeled objective strategy");
  const objectiveEncounter = avengeTemplate.populationHints.encounters.find((encounter) => encounter.key === "objective_structures:room_2");
  assert(objectiveEncounter, "Avenge emits explicit objective-structure encounter");
  assert(objectiveEncounter.trigger === "on_room_active" && objectiveEncounter.roomKey === "room:room_2", "Avenge Habitat spawns when gated pocket activates");
  assert(objectiveEncounter.spawnEntries[0].entityKind === "killableStructure", "Avenge Habitat spawn is a killable structure");
  assert(objectiveEncounter.spawnEntries[0].typeID === 19559, "Avenge Habitat spawn entry keeps typeID");
  assert(avengeTemplate.rooms[1].groups.some((group) => group.groupId === "objective_structures"), "Avenge authored room contains objective structure group");
  assert(avengeTemplate.objectiveHints.some((hint) => /habitat/i.test(hint.text)), "Avenge objective hint includes Habitat objective");

  process.stdout.write("Scrape test passed (Score fixture + Avenge source merge regression).\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
