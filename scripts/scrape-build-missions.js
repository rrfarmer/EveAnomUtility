#!/usr/bin/env node
/**
 * scrape-build-missions.js
 *
 * Batch-build Eve-Survival mission dungeon templates from the local scrape cache, optionally merging
 * cached Eve University objective data, and write them back to an EveJS dungeonAuthority target.
 *
 * This never scrapes the network. Run the collector scripts first, then use this to generate only the
 * templates missing from EveJS static tables, or to patch existing scraped templates after builder fixes.
 */

const fs = require("node:fs");
const path = require("node:path");

const { WORKSPACE_ROOT } = require("../src/lib/dataStore");
const { parseEveSurvival } = require("../src/lib/missionScraper");
const { enrichMissionFromLocalSources } = require("../src/lib/missionSourceMerge");
const { buildTemplate, patchExistingTemplate } = require("../src/lib/eveSurvivalTemplate");
const { validateMissionTemplate } = require("../src/lib/missionTemplateValidator");
const { resolveApplyTarget, backupTemplateOnce, readDungeonAuthority, writeDungeonAuthority } = require("../src/lib/sandbox");

const DEFAULT_MANIFEST = path.join(WORKSPACE_ROOT, "eve-survival", "manifests", "missionreports-links.json");
const DEFAULT_RAW_DIR = path.join(WORKSPACE_ROOT, "eve-survival", "raw", "eve-survival");

function parseArgs(argv) {
  const args = {
    apply: false,
    dryRun: true,
    target: "static",
    mergeSources: true,
    mode: "missing",
    skipEditLinks: true,
    skipUnplayable: true,
    strict: false,
    reset: false,
    levels: new Set([1, 2, 3, 4, 5]),
    wakkas: new Set(),
    excludedWakkas: new Set(),
    excludedTemplateIDs: new Set(),
    manifestPath: DEFAULT_MANIFEST,
    rawDir: DEFAULT_RAW_DIR,
    limit: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") { args.apply = true; args.dryRun = false; }
    else if (token === "--dry-run") { args.apply = false; args.dryRun = true; }
    else if (token === "--missing-only") args.mode = "missing";
    else if (token === "--patch-existing" || token === "--update-existing") args.mode = "patch";
    else if (token === "--replace-existing") args.mode = "replace";
    else if (token === "--no-merge") args.mergeSources = false;
    else if (token === "--include-unplayable") args.skipUnplayable = false;
    else if (token === "--strict") args.strict = true;
    else if (token === "--include-edit-links") args.skipEditLinks = false;
    else if (token === "--reset") args.reset = true;
    else if (token === "--sandbox") args.target = "sandbox";
    else if (token === "--live") args.target = "live";
    else if (token === "--static") args.target = "static";
    else if (token === "--target") args.target = String(argv[++index] || "static");
    else if (token === "--eve-root") args.eveRoot = String(argv[++index] || "");
    else if (token === "--manifest") args.manifestPath = path.resolve(String(argv[++index] || ""));
    else if (token === "--raw-dir") args.rawDir = path.resolve(String(argv[++index] || ""));
    else if (token === "--limit") args.limit = Math.max(0, Number(argv[++index]) || 0);
    else if (token === "--levels" || token === "--level") args.levels = parseLevels(String(argv[++index] || ""));
    else if (token === "--wakka") {
      for (const wakka of String(argv[++index] || "").split(",")) {
        if (wakka.trim()) args.wakkas.add(wakka.trim());
      }
    } else if (token === "--exclude-wakka") {
      for (const wakka of String(argv[++index] || "").split(",")) {
        if (wakka.trim()) args.excludedWakkas.add(wakka.trim());
      }
    } else if (token === "--exclude-template") {
      for (const templateID of String(argv[++index] || "").split(",")) {
        if (templateID.trim()) args.excludedTemplateIDs.add(templateID.trim());
      }
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown option: ${token}`);
    }
  }
  return args;
}

function parseLevels(value) {
  const levels = new Set();
  for (const part of String(value || "").split(",")) {
    const text = part.trim();
    if (!text) continue;
    const range = text.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Math.min(Number(range[1]), Number(range[2]));
      const end = Math.max(Number(range[1]), Number(range[2]));
      for (let level = start; level <= end; level += 1) levels.add(level);
      continue;
    }
    levels.add(Number(text));
  }
  return new Set([...levels].filter((level) => level >= 1 && level <= 5));
}

function usage() {
  return [
    "Usage:",
    "  node scripts/scrape-build-missions.js [--apply] [--target static|sandbox|live] [options]",
    "",
    "Defaults:",
    "  dry-run, target=static, levels=1-5, missing-only, local cache only, Eve University merge enabled.",
    "",
    "Options:",
    "  --apply                 Write changes. Without this, only reports what would change.",
    "  --missing-only          Insert only templates missing from dungeonAuthority (default).",
    "  --patch-existing        Patch existing templates too, preserving non-scrape fields.",
    "  --replace-existing      Replace existing templates with freshly built scrape templates.",
    "  --levels 1-5            Limit mission levels. Also accepts comma lists like 1,2.",
    "  --wakka A,B             Limit to one or more Eve-Survival wakka IDs.",
    "  --exclude-wakka A,B     Skip one or more Eve-Survival wakka IDs.",
    "  --exclude-template A,B  Skip one or more template IDs.",
    "  --limit N               Stop after N generated/updated templates.",
    "  --include-edit-links    Include bad source links whose wakka contains /edit.",
    "  --include-unplayable    Export scraped pages even when no playable objective can be built.",
    "  --no-merge              Disable Eve University local-cache enrichment.",
    "  --strict                Treat validation warnings as skips.",
    "  --sandbox|--live|--static or --target <target>",
    "  --eve-root <path>       Override EveJS repo root.",
    "",
    "Examples:",
    "  npm run scrape-build -- --levels 1-5",
    "  npm run scrape-build -- --apply --target static --levels 1-5 --missing-only",
    "  npm run scrape-build -- --apply --patch-existing --levels 1",
  ].join("\n");
}

function safeWakkaFilename(wakka) {
  return String(wakka || "").replace(/[\\/:*?"<>|]+/g, "_");
}

function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Mission manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.records)) {
    throw new Error(`Mission manifest has no records array: ${manifestPath}`);
  }
  return manifest;
}

function selectRecords(records, args) {
  return records
    .filter((record) => args.levels.has(Number(record.level)))
    .filter((record) => args.wakkas.size <= 0 || args.wakkas.has(record.wakka))
    .filter((record) => !args.excludedWakkas.has(record.wakka))
    .filter((record) => !args.excludedTemplateIDs.has(templateIDForRecord(record)))
    .filter((record) => !(args.skipEditLinks && /\/edit\b/i.test(String(record.wakka || ""))));
}

function readCachedMission(record, args) {
  const rawPath = path.join(args.rawDir, `${safeWakkaFilename(record.wakka)}.html`);
  if (!fs.existsSync(rawPath)) {
    return { error: `raw cache missing: ${rawPath}` };
  }
  const html = fs.readFileSync(rawPath, "utf8");
  const mission = parseEveSurvival(html, record.wakka);
  return {
    mission: enrichMissionFromLocalSources(mission, { mergeSources: args.mergeSources }),
    rawPath,
  };
}

function templateIDForRecord(record) {
  return `eve-survival:${record.wakka}`;
}

function addUnique(indexes, indexName, key, templateID) {
  indexes[indexName] = indexes[indexName] || {};
  indexes[indexName][key] = Array.isArray(indexes[indexName][key]) ? indexes[indexName][key] : [];
  if (!indexes[indexName][key].includes(templateID)) indexes[indexName][key].push(templateID);
  indexes[indexName][key].sort();
}

function sourceIndexKeyForTemplate(templateID, template) {
  if (templateID.startsWith("eve-survival:")) return "eve-survival";
  if (templateID.startsWith("client-dungeon:")) return "client";
  return String(template && template.source || "unknown");
}

function refreshAuthorityMetadata(dungeon) {
  dungeon.templatesByID = dungeon.templatesByID || {};
  dungeon.counts = dungeon.counts || {};
  dungeon.indexes = dungeon.indexes || {};
  dungeon.counts.templateCount = Object.keys(dungeon.templatesByID).length;
  dungeon.counts.eveSurvivalMissionCount = Object.keys(dungeon.templatesByID)
    .filter((templateID) => templateID.startsWith("eve-survival:")).length;

  dungeon.indexes.templateIDsBySource = {};
  dungeon.indexes.templateIDsByFamily = {};
  for (const [templateID, template] of Object.entries(dungeon.templatesByID)) {
    addUnique(dungeon.indexes, "templateIDsBySource", sourceIndexKeyForTemplate(templateID, template), templateID);
    addUnique(dungeon.indexes, "templateIDsByFamily", template.siteFamily || "unknown", templateID);
  }
}

function countMissionContent(mission) {
  let groups = 0;
  let spawns = 0;
  for (const room of mission.rooms || []) {
    groups += (room.groups || []).length;
    for (const group of room.groups || []) spawns += (group.spawns || []).length;
  }
  return { rooms: (mission.rooms || []).length, groups, spawns };
}

function templatePlayability(template) {
  return (template.adminMetadata && template.adminMetadata.playability) ||
    (template.populationHints && template.populationHints.playability) ||
    null;
}

async function maybeBackup(applyTarget, templateID, template, args) {
  if (!args.apply || applyTarget.target === "sandbox" || !template) return null;
  return backupTemplateOnce(templateID, template);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const manifest = readManifest(args.manifestPath);
  const records = selectRecords(manifest.records, args);
  const applyTarget = await resolveApplyTarget({
    target: args.target,
    eveRoot: args.eveRoot,
    reset: args.reset,
  });
  const dungeon = await readDungeonAuthority(applyTarget.dataDir);
  dungeon.templatesByID = dungeon.templatesByID || {};

  const summary = {
    selected: records.length,
    existingSkipped: 0,
    rawMissing: [],
    invalid: [],
    warnings: [],
    unplayableRemoved: [],
    unplayableSkipped: [],
    inserted: [],
    patched: [],
    replaced: [],
    merged: 0,
    backups: [],
  };
  const changedTemplateIDs = [];
  const removedTemplateIDs = [];

  for (const record of records) {
    const templateID = templateIDForRecord(record);
    const existing = dungeon.templatesByID[templateID] || null;
    if (existing && args.mode === "missing") {
      summary.existingSkipped += 1;
      continue;
    }

    const cached = readCachedMission(record, args);
    if (cached.error) {
      summary.rawMissing.push({ wakka: record.wakka, error: cached.error });
      continue;
    }
    const mission = cached.mission;
    if (mission.sourceMerge) summary.merged += 1;

    const nextTemplate = existing && args.mode === "patch"
      ? patchExistingTemplate(JSON.parse(JSON.stringify(existing)), mission)
      : buildTemplate(mission);
    const validation = validateMissionTemplate(nextTemplate);
    if (validation.errors.length > 0) {
      summary.invalid.push({
        wakka: record.wakka,
        templateID,
        errors: validation.errors,
        warnings: validation.warnings,
      });
      continue;
    }
    const playability = templatePlayability(nextTemplate);
    if (args.skipUnplayable && playability && playability.playable === false) {
      const row = {
        wakka: record.wakka,
        templateID,
        title: mission.title || record.title,
        level: mission.level || record.level,
        playability: playability.strategy || playability.grade || "",
        gaps: Array.isArray(playability.gaps) ? playability.gaps : [],
      };
      if (existing) {
        if (args.apply) {
          const backup = await maybeBackup(applyTarget, templateID, existing, args);
          if (backup) summary.backups.push(backup);
          delete dungeon.templatesByID[templateID];
          removedTemplateIDs.push(templateID);
        }
        summary.unplayableRemoved.push(row);
      } else {
        summary.unplayableSkipped.push(row);
      }
      continue;
    }
    if (args.strict && validation.warnings.length > 0) {
      summary.invalid.push({
        wakka: record.wakka,
        templateID,
        errors: validation.errors,
        warnings: validation.warnings,
      });
      continue;
    }
    for (const warning of validation.warnings) {
      summary.warnings.push({ wakka: record.wakka, templateID, warning });
    }

    if (args.apply) {
      const backup = await maybeBackup(applyTarget, templateID, existing, args);
      if (backup) summary.backups.push(backup);
      dungeon.templatesByID[templateID] = nextTemplate;
      changedTemplateIDs.push(templateID);
    }

    const content = countMissionContent(mission);
    const result = {
      wakka: record.wakka,
      templateID,
      title: mission.title || record.title,
      level: mission.level || record.level,
      faction: mission.faction || record.faction || "",
      merged: Boolean(mission.sourceMerge),
      objectiveStructures: (mission.objectiveStructures || []).length,
      playability: playability ? playability.strategy || playability.grade || "" : "",
      ...content,
    };
    if (!existing) summary.inserted.push(result);
    else if (args.mode === "replace") summary.replaced.push(result);
    else summary.patched.push(result);

    const changedCount = summary.inserted.length + summary.patched.length + summary.replaced.length;
    if (args.limit > 0 && changedCount >= args.limit) break;
  }

  if (args.apply && (changedTemplateIDs.length > 0 || removedTemplateIDs.length > 0)) {
    refreshAuthorityMetadata(dungeon);
    await writeDungeonAuthority(applyTarget.dataDir, dungeon);
  }

  printSummary(summary, args, applyTarget, records.length);
}

function printRows(label, rows, limit = 20) {
  if (rows.length <= 0) return;
  process.stdout.write(`\n${label} (${rows.length}${rows.length > limit ? `, first ${limit}` : ""}):\n`);
  for (const row of rows.slice(0, limit)) {
    process.stdout.write(
      `  ${row.templateID || row.wakka}  L${row.level || "?"}  ${row.title || row.error || ""}` +
      (row.merged ? "  [merged]" : "") +
      (row.objectiveStructures ? `  objectives=${row.objectiveStructures}` : "") +
      (row.playability ? `  ${row.playability}` : "") +
      "\n",
    );
  }
}

function printSummary(summary, args, applyTarget, selectedCount) {
  const changed = summary.inserted.length + summary.patched.length + summary.replaced.length;
  process.stdout.write(
    [
      "",
      `Scraped mission build ${args.apply ? "APPLIED" : "DRY RUN"}`,
      `  target: ${applyTarget.target}`,
      `  data dir: ${applyTarget.dataDir}${applyTarget.copied ? " (freshly copied)" : ""}`,
      `  mode: ${args.mode}`,
      `  selected records: ${selectedCount}`,
      `  existing skipped: ${summary.existingSkipped}`,
      `  generated/updated: ${changed} (${summary.inserted.length} inserted, ${summary.patched.length} patched, ${summary.replaced.length} replaced)`,
      `  source-merged with Eve University: ${summary.merged}`,
      `  raw cache missing: ${summary.rawMissing.length}`,
      `  ${args.apply ? "unplayable removed" : "unplayable would remove"}: ${summary.unplayableRemoved.length}`,
      `  unplayable skipped: ${summary.unplayableSkipped.length}`,
      `  invalid/skipped: ${summary.invalid.length}`,
      `  warnings: ${summary.warnings.length}`,
    ].join("\n"),
  );
  printRows("Inserted", summary.inserted);
  printRows("Patched", summary.patched);
  printRows("Replaced", summary.replaced);
  printRows(args.apply ? "Unplayable removed" : "Unplayable would remove", summary.unplayableRemoved);
  printRows("Unplayable skipped", summary.unplayableSkipped);
  if (summary.rawMissing.length) {
    process.stdout.write(`\nRaw cache missing (${summary.rawMissing.length}):\n`);
    for (const row of summary.rawMissing.slice(0, 20)) process.stdout.write(`  ${row.wakka}: ${row.error}\n`);
  }
  if (summary.invalid.length) {
    process.stdout.write(`\nInvalid/skipped (${summary.invalid.length}):\n`);
    for (const row of summary.invalid.slice(0, 20)) {
      process.stdout.write(`  ${row.templateID}: ${[...row.errors, ...row.warnings].join("; ")}\n`);
    }
  }
  if (!args.apply) {
    process.stdout.write("\nNo files written. Re-run with --apply to save to the selected EveJS target.\n");
  } else if (changed > 0 && applyTarget.target === "static") {
    process.stdout.write("\nWrote EveJS static-table source. Build runtime data with:\n  cd <eve.js> && tools\\DatabaseCreator\\CreateDatabase.bat /force\n");
  } else if (changed > 0) {
    process.stdout.write("\nWrote selected EveJS target. Restart EveJS to load runtime changes.\n");
  }
  if (summary.backups.length) {
    process.stdout.write(`Backups written: ${summary.backups.length}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`scrape-build-missions failed: ${error.message}\n`);
  process.exit(1);
});
