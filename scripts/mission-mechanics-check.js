#!/usr/bin/env node
/**
 * mission-mechanics-check.js (Plan E2)
 *
 * Asserts the EveAnomUtility builders emit correct, EveJS-supported mechanics per mission TYPE, and
 * that the pre-apply validator catches broken ones. Pure Utility-side (no eve.js runtime needed) —
 * run with `npm run mission-check`.
 */

const assert = require("node:assert");
const { buildTemplate } = require("../src/lib/eveSurvivalTemplate");
const { validateMissionTemplate } = require("../src/lib/missionTemplateValidator");

function check(name, fn) {
  fn();
  process.stdout.write(`  ok  ${name}\n`);
}

// Gate combat: a combat scrape gets a gate-first deadspace (acceleration gate -> first pocket).
check("gate combat: acceleration gate to the first pocket", () => {
  const t = buildTemplate({
    wakka: "Score1gu",
    rooms: [{ roomId: "room_1", groups: [{ spawns: [{ count: 3, shipClass: "Frigate", shipNames: ["Pithi"] }] }] }],
  });
  const gates = t.siteSceneProfile.gateProfiles;
  assert.equal(gates.length, 1, "one acceleration gate");
  assert.equal(gates[0].typeID, 17831, "acceleration gate type id");
  assert.equal(gates[0].destinationRoomKey, "room:room_1", "gate targets the first pocket");
  const v = validateMissionTemplate(t);
  assert.equal(v.errors.length, 0, `no errors: ${v.errors.join("; ")}`);
});

// Mining: mining params -> mineable rocks + objective quantity EveJS reads.
check("mining: miningRocks + objectiveQuantity", () => {
  const t = buildTemplate({ wakka: "AsteroidCatastrophe", rooms: [], mining: { objectiveTypeID: 3739, quantity: 5000, rockCount: 6 } });
  const ph = t.populationHints;
  assert.equal(ph.objectiveQuantity, 5000, "objective quantity");
  assert.ok(Array.isArray(ph.miningRocks) && ph.miningRocks.length === 1, "mining rocks present");
  assert.equal(ph.miningRocks[0].typeID, 3739, "ore type id");
  const v = validateMissionTemplate(t);
  assert.equal(v.errors.length, 0, `no errors: ${v.errors.join("; ")}`);
});

// Proximity: an authored proximity template carries target+range and validates clean.
check("proximity: target + range, validates clean", () => {
  const t = {
    templateID: "authored.test.proximity",
    siteFamily: "mission",
    siteKind: "encounter",
    siteSceneProfile: { gateProfiles: [] },
    populationHints: {
      objectiveMode: "investigate_object",
      encounters: [{ key: "w1", trigger: "proximity", proximityTargetKey: "drone", proximityRangeMeters: 6000, spawnQuery: "parity_guristas_missile_frigate", amount: 3 }],
    },
  };
  const v = validateMissionTemplate(t);
  assert.equal(v.errors.length, 0, "no errors");
  assert.ok(!v.warnings.some((w) => /without proximityTargetKey/.test(w)), "target present");
});

// Validator catches broken mechanics.
check("validator: flags gateless on_room_active + unknown trigger", () => {
  const v = validateMissionTemplate({
    templateID: "x",
    siteFamily: "mission",
    siteSceneProfile: { gateProfiles: [] },
    populationHints: { encounters: [
      { key: "e", trigger: "on_room_active", roomKey: "room:1", spawnQuery: "p" },
      { key: "f", trigger: "on_explode", spawnQuery: "p" },
    ] },
  });
  assert.ok(v.warnings.some((w) => /no acceleration gate/.test(w)), "gateless on_room_active warned");
  assert.ok(v.warnings.some((w) => /unsupported trigger/.test(w)), "unknown trigger warned");
});

process.stdout.write("Mission mechanics check passed.\n");
