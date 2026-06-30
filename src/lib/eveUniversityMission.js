const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const UNIVERSITY_MANIFEST = path.join(ROOT, "workspace", "eve-university", "manifests", "mission-reports-security-links.json");
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

function stripTags(value) {
  return decodeEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\blevel\s*\d+\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function groupNumber(title) {
  const match = String(title || "").match(/group\s*(\d+)/i);
  return match ? Number(match[1]) : 0;
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

function parseMissionDetails(html) {
  const details = {};
  const rowPattern = /<td[^>]*class="MssnDtls-label"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*class="MssnDtls-data"[^>]*>([\s\S]*?)<\/td>/gi;
  for (const match of String(html || "").matchAll(rowPattern)) {
    const key = stripTags(match[1]).replace(/^\s+|\s+$/g, "");
    const value = stripTags(match[2]);
    if (key) details[key] = value;
  }
  return details;
}

function parseUniversityBlitz(html) {
  const match = String(html || "").match(/<b>\s*Blitz\s*:\s*<\/b>[\s\S]*?<ul>\s*<li>([\s\S]*?)<\/li>/i);
  return match ? stripTags(match[1]) : "";
}

function parseUniversityPocketNote(html) {
  const source = String(html || "");
  const pocketStart = source.search(/<span[^>]*class="mw-headline"[^>]*id="Pocket"[^>]*>/i);
  if (pocketStart < 0) return "";
  const navboxStart = source.search(/<table class="navbox"/i);
  const section = source.slice(pocketStart, navboxStart > pocketStart ? navboxStart : undefined);
  const pMatch = section.match(/<\/h3>[\s\S]*?<p>([\s\S]*?)<\/p>/i);
  return pMatch ? stripTags(pMatch[1]) : "";
}

function parseSpawnText(text, entityKind) {
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
      shipClass: rest,
      shipNames: [rest],
      candidateNames: [rest],
    };
  }

  const names = rest.slice(shipClass.length).trim();
  const candidateNames = splitNames(names);
  return {
    raw,
    count,
    entityKind: "npc",
    shipClass,
    shipNames: candidateNames,
    candidateNames,
  };
}

function parseUniversityTables(html) {
  const source = String(html || "");
  const pocketStart = source.search(/<span[^>]*class="mw-headline"[^>]*id="Pocket"[^>]*>/i);
  const navboxStart = source.search(/<table class="navbox"/i);
  const section = pocketStart >= 0 ? source.slice(pocketStart, navboxStart > pocketStart ? navboxStart : undefined) : source;
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
    for (const rowMatch of table.html.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
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
      const spawn = parseSpawnText(cells[1], entityKind);
      if (!spawn) continue;
      spawn.objectiveOnDestruction = /Mission completed on destruction|Icon_large_red_x/i.test(row);

      if (entityKind === "structure") {
        structures.push(spawn);
      } else {
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

function parseEveUniversityMission(html, record = {}) {
  const details = parseMissionDetails(html);
  const tables = parseUniversityTables(html);
  return {
    source: "eve-university",
    pageKey: record.page_key || record.pageKey || "",
    url: record.url || "",
    title: record.title || "",
    level: Number(record.level) || null,
    faction: record.enemy_faction || record.faction || "",
    details,
    objectiveText: details.Objective || "",
    blitz: parseUniversityBlitz(html),
    pocketNote: parseUniversityPocketNote(html),
    structures: tables.structures,
    groups: tables.groups,
  };
}

function readUniversityManifest(manifestPath = UNIVERSITY_MANIFEST) {
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function findEveUniversityRecordForMission(mission, options = {}) {
  const manifest = options.manifest || readUniversityManifest(options.manifestPath);
  if (!manifest || !Array.isArray(manifest.records)) return null;
  if (options.pageKey) {
    return manifest.records.find((record) => record.page_key === options.pageKey) || null;
  }

  const titleKey = normalizeKey(mission && mission.title);
  const factionKey = normalizeKey(mission && mission.faction);
  const level = Number(mission && mission.level) || null;
  const candidates = manifest.records.filter((record) =>
    (!level || Number(record.level) === level) &&
    normalizeKey(record.enemy_faction) === factionKey &&
    normalizeKey(record.title).includes(titleKey));
  return candidates.length === 1 ? candidates[0] : null;
}

function universityRawPath(pageKey, rawDir = UNIVERSITY_RAW_DIR) {
  return path.join(rawDir, `${pageKey}.html`);
}

function loadCachedEveUniversityMission(mission, options = {}) {
  const record = options.record || findEveUniversityRecordForMission(mission, options);
  if (!record) return null;
  const rawPath = universityRawPath(record.page_key, options.rawDir || UNIVERSITY_RAW_DIR);
  if (!fs.existsSync(rawPath)) return null;
  const html = fs.readFileSync(rawPath, "utf8");
  return parseEveUniversityMission(html, record);
}

module.exports = {
  UNIVERSITY_MANIFEST,
  UNIVERSITY_RAW_DIR,
  findEveUniversityRecordForMission,
  groupNumber,
  loadCachedEveUniversityMission,
  normalizeKey,
  parseDistanceMeters,
  parseEveUniversityMission,
  splitNames,
  stripTags,
};
