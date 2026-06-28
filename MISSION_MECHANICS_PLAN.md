# Mission Mechanics — Implementation Plan & Handoff

Living plan for making EveJS run accurate agent missions (combat + mining + more) and for the
EveAnomUtility authoring tool to load/edit/save them. Hand this to any session to resume.

## 0. Direction (read first)

- **Scrapes are ~99% of missions.** Real data comes from **eve-survival.org** and the **EVE-University
  wiki**, not from logs. Logs are rare ground-truth for a handful of missions.
- **Fallbacks are the primary path.** Most missions only have "what NPCs to spawn." Every mechanic must
  degrade to a sensible default so a bare scrape is still playable; authored detail is honored when present.
- **No pack/log decoder.** We have very few logs and more are hard to get. Packs are a manual, rare input.
- **The Utility must load/edit/save ANY mission** and let us author the same params on scraped missions.

## 1. Source data & logs (re-discovery references)

Keep these paths — future sessions should re-open them to re-derive mechanics:

- **Combat mission logs:** `D:\SSDSync\Downloads\MissionTQLogs\MissionTQLogs\Combat\`
  - Analyzed: `AlluringEmanationsLevel1.txt` (proximity "investigate the drone" ambush; mission 13735,
    dungeon 3030). These are full EVE client trace logs: `DoDestinyUpdate`/`AddBalls2` (spawns, sometimes
    decoded as Python dicts with `typeID`/`ownerID`/`groupID`/`dunPosition`), `EnteringDungeonRoom
    (dungeonID, roomID, pos)`, `OnDungeonEntered/Exited/Completed`, `OnDungeonTriggerMessage/Audio`,
    `GetMissionBriefingInfo`/`GetMissionObjectiveInfo`. Retail acceleration gate = real `WarpTo` +
    `OnSpecialFX effects.Warping` (not a teleport).
- **Mining mission logs:** `D:\SSDSync\Downloads\MissionTQLogs\MissionTQLogs\Mining\`
  - Asteroid Catastrophe / Bountiful Banidine / Burnt Traces / Mercium Experiments / Starting Simple
    (L1), Unknown Events (L2). Objective carries `objectiveQuantity` + `objectiveTypeID` (mine N of an
    ore), special mission asteroids (e.g. typeIDs 3739–3741, asteroid groupID 99), and
    `objective_task_travel_to_agent` / `objective_task_talk_to_agent` turn-in steps.
- **Decoded pack example (manual):** `D:\SSDSync\Downloads\13735-alluring-emanations\` —
  `manifest/mission/nodegraph/dungeon/timeline.json`. `dungeon.json` is already an EveJS dungeon-authority
  template; the Utility imports it (`missionPack.js`, `pack-apply`, `/api/pack`, Designer "Import mission pack").
- **Scrape sources (the 99%):** eve-survival.org `?wakka=<Wakka>`; EVE-University wiki (cross-check, TODO).

## 2. Data / build workflow — the DatabaseCreator and static tables

**How startup data is built (eve.js):** `tools/DatabaseCreator/database-creator.js` builds the runtime
gameStore `_local/gameStore/data/<table>/data.json` from `tools/DatabaseCreator/staticTables/<table>/` (+ the
SDE). It only builds when the output dir is empty (first run) or with `--force` (it errors otherwise). A set
of tables are **"required static overrides"** — copied verbatim from the static source, not derived from the
SDE — and these include **`dungeonAuthority`** (mission/site templates), **`missionAuthority`** (agent
mission records), and **`npcLootTables`**.

**Decision (correct, matches the design): the Utility writes to the STATIC source, not `_local`, and in
development we FULL-BUILD every time.**
- Authored mission templates → `tools/DatabaseCreator/staticTables/dungeonAuthority/data.json`.
- Authored/new mission records → `tools/DatabaseCreator/staticTables/missionAuthority/data.json`.
- To test, run a **full `CreateDatabase --force`** every time — it rebuilds `_local` from the static
  tables. Content is persistent, version-controlled, and survives the rebuild.
- **No incremental "little change table" sync, and the Utility never writes `_local` directly.** We are in
  development; always do the full build. (Writing `_local` directly is wiped on `--force` anyway.)

This supersedes the current `scrape-apply`/`pack-apply`/`/api/*apply`, which write `_local` directly — migrate
them to write the static tables (folded into Plan D, see D4).

## 3. Foundation already done

EveJS (branch `fix/agent-mission-deadspace-flow`): full Score gate flow; gate activation warps the pilot
(real `WarpTo` + `effects.Warping`) with fallback; `proximity` encounter trigger; fallback-rich
`resolveEncounterPlans` (`baseProfileID`/`spawnEntries` → `spawnQuery`/`amount`); reads explicit
`populationHints.encounters` with triggers `on_load`/`on_room_active`/`proximity`/`wave_cleared`/
`visible_countdown`/`battleships_destroyed`. Utility (`main`): pack importer (`missionPack.js`),
`pack-apply` CLI, `/api/pack`(+`/apply`), Designer "Import mission pack"; eve-survival scrape→template with
gate-by-default for combat. (Temp in-client test hooks: `EVEJS_FORCE_MISSION_ID/_TEMPLATE/_DUNGEON_ID`.)

## 4. Plan A — EveJS combat mechanics + the fallback ladder

- **A1 Fallback ladder.** Deterministic default when only spawns are known: combat + gate hint → gate-first
  (`on_room_active` behind the gate); no gate → `on_load`; multiple groups → `wave_cleared` chain.
- **A2 Remaining trigger families** (explicit data + fallback): timer/delay, destroy-object→spawn,
  aggression-triggered. Small adds to `tickSceneSiteBehaviors`/`processEncounterPlansForTrigger`.
- **A3 Stagger waves** — proximity/reinforcement waves currently fire on one tick; sequence them.
- **A4 Exact `spawnEntries` fidelity** (typeID/position/AI/`entityGroupID`), fallback procedural —
  **blocked on the loot/rats agents' `npcService` rework.**
- **A5 Verify gate warp animation** in-client.

## 5. Plan B — EveJS objective modes + interactables

- **B1 ObjectiveMode framework** on the template + encounter-clear fallback: kill✓, investigate/approach,
  mine-quantity, retrieve-item, destroy-structure, hack/analyze.
- **B2 Interactable objects** (investigate/hack/tractor/destroy → objective progress).
- **B3 `travel_to_agent` / `talk_to_agent`** turn-in chain.

## 6. Plan C — Mining missions (grounded in the Mining logs)

- **C1 Mission asteroids** — materialize the special mineable rocks (`objectiveTypeID` ore) in deadspace,
  reusing EveJS asteroid/mining mechanics.
- **C2 Mining-objective tracking** — mine `objectiveQuantity` → progress → complete, then B3 turn-in.
- **C3 Fallback** — scraped "mine N of ore X" spawns the asteroids + tracks quantity with no log.
- **C4 Optional rat ambush** (reuses Plan A triggers).

## 7. Plan D — Utility: load / edit / save ANY mission + author mechanics

- **D1 Unified mission model** = full EveJS template (rooms, gates+destinations, encounters w/ trigger+params,
  objectives, objective/env objects, mining asteroids). Scrape → model via the fallback ladder.
- **D2 Load any template** into the editor (`eve-survival:*`, `client-dungeon:*`, `authored.*`, packs).
- **D3 Author-mechanics UI** — per-group trigger type+params, objectiveMode + objects, gates/connections
  (multi-pocket), mining asteroids.
- **D4 Save correctly to the STATIC tables** — emit a valid EveJS template and write it to
  `staticTables/dungeonAuthority` (+ `missionAuthority` for new mission records), not `_local`; then a full
  `CreateDatabase --force` picks it up (see §2). Migrate `scrape-apply`/`pack-apply`/`/api/*apply`/
  `sandbox.resolveApplyTarget` off direct `_local` writes. Pre-apply validation (Plan E1).
- **D5 Presets** — one-click "standard gate-first combat / proximity ambush / mine-N" so a scrape gets real
  mechanics fast (the non-log 99%).

## 8. Plan E — Validation + test harness (alongside)

- **E1 Pre-apply validation** (Utility) vs EveJS's supported triggers/objectives.
- **E2 Extend `emu-test`** to drive each mission TYPE (gate combat, proximity, mining) offer→accept→
  materialize and assert mechanics headlessly.

## 9. Agent coordination

- **Rats agent:** done. **Loot-profiles agent:** spinning up now — **OK to proceed.** Loot owns
  `staticTables/npcLootTables` (separate static table) + loot/reward mechanics. Mission work owns
  `staticTables/dungeonAuthority` + `missionAuthority` + dungeon/mission services. **No static-table
  conflict.** The only shared eve.js file is `server/src/services/dungeon/dungeonUniverseSiteService.js`
  (its `materializeEncounterRewardContainers`/reward section is loot's; the encounter/trigger/objective
  sections are mission's) — non-overlapping hunks, git-mergeable. Missions **reference** loot by
  `lootProfile`/`lootTags`; loot **defines** them. Each agent stages only its own files/sections.

## 10. Suggested loop order

`A1 → A2 → A3`, then `B1 → B3`, then `C`, then `D (D1/D2 first, then D3–D5; D4 writes static tables per §2)`,
with `E` alongside. `A4` waits on the loot/rats `npcService` work. See memory:
`mission-mechanics-roadmap`, `mission-trigger-taxonomy`, `evejs-mission-flow-fixes`, `mission-warp-rpc-path`.

## Status — loop session 2026-06-28 (all commits no-co-author)

Plans **A, B, C, D, E essentially complete.**

- **A (combat triggers + fallback ladder):** A1 per-room fallback ladder `7c60e12d`, A2 timer trigger `8ed84af2`, A3 staggered proximity waves `3b014ce2` (eve.js). **A4** exact per-NPC spawnEntries fidelity — **blocked on the loot/rats `npcService` rework**. **A5** gate-warp animation — **needs in-client verify**.
- **B (objectives):** B1 objective hook `d01787f8`, B2 setter `markInstanceObjectiveSatisfied` `887e2b6e` (eve.js). B3 turn-in already handled by the agent flow; B2 interaction-detectors (hack/approach) deferred (low value, framework ready).
- **C (mining):** C1 mineable-rock materialization `b3a932b7`, C2 mining-quantity completion `71b07fab` (eve.js), C3 builder hints `21ab563` (Utility). **Needs in-client verify** of actual mining behavior.
- **D (Utility load/edit/save + static apply):** D2 `e2a9f73`, D4 server `6bba75c` + CLIs `8008d52`, D3 load/save UI `d9bffbf`, TESTING `316be92`. Apply/save now write the static-table source of truth by default; full `CreateDatabase --force` to test. D1/D3 deep in-editor per-field mechanics editing is a follow-up (load+review+save round-trip works today).
- **E (validation + harness):** E1 `missionTemplateValidator` `4046626` (wired into save + apply CLIs `bc16540`), E2 `npm run mission-check` per-type assertions `40fa943`.

**Next:** in-client verification (A5 gate warp, C mining), then A4 once the loot/rats `npcService` work lands, then optional deep in-editor mechanics editing (D1/D3).
