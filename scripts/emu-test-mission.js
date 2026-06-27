#!/usr/bin/env node
/**
 * emu-test-mission.js — client-free verification that scraped content reached EveJS and that a Level 1
 * security agent offers/accepts The Score. Runs against the sandbox only; eve.js is required read-only.
 *
 *   Stage 1: read the patched eve-survival:<Wakka> template straight from the sandbox data file and confirm
 *            our scraped spawn groups are present (proves "write to emulator correctly").
 *   Stage 2: require eve.js, find a L1 security agent that offers The Score (mission 2391), accept it, and
 *            report which eve-survival variant it resolves to + whether the accepted instance carries our
 *            scraped spawns. Runtime tables are backed up and restored.
 *
 * Usage: node scripts/emu-test-mission.js --wakka Score1gu
 */

const fs = require("node:fs");
const path = require("node:path");
const { sandboxDataDir, dungeonAuthorityFile } = require("../src/lib/sandbox");
const { resolveEveRoot } = require("../src/lib/dataStore");

const THE_SCORE_MISSION_ID = 2391;

function parseArgs(argv) {
  const args = { wakka: "Score1gu", agentScanCap: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--wakka") args.wakka = String(argv[++i] || "Score1gu");
    else if (argv[i] === "--mission") args.missionID = Number(argv[++i]) || THE_SCORE_MISSION_ID;
    else if (argv[i] === "--eve-root") args.eveRoot = String(argv[++i] || "");
    else if (argv[i] === "--scan") args.agentScanCap = Number(argv[++i]) || 60;
  }
  args.missionID = args.missionID || THE_SCORE_MISSION_ID;
  return args;
}

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function spawnSummary(template) {
  const lines = [];
  for (const room of template.rooms || []) {
    const groups = room.groups && room.groups.length ? room.groups : [{ title: room.title, spawnEntries: room.spawnEntries }];
    for (const group of groups) {
      for (const entry of group.spawnEntries || []) {
        if (entry.entityKind === "npc") lines.push(`${entry.count && entry.count.min || "?"}x ${entry.label} (${(entry.candidateNames || []).join("/")})`);
      }
    }
  }
  return lines;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const eveRoot = resolveEveRoot(args.eveRoot);
  const sandbox = sandboxDataDir(eveRoot);
  const templateID = `eve-survival:${args.wakka}`;

  // ---- Stage 1: applied content (pure file read) ----
  const dungeonFile = dungeonAuthorityFile(sandbox);
  if (!fs.existsSync(dungeonFile)) fail(`No sandbox dungeonAuthority. Run: npm run scrape-apply -- --wakka ${args.wakka}`);
  const dungeon = JSON.parse(fs.readFileSync(dungeonFile, "utf8"));
  const applied = (dungeon.templatesByID || {})[templateID];
  if (!applied) fail(`${templateID} not found in sandbox. Run scrape-apply first.`);
  const appliedSpawns = spawnSummary(applied);
  const authored = applied.populationHints && applied.populationHints.source === "eve_anom_utility";
  process.stdout.write(`Stage 1 — applied template ${templateID}:\n`);
  process.stdout.write(`  authored-by-utility: ${authored}\n`);
  process.stdout.write(`  spawn groups: ${appliedSpawns.length ? appliedSpawns.join("  |  ") : "(none)"}\n`);
  if (!authored || !appliedSpawns.length) fail("applied template does not carry authored spawns");

  // ---- Stage 2: a L1 security agent offers + accepts The Score ----
  process.env.EVEJS_GAMESTORE_DATA_DIR = sandbox;
  const database = require(path.join(eveRoot, "server/src/gameStore"));
  const { listAgents } = require(path.join(eveRoot, "server/src/services/agent/agentAuthority"));
  const mr = require(path.join(eveRoot, "server/src/services/agent/agentMissionRuntime"));
  const ma = require(path.join(eveRoot, "server/src/services/agent/missionAuthority"));
  const { mutateCharacterState, resetCharacterState } = require(path.join(eveRoot, "server/src/services/agent/missionRuntimeState"));
  const dungeonRuntime = require(path.join(eveRoot, "server/src/services/dungeon/dungeonRuntime"));

  const characterID = Object.keys(database.read("characters", "/").data || {}).map(Number).filter((n) => n > 0).sort((a, b) => a - b)[0];
  if (!characterID) fail("no character in sandbox");

  const backup = {
    missionRuntimeState: JSON.parse(JSON.stringify(database.read("missionRuntimeState", "/").data || {})),
    dungeonRuntimeState: JSON.parse(JSON.stringify(database.read("dungeonRuntimeState", "/").data || {})),
    items: JSON.parse(JSON.stringify(database.read("items", "/").data || {})),
  };
  const restore = () => {
    database.write("missionRuntimeState", "/", backup.missionRuntimeState);
    database.write("dungeonRuntimeState", "/", backup.dungeonRuntimeState);
    database.write("items", "/", backup.items);
  };

  const agents = listAgents().filter((a) => Number(a.agentID) > 0 && Number(a.stationID) > 0 && Number(a.level) === 1);

  // Offer The Score by setting the agent's selection cursor to the mission's pool index, then verifying the
  // offered contentID actually is the mission (the pool/plausible orderings can diverge).
  function offerTheScore(agent) {
    const ids = (mr.getPlausibleMissionIDs(agent.agentID) || []).map(Number);
    const idx = ids.indexOf(args.missionID);
    if (idx < 0) return null;
    resetCharacterState(characterID);
    mutateCharacterState(characterID, (cs) => {
      cs.missionsByAgentID = {};
      cs.declineTimersByAgentID = {};
      cs.missionSelectionCursorByAgentID = { [String(agent.agentID)]: idx };
      return { kind: "seed" };
    });
    mr.doAgentAction(characterID, agent.agentID, mr.AGENT_DIALOGUE_BUTTON_REQUEST_MISSION);
    const rec = mr.getMissionRecord(characterID, agent.agentID);
    return rec && Number(rec.contentID) === args.missionID ? rec : null;
  }

  let chosen = null;
  let offered = null;
  let scanned = 0;
  for (const agent of agents) {
    if (scanned >= args.agentScanCap) break;
    if (!(mr.getPlausibleMissionIDs(agent.agentID) || []).map(Number).includes(args.missionID)) continue;
    scanned += 1;
    const rec = offerTheScore(agent);
    if (rec) { chosen = agent; offered = rec; break; }
  }

  if (!chosen) { restore(); fail(`no L1 security agent offered mission ${args.missionID} within ${args.agentScanCap} candidates`); }

  const acc = mr.doAgentAction(characterID, chosen.agentID, mr.AGENT_DIALOGUE_BUTTON_ACCEPT);
  const accepted = mr.getMissionRecord(characterID, chosen.agentID);
  const instance = accepted && accepted.dungeonInstanceID ? dungeonRuntime.getInstance(accepted.dungeonInstanceID) : null;
  const resolvedTemplate = (offered && offered.missionTemplateID) || (instance && instance.templateID) || "(unknown)";

  // Read the instance's materialized room spawns (carried as rawRoomProfile.spawnEntries).
  const instanceSpawns = [];
  if (instance && instance.roomStatesByKey) {
    for (const room of Object.values(instance.roomStatesByKey)) {
      const raw = room && room.metadata && room.metadata.rawRoomProfile;
      const entries = [
        ...((raw && raw.spawnEntries) || []),
        ...(((raw && raw.groups) || []).flatMap((g) => (g && g.spawnEntries) || [])),
      ];
      for (const e of entries) if (e && e.entityKind === "npc") instanceSpawns.push(e.raw || `${e.count && e.count.min}x ${e.label}`);
    }
  }

  const mission = ma.getMissionByID(args.missionID);
  const missionName = mission && (typeof mission.localizedName === "string" ? mission.localizedName : (mission.localizedName && (mission.localizedName.en || mission.localizedName.value))) || "The Score";
  process.stdout.write(`\nStage 2 — agent offer/accept:\n`);
  process.stdout.write(`  mission ${args.missionID} (${missionName}) offered by L1 agent ${chosen.agentID} @station ${chosen.stationID} (system ${chosen.solarSystemID})\n`);
  process.stdout.write(`  accepted: ${acc && acc.success} | objectiveMode: ${accepted && accepted.objectiveMode} | dungeonInstanceID: ${accepted && accepted.dungeonInstanceID}\n`);
  process.stdout.write(`  resolved eve-survival variant: ${resolvedTemplate}\n`);
  process.stdout.write(`  accepted-instance npc spawns: ${instanceSpawns.length ? instanceSpawns.join("  |  ") : "(materialized on warp-in)"}\n`);

  const acceptedOk = acc && acc.success && Number(accepted && accepted.dungeonInstanceID) > 0 && /^eve-survival:/.test(resolvedTemplate);
  restore();

  process.stdout.write("\n");
  if (resolvedTemplate === templateID) {
    process.stdout.write(`RESULT: a L1 security agent accepted The Score and it resolved to OUR template ${templateID}. End-to-end content path confirmed.\n`);
  } else {
    process.stdout.write(`RESULT: a L1 security agent accepts The Score, but EveJS's fuzzy mission->template matcher resolved it to ${resolvedTemplate}, not ${templateID}.\n`);
    process.stdout.write(`        To test that variant end-to-end, apply the one the agent uses:  npm run scrape-apply -- --wakka ${resolvedTemplate.replace(/^eve-survival:/, "")}\n`);
  }
  if (!acceptedOk) fail("agent did not accept into an eve-survival mission dungeon");
  process.stdout.write("emu-test passed (template applied; L1 agent offers + accepts The Score into an eve-survival dungeon).\n");
}

main();
