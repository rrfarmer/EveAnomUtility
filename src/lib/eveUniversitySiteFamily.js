const fs = require("node:fs");
const path = require("node:path");
const cheerio = require("cheerio");

const { WORKSPACE_ROOT } = require("./dataStore");
const { getCatalog } = require("./catalog");

const DEFAULT_SITE_FAMILY_CACHE_DIR = path.join(WORKSPACE_ROOT, "eve-site-families", "eve-university");
const DEFAULT_LINK_MANIFEST = path.join(DEFAULT_SITE_FAMILY_CACHE_DIR, "manifests", "site-family-links.json");

const MAX_PROCEDURAL_ENCOUNTER_AMOUNT = 8;
const MAX_MINING_ROCKS_PER_RESOURCE = 60;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeText(value, fallback = "") {
  const text = String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[']/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sanitizeID(value, fallback = "site") {
  const safe = normalizeText(value)
    .replace(/&/g, "and")
    .replace(/[^A-Za-z0-9_.()!-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return safe || fallback;
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = normalizeText(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function uniqueSortedInts(values) {
  return [...new Set((values || [])
    .map((value) => Math.trunc(Number(value) || 0))
    .filter((value) => value > 0))]
    .sort((left, right) => left - right);
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function parseNumber(value, fallback = 0) {
  const text = normalizeText(value);
  if (!text || text === "?") return fallback;
  const match = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return fallback;
  const numeric = Number(match[0]);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseCountRange(value) {
  const text = normalizeText(value).replace(/,/g, "");
  const match = text.match(/(\d+)\s*(?:-\s*(\d+))?/);
  if (!match) return { min: 0, max: 0 };
  const first = toInt(match[1], 0);
  const second = match[2] ? toInt(match[2], first) : first;
  return {
    min: Math.min(first, second),
    max: Math.max(first, second),
  };
}

function pageKeyFromUrl(url) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return decodeURIComponent(last || "");
  } catch (_error) {
    return "";
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (fallback !== null) return fallback;
    throw error;
  }
}

function readSiteFamilyManifest(cacheDir = DEFAULT_SITE_FAMILY_CACHE_DIR) {
  const manifestPath = path.join(cacheDir, "manifests", "site-family-links.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Eve University site-family manifest not found: ${manifestPath}`);
  }
  const manifest = readJson(manifestPath);
  const records = Array.isArray(manifest) ? manifest : manifest.records;
  if (!Array.isArray(records)) {
    throw new Error(`Eve University site-family manifest has no records array: ${manifestPath}`);
  }
  return {
    manifestPath,
    manifest,
    records,
  };
}

function buildPageMetadataIndex(cacheDir) {
  const metadataDir = path.join(cacheDir, "metadata", "pages");
  const byUrl = new Map();
  const byTitle = new Map();
  const byPageKey = new Map();
  if (!fs.existsSync(metadataDir)) return { byUrl, byTitle, byPageKey };
  for (const entry of fs.readdirSync(metadataDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(metadataDir, entry.name);
    const metadata = readJson(filePath, null);
    if (!metadata || typeof metadata !== "object") continue;
    metadata.metadataPath = filePath;
    const url = normalizeText(metadata.url);
    const finalUrl = normalizeText(metadata.final_url);
    const title = normalizeText(metadata.title);
    const pageKey = normalizeText(metadata.page_key);
    if (url) byUrl.set(url, metadata);
    if (finalUrl) byUrl.set(finalUrl, metadata);
    if (title) byTitle.set(normalizeKey(title), metadata);
    if (pageKey) byPageKey.set(normalizeKey(pageKey), metadata);
  }
  return { byUrl, byTitle, byPageKey };
}

function resolveCachedRawPath(cacheDir, record, metadataIndex) {
  const url = normalizeText(record && record.url);
  const title = normalizeText(record && record.title);
  const pageKey = normalizeText(pageKeyFromUrl(url));
  const metadata =
    (url && metadataIndex.byUrl.get(url)) ||
    (title && metadataIndex.byTitle.get(normalizeKey(title))) ||
    (pageKey && metadataIndex.byPageKey.get(normalizeKey(pageKey))) ||
    null;
  if (metadata && metadata.raw_path) {
    const rawPath = path.resolve(cacheDir, metadata.raw_path);
    if (fs.existsSync(rawPath)) return { rawPath, metadata };
  }
  const guessed = path.join(cacheDir, "raw", "pages", `${sanitizeID(pageKey || title)}.html`);
  return {
    rawPath: fs.existsSync(guessed) ? guessed : null,
    metadata,
  };
}

function elementText($, element) {
  return normalizeText($(element).text());
}

function tableClass($, table) {
  return normalizeText($(table).attr("class")).toLowerCase();
}

function isNavboxTable($, table) {
  const cls = tableClass($, table);
  return /navbox|metadata|nowraplinks/.test(cls);
}

function getRowCellTexts($, row) {
  return $(row).find("th,td").map((_index, cell) => elementText($, cell)).get();
}

function headerIndex(headers, patterns) {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
}

function extractInfoboxDetails($) {
  const details = {};
  const infobox = $("table.infobox").first();
  if (!infobox.length) return details;
  infobox.find("tr").each((_rowIndex, row) => {
    const cells = getRowCellTexts($, row);
    if (cells.length < 2) return;
    const key = normalizeText(cells[0]).replace(/:$/, "");
    const value = normalizeText(cells.slice(1).join(" "));
    if (!key || !value || key === value) return;
    details[key] = value;
  });
  return details;
}

function extractPageTitle($, record) {
  return normalizeText($("h1").first().text()) || normalizeText(record && record.title) || pageKeyFromUrl(record && record.url);
}

function extractPlainText($) {
  const root = $("#mw-content-text").length ? $("#mw-content-text") : $("body");
  root.find("script,style,noscript,table.navbox,.mw-editsection").remove();
  return normalizeText(root.text());
}

function categorySet(record) {
  return new Set([
    ...(Array.isArray(record && record.source_categories) ? record.source_categories : []),
    ...(Array.isArray(record && record.root_categories) ? record.root_categories : []),
  ].map((entry) => normalizeText(entry)));
}

function hasCategory(categories, pattern) {
  return [...categories].some((category) => pattern.test(category));
}

function classifySite(record, details, title) {
  const categories = categorySet(record);
  const lowerTitle = normalizeText(title).toLowerCase();
  let siteFamily = "unknown";
  let siteKind = "signature";

  if (hasCategory(categories, /ice belts/i)) {
    siteFamily = "ice";
    siteKind = "anomaly";
  } else if (hasCategory(categories, /ore sites|rare ore sites|removed ore sites|sovereignty hub ore deposits/i)) {
    siteFamily = "ore";
    siteKind = "anomaly";
  } else if (hasCategory(categories, /gas sites/i)) {
    siteFamily = "gas";
    siteKind = "signature";
  } else if (hasCategory(categories, /data sites/i)) {
    siteFamily = "data";
    siteKind = "signature";
  } else if (hasCategory(categories, /relic sites/i)) {
    siteFamily = "relic";
    siteKind = "signature";
  } else if (hasCategory(categories, /chemical labs/i)) {
    siteFamily = "combat_hacking";
    siteKind = "signature";
  } else if (hasCategory(categories, /incursions sites/i)) {
    siteFamily = "combat";
    siteKind = "anomaly";
  } else if (hasCategory(categories, /expeditions/i)) {
    siteFamily = "combat";
    siteKind = "escalation";
  } else if (hasCategory(categories, /combat anomalies/i)) {
    siteFamily = "combat";
    siteKind = "anomaly";
  } else if (hasCategory(categories, /ded complexes|unrated complexes|wormhole sites/i)) {
    siteFamily = "combat";
    siteKind = "signature";
  } else if (/abyssal/.test(lowerTitle)) {
    siteFamily = "combat";
    siteKind = "signature";
  }

  const type = normalizeText(details.Type).toLowerCase();
  if (/combat anomaly/.test(type)) siteKind = "anomaly";
  if (/ded|unrated|chemical|data|relic|gas/.test(type)) siteKind = "signature";

  const scopeTags = [];
  if (hasCategory(categories, /wormhole sites/i) || /wormhole/.test(lowerTitle)) scopeTags.push("wormhole");
  if (hasCategory(categories, /incursions sites/i) || /incursion/.test(lowerTitle)) scopeTags.push("incursion");
  if (hasCategory(categories, /expeditions/i)) scopeTags.push("expedition");
  if (/abyssal/.test(lowerTitle)) scopeTags.push("abyssal");

  return {
    siteFamily,
    siteKind,
    scopeTags: uniqueStrings(scopeTags),
    sourceCategories: [...categories].sort(),
  };
}

function parseDifficulty(details) {
  const rating = normalizeText(details.Rating || details.DED || details.Difficulty);
  const ded = rating.match(/(\d+)\s*\/\s*10/);
  if (ded) return toInt(ded[1], 0);
  const classMatch = rating.match(/class\s*(\d+)/i);
  if (classMatch) return toInt(classMatch[1], 0);
  const levelMatch = rating.match(/level\s*(\d+)/i);
  if (levelMatch) return toInt(levelMatch[1], 0);
  return null;
}

function parseSecurityBands(details) {
  const found = normalizeText(details["Found in"] || details.Security || details.Location).toLowerCase();
  const bands = [];
  if (/high/.test(found)) bands.push("highsec");
  if (/low/.test(found)) bands.push("lowsec");
  if (/null|0\.0/.test(found)) bands.push("nullsec");
  if (/wormhole/.test(found)) bands.push("wormhole");
  return uniqueStrings(bands);
}

function cleanResourceName(value) {
  return normalizeText(value)
    .replace(/\([^)]*\)/g, "")
    .replace(/\bsec(?:urity)?\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isExcludedItemName(name) {
  return /blueprint|compressed|batch compressed|mining crystal|non-interactable/i.test(name);
}

function resourceKindMatches(row, kind) {
  const groupID = toInt(row && row.groupID, 0);
  const categoryID = toInt(row && row.categoryID, 0);
  if (kind === "gas") return categoryID === 2 && (groupID === 711 || groupID === 4168 || /fullerite|mykoserocin|cytoserocin/i.test(row.name || row.typeName || ""));
  if (kind === "ice") return categoryID === 25 && groupID === 465;
  if (kind === "ore") return categoryID === 25 && groupID !== 465;
  return true;
}

function buildItemNameIndex(catalog) {
  const exact = new Map();
  for (const [typeID, row] of catalog.itemTypesByID || new Map()) {
    const name = normalizeText(row && (row.name || row.typeName));
    if (!name || isExcludedItemName(name)) continue;
    const key = normalizeKey(name);
    if (!exact.has(key)) exact.set(key, []);
    exact.get(key).push({ typeID: toInt(typeID, 0), name, row });
  }
  return { exact };
}

function resolveResourceType(name, kind, itemIndex) {
  const cleaned = cleanResourceName(name);
  const keys = [normalizeKey(cleaned), normalizeKey(name)].filter(Boolean);
  const attempts = [];
  for (const key of keys) {
    const matches = (itemIndex.exact.get(key) || []).filter((entry) => resourceKindMatches(entry.row, kind));
    if (matches.length > 0) {
      const selected = matches.sort((left, right) => left.typeID - right.typeID)[0];
      return {
        typeID: selected.typeID,
        typeName: selected.name,
        resolvedFrom: selected.name === cleaned ? "exact" : "cleaned_exact",
      };
    }
    attempts.push(key);
  }

  const tokens = normalizeKey(cleaned).split(" ").filter(Boolean);
  for (let start = 1; start < tokens.length; start += 1) {
    const suffix = tokens.slice(start).join(" ");
    const matches = (itemIndex.exact.get(suffix) || []).filter((entry) => resourceKindMatches(entry.row, kind));
    if (matches.length > 0) {
      const selected = matches.sort((left, right) => left.typeID - right.typeID)[0];
      return {
        typeID: selected.typeID,
        typeName: selected.name,
        resolvedFrom: "base_resource_fallback",
        requestedName: cleaned,
      };
    }
  }

  return {
    typeID: null,
    typeName: cleaned || normalizeText(name),
    unresolved: true,
    attemptedKeys: attempts,
  };
}

function inferResourceKind(siteFamily, headerText, resourceName) {
  const combined = `${siteFamily} ${headerText} ${resourceName}`.toLowerCase();
  if (/gas|fullerite|mykoserocin|cytoserocin/.test(combined)) return "gas";
  if (/ice|icicle|glaze|glitter|crust|gelidus|krystallos|mass/.test(combined)) return "ice";
  return "ore";
}

function parseResourceTables($, catalog, classification) {
  const itemIndex = buildItemNameIndex(catalog);
  const resources = [];
  const gaps = [];
  $("table").each((_tableIndex, table) => {
    if (isNavboxTable($, table)) return;
    const rows = $(table).find("tr").toArray();
    if (rows.length <= 1) return;
    const headers = getRowCellTexts($, rows[0]).map((entry) => normalizeKey(entry));
    const headerText = headers.join(" ");
    const typeIndex = headerIndex(headers, [/ore type/, /gas type/, /ice type/, /^type$/]);
    const countIndex = headerIndex(headers, [/asteroids/, /^count$/, /clouds/]);
    const quantityIndex = headerIndex(headers, [/ore quantity/, /^units$/, /quantity/]);
    const unitVolumeIndex = headerIndex(headers, [/m per unit/, /m3 per unit/, /unit volume/]);
    const totalVolumeIndex = headerIndex(headers, [/m total/, /total m/, /m3 total/, /total volume/]);
    if (typeIndex < 0 || !/(ore type|gas type|ice type|asteroids|units)/.test(headerText)) return;

    for (const row of rows.slice(1)) {
      const cells = getRowCellTexts($, row);
      if (cells.length <= typeIndex) continue;
      const rawName = normalizeText(cells[typeIndex]);
      const name = cleanResourceName(rawName);
      if (!name || /total|ore type|gas type|ice type/i.test(name)) continue;
      const kind = inferResourceKind(classification.siteFamily, headerText, name);
      const countValue = countIndex >= 0 ? parseNumber(cells[countIndex], 0) : 0;
      const quantityValue = quantityIndex >= 0 ? parseNumber(cells[quantityIndex], 0) : 0;
      const count = Math.max(1, Math.min(
        MAX_MINING_ROCKS_PER_RESOURCE,
        toInt(countValue, 0) || (kind === "gas" ? Math.ceil(Math.max(1, quantityValue) / 3000) : 1),
      ));
      const totalQuantity = Math.max(0, toInt(quantityValue, 0));
      const unitVolume = unitVolumeIndex >= 0 ? parseNumber(cells[unitVolumeIndex], 0) : 0;
      const totalVolume = totalVolumeIndex >= 0 ? parseNumber(cells[totalVolumeIndex], 0) : 0;
      const resolved = resolveResourceType(name, kind, itemIndex);
      if (resolved.unresolved) {
        gaps.push(`resource_unresolved:${name}`);
      }
      resources.push({
        name,
        rawName,
        kind,
        typeID: resolved.typeID || null,
        typeName: resolved.typeName || name,
        resolvedFrom: resolved.resolvedFrom || null,
        requestedName: resolved.requestedName || null,
        count,
        totalQuantity,
        quantityPerRock: Math.max(1, Math.ceil((totalQuantity || count) / count)),
        unitVolume,
        totalVolume,
        sourceTableHeaders: headers,
      });
    }
  });
  return { resources, gaps };
}

function nearestHeadingText($, element) {
  const heading = $(element).prevAll("h2,h3,h4").first();
  return normalizeText(heading.text().replace(/\[edit\]/ig, ""));
}

const SHIP_CLASSES = [
  "Commander Battleship",
  "Commander Battlecruiser",
  "Commander Cruiser",
  "Commander Frigate",
  "Elite Battleship",
  "Elite Battlecruiser",
  "Elite Cruiser",
  "Elite Frigate",
  "Sentry Tower",
  "Missile Battery",
  "Cruise Missile Battery",
  "Heavy Missile Battery",
  "Light Missile Battery",
  "Battleship",
  "Battlecruiser",
  "Destroyer",
  "Cruiser",
  "Frigate",
  "Sentry",
  "Tower",
  "Drone",
  "Industrial",
  "Structure",
  "Acceleration Gate",
].sort((left, right) => right.length - left.length);

function extractSpawnCellText(cells) {
  const countPattern = /\d+\s*(?:-\s*\d+)?\s*x\b/i;
  return cells.find((cell) => countPattern.test(cell) && cell.length < 260) ||
    cells.find((cell) => countPattern.test(cell)) ||
    "";
}

function splitCandidateNames(value) {
  const cleaned = normalizeText(value)
    .replace(/\.\.\.$/, "")
    .replace(/\s+\.\.\.$/, "");
  return uniqueStrings(cleaned
    .split(/\s*(?:\/|,|\bor\b)\s*/i)
    .map((part) => part.replace(/\.\.\./g, "").trim())
    .filter((part) => part && !/^\.\.\.$/.test(part)));
}

function parseSpawnLine(line) {
  const text = normalizeText(line);
  const match = text.match(/(\d+)\s*(?:-\s*(\d+))?\s*x\s+(.+)/i);
  if (!match) return null;
  const min = toInt(match[1], 0);
  const max = match[2] ? toInt(match[2], min) : min;
  let remainder = normalizeText(match[3]);
  if (!remainder) return null;
  const shipClass = SHIP_CLASSES.find((candidate) =>
    remainder.toLowerCase().startsWith(candidate.toLowerCase()));
  if (shipClass) {
    remainder = normalizeText(remainder.slice(shipClass.length));
  }
  const label = shipClass || "Hostile";
  const entityKind = /^acceleration gate$/i.test(label) || /\bacceleration gate\b/i.test(`${label} ${remainder}`)
    ? "gate"
    : /sentry|tower|battery|structure|bunker|depot|habitat|station|container/i.test(`${label} ${remainder}`)
      ? "structure"
      : "npc";
  const tags = [];
  if (/scram|warp disrupt|point/i.test(text)) tags.push("warp_disrupt");
  if (/\bweb\b|stasis/i.test(text)) tags.push("web");
  if (/neut|neutraliz/i.test(text)) tags.push("energy_neutralizer");
  if (/jam|ecm/i.test(text)) tags.push("ecm");
  if (/damp/i.test(text)) tags.push("sensor_dampener");
  if (/tracking disrupt/i.test(text)) tags.push("tracking_disruptor");
  if (min <= 0) tags.push("optional");
  return {
    raw: text,
    count: { min: Math.min(min, max), max: Math.max(min, max) },
    label,
    shipClass: label,
    candidateNames: splitCandidateNames(remainder),
    entityKind,
    tags,
  };
}

function tableLooksNpc($, table) {
  if (isNavboxTable($, table)) return false;
  const cls = tableClass($, table);
  if (/\bnpc\b/.test(cls)) return true;
  const firstRows = $(table).find("tr").slice(0, 4).map((_index, row) =>
    getRowCellTexts($, row).join(" "),
  ).get().join(" ");
  return /\d+\s*(?:-\s*\d+)?\s*x\b/i.test(firstRows) &&
    !/ore type|gas type|ice type|asteroids|m3 total|m³ total/i.test(firstRows);
}

function parseNpcTables($, title, classification) {
  const roomsByKey = new Map();
  const gates = [];
  const gaps = [];
  let tableCounter = 0;
  $("table").each((_tableIndex, table) => {
    if (!tableLooksNpc($, table)) return;
    const rows = $(table).find("tr").toArray();
    if (rows.length <= 0) return;
    tableCounter += 1;
    const heading = nearestHeadingText($, table);
    const baseRoomTitle = heading && !/^walkthrough$/i.test(heading) ? heading : "Entry Pocket";
    const roomKey = `room:${sanitizeID(baseRoomTitle).toLowerCase() || "entry"}`;
    if (!roomsByKey.has(roomKey)) {
      roomsByKey.set(roomKey, {
        roomId: roomKey.replace(/^room:/, ""),
        title: baseRoomTitle,
        groups: [],
      });
    }
    const room = roomsByKey.get(roomKey);
    let group = {
      groupId: `group_${room.groups.length + 1}`,
      title: `Wave ${tableCounter}`,
      sourceTableIndex: tableCounter,
      spawns: [],
      notes: [],
    };
    const pushGroup = () => {
      if (group.spawns.length <= 0) return;
      room.groups.push(group);
      group = {
        groupId: `group_${room.groups.length + 1}`,
        title: `Wave ${tableCounter}.${room.groups.length + 1}`,
        sourceTableIndex: tableCounter,
        spawns: [],
        notes: [],
      };
    };

    for (const row of rows) {
      const cells = getRowCellTexts($, row);
      if (cells.length <= 0) continue;
      const rowText = normalizeText(cells.join(" "));
      if (!rowText || /WD\s+EWAR\s+L/i.test(rowText)) continue;
      const spawnCellText = extractSpawnCellText(cells);
      if (!spawnCellText) {
        if (/^wave\b|^spawn\b|^room\b|^group\b|rare spawn/i.test(rowText)) {
          pushGroup();
          group.title = rowText.slice(0, 80);
        }
        continue;
      }
      const spawn = parseSpawnLine(spawnCellText);
      if (!spawn) continue;
      if (spawn.entityKind === "gate") {
        gates.push({
          gateKey: `gate:${gates.length + 1}`,
          label: "Acceleration Gate",
          typeID: 17831,
          typeNameCandidates: ["Acceleration Gate"],
          source: "eve_university_site_family",
          destinationRoomKey: roomKey,
          sourceEvidence: spawn.raw,
        });
        continue;
      }
      group.spawns.push(spawn);
    }
    pushGroup();
  });

  const rooms = [...roomsByKey.values()].filter((room) => room.groups.length > 0);
  if (rooms.length <= 0 && classification.siteFamily === "combat") {
    gaps.push("no_npc_tables_found");
  }
  return { rooms, gates, gaps };
}

function inferFactionFromText(value) {
  const text = normalizeText(value).toLowerCase();
  if (/angel|gist|domination/.test(text)) return "angel";
  if (/blood|corpi|corpum|corpatis|dark blood/.test(text)) return "blood";
  if (/sansha|centii|centior|centum|centus|true sansha/.test(text)) return "sansha";
  if (/guristas|pithi|pithum|pithatis|pith|dread guristas/.test(text)) return "guristas";
  if (/serpentis|coreli|corelum|corelatis|shadow serpentis/.test(text)) return "serpentis";
  if (/rogue drone|drone|alvi|infestor|defeater|crippler/.test(text)) return "rogue_drone";
  if (/sleeper|emergent|awakened|sleepless/.test(text)) return "sleeper";
  if (/triglavian|damavik|vedmak|leshak|kikimora|drekavac|conduit/.test(text)) return "triglavian";
  return "";
}

function inferFaction(parsed) {
  const texts = [
    parsed.title,
    ...(parsed.classification.sourceCategories || []),
    parsed.plainText.slice(0, 3000),
  ];
  for (const room of parsed.rooms || []) {
    for (const group of room.groups || []) {
      for (const spawn of group.spawns || []) {
        texts.push(spawn.raw, ...(spawn.candidateNames || []));
      }
    }
  }
  for (const text of texts) {
    const faction = inferFactionFromText(text);
    if (faction) return faction;
  }
  return "";
}

function spawnQueryForFaction(faction, classification, group) {
  const groupText = normalizeText([
    group && group.title,
    ...((group && group.spawns) || []).map((spawn) => spawn.raw),
  ].join(" ")).toLowerCase();
  if (/sentry|tower|battery/.test(groupText) && !/(frigate|cruiser|battle|destroyer)/.test(groupText)) {
    return "destructible_sentry_guns_hostiles";
  }
  if (classification.scopeTags.includes("incursion")) return "incursion_sansha_hostiles";
  if (classification.scopeTags.includes("abyssal")) return "abyssal_entities_hostiles";
  if (faction === "sleeper") return "advanced_pve_entities_hostiles";
  if (faction === "triglavian") return "irregular_entities_hostiles";
  if (faction === "rogue_drone") {
    return classification.siteKind === "anomaly" ? "rogue_drones" : "rogue_drones_deadspace_pve";
  }
  const deadspace = classification.siteKind === "signature" || classification.siteKind === "escalation";
  const map = {
    angel: deadspace ? "angels_deadspace_pve" : "angels",
    blood: deadspace ? "blood_deadspace_pve" : "blood",
    sansha: deadspace ? "sanshas_deadspace_pve" : "sanshas",
    guristas: deadspace ? "guristas_deadspace_pve" : "guristas",
    serpentis: deadspace ? "serpentis_deadspace_pve" : "serpentis",
  };
  return map[faction] || (deadspace ? "npc_deadspace_pve_hostiles" : "npc_hostiles");
}

function buildEncounters(parsed) {
  const encounters = [];
  const faction = inferFaction(parsed);
  for (const room of parsed.rooms || []) {
    for (const group of room.groups || []) {
      const fullAmount = group.spawns.reduce((total, spawn) => total + Math.max(0, toInt(spawn.count && spawn.count.max, 0)), 0);
      if (fullAmount <= 0) continue;
      const index = encounters.length;
      encounters.push({
        key: `wave_${String(index + 1).padStart(2, "0")}`,
        label: group.title || `Wave ${index + 1}`,
        supported: true,
        spawnQuery: spawnQueryForFaction(faction, parsed.classification, group),
        amount: Math.min(MAX_PROCEDURAL_ENCOUNTER_AMOUNT, fullAmount),
        sourceAmount: fullAmount,
        capped: fullAmount > MAX_PROCEDURAL_ENCOUNTER_AMOUNT,
        trigger: index === 0 ? "on_load" : "wave_cleared",
        waveIndex: index + 1,
        roomKey: `room:${room.roomId}`,
        sourceGroup: group.groupId,
        notes: group.spawns.map((spawn) => spawn.raw).slice(0, 8),
      });
    }
  }
  return { encounters, faction };
}

function parseTextWaveFallback(parsed) {
  const text = parsed.plainText;
  const waveMatch = text.match(/(\d+)\s+waves?.{0,80}?(\d+)\s*-\s*(\d+)\s+ships?/i);
  if (!waveMatch) return [];
  const waves = Math.min(20, Math.max(1, toInt(waveMatch[1], 1)));
  const amount = Math.min(MAX_PROCEDURAL_ENCOUNTER_AMOUNT, Math.max(1, toInt(waveMatch[3], 1)));
  const faction = inferFaction(parsed);
  const query = spawnQueryForFaction(faction, parsed.classification, { title: parsed.title, spawns: [] });
  return Array.from({ length: waves }, (_unused, index) => ({
    key: `text_wave_${String(index + 1).padStart(2, "0")}`,
    label: `Wave ${index + 1}`,
    supported: true,
    spawnQuery: query,
    amount,
    sourceAmount: toInt(waveMatch[3], amount),
    capped: toInt(waveMatch[3], amount) > amount,
    trigger: index === 0 ? "on_load" : "wave_cleared",
    waveIndex: index + 1,
    roomKey: "room:entry",
    notes: [`Text fallback: ${waveMatch[0]}`],
  }));
}

function buildMiningRocks(resources) {
  return resources
    .filter((resource) => toInt(resource.typeID, 0) > 0 && resource.quantityPerRock > 0 && resource.count > 0)
    .map((resource) => ({
      typeID: resource.typeID,
      oreTypeID: resource.typeID,
      kind: resource.kind,
      label: resource.typeName || resource.name,
      count: resource.count,
      quantity: resource.quantityPerRock,
      source: "eve_university_site_family",
    }));
}

function buildResourceComposition(resources) {
  const oreTypeIDs = [];
  const gasTypeIDs = [];
  const iceTypeIDs = [];
  for (const resource of resources || []) {
    const typeID = toInt(resource && resource.typeID, 0);
    if (!typeID) continue;
    if (resource.kind === "gas") gasTypeIDs.push(typeID);
    else if (resource.kind === "ice") iceTypeIDs.push(typeID);
    else oreTypeIDs.push(typeID);
  }
  const composition = {
    oreTypeIDs: uniqueSortedInts(oreTypeIDs),
    gasTypeIDs: uniqueSortedInts(gasTypeIDs),
    iceTypeIDs: uniqueSortedInts(iceTypeIDs),
  };
  return {
    ...composition,
    hasAnyResources: composition.oreTypeIDs.length > 0 || composition.gasTypeIDs.length > 0 || composition.iceTypeIDs.length > 0,
  };
}

function buildContainers(parsed) {
  const family = parsed.classification.siteFamily;
  if (!["data", "relic", "combat_hacking"].includes(family)) return [];
  const analyzer = family === "relic" ? "relic" : "data";
  const role = family === "combat_hacking" ? "combat_hacking" : analyzer;
  return [{
    role,
    count: family === "combat_hacking" ? 3 : 4,
    analyzer,
    lootProfile: analyzer === "relic" ? "generic_relic_loot" : "generic_data_loot",
    lootTags: analyzer === "relic" ? ["salvage", "relic_material"] : ["datacore", "decryptor", "data_material"],
    hackingDifficulty: parsed.difficulty && parsed.difficulty >= 4 ? "hard" : parsed.difficulty && parsed.difficulty >= 2 ? "medium" : "easy",
  }];
}

function factionDisplayPrefix(faction) {
  const map = {
    angel: "Angel",
    blood: "Blood",
    sansha: "Sansha",
    guristas: "Guristas",
    serpentis: "Serpentis",
    rogue_drone: "Drone",
    sleeper: "Sleeper",
  };
  return map[faction] || "Guristas";
}

function factionStructurePrefix(faction) {
  if (faction === "blood") return "Blood Raider";
  if (faction === "rogue_drone") return "Drone";
  return factionDisplayPrefix(faction);
}

function buildEnvironmentProps(parsed) {
  const family = parsed.classification.siteFamily;
  if (!["combat", "data", "relic", "combat_hacking"].includes(family)) return [];
  const prefix = factionDisplayPrefix(parsed.faction);
  if (family === "combat") {
    const structurePrefix = factionStructurePrefix(parsed.faction);
    return [
      {
        key: "combat_bunker",
        typeNameCandidates: [`${structurePrefix} Bunker`, "Asteroid Colony - Factory", "Habitation Module"],
        label: `${structurePrefix} Bunker`,
        source: "eve_university_site_family",
      },
      {
        key: "combat_lookout",
        typeNameCandidates: [`${structurePrefix} Lookout`, "Asteroid Station", "Asteroid Colony - Small Tower"],
        label: `${structurePrefix} Lookout`,
        source: "eve_university_site_family",
      },
      {
        key: "combat_battery",
        typeNameCandidates: [`${structurePrefix} Battery`, `${structurePrefix} Sentry Gun`, "Angel Battery"],
        label: `${structurePrefix} Battery`,
        source: "eve_university_site_family",
      },
    ];
  }
  if (family === "relic") {
    return [
      {
        key: "relic_debris",
        typeNameCandidates: [`${prefix} Debris`, "Angel Debris", "Ruined Monument"],
        label: `${prefix} Debris`,
        source: "eve_university_site_family",
      },
      {
        key: "relic_rubble",
        typeNameCandidates: [`${prefix} Rubble`, "Angel Rubble", "Ancient Ruins"],
        label: `${prefix} Rubble`,
        source: "eve_university_site_family",
      },
      {
        key: "relic_remains",
        typeNameCandidates: [`${prefix} Remains`, "Angel Remains", "Derelict Station"],
        label: `${prefix} Remains`,
        source: "eve_university_site_family",
      },
    ];
  }
  if (family === "combat_hacking") {
    const labPrefix = parsed.faction === "blood" ? "Blood Raider" : prefix;
    return [{
      key: "chemical_laboratory",
      typeNameCandidates: [`${labPrefix} Chemical Laboratory`, "Guristas Chemical Laboratory", "Angel Chemical Laboratory"],
      label: `${labPrefix} Chemical Laboratory`,
      source: "eve_university_site_family",
    }];
  }
  return [
    {
      key: "data_mainframe",
      typeNameCandidates: [`${prefix} Mainframe`, "Guristas Mainframe"],
      label: `${prefix} Mainframe`,
      source: "eve_university_site_family",
    },
    {
      key: "data_databank",
      typeNameCandidates: [`${prefix} Databank`, "Guristas Databank"],
      label: `${prefix} Databank`,
      source: "eve_university_site_family",
    },
    {
      key: "data_com_tower",
      typeNameCandidates: [`${prefix} Com Tower`, "Guristas Com Tower"],
      label: `${prefix} Communications Tower`,
      source: "eve_university_site_family",
    },
  ];
}

function buildObjectiveMarkers(parsed, resourceComposition, encounters, containers) {
  const family = parsed.classification.siteFamily;
  if (containers.length > 0) {
    const analyzer = containers[0].analyzer || "data";
    return [{
      role: "objective",
      label: analyzer === "relic" ? "Open relic containers" : "Open data containers",
      key: analyzer === "relic" ? "open_relic_containers" : "open_data_containers",
      analyzer,
    }];
  }
  if (family === "ore" || family === "ice") {
    return [{ role: "objective", label: "Extract mineable resources", key: "extract_mineable_resources" }];
  }
  if (family === "gas") {
    return [{ role: "objective", label: "Harvest gas resources", key: "harvest_gas_resources" }];
  }
  if (encounters.length > 0) {
    return [{ role: "objective", label: "Eliminate hostile defenders", key: "eliminate_hostile_defenders" }];
  }
  if (resourceComposition.hasAnyResources) {
    return [{ role: "task", label: "Extract site resources", key: "extract_site_resources" }];
  }
  return [];
}

function buildCompletion(parsed, encounters, miningRocks, containers) {
  if (encounters.length > 0 && parsed.classification.siteFamily === "combat") {
    return {
      mode: "encounter_groups_cleared",
      completeObjectiveOnEncounterClear: true,
      fallback: "clear_all_hostiles",
      despawnDelaySeconds: 0,
    };
  }
  if (containers.length > 0) {
    return {
      mode: "containers_hacked",
      fallback: "open_site_containers",
    };
  }
  if (miningRocks.length > 0) {
    return {
      mode: "resource_depletion",
      fallback: "extract_available_resources",
    };
  }
  if (encounters.length > 0) {
    return {
      mode: "encounter_groups_cleared",
      completeObjectiveOnEncounterClear: true,
      fallback: "clear_all_hostiles",
      despawnDelaySeconds: 0,
    };
  }
  return null;
}

function buildPlayability(parsed, encounters, miningRocks, containers, gaps) {
  const commonGaps = ["exact_positions_missing", "loot_not_exact", "site_specific_triggers_not_exact"];
  if (encounters.length > 0) {
    return {
      playable: true,
      grade: "community_scrape_fallback_combat",
      strategy: "fallback_clear_spawned_encounters",
      source: "eve_university_site_family",
      gaps: uniqueStrings([...commonGaps, ...gaps]),
    };
  }
  if (miningRocks.length > 0) {
    return {
      playable: true,
      grade: "community_scrape_resource_layout",
      strategy: "spawn_mineable_resource_rocks",
      source: "eve_university_site_family",
      gaps: uniqueStrings(["resource_positions_randomized", ...gaps]),
    };
  }
  if (containers.length > 0) {
    return {
      playable: true,
      grade: "community_scrape_hacking_fallback",
      strategy: "spawn_generic_hackable_containers",
      source: "eve_university_site_family",
      gaps: uniqueStrings(["container_count_defaulted", ...commonGaps, ...gaps]),
    };
  }
  return {
    playable: false,
    grade: "unmodeled_site_family_page",
    strategy: "no_spawnable_content_extracted",
    source: "eve_university_site_family",
    gaps: uniqueStrings(["no_spawnable_content_extracted", ...gaps]),
  };
}

function roomProfilesFor(parsed) {
  const rooms = (parsed.rooms || []).length > 0
    ? parsed.rooms
    : [{ roomId: "entry", title: "Entry Pocket", groups: [] }];
  return rooms.map((room, index) => ({
    roomKey: `room:${room.roomId || `room_${index + 1}`}`,
    label: room.title || (index === 0 ? "Entry Pocket" : `Room ${index + 1}`),
    source: "eve_university_site_family",
    initialState: "active",
  }));
}

function roomsForTemplate(parsed) {
  if (!Array.isArray(parsed.rooms) || parsed.rooms.length <= 0) {
    return [{
      roomId: "entry",
      title: "Entry Pocket",
      source: "eve_university_site_family",
      groups: [],
      spawnEntries: [],
    }];
  }
  return parsed.rooms.map((room, roomIndex) => ({
    roomId: room.roomId || `room_${roomIndex + 1}`,
    title: room.title || `Room ${roomIndex + 1}`,
    source: "eve_university_site_family",
    spawnEntries: [],
    groups: (room.groups || []).map((group, groupIndex) => ({
      groupId: group.groupId || `group_${groupIndex + 1}`,
      title: group.title || `Group ${groupIndex + 1}`,
      sourceTableIndex: group.sourceTableIndex || null,
      spawnEntries: (group.spawns || []).map((spawn) => ({
        raw: spawn.raw,
        count: clone(spawn.count),
        entityKind: spawn.entityKind || "npc",
        label: spawn.label || spawn.shipClass || "Hostile",
        shipClass: spawn.shipClass || "",
        candidateNames: uniqueStrings(spawn.candidateNames || []),
        tags: Array.isArray(spawn.tags) ? spawn.tags.slice() : [],
        source: "eve_university_site_family_audit_only",
      })),
      notes: Array.isArray(group.notes) ? group.notes.slice() : [],
    })),
  }));
}

function sourceIndexKeyForTemplate(templateID, template) {
  if (templateID.startsWith("eve-university:")) return "eve-university";
  if (templateID.startsWith("eve-survival:")) return "eve-survival";
  if (templateID.startsWith("client-dungeon:")) return "client";
  return normalizeText(template && template.source, "unknown");
}

function addUnique(indexes, indexName, key, templateID) {
  indexes[indexName] = indexes[indexName] || {};
  indexes[indexName][key] = Array.isArray(indexes[indexName][key]) ? indexes[indexName][key] : [];
  if (!indexes[indexName][key].includes(templateID)) indexes[indexName][key].push(templateID);
  indexes[indexName][key].sort();
}

function refreshDungeonAuthorityMetadata(dungeon) {
  dungeon.templatesByID = dungeon.templatesByID || {};
  dungeon.counts = dungeon.counts || {};
  dungeon.indexes = dungeon.indexes || {};
  dungeon.counts.templateCount = Object.keys(dungeon.templatesByID).length;
  dungeon.counts.eveUniversitySiteFamilyCount = Object.keys(dungeon.templatesByID)
    .filter((templateID) => templateID.startsWith("eve-university:")).length;
  dungeon.indexes.templateIDsBySource = {};
  dungeon.indexes.templateIDsByFamily = {};
  for (const [templateID, template] of Object.entries(dungeon.templatesByID)) {
    addUnique(dungeon.indexes, "templateIDsBySource", sourceIndexKeyForTemplate(templateID, template), templateID);
    addUnique(dungeon.indexes, "templateIDsByFamily", template.siteFamily || "unknown", templateID);
  }
}

function parseSiteFamilyPage(record, html, options = {}) {
  const catalog = options.catalog || getCatalog();
  const $ = cheerio.load(html);
  const title = extractPageTitle($, record);
  const details = extractInfoboxDetails($);
  const classification = classifySite(record, details, title);
  const plainText = extractPlainText($);
  const resourceParse = parseResourceTables($, catalog, classification);
  const npcParse = parseNpcTables($, title, classification);
  const parsed = {
    record: clone(record),
    title,
    url: normalizeText(record && record.url),
    pageKey: sanitizeID(normalizeText(record && record.title) || pageKeyFromUrl(record && record.url)),
    details,
    classification,
    difficulty: parseDifficulty(details),
    securityBands: parseSecurityBands(details),
    resources: resourceParse.resources,
    rooms: npcParse.rooms,
    gates: npcParse.gates,
    plainText,
    gaps: uniqueStrings([...resourceParse.gaps, ...npcParse.gaps]),
  };
  const encounterParse = buildEncounters(parsed);
  parsed.faction = encounterParse.faction;
  parsed.encounters = encounterParse.encounters;
  if (parsed.encounters.length <= 0) {
    const fallback = parseTextWaveFallback(parsed);
    if (fallback.length > 0) {
      parsed.encounters = fallback;
      parsed.rooms = [{ roomId: "entry", title: "Entry Pocket", groups: [] }];
      parsed.gaps = uniqueStrings([...parsed.gaps, "text_wave_fallback"]);
    }
  }
  return parsed;
}

function buildSiteFamilyTemplate(parsed) {
  const classification = parsed.classification || {};
  const templateID = `eve-university:${sanitizeID(parsed.pageKey || parsed.title)}`;
  const resources = Array.isArray(parsed.resources) ? parsed.resources : [];
  const resourceComposition = buildResourceComposition(resources);
  const miningRocks = buildMiningRocks(resources);
  const containers = buildContainers(parsed);
  const environmentProps = buildEnvironmentProps(parsed);
  const encounters = Array.isArray(parsed.encounters) ? parsed.encounters : [];
  const gaps = uniqueStrings([
    ...(Array.isArray(parsed.gaps) ? parsed.gaps : []),
    ...encounters.filter((encounter) => encounter.capped).map((encounter) => `encounter_capped:${encounter.key}`),
  ]);
  const completion = buildCompletion(parsed, encounters, miningRocks, containers);
  const playability = buildPlayability(parsed, encounters, miningRocks, containers, gaps);
  const objectiveMarkers = buildObjectiveMarkers(parsed, resourceComposition, encounters, containers);
  const roomProfiles = roomProfilesFor(parsed);
  return {
    templateID,
    source: "eve-university",
    sourcePriority: 80,
    sourceConfidence: {
      label: "Community Site Family Scrape",
      score: playability.playable ? 55 : 35,
    },
    siteFamily: classification.siteFamily || "unknown",
    siteKind: classification.siteKind || "signature",
    siteOrigin: "eve_university_site_family",
    resolvedName: parsed.title,
    title: parsed.title,
    difficulty: parsed.difficulty,
    securityBands: Array.isArray(parsed.securityBands) ? parsed.securityBands : [],
    sourceUrl: parsed.url,
    faction: parsed.faction || "",
    rooms: roomsForTemplate(parsed),
    gates: Array.isArray(parsed.gates) ? parsed.gates : [],
    connections: (Array.isArray(parsed.gates) ? parsed.gates : []).map((gate, index) => ({
      connectionKey: gate.gateKey || `gate:${index + 1}`,
      gateKey: gate.gateKey || `gate:${index + 1}`,
      destinationRoomKey: gate.destinationRoomKey || "room:entry",
      initialState: "active",
    })),
    resourceComposition,
    populationHints: {
      source: "eve_university_site_family",
      siteFamily: classification.siteFamily || "unknown",
      siteKind: classification.siteKind || "signature",
      encounter: encounters[0] || null,
      encounters,
      completion,
      containers,
      hazards: [],
      environmentProps,
      miningRocks,
      resources: {
        oreTypeIDs: resourceComposition.oreTypeIDs,
        gasTypeIDs: resourceComposition.gasTypeIDs,
        iceTypeIDs: resourceComposition.iceTypeIDs,
      },
      dangerousWarpIn: false,
      safeFromNpc: encounters.length <= 0,
      objectiveMarkers,
      playability,
    },
    siteSceneProfile: {
      source: "eve_university_site_family",
      confidence: {
        label: "Community Site Family Scrape",
        score: playability.playable ? 50 : 25,
      },
      evidence: uniqueStrings([
        parsed.url,
        ...(classification.sourceCategories || []).map((category) => `Category:${category}`),
      ]),
      roomProfiles,
      gateProfiles: Array.isArray(parsed.gates) ? parsed.gates : [],
      structureProfiles: environmentProps,
      objectiveVisualProfiles: objectiveMarkers.map((marker) => ({ ...marker })),
    },
    resourceHints: {
      oreTypesByDungeonIDAvailable: resourceComposition.oreTypeIDs.length > 0,
      gasTypesByDungeonIDAvailable: resourceComposition.gasTypeIDs.length > 0,
      iceTypesByDungeonIDAvailable: resourceComposition.iceTypeIDs.length > 0,
    },
    adminMetadata: {
      authoredBy: "EveAnomUtility",
      authoredAt: new Date().toISOString(),
      parser: "eveUniversitySiteFamily",
      sourceUrl: parsed.url,
      pageTitle: parsed.title,
      pageKey: parsed.pageKey,
      details: parsed.details || {},
      sourceCategories: classification.sourceCategories || [],
      scopeTags: classification.scopeTags || [],
      faction: parsed.faction || "",
      resourceLayout: resources,
      originalEncounterCount: encounters.length,
      originalRooms: roomsForTemplate(parsed),
      gaps,
      playability,
    },
  };
}

function validateSiteFamilyTemplate(template) {
  const errors = [];
  const warnings = [];
  if (!normalizeText(template && template.templateID)) errors.push("templateID is required");
  if (!normalizeText(template && template.siteFamily)) errors.push("siteFamily is required");
  if (!normalizeText(template && template.siteKind)) errors.push("siteKind is required");
  const hints = template && template.populationHints || {};
  const playability = hints.playability || {};
  if (playability.playable !== true) warnings.push(`unplayable:${playability.strategy || "unknown"}`);
  if (Array.isArray(hints.encounters)) {
    for (const encounter of hints.encounters) {
      if (!normalizeText(encounter && encounter.spawnQuery)) warnings.push(`encounter missing spawnQuery: ${encounter && encounter.key}`);
      if (toInt(encounter && encounter.amount, 0) <= 0) warnings.push(`encounter missing amount: ${encounter && encounter.key}`);
    }
  }
  if (Array.isArray(hints.miningRocks)) {
    for (const rock of hints.miningRocks) {
      if (toInt(rock && (rock.typeID || rock.oreTypeID), 0) <= 0) warnings.push("mining rock missing typeID");
      if (toInt(rock && rock.quantity, 0) <= 0) warnings.push("mining rock missing quantity");
    }
  }
  return { ok: errors.length <= 0, errors, warnings };
}

function selectParsedSites(parsedSites, filters = {}) {
  const families = new Set(String(filters.family || filters.families || "")
    .split(",")
    .map((entry) => normalizeText(entry))
    .filter(Boolean));
  const categories = new Set(String(filters.category || filters.categories || "")
    .split(",")
    .map((entry) => normalizeKey(entry))
    .filter(Boolean));
  const pages = new Set(String(filters.page || filters.pages || "")
    .split(",")
    .map((entry) => normalizeKey(entry))
    .filter(Boolean));
  return parsedSites.filter((entry) => {
    if (families.size > 0 && !families.has(entry.parsed.classification.siteFamily)) return false;
    if (categories.size > 0) {
      const sourceCategories = (entry.parsed.classification.sourceCategories || []).map((category) => normalizeKey(category));
      if (![...categories].some((category) => sourceCategories.includes(category))) return false;
    }
    if (pages.size > 0) {
      const candidates = [
        entry.parsed.title,
        entry.parsed.pageKey,
        entry.template.templateID,
        entry.parsed.url,
      ].map((value) => normalizeKey(value));
      if (![...pages].some((page) => candidates.some((candidate) => candidate.includes(page)))) return false;
    }
    return true;
  });
}

function parseSiteFamilyCache(options = {}) {
  const cacheDir = path.resolve(options.cacheDir || DEFAULT_SITE_FAMILY_CACHE_DIR);
  const catalog = options.catalog || getCatalog(options.catalogOptions || {});
  const manifestInfo = readSiteFamilyManifest(cacheDir);
  const metadataIndex = buildPageMetadataIndex(cacheDir);
  const parsedSites = [];
  const missingRaw = [];
  const parseErrors = [];
  for (const record of manifestInfo.records) {
    const raw = resolveCachedRawPath(cacheDir, record, metadataIndex);
    if (!raw.rawPath) {
      missingRaw.push({ title: record.title, url: record.url });
      continue;
    }
    try {
      const html = fs.readFileSync(raw.rawPath, "utf8");
      const parsed = parseSiteFamilyPage(record, html, { catalog });
      parsed.rawPath = raw.rawPath;
      parsed.metadata = raw.metadata || null;
      const template = buildSiteFamilyTemplate(parsed);
      parsedSites.push({ record, parsed, template, rawPath: raw.rawPath });
    } catch (error) {
      parseErrors.push({ title: record.title, url: record.url, error: error.message });
    }
  }
  const selected = selectParsedSites(parsedSites, options);
  const limited = options.limit > 0 ? selected.slice(0, options.limit) : selected;
  return {
    cacheDir,
    manifestPath: manifestInfo.manifestPath,
    manifest: manifestInfo.manifest,
    selected: limited,
    parsedSites,
    missingRaw,
    parseErrors,
  };
}

module.exports = {
  DEFAULT_LINK_MANIFEST,
  DEFAULT_SITE_FAMILY_CACHE_DIR,
  buildSiteFamilyTemplate,
  parseSiteFamilyCache,
  parseSiteFamilyPage,
  readSiteFamilyManifest,
  refreshDungeonAuthorityMetadata,
  validateSiteFamilyTemplate,
};
