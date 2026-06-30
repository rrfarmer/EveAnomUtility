#!/usr/bin/env node
/**
 * compare-mission-sources.js
 *
 * Local-cache comparison prototype for combining Eve-Survival and Eve University
 * mission pages. This does not fetch, scrape live pages, or apply templates.
 *
 * Usage:
 *   node scripts/compare-mission-sources.js --wakka AvengeaFallenComrade1an
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseEveSurvival } = require("../src/lib/missionScraper");

const ROOT = path.resolve(__dirname, "..");
const SURVIVAL_MANIFEST = path.join(ROOT, "workspace", "eve-survival", "manifests", "missionreports-links.json");
const UNIVERSITY_MANIFEST = path.join(ROOT, "workspace", "eve-university", "manifests", "mission-reports-security-links.json");
const SURVIVAL_RAW_DIR = path.join(ROOT, "workspace", "eve-survival", "raw", "eve-survival");
const UNIVERSITY_RAW_DIR = path.join(ROOT, "workspace", "eve-university", "raw", "pages");

const NPC_CLASSES = [
  "Elite Frigate",
  "Elite Cruiser",
  "Battlecruiser",
  "Battleship",
  "Destroyer",
  "Frigate",
  "Cruiser",
  "Sentry",
  "Drone",
  "Hauler",
  "Industrial",
  "Structure",
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--wakka") args.wakka = String(argv[++i] || "");
    else if (token === "--university-page-key") args.universityPageKey = String(argv[++i] || "");
    else if (token === "--json") args.json = true;
    else if (token === "--help" || token === "-h") args.help = true;
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/compare-mission-sources.js --wakka <EveSurvivalWakka> [--json]",
    "",
    "Example:",
    "  node scripts/compare-mission-sources.js --wakka AvengeaFallenComrade1an",
    "",
    "Reads local cache only:",
    `  ${path.relative(ROOT, SURVIVAL_RAW_DIR)}`,
    `  ${path.relative(ROOT, UNIVERSITY_RAW_DIR)}`,
  ].join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stripTags(value) {
  return decodeEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\blevel\s*\d+\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function splitNames(value) {
  const parts = String(value || "")
    .split(/[\/,]|\bor\b/i)
    .map((name) => name.trim())
    .filter(Boolean);
  const expanded = [];
  let prefix = "";
  for (const part of parts) {
    if (/\s/.test(part)) {
      const tokens = part.split(/\s+/);
      prefix = tokens.slice(0, -1).join(" ");
      expanded.push(part);
    } else if (prefix) {
      expanded.push(`${prefix} ${part}`);
    } else {
      expanded.push(part);
    }
  }
  return expanded;
}

function parseDistanceMeters(text) {
  const source = String(text || "");
  const match = source.match(/\(?\s*(\d+)\s*(?:-\s*(\d+)\s*)?km\b/i);
  if (!match) return null;
  const min = Number(match[1]) * 1000;
  const max = match[2] ? Number(match[2]) * 1000 : min;
  return { minMeters: min, maxMeters: max, raw: match[0].trim() };
}

function parseUniversitySpawnText(text, entityKind) {
  const raw = stripTags(text);
  const match = raw.match(/^(\d+)\s*x\s+(.+)$/i);
  if (!match) return null;

  const count = Number(match[1]) || 1;
  const rest = match[2].trim();
  if (entityKind === "structure") {
    return {
      raw,
      count,
      entityKind: "structure",
      label: rest,
      candidateNames: [rest],
    };
  }

  const shipClass = NPC_CLASSES.find((candidate) => new RegExp(`^${candidate}\\b`, "i").test(rest)) || "";
  if (!shipClass) {
    return {
      raw,
      count,
      entityKind: "npc",
      label: rest,
      candidateNames: [rest],
    };
  }

  const names = rest.slice(shipClass.length).trim();
  return {
    raw,
    count,
    entityKind: "npc",
    label: shipClass,
    candidateNames: splitNames(names),
  };
}

function parseMissionDetails(html) {
  const details = {};
  const rowPattern = /<td[^>]*class="MssnDtls-label"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*class="MssnDtls-data"[^>]*>([\s\S]*?)<\/td>/gi;
  for (const match of html.matchAll(rowPattern)) {
    const key = stripTags(match[1]).replace(/^\s+|\s+$/g, "");
    const value = stripTags(match[2]);
    if (key) details[key] = value;
  }
  return details;
}

function parseUniversityBlitz(html) {
  const match = html.match(/<b>\s*Blitz\s*:\s*<\/b>[\s\S]*?<ul>\s*<li>([\s\S]*?)<\/li>/i);
  return match ? stripTags(match[1]) : "";
}

function parseUniversityPocketNote(html) {
  const pocketStart = html.search(/<span[^>]*class="mw-headline"[^>]*id="Pocket"[^>]*>/i);
  if (pocketStart < 0) return "";
  const section = html.slice(pocketStart, html.search(/<table class="navbox"/i) > 0 ? html.search(/<table class="navbox"/i) : undefined);
  const pMatch = section.match(/<\/h3>[\s\S]*?<p>([\s\S]*?)<\/p>/i);
  return pMatch ? stripTags(pMatch[1]) : "";
}

function parseUniversityTables(html) {
  const pocketStart = html.search(/<span[^>]*class="mw-headline"[^>]*id="Pocket"[^>]*>/i);
  const navboxStart = html.search(/<table class="navbox"/i);
  const section = pocketStart >= 0 ? html.slice(pocketStart, navboxStart > pocketStart ? navboxStart : undefined) : html;
  const tables = [];

  const tablePattern = /(?:<div[^>]*font-weight:\s*bold[^>]*>([\s\S]*?)<\/div>\s*)?<table[^>]*class="[^"]*\bNPC\b[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  for (const match of section.matchAll(tablePattern)) {
    const label = stripTags(match[1]) || (tables.length === 0 ? "Structures" : `Table ${tables.length + 1}`);
    tables.push({ label, html: match[2] });
  }

  const structures = [];
  const groups = [];
  for (const table of tables) {
    const entityKind = /structure/i.test(table.label) ? "structure" : "npc";
    let currentGroup = null;
    const rowPattern = /<tr[\s\S]*?<\/tr>/gi;
    for (const rowMatch of table.html.matchAll(rowPattern)) {
      const row = rowMatch[0];
      const groupMatch = row.match(/<th[^>]*colspan="5"[^>]*>([\s\S]*?)<\/th>/i);
      if (groupMatch) {
        currentGroup = {
          title: stripTags(groupMatch[1]),
          distance: parseDistanceMeters(stripTags(groupMatch[1])),
          spawns: [],
        };
        groups.push(currentGroup);
        continue;
      }

      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      if (cells.length < 2) continue;
      const spawn = parseUniversitySpawnText(cells[1], entityKind);
      if (!spawn) continue;
      spawn.objectiveOnDestruction = /Mission completed on destruction|Icon_large_red_x/i.test(row);

      if (entityKind === "structure") structures.push(spawn);
      else {
        if (!currentGroup) {
          currentGroup = { title: table.label || "Group 1", distance: null, spawns: [] };
          groups.push(currentGroup);
        }
        currentGroup.spawns.push(spawn);
      }
    }
  }

  return { structures, groups };
}

function parseEveUniversity(html, record) {
  const details = parseMissionDetails(html);
  const tables = parseUniversityTables(html);
  return {
    source: "eve-university",
    pageKey: record.page_key,
    url: record.url,
    title: record.title,
    level: record.level,
    faction: record.enemy_faction,
    details,
    objectiveText: details.Objective || "",
    blitz: parseUniversityBlitz(html),
    pocketNote: parseUniversityPocketNote(html),
    structures: tables.structures,
    groups: tables.groups,
  };
}

function survivalRawPath(wakka) {
  return path.join(SURVIVAL_RAW_DIR, `${wakka}.html`);
}

function universityRawPath(pageKey) {
  return path.join(UNIVERSITY_RAW_DIR, `${pageKey}.html`);
}

function findUniversityRecord(survivalRecord, explicitPageKey) {
  const manifest = readJson(UNIVERSITY_MANIFEST);
  if (explicitPageKey) {
    const found = manifest.records.find((record) => record.page_key === explicitPageKey);
    if (!found) throw new Error(`No Eve University manifest record for page key ${explicitPageKey}`);
    return found;
  }

  const titleKey = normalizeKey(survivalRecord.title);
  const factionKey = normalizeKey(survivalRecord.faction);
  const candidates = manifest.records.filter((record) =>
    record.level === survivalRecord.level &&
    normalizeKey(record.enemy_faction) === factionKey &&
    normalizeKey(record.title).includes(titleKey));

  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new Error(`No Eve University match for ${survivalRecord.title} level ${survivalRecord.level} ${survivalRecord.faction}`);
  }
  throw new Error(`Ambiguous Eve University match: ${candidates.map((record) => record.page_key).join(", ")}`);
}

function sourceSpawnRowsFromSurvival(mission) {
  const rows = [];
  for (const room of mission.rooms || []) {
    for (const group of room.groups || []) {
      for (const spawn of group.spawns || []) {
        rows.push({
          room: room.title,
          group: group.title,
          count: spawn.count,
          label: spawn.shipClass,
          candidateNames: spawn.shipNames || [],
          distance: group.distance,
          raw: spawn.raw,
        });
      }
    }
  }
  return rows;
}

function sourceSpawnRowsFromUniversity(mission) {
  const rows = [];
  for (const group of mission.groups || []) {
    for (const spawn of group.spawns || []) {
      rows.push({
        room: "Pocket",
        group: group.title,
        count: spawn.count,
        label: spawn.label,
        candidateNames: spawn.candidateNames || [],
        distance: group.distance,
        raw: spawn.raw,
      });
    }
  }
  return rows;
}

function groupNumber(title) {
  const match = String(title || "").match(/group\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function mergeCandidateNames(left, right) {
  const result = [];
  const seen = new Set();
  for (const name of [...(left || []), ...(right || [])]) {
    const key = normalizeKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function buildMergeDraft(survival, university) {
  const survivalRows = sourceSpawnRowsFromSurvival(survival);
  const universityRows = sourceSpawnRowsFromUniversity(university);
  const universityByGroup = new Map(universityRows.map((row) => [groupNumber(row.group), row]));

  const groups = survivalRows.map((survivalRow) => {
    const number = groupNumber(survivalRow.group);
    const universityRow = universityByGroup.get(number);
    return {
      group: survivalRow.group,
      count: survivalRow.count,
      label: survivalRow.label.replace(/s$/, ""),
      candidateNames: mergeCandidateNames(survivalRow.candidateNames, universityRow && universityRow.candidateNames),
      distance: survivalRow.distance || (universityRow && universityRow.distance) || null,
      sourceNotes: {
        eveSurvival: survivalRow.raw,
        eveUniversity: universityRow ? universityRow.raw : "",
      },
    };
  });

  const objectiveStructures = (university.structures || []).filter((structure) => structure.objectiveOnDestruction);
  return {
    title: survival.title,
    level: survival.level,
    faction: survival.faction || university.faction,
    topology: {
      use: "eve-survival",
      reason: "Eve-Survival separates the acceleration-gate entry pocket from the combat pocket.",
      rooms: survival.rooms.map((room) => ({
        title: room.title,
        notes: room.notes || [],
        groupCount: (room.groups || []).length,
      })),
    },
    objective: {
      completion: objectiveStructures.length ? "destroy-structure" : "unknown",
      text: university.objectiveText || survival.blitz || "",
      blitz: university.blitz || survival.blitz || "",
      structures: objectiveStructures.map((structure) => ({
        label: structure.label,
        count: structure.count,
        objectiveOnDestruction: structure.objectiveOnDestruction,
      })),
      sourceNotes: {
        eveSurvival: survival.rooms.flatMap((room) => (room.groups || []).flatMap((group) => group.notes || [])).filter((note) => /mission objective|habitat/i.test(note)),
        eveUniversity: university.structures.filter((structure) => /habitat/i.test(structure.label)).map((structure) => structure.raw),
      },
    },
    advisory: {
      eveSurvivalDamageDealt: survival.damageToDeal,
      eveUniversityBestDamage: university.details["Best damage to deal"] || "",
      eveUniversityDamageToResist: university.details["Damage to resist"] || "",
    },
    aggro: {
      text: university.pocketNote || (survival.rooms[1] && survival.rooms[1].notes.join(" ")) || "",
      source: university.pocketNote ? "eve-university" : "eve-survival",
    },
    groups,
    mergeRules: [
      "Keep one spawn row per logical group/count/ship class.",
      "Union candidate NPC names from both sources instead of creating duplicate rows.",
      "Use Eve-Survival room/gate topology when it has an explicit gate/entry pocket.",
      "Use Eve University objective icons/text to create structure completion triggers.",
      "When a structure objective exists, do not mark every NPC group as a mission objective by default.",
    ],
  };
}

function countRows(rows) {
  return rows.reduce((sum, row) => sum + row.count, 0);
}

function formatNames(names) {
  return names && names.length ? names.join("/") : "?";
}

function formatDistance(distance) {
  if (!distance) return "";
  const min = Math.round(distance.minMeters / 1000);
  const max = Math.round(distance.maxMeters / 1000);
  return min === max ? `${min}km` : `${min}-${max}km`;
}

function formatMarkdown(payload) {
  const survivalRows = sourceSpawnRowsFromSurvival(payload.eveSurvival);
  const universityRows = sourceSpawnRowsFromUniversity(payload.eveUniversity);
  const draft = payload.mergeDraft;
  const lines = [];

  lines.push(`# Mission Source Comparison: ${draft.title}`);
  lines.push("");
  lines.push(`Mission: ${draft.title} / Level ${draft.level} / ${draft.faction}`);
  lines.push(`Eve-Survival: ${payload.eveSurvival.wakka} (${payload.eveSurvival.url})`);
  lines.push(`Eve University: ${payload.eveUniversity.pageKey} (${payload.eveUniversity.url})`);
  lines.push("");
  lines.push("## Quick Read");
  lines.push("");
  lines.push("- Productive: yes. The two sources complement each other instead of duplicating the same value.");
  lines.push("- Eve-Survival is stronger for room/gate topology and simple spawn grouping.");
  lines.push("- Eve University is stronger for objective semantics, objective icons, and alternate NPC candidate names.");
  lines.push("- For this mission, current Eve-Survival-only parsing would incorrectly make all NPC groups objectives and miss the Habitat structure completion trigger.");
  lines.push("");
  lines.push("## Source Differences");
  lines.push("");
  lines.push("| Area | Eve-Survival | Eve University | Merge decision |");
  lines.push("|---|---|---|---|");
  lines.push(`| Topology | ${draft.topology.rooms.map((room) => `${room.title} (${room.groupCount} groups)`).join("; ")} | One Pocket section | Use Eve-Survival gate/entry topology |`);
  lines.push(`| Objective | ${draft.objective.sourceNotes.eveSurvival.join("; ") || "No structured objective"} | ${draft.objective.text}; blitz: ${draft.objective.blitz}; structure row: ${draft.objective.sourceNotes.eveUniversity.join("; ") || "none"} | Structure destroy trigger |`);
  lines.push(`| Aggro | ${(payload.eveSurvival.rooms[1] && payload.eveSurvival.rooms[1].notes.join(" ")) || ""} | ${payload.eveUniversity.pocketNote} | Use Eve University because it adds habitat engagement aggro |`);
  lines.push(`| NPC rows | ${survivalRows.length} rows / ${countRows(survivalRows)} ships | ${universityRows.length} rows / ${countRows(universityRows)} ships | Same logical groups; union candidate names |`);
  lines.push("");
  lines.push("## Spawn Merge Draft");
  lines.push("");
  lines.push("| Group | Count | Class | Distance | Candidate names | Source notes |");
  lines.push("|---|---:|---|---|---|---|");
  for (const group of draft.groups) {
    lines.push(`| ${group.group} | ${group.count} | ${group.label} | ${formatDistance(group.distance)} | ${formatNames(group.candidateNames)} | ES: ${group.sourceNotes.eveSurvival}; EU: ${group.sourceNotes.eveUniversity || "missing"} |`);
  }
  lines.push("");
  lines.push("## Structure Objective Draft");
  lines.push("");
  for (const structure of draft.objective.structures) {
    lines.push(`- ${structure.count} x ${structure.label}: completion trigger on destruction.`);
  }
  if (!draft.objective.structures.length) lines.push("- None detected.");
  lines.push("");
  lines.push("## Merge Rules From This Iteration");
  lines.push("");
  for (const rule of draft.mergeRules) lines.push(`- ${rule}`);
  lines.push("");
  lines.push("## Utility Implication");
  lines.push("");
  lines.push("The scraped mission builder should keep source-specific extracts and generate a merged draft layer. The merged layer should record provenance per field, because the best source differs by field: topology from Eve-Survival, objective/completion semantics from Eve University, and exact runtime behavior from golden logs when available.");
  lines.push("");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.wakka) {
    process.stdout.write(`${usage()}\n`);
    process.exit(args.help ? 0 : 2);
  }

  const survivalManifest = readJson(SURVIVAL_MANIFEST);
  const survivalRecord = survivalManifest.records.find((record) => record.wakka === args.wakka);
  if (!survivalRecord) throw new Error(`No Eve-Survival manifest record for wakka ${args.wakka}`);

  const survivalPath = survivalRawPath(survivalRecord.wakka);
  if (!fs.existsSync(survivalPath)) throw new Error(`Missing local Eve-Survival raw page: ${survivalPath}`);
  const survivalHtml = fs.readFileSync(survivalPath, "utf8");
  const eveSurvival = parseEveSurvival(survivalHtml, survivalRecord.wakka);

  const universityRecord = findUniversityRecord(survivalRecord, args.universityPageKey);
  const universityPath = universityRawPath(universityRecord.page_key);
  if (!fs.existsSync(universityPath)) throw new Error(`Missing local Eve University raw page: ${universityPath}`);
  const universityHtml = fs.readFileSync(universityPath, "utf8");
  const eveUniversity = parseEveUniversity(universityHtml, universityRecord);

  const payload = {
    comparedAt: new Date().toISOString(),
    eveSurvival,
    eveUniversity,
    mergeDraft: buildMergeDraft(eveSurvival, eveUniversity),
  };

  process.stdout.write(args.json ? `${JSON.stringify(payload, null, 2)}\n` : formatMarkdown(payload));
}

try {
  main();
} catch (error) {
  process.stderr.write(`compare-mission-sources failed: ${error.message}\n`);
  process.exit(1);
}
