#!/usr/bin/env node
/**
 * Build EveJS dungeonAuthority templates from the local Eve University site-family cache.
 *
 * This does not scrape the network. Run tools/eve_site_family_collector.py first, then use this
 * command to dry-run or write generated, playable fallback templates into EveJS static tables.
 */

const path = require("node:path");

const {
  DEFAULT_SITE_FAMILY_CACHE_DIR,
  parseSiteFamilyCache,
  refreshDungeonAuthorityMetadata,
  validateSiteFamilyTemplate,
} = require("../src/lib/eveUniversitySiteFamily");
const {
  backupTemplateOnce,
  readDungeonAuthority,
  resolveApplyTarget,
  writeDungeonAuthority,
} = require("../src/lib/sandbox");

function text(value) {
  return String(value || "").trim();
}

function parseArgs(argv) {
  const args = {
    apply: false,
    dryRun: true,
    target: "static",
    mode: "missing",
    reset: false,
    strict: false,
    skipUnplayable: true,
    cacheDir: DEFAULT_SITE_FAMILY_CACHE_DIR,
    family: "",
    category: "",
    page: "",
    limit: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") { args.apply = true; args.dryRun = false; }
    else if (token === "--dry-run") { args.apply = false; args.dryRun = true; }
    else if (token === "--missing-only") args.mode = "missing";
    else if (token === "--patch-existing" || token === "--update-existing") args.mode = "patch";
    else if (token === "--replace-existing") args.mode = "replace";
    else if (token === "--include-unplayable") args.skipUnplayable = false;
    else if (token === "--strict") args.strict = true;
    else if (token === "--reset") args.reset = true;
    else if (token === "--sandbox") args.target = "sandbox";
    else if (token === "--live") args.target = "live";
    else if (token === "--static") args.target = "static";
    else if (token === "--target") args.target = text(argv[++index]) || "static";
    else if (token === "--eve-root") args.eveRoot = text(argv[++index]);
    else if (token === "--cache-dir") args.cacheDir = path.resolve(text(argv[++index]));
    else if (token === "--family" || token === "--families") args.family = text(argv[++index]);
    else if (token === "--category" || token === "--categories") args.category = text(argv[++index]);
    else if (token === "--page" || token === "--title") args.page = [args.page, text(argv[++index])].filter(Boolean).join(",");
    else if (token === "--limit") args.limit = Math.max(0, Number(argv[++index]) || 0);
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown option: ${token}`);
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/site-family-build.js [--dry-run|--apply] [--target static|sandbox|live] [options]",
    "",
    "Defaults:",
    "  dry-run, target=static, missing-only, skip unplayable pages, local cache only.",
    "",
    "Options:",
    "  --apply                  Write generated templates. Without this, only reports.",
    "  --missing-only           Insert only templates missing from dungeonAuthority (default).",
    "  --patch-existing         Patch existing eve-university templates too.",
    "  --replace-existing       Replace existing eve-university templates.",
    "  --include-unplayable     Export pages even when no spawnable content was extracted.",
    "  --family combat,ore      Limit by generated siteFamily.",
    "  --category Gas sites     Limit by Eve University category.",
    "  --page Angel_Burrow      Limit by title/template/url substring. Repeatable.",
    "  --limit N                Stop after N selected parsed pages.",
    "  --cache-dir <path>       Override Eve University site-family cache path.",
    "  --strict                 Treat validation warnings as skips.",
    "  --sandbox|--live|--static or --target <target>",
    "  --eve-root <path>        Override EveJS repo root.",
    "",
    "Examples:",
    "  node scripts/site-family-build.js --dry-run --page Angel_Burrow",
    "  node scripts/site-family-build.js --dry-run --family combat --limit 20",
    "  node scripts/site-family-build.js --apply --target static --missing-only",
  ].join("\n");
}

function templatePlayability(template) {
  return template &&
    template.populationHints &&
    template.populationHints.playability &&
    typeof template.populationHints.playability === "object"
    ? template.populationHints.playability
    : null;
}

function countBy(rows, keyFn) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyFn(row) || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

async function maybeBackup(applyTarget, templateID, template, args) {
  if (!args.apply || applyTarget.target === "sandbox" || !template) return null;
  return backupTemplateOnce(templateID, template);
}

function resultRow(entry, validation, existing) {
  const template = entry.template;
  const playability = templatePlayability(template);
  const hints = template.populationHints || {};
  return {
    templateID: template.templateID,
    title: template.resolvedName || template.title,
    siteFamily: template.siteFamily,
    siteKind: template.siteKind,
    existing: Boolean(existing),
    playable: playability ? playability.playable === true : false,
    strategy: playability ? playability.strategy || playability.grade || "" : "",
    encounters: Array.isArray(hints.encounters) ? hints.encounters.length : 0,
    miningRocks: Array.isArray(hints.miningRocks) ? hints.miningRocks.length : 0,
    containers: Array.isArray(hints.containers) ? hints.containers.length : 0,
    warnings: validation.warnings,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const parsed = parseSiteFamilyCache({
    cacheDir: args.cacheDir,
    family: args.family,
    category: args.category,
    page: args.page,
    limit: args.limit,
  });
  const applyTarget = await resolveApplyTarget({
    target: args.target,
    eveRoot: args.eveRoot,
    reset: args.reset,
  });
  const dungeon = await readDungeonAuthority(applyTarget.dataDir);
  dungeon.templatesByID = dungeon.templatesByID || {};

  const summary = {
    selected: parsed.selected.length,
    existingSkipped: 0,
    unplayableSkipped: [],
    invalid: [],
    warnings: [],
    inserted: [],
    patched: [],
    replaced: [],
    backups: [],
  };
  const changedTemplateIDs = [];

  for (const entry of parsed.selected) {
    const template = entry.template;
    const templateID = template.templateID;
    const existing = dungeon.templatesByID[templateID] || null;
    if (existing && args.mode === "missing") {
      summary.existingSkipped += 1;
      continue;
    }

    const validation = validateSiteFamilyTemplate(template);
    if (validation.errors.length > 0 || (args.strict && validation.warnings.length > 0)) {
      summary.invalid.push(resultRow(entry, validation, existing));
      continue;
    }
    const playability = templatePlayability(template);
    if (args.skipUnplayable && playability && playability.playable === false) {
      summary.unplayableSkipped.push(resultRow(entry, validation, existing));
      continue;
    }
    for (const warning of validation.warnings) {
      summary.warnings.push({ templateID, warning });
    }

    if (args.apply) {
      const backup = await maybeBackup(applyTarget, templateID, existing, args);
      if (backup) summary.backups.push(backup);
      dungeon.templatesByID[templateID] = template;
      changedTemplateIDs.push(templateID);
    }

    const row = resultRow(entry, validation, existing);
    if (!existing) summary.inserted.push(row);
    else if (args.mode === "replace") summary.replaced.push(row);
    else summary.patched.push(row);
  }

  if (args.apply && changedTemplateIDs.length > 0) {
    refreshDungeonAuthorityMetadata(dungeon);
    await writeDungeonAuthority(applyTarget.dataDir, dungeon);
  }

  printSummary(summary, parsed, args, applyTarget);
}

function printRows(label, rows, limit = 20) {
  if (rows.length <= 0) return;
  process.stdout.write(`\n${label} (${rows.length}${rows.length > limit ? `, first ${limit}` : ""}):\n`);
  for (const row of rows.slice(0, limit)) {
    process.stdout.write(
      `  ${row.templateID}  ${row.siteFamily}/${row.siteKind}  ${row.title}` +
      (row.strategy ? `  ${row.strategy}` : "") +
      (row.encounters ? `  encounters=${row.encounters}` : "") +
      (row.miningRocks ? `  resources=${row.miningRocks}` : "") +
      (row.containers ? `  containers=${row.containers}` : "") +
      "\n",
    );
  }
}

function printCounts(label, counts) {
  if (counts.length <= 0) return;
  process.stdout.write(`\n${label}:\n`);
  for (const [key, count] of counts.slice(0, 12)) {
    process.stdout.write(`  ${key}: ${count}\n`);
  }
}

function printSummary(summary, parsed, args, applyTarget) {
  const changed = summary.inserted.length + summary.patched.length + summary.replaced.length;
  const selectedTemplates = parsed.selected.map((entry) => entry.template);
  process.stdout.write([
    "",
    `Eve University site-family build ${args.apply ? "APPLIED" : "DRY RUN"}`,
    `  target: ${applyTarget.target}`,
    `  data dir: ${applyTarget.dataDir}${applyTarget.copied ? " (freshly copied)" : ""}`,
    `  cache dir: ${parsed.cacheDir}`,
    `  parsed pages: ${parsed.parsedSites.length}`,
    `  selected pages: ${summary.selected}`,
    `  mode: ${args.mode}`,
    `  existing skipped: ${summary.existingSkipped}`,
    `  generated/updated: ${changed} (${summary.inserted.length} inserted, ${summary.patched.length} patched, ${summary.replaced.length} replaced)`,
    `  unplayable skipped: ${summary.unplayableSkipped.length}`,
    `  invalid/skipped: ${summary.invalid.length}`,
    `  warnings: ${summary.warnings.length}`,
    `  raw cache missing: ${parsed.missingRaw.length}`,
    `  parse errors: ${parsed.parseErrors.length}`,
  ].join("\n"));

  printCounts("Selected by family", countBy(selectedTemplates, (template) => template.siteFamily));
  printCounts("Selected by kind", countBy(selectedTemplates, (template) => template.siteKind));
  printRows("Inserted", summary.inserted);
  printRows("Patched", summary.patched);
  printRows("Replaced", summary.replaced);
  printRows("Unplayable skipped", summary.unplayableSkipped);
  printRows("Invalid/skipped", summary.invalid);

  if (parsed.missingRaw.length > 0) {
    process.stdout.write(`\nRaw cache missing (${parsed.missingRaw.length}, first 10):\n`);
    for (const row of parsed.missingRaw.slice(0, 10)) process.stdout.write(`  ${row.title || row.url}\n`);
  }
  if (parsed.parseErrors.length > 0) {
    process.stdout.write(`\nParse errors (${parsed.parseErrors.length}, first 10):\n`);
    for (const row of parsed.parseErrors.slice(0, 10)) process.stdout.write(`  ${row.title || row.url}: ${row.error}\n`);
  }
  if (!args.apply) {
    process.stdout.write("\nNo files written. Re-run with --apply to save to the selected EveJS target.\n");
  } else if (changed > 0 && applyTarget.target === "static") {
    process.stdout.write("\nWrote EveJS static-table source. Build runtime data with:\n  cd <eve.js> && tools\\DatabaseCreator\\CreateDatabase.bat /force\n");
  } else if (changed > 0) {
    process.stdout.write("\nWrote selected EveJS target. Restart EveJS to load runtime changes.\n");
  }
  if (summary.backups.length > 0) {
    process.stdout.write(`Backups written: ${summary.backups.length}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`site-family-build failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
