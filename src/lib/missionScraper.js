/**
 * missionScraper.js
 *
 * On-demand scraper for community mission databases. Lives entirely in this utility; it is only
 * invoked when the user explicitly asks (CLI or Import button). EveJS never scrapes.
 *
 * Primary source: eve-survival.org (WikkaWiki). Pages are highly regular:
 *   <h1> The Score, level 1        -> title
 *   "Mission type: Deadspace"      -> space type
 *   "Damage dealt: Kinetic/Thermal"-> damage to deal
 *   "Extras: Jamming from ..."     -> ewar
 *   <h3> Single Pocket             -> room / pocket
 *   <h4> Group 1: (40km)           -> group (distance in parens)
 *   "3x Frigate (Pithi A/Pithi B)" -> spawn line (count, class, candidate names)
 *   <h5> Blitz -> "Kill Group 1 and 2" -> objective groups
 */

const https = require("node:https");

// eve-survival wakka faction suffix -> faction name.
const FACTION_BY_SUFFIX = {
  an: "Angel Cartel",
  bl: "Blood Raiders",
  gu: "Guristas",
  sa: "Sansha's Nation",
  se: "Serpentis",
  ro: "Rogue Drones",
  me: "Mercenaries",
  am: "Amarr",
  ca: "Caldari",
  kk: "Caldari",
  ga: "Gallente",
  mi: "Minmatar",
  at: "Angel Cartel",
};

const SHIP_CLASSES = [
  "Frigate", "Destroyer", "Cruiser", "Battlecruiser", "Battleship",
  "Hauler", "Industrial", "Dreadnought", "Carrier", "Titan", "Capital",
  "Sentry", "Drone", "Structure",
];

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { "User-Agent": "EveAnomUtility/0.1 (+local content authoring)" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(httpsGet(new URL(res.headers.location, url).toString()));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
      },
    );
    request.on("error", reject);
    request.setTimeout(20000, () => request.destroy(new Error(`Timeout fetching ${url}`)));
  });
}

function wakkaFromUrl(url) {
  const match = String(url || "").match(/[?&]wakka=([A-Za-z0-9_]+)/);
  return match ? match[1] : "";
}

function eveSurvivalUrl(wakka) {
  return `https://eve-survival.org/?wakka=${encodeURIComponent(wakka)}`;
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

function stripTags(value) {
  return decodeEntities(String(value || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

// Turn the page HTML into an ordered list of { kind: "h1".."h6"|"text", text }.
function tokenize(html) {
  // Cut from the first <h1 to the comments/footer to avoid nav chrome.
  const startIdx = html.search(/<h1[\s>]/i);
  let body = startIdx >= 0 ? html.slice(startIdx) : html;
  const endIdx = body.search(/<div[^>]*class="(commentsContainer|footer)"|id="footer"/i);
  if (endIdx > 0) body = body.slice(0, endIdx);

  // Mark headings, then convert line breaks/paragraphs to newlines.
  body = body.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, level, inner) => `\nH${level}${stripTags(inner)}\n`);
  body = body.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<\/li>/gi, "\n").replace(/<li[^>]*>/gi, "\n");

  const tokens = [];
  for (const rawLine of body.split(/\n/)) {
    const headingMatch = rawLine.match(/^H([1-6])(.*)$/);
    if (headingMatch) {
      tokens.push({ kind: `h${headingMatch[1]}`, text: headingMatch[2].trim() });
      continue;
    }
    const text = stripTags(rawLine);
    if (text) tokens.push({ kind: "text", text });
  }
  return tokens;
}

function parseDistanceMeters(text) {
  const match = String(text || "").match(/\(?\s*(\d+)\s*(?:-\s*(\d+)\s*)?km/i);
  if (!match) return null;
  const min = Number(match[1]) * 1000;
  const max = match[2] ? Number(match[2]) * 1000 : min;
  return { minMeters: min, maxMeters: max, raw: match[0].trim() };
}

const NPC_HULL_CLASSES = new Set([
  "frigate", "destroyer", "cruiser", "battlecruiser", "battleship",
  "dreadnought", "carrier", "titan", "capital", "drone", "sentry",
  "elite frigate", "elite cruiser", "heavy assault", "officer",
]);

// "3x Frigate (Pithi Saboteur/Pithi Despoiler)" -> { count, shipClass, shipNames, entityKind }
function parseSpawnLine(text) {
  const match = String(text).match(/^(\d+)\s*x?\s+([A-Za-z][A-Za-z .\/-]*?)\s*\(([^)]+)\)\s*$/);
  if (!match) return null;
  const count = Number(match[1]) || 1;
  const shipClass = match[2].trim();
  const shipNames = match[3].split("/").map((s) => s.trim()).filter(Boolean);
  // NPC if the hull class is a recognised ship class (singular or plural); else a structure/prop.
  const cls = shipClass.toLowerCase();
  const isNpc = NPC_HULL_CLASSES.has(cls) || NPC_HULL_CLASSES.has(cls.replace(/s$/, ""));
  return { count, shipClass, shipNames, entityKind: isNpc ? "npc" : "structure" };
}

// "Kill Group 1 and 2" / "Groups 1, 2 and 3" -> [1, 2, ...]
function parseBlitzGroups(blitzText) {
  const idx = String(blitzText || "").search(/group/i);
  if (idx < 0) return [];
  const segment = blitzText.slice(idx);
  return [...new Set((segment.match(/\b(\d{1,2})\b/g) || []).map(Number).filter((n) => n >= 1 && n <= 12))];
}

function metaLine(tokens, label) {
  const found = tokens.find((t) => t.kind === "text" && new RegExp(`^${label}\\s*:`, "i").test(t.text));
  return found ? found.text.replace(new RegExp(`^${label}\\s*:\\s*`, "i"), "").trim() : "";
}

function parseEveSurvival(html, wakka = "") {
  const tokens = tokenize(html);
  const title = (tokens.find((t) => t.kind === "h1") || {}).text || (wakka || "Mission");
  const levelMatch = title.match(/level\s*(\d)/i);
  const suffix = (wakka.match(/([a-z]{2})\d*$/i) || [])[1];
  const faction = metaLine(tokens, "Faction") || FACTION_BY_SUFFIX[String(suffix || "").toLowerCase()] || "";

  const rooms = [];
  const structures = [];
  let currentRoom = null;
  let currentGroup = null;
  let section = "spawns"; // spawns | structures | blitz | other
  let blitzText = "";

  for (const token of tokens) {
    if (token.kind === "h3") {
      currentRoom = { title: token.text, gateHint: /gate|accel/i.test(token.text) ? token.text : null, groups: [] };
      rooms.push(currentRoom);
      currentGroup = null;
      section = "spawns";
      continue;
    }
    if (token.kind === "h4") {
      if (!currentRoom) { currentRoom = { title: "Pocket", gateHint: null, groups: [] }; rooms.push(currentRoom); }
      currentGroup = { title: token.text, distance: parseDistanceMeters(token.text), spawns: [], objective: false };
      currentRoom.groups.push(currentGroup);
      section = "spawns";
      continue;
    }
    if (token.kind === "h5" || token.kind === "h6") {
      const t = token.text.toLowerCase();
      section = /blitz/.test(t) ? "blitz" : /structure/.test(t) ? "structures" : "other";
      continue;
    }
    if (token.kind !== "text") continue;

    if (section === "blitz") { blitzText += ` ${token.text}`; continue; }
    const spawn = parseSpawnLine(token.text);
    if (!spawn) continue;
    if (section === "structures" || spawn.entityKind === "structure") {
      structures.push(spawn);
      continue;
    }
    if (!currentGroup) {
      // spawns before any group heading -> implicit single group in the room
      if (!currentRoom) { currentRoom = { title: "Pocket", gateHint: null, groups: [] }; rooms.push(currentRoom); }
      currentGroup = { title: "Group 1", distance: null, spawns: [], objective: false };
      currentRoom.groups.push(currentGroup);
    }
    currentGroup.spawns.push(spawn);
  }

  // Blitz "Kill Group 1 and 2" -> objective flags.
  const blitzGroups = parseBlitzGroups(blitzText);
  if (blitzGroups.length) {
    let groupIndex = 0;
    for (const room of rooms) {
      for (const group of room.groups) {
        groupIndex += 1;
        const num = (group.title.match(/group\s*(\d+)/i) || [])[1];
        if (num && blitzGroups.includes(Number(num))) group.objective = true;
        else if (!num && blitzGroups.includes(groupIndex)) group.objective = true;
      }
    }
  } else {
    // No blitz -> all groups are objectives (kill everything).
    rooms.forEach((room) => room.groups.forEach((group) => { group.objective = true; }));
  }

  return {
    source: "eve-survival",
    wakka,
    url: wakka ? eveSurvivalUrl(wakka) : "",
    title,
    faction,
    level: levelMatch ? Number(levelMatch[1]) : null,
    spaceType: metaLine(tokens, "Mission type"),
    damageToDeal: metaLine(tokens, "Damage dealt") || metaLine(tokens, "Damage to deal"),
    ewar: metaLine(tokens, "Extras") || metaLine(tokens, "EWAR"),
    recommendedShip: metaLine(tokens, "Recommended ship class") || metaLine(tokens, "Recommended ship"),
    blitz: blitzText.trim(),
    // Best-effort detection hint (NOT a decision): a room heading mentioning a gate/acceleration
    // implies a gated deadspace pocket. eve-survival omits this for single-pocket missions, so the
    // template builder treats combat missions as gated by default; this only nudges the heuristic.
    gateDetected: rooms.some((room) => !!room.gateHint),
    rooms,
    structures,
  };
}

async function scrapeEveSurvival(input) {
  const wakka = /^https?:/i.test(input) ? wakkaFromUrl(input) : String(input || "").trim();
  if (!wakka) throw new Error(`Could not determine eve-survival wakka from "${input}".`);
  const html = await httpsGet(eveSurvivalUrl(wakka));
  return parseEveSurvival(html, wakka);
}

module.exports = {
  SHIP_CLASSES,
  FACTION_BY_SUFFIX,
  eveSurvivalUrl,
  wakkaFromUrl,
  parseEveSurvival,
  scrapeEveSurvival,
  tokenize,
  parseSpawnLine,
};
