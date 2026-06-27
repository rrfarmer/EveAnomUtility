# Testing missions in the EveJS emulator

This is the loop for getting a **mostly-accurate agent mission** out of the community databases and into a
playable EveJS state. All scraping happens **only in this utility, on demand**. EveJS never scrapes — we patch
its data files. Everything runs against a **sandbox copy** of the gameStore; the live database is never touched.

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
npm run scrape-apply -- --wakka Score1gu          # patch the sandbox's eve-survival:Score1gu
npm run scrape-apply -- --url "https://eve-survival.org/?wakka=Score1gu"
npm run scrape-apply -- --wakka Score1gu --reset  # re-copy a clean sandbox first
```
First run copies the live gameStore (~580 MB) to `eve.js/_local/gameStore-test/data` once; later runs just
re-patch. Prints the parsed pockets/groups/ships.

### 2. Scrape + apply (UI)
Mission Designer → **Import from eve-survival** (enter `Score1gu` or the URL) → review the pockets/groups/NPCs →
**Apply to Emulator**. Same sandbox patch as the CLI.

### 3. Verify headless
```
npm run emu-test -- --wakka Score1gu
```
- Stage 1: confirms the patched `eve-survival:Score1gu` template carries the scraped spawns.
- Stage 2: drives a real L1 security agent through offer→accept of The Score and reports the variant it
  resolved to and the spawns the accepted instance carries. If the agent resolves to a *different* variant,
  it tells you which one to apply instead (`npm run scrape-apply -- --wakka <that variant>`).

### 4. Fly it (real client)
Run the real server against the sandbox, then visit an agent the harness reported and accept The Score:
```
# eve.js/server
EVEJS_GAMESTORE_DATA_DIR=../_local/gameStore-test/data npm start
```
(Windows PowerShell: `$env:EVEJS_GAMESTORE_DATA_DIR="...\eve.js\_local\gameStore-test\data"; npm start`.)

## Iterating
Edit content (re-import / re-scrape, or hand-tune in the Mission Designer and Apply) **or** the emulator side,
then re-run `emu-test`. `--reset` on `scrape-apply` rebuilds a clean sandbox if it drifts.

## Boundaries / safety
- Scraping/network lives only in `src/lib/missionScraper.js` and runs only via `scrape-apply` / the Import
  button. EveJS gets no scraper code.
- The sandbox lives under `eve.js/_local/gameStore-test/`; the scripts refuse to write the live
  `_local/gameStore/data`.
- `npm run scrape-test` checks the parser offline against `test/fixtures/Score1gu.html`.

## Known gaps / follow-ups
- **Variant matching is EveJS-side and fuzzy.** Reaching a *specific* faction variant via an arbitrary agent
  isn't guaranteed; apply the variant the target agent resolves to (the harness reports it).
- EVE-Uni wiki parser (cross-check), inserting missions EveJS lacks, structures/loot, and named/officer NPC
  name normalization are follow-ups.
