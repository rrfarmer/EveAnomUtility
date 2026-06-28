# Testing missions in the EveJS emulator

This is the loop for getting a **mostly-accurate agent mission** out of the community databases and into a
playable EveJS state. All scraping happens **only in this utility, on demand**. EveJS never scrapes — we write
its data files directly.

**Apply targets the STATIC-table source of truth by default**
(`eve.js/tools/DatabaseCreator/staticTables/dungeonAuthority`) — overwriting the relevant template (the
original is backed up to `workspace/backups/dungeonAuthority/<id>.json` first). This is version-controlled and
persistent. **To test, run a full build** (`tools/DatabaseCreator/CreateDatabase.bat`, or
`node tools/DatabaseCreator/database-creator.js --force`), which rebuilds `_local/gameStore/data` from the
static tables; then start the server. We always full-build in development — no incremental syncs (see
`MISSION_MECHANICS_PLAN.md` §2).

`--live` is a **throwaway quick test**: it writes `_local/gameStore/data` directly and just needs a server
restart, but is **wiped on the next `--force` build**. `--sandbox` writes a disposable copy (headless harness).

## Prove the loop directly: `/spawnsite` (simplest)

To prove **author -> export -> server spawns it** without the agent-mission machinery, use the dev chat command
added to `server/src/services/chat/chatCommands.js` (`handleSpawnSiteCommand`; delete to remove). It reads an
authored dungeon-authority template and spawns its NPC groups at your ship with the same engine `/npc` uses.

1. Apply authored content to live: `npm run scrape-apply -- --wakka Score1gu`.
2. Restart the EveJS server (loads the command + the applied template).
3. Undock (be in space), then in chat: `/spawnsite eve-survival:Score1gu`.
4. ~10 Guristas spawn around you (3x Pithi Saboteur, 3x Pithi Despoiler, 1x Pithior Renegade, 3x Pithi
   Plunderer). Names that don't resolve fall back to the faction pool.

This is the minimal end-to-end proof. The mission flow below (force flags) tests the full *agent mission* path:
offer → accept → **warp in → site materializes (gate, then pocket spawns)**.

### The warp-in materialization fix (eve.js, uncommitted)

Combat agent missions create a private per-character deadspace site instance at accept time
(`agentMissionRuntime.ensureMissionSiteState` → `siteKind:"mission"`), and the mission journal bookmark carries
`metadata.missionInstanceID`. EveJS even had a dedicated lazy materializer for it,
`beyonceService.maybeMaterializeMissionBookmarkTarget` — **but nothing ever called it** (orphaned function). So
warping to a mission bookmark just flew to the coordinates and dropped you into an empty grid (no gate, no
spawn). Mission sites are materialized lazily on arrival (like universe anomaly sites); the trigger was simply
never wired into the warp handler.

Fixes:

- `ship/beyonceService.js` `Handle_CmdWarpToStuff` (`warpType === "bookmark"`) — now reads
  `bookmark.metadata.missionInstanceID`; if present, calls `maybeMaterializeMissionBookmarkTarget` at warp-start
  (creating the acceleration gate + encounters) and warps to the resulting site beacon, falling back to the
  bookmark coordinates. Emits `[Beyonce] bookmark warp …` / `[Beyonce] mission bookmark materialize …` logs.
- `agentMissionRuntime.listAcceptedMissionSiteInstancesForSystem` + `space/runtime.js`
  `autoMaterializeNearbyUniverseSiteForAttach` — complementary: seeds the mission beacon into the scene on
  attach (undock / system-entry / relog) so the proximity-materialize and overview-warp (`item` → `missionSite`)
  paths also work.

Whether the **acceleration gate** specifically appears depends on the materialized template carrying gate/room
data — the first milestone is just confirming materialization fires on warp-in (gate and/or spawns), then we
tune gate-first → activate → pocket sequencing for retail accuracy.

## One-off in-game test (THREE temp debug flags — all required)

Three env-gated hooks in `server/src/services/agent/agentMissionRuntime.js` (clearly commented; delete the
blocks to remove). **All three matter** — `FORCE_MISSION_ID` is the one that was missing before and is why the
test was warping to stations with no gate: without it the agent offers a *random* L1 mission that may not be a
deadspace/dungeon mission at all, so there is no acceleration-gate site to warp to.

- `EVEJS_FORCE_MISSION_ID=2391` — forces the agent to **offer The Score itself** (mission `2391`), a real
  deadspace kill mission with an acceleration gate. Without this you get whatever the agent rolls (often a
  non-deadspace mission → nothing to warp to).
- `EVEJS_FORCE_MISSION_TEMPLATE=eve-survival:Score1gu` — forces the mission's **spawns** to your scraped template
  (`getMissionInstanceTemplateRecord`).
- `EVEJS_FORCE_MISSION_DUNGEON_ID=921` — forces the mission **objective** to report a **client-renderable**
  dungeon id (`buildMissionRecord` / `buildMissionObjectivePayload`). Without this the retail client crashes: it
  calls `GetDungeon(dungeonID)` against its *local* dungeon set, and EveJS's synthetic eve-survival ids (e.g.
  `930000001`) return `None` -> `_ProcessDungeonData` blanks the agent window. The Score = `921` (from
  `killMission.dungeonID`).

```powershell
# eve.js/server  (PowerShell) — after `npm run scrape-apply -- --wakka Score1gu`
# NOTE: $env vars only persist for THIS shell. If you open a new terminal, set all three again.
$env:EVEJS_FORCE_MISSION_ID="2391"
$env:EVEJS_FORCE_MISSION_TEMPLATE="eve-survival:Score1gu"
$env:EVEJS_FORCE_MISSION_DUNGEON_ID="921"
npm start
```
Then talk to any L1 security agent, **request + accept** the mission, and **warp to the mission location from the
journal** (the objective's "Warp to location"). On accept the server logs a `[MissionDebug] accept …` line
reporting `objectiveMode`, `dungeonInstanceID`, `missionSiteID`, and `pos` — if `objectiveMode=dungeon` with a
non-zero `dungeonInstanceID` and a real `pos`, the deadspace site exists and warping should materialize the gate
(`[Beyonce] bookmark warp …` / `mission bookmark materialize …`). Start a fresh shell without the env vars to
restore normal behavior.

## Acceleration gates on authored missions

Authored `eve-survival:<Wakka>` templates can now carry an **acceleration gate**, so the mission plays the
retail way (warp in to just the gate → activate → the pocket's NPCs spawn on the far side) instead of dumping
every spawn on the warp-in grid. How it works:

- `eveSurvivalTemplate.js` emits a `siteSceneProfile.gateProfiles` Acceleration Gate (typeID 17831) from the
  warp-in landing into the first pocket (`room:<firstRoomId>`).
- EveJS (`dungeonUniverseSiteService.buildMissionDerivedEncounterPlans`) marks any room that is a gate
  destination as `on_room_active`, so its encounters spawn on gate activation, not on warp-in.

The scraper auto-detects a gate only when a pocket heading mentions "gate"/"accel" (eve-survival omits this for
single-pocket missions like The Score), so override it when authoring:

```
npm run scrape-apply -- --wakka Score1gu --gate       # force an acceleration gate
npm run scrape-apply -- --wakka Score1gu --no-gate     # force spawns on warp-in (no gate)
```

Then start the server with `EVEJS_FORCE_MISSION_TEMPLATE=eve-survival:Score1gu` and fly it — the gate now comes
from the **authored** template, not the client dungeon. Follow-ups: a Mission Designer gate toggle, and
multi-pocket missions (a gate per pocket).

## Quick recipe (the common case)

```
npm run scrape-apply -- --wakka Score1gu     # writes LIVE eve-survival:Score1gu (backs up original)
# then in eve.js/server, start with EVEJS_FORCE_MISSION_TEMPLATE=eve-survival:Score1gu and accept The Score
```
To revert: restore `workspace/backups/dungeonAuthority/eve-survival_Score1gu.json` over the template (or
re-pull from source) and restart.

## How agent missions actually spawn (important)

- An agent mission (e.g. "The Score", mission `2391`) resolves at runtime to an **eve-survival mission
  template** — `eve-survival:<Wakka>` (e.g. `eve-survival:Score1gu` = The Score / Guristas).
- NPCs come from that template's `rooms[].groups[].spawnEntries` (ship names in `candidateNames`, resolved to
  NPC profiles by EveJS). This is **not** the `client-dungeon:<id>` / `populationHints` format used by public
  combat anomalies (that's what the **Site Builder** authors).
- **Which variant an agent uses is EveJS's call** (region/faction matching, and it is fuzzy). A Caldari/Guristas
  agent tends to get `Score1gu`; an Angel-space agent gets `Score1an`; some resolve to unrelated templates.
  So to test end-to-end against a *specific* agent, apply the variant **that agent actually resolves to** (the
  harness prints it).

## The loop

### 1. Scrape + apply (CLI)
```
npm run scrape-apply -- --wakka Score1gu             # LIVE (default): overwrite eve-survival:Score1gu
npm run scrape-apply -- --url "https://eve-survival.org/?wakka=Score1gu"
npm run scrape-apply -- --wakka Score1gu --sandbox   # disposable copy instead (for the harness)
```
Prints the parsed pockets/groups/ships and the backup path. `--sandbox` copies the live gameStore (~580 MB) to
`eve.js/_local/gameStore-test/data` once, then re-patches; `--reset` re-copies it clean.

### 2. Scrape + apply (UI)
Mission Designer → **Import from eve-survival** (enter `Score1gu` or the URL) → review the pockets/groups/NPCs →
**Apply to Live Server**. Same live write as the CLI (original backed up).

### 3. Verify headless (sandbox)
```
npm run scrape-apply -- --wakka Score1gu --sandbox
npm run emu-test -- --wakka Score1gu
```
- Stage 1: confirms the patched `eve-survival:Score1gu` template carries the scraped spawns.
- Stage 2: drives a real L1 security agent through offer→accept of The Score and reports the variant it
  resolved to. (EveJS's matcher is fuzzy; see the force-flag above to pin it.)

### 4. Fly it (real client)
After a live apply, start the real server (PowerShell), optionally with the force flag, and accept The Score:
```powershell
cd C:\Users\ryanf\Documents\GitHub\eve.js\server
$env:EVEJS_FORCE_MISSION_TEMPLATE="eve-survival:Score1gu"   # optional: any security agent serves it
npm start
```

## Boundaries / safety
- Scraping/network lives only in `src/lib/missionScraper.js` and runs only via `scrape-apply` / the Import
  button. EveJS gets no scraper code.
- Live applies overwrite one `eve-survival:<Wakka>` template in `_local/gameStore/data`; the original is backed
  up to `workspace/backups/dungeonAuthority/` first, so edits are reversible.
- `npm run scrape-test` checks the parser offline against `test/fixtures/Score1gu.html`.

## Known gaps / follow-ups
- **Variant matching is EveJS-side and fuzzy.** Reaching a *specific* faction variant via an arbitrary agent
  isn't guaranteed; apply the variant the target agent resolves to (the harness reports it).
- EVE-Uni wiki parser (cross-check), inserting missions EveJS lacks, structures/loot, and named/officer NPC
  name normalization are follow-ups.
