# Mission Source Merge Iteration 1

Mission compared: `AvengeaFallenComrade1an` / `Avenge a Fallen Comrade (Angel Cartel) (Level 1)`.

Inputs were read from local cache only:

- `workspace/eve-survival/raw/eve-survival/AvengeaFallenComrade1an.html`
- `workspace/eve-university/raw/pages/Avenge_a_Fallen_Comrade_(Angel_Cartel)_(Level_1).html`

## Result

This is productive. The two public sources are not simple duplicates; they fill different gaps.

Eve-Survival is better for room and gate topology. It has a `First Pocket` containing the acceleration gate, then a `Second Pocket` with four NPC groups. That shape maps better to the EveJS gate-first mission flow.

Eve University is better for objective semantics. It explicitly says the objective is to destroy the Habitat, has a blitz line of `Destroy Habitat, warp out.`, and marks the `1 x Habitat` structure row with the "mission completed on destruction" icon. It also adds that groups 2-4 aggro when the habitat is engaged.

## Important Difference

The current Eve-Survival-only parser treats every NPC group as an objective when no blitz text is present. For this mission that is wrong: completion is the Habitat destruction, not killing every pirate.

Eve-Survival has the clue as free text:

```text
Mission objective: Habitat at about 75km
```

Eve University has the same fact as structured mission data:

```text
Objective: Destroy the habitat of the pirate leaders then report back to your agent.
Blitz: Destroy Habitat, warp out.
Structure: 1 x Habitat, mission completed on destruction.
```

## Merge Draft

Use Eve-Survival topology:

- Entry room: acceleration gate.
- Combat room: four NPC groups.

Use Eve University objective semantics:

- Spawn `1 x Habitat` as a structure/objective visual.
- Mission completion trigger: Habitat destroyed.
- Do not mark the NPC groups as completion objectives.

Merge NPC rows without duplication:

| Group | Count | Merged candidates |
|---|---:|---|
| Group 1 | 2 | `Gistii Hijacker` |
| Group 2 | 3 | `Gistii Rogue`, `Gistii Hijacker` |
| Group 3 | 1 | `Gistii Ambusher`, `Gistii Raider` |
| Group 4 | 8 | `Gistii Hijacker` |

The candidate-name union matters because Eve-Survival uses one candidate in groups 2 and 3, while Eve University lists variants:

- Group 2: Eve-Survival says `Gistii Rogue`; Eve University says `Gistii Hijacker/Rogue`.
- Group 3: Eve-Survival says `Gistii Ambusher`; Eve University says `Gistii Raider/Ambusher`.

## Proposed Merge Rules

- Preserve source-specific extracts instead of overwriting one source with the other.
- Build a merged draft layer with field-level provenance.
- Prefer Eve-Survival for room/gate topology when it has explicit pocket/gate structure.
- Prefer Eve University for objective rows, objective icons, blitz text, and completion semantics.
- Union candidate NPC names for the same logical group/count/class instead of creating duplicate spawn rows.
- If a structure objective exists, disable the current "no blitz means all groups are objectives" fallback.
- Golden logs still override both public sources when available.

## Prototype

The local comparison script is:

```powershell
node scripts\compare-mission-sources.js --wakka AvengeaFallenComrade1an
```

It emits a Markdown comparison from the local Eve-Survival and Eve University caches. Use `--json` to inspect the parsed source extracts and merged draft object.
