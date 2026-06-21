# EveAnomUtility Handover

Workspace: `D:\EveAnomUtility`
Read-only source repo: `C:\Users\ryanf\Documents\GitHub\eve.js`
Date started: 2026-06-18

## Mission

Build a production-ready server-side authoring utility for EveJS playable content customization. Initial scope is combat anomalies, ore anomalies, and mission-combat content. The tool must support named solar systems and named entities, custom content creation, save/load/edit flows, template overrides, NPC spawn/fitting/attack/damage customization, and safe testing against a cloned database only.

Clarification from user: this utility does not need to edit a live server or behave as a live admin console. It should generate customizable EveJS server-side content templates and assignment data that admins can review and apply later.

Hard boundary: do not modify EVE client data or require client-side edits. Server-side content overrides must avoid changing client-authoritative static concepts such as ship attributes, type definitions, icons, models, or anything that would desync from the installed client/SDE.

## Running Checklist

- [X] Created external workspace at `D:\EveAnomUtility`.
- [X] Confirmed EveJS repo is dirty and should be treated as read-only for this effort.
- [X] Created this handover/checklist document outside the repo.
- [X] Inventory EveJS dungeon, anomaly, ore, mission, NPC, stargate, Concord, and EverMore spawn systems.
- [X] Identify all data-template entry points that control playable content spawns.
- [X] Identify all database tables/files that must be cloned for safe testing.
- [X] Research EVE Online anomaly/site taxonomy from online sources and record server-safe implications.
- [X] Define admin utility data model for combat, ore, and mission-combat content.
- [X] Define validation rules that prevent client/SDE-incompatible edits.
- [X] Build the first admin UI outside the repo.
- [X] Build clone/import/export workflow for server data.
- [X] Build exportable generated template-pack output.
- [X] Verify functionality against cloned data only.
- [X] Run UI locally and capture screenshots for each major menu/flow.
- [X] Visually review every menu and iterate on usability.
- [X] Add Lucide icons across navigation, major actions, section headers, dynamic row actions, validation states, summary tiles, and rail metrics.
- [X] Improve Resources authoring: resource-scoped search, named individual resource chips, typeID resolution, and a non-magic default resource row.
- [X] Remove SDE group metadata from the admin-facing Resources editor; resource authoring selects individual item typeIDs such as `1230 = Veldspar` or `21 = Hedbergite`.
- [X] Refactor Builder workflow around Template Library: content family, delivery mode, explicit template ID, existing-template load, and blank custom template creation.
- [X] Expand content taxonomy beyond the first three scopes to Combat, Resource, Hacking, Mission, Wormhole, Special, Static World, and NPC Presence.
- [X] Add backend template classification so existing EveJS templates expose admin-facing `contentFamily` and `delivery` while preserving raw `siteFamily` and `siteKind`.
- [X] Make generated packs use the selected/admin-entered `templateID` as the output template ID, with backward compatibility for older drafts that only had `baseTemplateID`.
- [X] Replace hardcoded solar-system assignment with spawn scopes: any eligible system, security bands, specific system, or specific stargate.
- [X] Make generic anomaly/site drafts valid without selecting a solar system; fixed coordinates and specific gates still require concrete server data.
- [X] Change visual QA target to 1920x1080 only per user direction; mobile screenshots are no longer part of the verification pass.
- [X] Add filtered Existing Template dropdown to Builder; it reloads from the cloned EveJS catalog when content family, delivery, or filter text changes.
- [X] Make selecting a template from the dropdown load that template directly, while keeping the separate Template ID field for new custom IDs.
- [X] Replace the numeric `Individual Resource TypeID` editor field with a named `Individual Resource` dropdown that stores typeID in generated JSON but shows admin-friendly resource names.
- [X] Reset loaded draft/template/form data when switching content family or delivery so Resource/Combat/Mission edits cannot bleed into the next template type.
- [X] Add delete controls for saved overlay drafts in the Saved panel.
- [X] Add clone-only server template deletion for loaded templates from the cloned `dungeonAuthority` catalog; live EveJS data remains protected.
- [X] Add mission subtype classification for EveJS `missionAuthority`: combat/encounter, courier, mining, trade, talk-to-agent, agent-interaction, and other.
- [X] Add Mission Catalog UI with mission-type filtering and combat mission handoff into Builder via linked `client-dungeon:<dungeonID>` templates.
- [X] Add Builder-level `Mission Category` selector that appears when the Mission content family is selected and persists as `missionType` in saved/generated data.
- [X] Hide `Mission Category` everywhere except the Builder Mission content-family state; Combat, Resource, Overrides, and other non-Mission states must not show the field.
- [X] Make Builder Existing Template dropdown filter by Mission Category. Mission/Combat and Mission/Mining use templates referenced by `missionAuthority`; Mission/Courier and Mission/Trade correctly show no dungeon templates.
- [X] Reconcile EveAnomUtility with EveJS database resolver changes: clone/read from the same runtime data root EveJS uses, preferring `_local\newDatabase\data` over source shims when present.
- [X] Update generated template pack rows to match current `dungeonAuthority.templatesByID` shape with `source`, `sourcePriority`, `sourceConfidence`, `siteOrigin`, `resourceComposition`, structured `populationHints.resources`, `siteSceneProfile`, and utility metadata under `adminMetadata`.

## Current Findings

- EveJS database resolution now matters. Runtime reads use `EVEJS_NEWDB_DATA_DIR` when set, otherwise `_local\newDatabase\data` when `_local\newDatabase\manifest.json` or the local data folder exists, otherwise `server\src\newDatabase\data`.
- In the current checkout, the actual EveJS runtime data root is `C:\Users\ryanf\Documents\GitHub\eve.js\_local\newDatabase\data`. The source folder `server\src\newDatabase\data` contains many `index.js` table shims and only some source authority JSON, so it is not sufficient for utility catalog reads.
- EveJS can redirect that database through `EVEJS_NEWDB_DATA_DIR`; use this for cloned testing.
- The current repo worktree already has modified runtime database files including `dungeonRuntimeState`, `missionRuntimeState`, `probeRuntimeState`, `items`, `celestials`, and many account/player data files. Do not edit those in place during this project.
- Existing tests indicate relevant implemented areas: dungeon/anomaly runtime, scene site adapters, mining resource sites, agent missions, NPC combat/equipment, EverMore gate presence, stargates, and capital/faction NPC behavior.
- Detailed findings and online sources are in `D:\EveAnomUtility\RESEARCH.md`.
- CONCORD has two distinct layers: passive gate/station/startup presence and Crimewatch punitive response. EverMore is a generated Jita-style gate-presence variant, not the Crimewatch responder system.
- The NPC customization ladder already exists in server-side tables: profiles, loadouts, behavior profiles, loot tables, spawn pools, spawn groups, spawn sites, and startup rules.
- Mission subtype split is explicit in EveJS cloned data. Combat missions use `missionKind: encounter`/`killMission` and link to `client-dungeon:<dungeonID>`. Courier missions use `missionKind: courier` and `courierMission` item objectives without a combat dungeon template. Trade missions may also have `courierMission` objective data, so `missionKind` must be trusted before helper-object shape.

## Source Areas To Inspect

- `server/src/services/exploration`
- `server/src/services/mining`
- `server/src/services/agent`
- `server/src/space/empireGatePresence`
- `server/src/space`
- `server/src/services/chat`
- `server/src/newDatabase`
- `doc/PARITY_DUNGEON_ANOMALY_RESEARCH.md`
- Tests matching dungeon, anomaly, mining, mission, NPC, stargate, Concord, EverMore, and site providers.

## Design Notes

- The utility should work from an EveJS source path and a cloned data path. It must never default to writing into the live EveJS database.
- UI selectors must resolve IDs to names for solar systems, stargates, NPC types, factions, ores, anomalies, missions, and templates wherever the source/SDE provides names.
- The tool should model overrides as layered server-side templates rather than rewriting raw SDE/client type definitions.
- NPC customization should operate on server spawn/equipment/behavior layers: chosen type, quantity, wave, position, faction, AI profile, module/equipment profile, damage profile override, repair/e-war behavior, bounty/loot/wreck behavior, and respawn conditions.
- The initial build will store overlay drafts under `D:\EveAnomUtility\workspace\overlays`, not in EveJS. Export/apply must remain explicit.
- Primary output should be generated template packs and assignment records, not live runtime writes.

## Current Build

- Local app: `http://127.0.0.1:4732`
- Package root: `D:\EveAnomUtility`
- Icon system: local `lucide` package served from `/vendor/lucide.js`; no CDN dependency.
- Builder workflow: `Template Library -> Delivery -> Template ID -> Existing Template Search/Load -> Assignment/Content Editors`.
- Existing-template workflow: select content family and delivery, optionally type in the filter box, then pick from the `Existing Template` dropdown. The dropdown is server-filtered by `contentFamily` and `delivery` and loads up to 500 matching templates.
- Delete workflow: saved drafts can be deleted from the Saved panel after confirmation. Loaded server templates can be deleted from the cloned EveJS catalog after confirmation; this edits only `D:\EveAnomUtility\workspace\db-clone\dungeonAuthority\data.json`, refreshes the catalog, and refuses if no clone exists.
- Mission Catalog workflow: use the Missions nav tab to filter all cloned `missionAuthority` rows by All, Combat, Courier, Mining, Trade, Talk To Agent, Agent Interaction, or Other. Combat rows expose a `Use` action that opens Builder as mission-private content using the linked dungeon template. Courier/trade rows show hauling/item objectives and do not pretend to have combat-site templates.
- Builder mission workflow: select the Mission content-family card in Template Library; the `Mission Category` dropdown appears below Delivery and can select Combat, Courier, Mining, Trade, Talk To Agent, Agent Interaction, or Other. The field is hidden for every non-Mission Builder state. Saved overlays and generated packs carry this as `missionType`. Existing Template filtering now includes Mission Category: Combat/Mining pull linked dungeon templates from `missionAuthority`, while Courier/Trade generally show no templates because those categories are item-delivery mission rows rather than dungeon/site templates.
- Resource row workflow: search/add resources or use the row dropdown by resource name. Generated data still records `resources[].typeID` because EveJS needs the server/SDE typeID, but the editor does not require admins to type raw IDs.
- Type switch workflow: choosing a different content family or delivery clears title, template ID, loaded base template, system/gate assignment, resource rows, NPC overrides, notes, and validation state, then applies the default row appropriate for the newly selected type.
- Spawn rule workflow: generic by default with `spawnScope.mode = any_eligible`, checked security bands, max-per-system, weight, respawn minutes, and slot count. Specific solar systems/stargates are optional narrowing modes, not required for normal anomalies.
- Supported admin-facing content families: `combat`, `resource`, `hacking`, `mission`, `wormhole`, `special`, `static_world`, `npc_presence`.
- Supported delivery modes: `anomaly`, `signature`, `mission_private`, `static_beacon`, `startup_rule`, `runtime_response`, `escalation`.
- Current EveJS runtime data root: `C:\Users\ryanf\Documents\GitHub\eve.js\_local\newDatabase\data`.
- EveJS source data root: `C:\Users\ryanf\Documents\GitHub\eve.js\server\src\newDatabase\data`.
- Cloned data root: `D:\EveAnomUtility\workspace\db-clone`
- Overlay drafts: `D:\EveAnomUtility\workspace\overlays\content-overlays.json`
- Generated pack: `D:\EveAnomUtility\workspace\overlays\generated-template-pack.json`
- Generated template rows now mirror current `dungeonAuthority` records enough for an import/review step: `resourceComposition` is a top-level summary, `populationHints.resources` is an `{ oreTypeIDs, gasTypeIDs, iceTypeIDs }` object, and detailed utility-only fields are contained under `adminMetadata`.
- Visual report: `D:\EveAnomUtility\workspace\screenshots\visual-report.json`
- Screenshot set:
  - `D:\EveAnomUtility\workspace\screenshots\builder-1920x1080.png`
  - `D:\EveAnomUtility\workspace\screenshots\builder-mission-category-1920x1080.png`
  - `D:\EveAnomUtility\workspace\screenshots\builder-resources-1920x1080.png`
  - `D:\EveAnomUtility\workspace\screenshots\builder-overrides-1920x1080.png`
  - `D:\EveAnomUtility\workspace\screenshots\builder-delete-controls-1920x1080.png`
  - `D:\EveAnomUtility\workspace\screenshots\systems-1920x1080.png`
  - `D:\EveAnomUtility\workspace\screenshots\missions-1920x1080.png`
  - `D:\EveAnomUtility\workspace\screenshots\npcs-1920x1080.png`
  - `D:\EveAnomUtility\workspace\screenshots\pack-1920x1080.png`
  - `D:\EveAnomUtility\workspace\screenshots\research-1920x1080.png`

## Verification

- [X] `npm run check`
- [X] `npm run smoke`
- [X] `npm run visual-check`
- [X] Cloned EveJS runtime database from `C:\Users\ryanf\Documents\GitHub\eve.js\_local\newDatabase\data` into `D:\EveAnomUtility\workspace\db-clone`.
- [X] Verified live runtime data and cloned data both report 139 JSON tables and 615,829,655 bytes after refresh.
- [X] Confirmed active read mode is `clone` and `liveWritesAllowed` is `false`.
- [X] Generated a sample combat anomaly assigned to Jita stargate `50001248` and a sample ore anomaly assigned to Tanoo.
- [X] Verified generated pack schema with a temporary ore overlay: output contained `source: "eve_anom_utility"`, `siteFamily: "ore"`, `siteKind: "anomaly"`, top-level `resourceComposition`, structured `populationHints.resources`, objective markers, `adminMetadata.authoredResources`, and a matching assignment; temporary overlay was deleted afterward.
- [X] Playwright screenshot verification is scoped to the 1920x1080 desktop layout only.
- [X] Current Playwright visual target is 1920x1080 only. Latest report generated 10 screenshots at `1920x1080` with 0 console messages, 0 page errors, and no overflow failures.
- [X] Verified NPC module override JSON validation rejects non-array values.
- [X] Verified lower Builder NPC override editor visually after adding profile/loadout/behavior autocomplete and module override JSON editing.
- [X] Verified Lucide icon hydration in visual QA: each captured screen has visible `svg.icon` elements and zero unresolved `i[data-lucide]` placeholders.
- [X] Verified resource search now resolves `21` to `Hedbergite`, `hedbergite` to mineable Hedbergite variants, and `veldspar` to Veldspar first instead of compressed/blueprint item types.
- [X] Verified Resources screenshot shows individual resource typeIDs and no visible group IDs.
- [X] Verified filtered template API returns expected rows for combat anomalies, resource anomalies, hacking signatures, and private mission templates.
- [X] Verified template detail route returns raw catalog data for a selected existing template, e.g. `client-dungeon:141`.
- [X] Verified in-app Browser state after refactor: 8 family controls, Combat active by default, delivery options populated, template ID input visible, 44 visible SVG icons, 0 unresolved Lucide placeholders, and no horizontal overflow.
- [X] Verified generic spawn validation: `spawnScope.mode = any_eligible` with security bands validates without a `solarSystemID`.
- [X] Verified constrained spawn validation: fixed coordinate placement requires a specific solar system, and specific stargate scope requires a valid EveJS stargate.
- [X] Verified 1920x1080 Builder screenshot shows the filtered Existing Template dropdown populated; default Combat/Anomaly view showed 212 matching templates.
- [X] Verified Resources editor screenshot shows `Veldspar - individual ore type` in the individual resource dropdown while the generated draft data still stores `typeID: 1230`.
- [X] Verified type-switch reset in Playwright: switching from a stale Resource draft to Combat clears title, template ID, notes, and resource rows, then leaves a fresh Combat encounter row.
- [X] Verified delete APIs in smoke test: temporary saved overlay is created/deleted, and a temporary cloned server template is inserted/deleted without leaving test records behind.
- [X] Verified cloned `dungeonAuthority` cleanup after delete smoke: `counts.templateCount` and `templatesByID` key count both remain `6040`.
- [X] Verified 1920x1080 delete-control screenshot: Saved panel shows draft Delete buttons, and a loaded server template shows `Delete Server Template`.
- [X] Verified mission classification counts against cloned `missionAuthority`: 2,879 total, 1,617 combat, 617 courier, 42 mining, 534 trade.
- [X] Verified `/api/missions?missionType=combat` returns combat rows with linked dungeon templates, while `/api/missions?missionType=courier` returns courier rows without linked combat templates.
- [X] Verified 1920x1080 Mission Catalog screenshot and Playwright filters for Combat and Courier.
- [X] Verified Builder Mission Category screenshot: selecting Mission shows the category dropdown with Combat selected and `missionType: "combat"` in the draft preview.
- [X] Verified Mission Category visibility guard: non-Mission Builder screenshots fail visual QA if the `Mission Category` label appears; the Mission Builder screenshot must show it.
- [X] Verified Builder Existing Template filtering by Mission Category: Combat returns 500 linked templates at the UI cap, Mining returns 37, Courier returns 0, and Trade returns 0.
- [X] Verified Playwright category switch in Builder: Mission/Combat has template options, switching to Mission/Courier leaves only the placeholder and clears combat encounter rows.

## Open Questions

- Which EveJS data files are considered the live server database in the user's deployment, and whether `evejs.config.local.json` can point to an alternate data root.
- How the generated template pack should eventually be consumed by EveJS: explicit import script, admin-reviewed copy into server-authoritative tables, or a future server overlay loader.
