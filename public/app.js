const CONTENT_FAMILIES = [
  {
    id: "combat",
    label: "Combat",
    icon: "swords",
    description: "Anomalies, signatures, DED-style complexes, and escalations.",
    deliveries: ["anomaly", "signature", "escalation"],
    defaultDelivery: "anomaly",
  },
  {
    id: "resource",
    label: "Resource",
    icon: "pickaxe",
    description: "Ore, ice, gas, and mining mission pockets.",
    deliveries: ["anomaly", "signature", "mission_private"],
    defaultDelivery: "anomaly",
  },
  {
    id: "hacking",
    label: "Hacking",
    icon: "binary",
    description: "Data, relic, sleeper-cache, and guarded hacking sites.",
    deliveries: ["signature", "escalation"],
    defaultDelivery: "signature",
  },
  {
    id: "wormhole",
    label: "Wormhole",
    icon: "orbit",
    description: "Wormhole connections and wormhole-space sites.",
    deliveries: ["signature", "anomaly"],
    defaultDelivery: "signature",
  },
  {
    id: "special",
    label: "Special",
    icon: "sparkles",
    description: "Ghost, event, pirate hideaway, and unusual limited sites.",
    deliveries: ["signature", "anomaly", "escalation"],
    defaultDelivery: "signature",
  },
  {
    id: "static_world",
    label: "Static World",
    icon: "landmark",
    description: "Permanent authored sites, beacons, landmarks, and COSMOS-style content.",
    deliveries: ["static_beacon", "signature"],
    defaultDelivery: "static_beacon",
  },
  {
    id: "npc_presence",
    label: "NPC Presence",
    icon: "shield",
    description: "CONCORD, faction police, gate guards, startup rules, and response spawns.",
    deliveries: ["startup_rule", "runtime_response"],
    defaultDelivery: "startup_rule",
  },
];

const DELIVERY_OPTIONS = {
  anomaly: { label: "Anomaly", icon: "radar", scanner: "anomaly" },
  signature: { label: "Signature", icon: "scan-search", scanner: "signature" },
  mission_private: { label: "Mission / Private", icon: "lock-keyhole", scanner: "private_mission" },
  static_beacon: { label: "Static Beacon", icon: "radio-tower", scanner: "static" },
  startup_rule: { label: "Startup Rule", icon: "power", scanner: "startup_rule" },
  runtime_response: { label: "Runtime Response", icon: "shield-alert", scanner: "runtime_response" },
  escalation: { label: "Escalation Child", icon: "route", scanner: "escalation" },
};

const state = {
  view: "builder",
  builderStep: "define",
  contentFamily: "combat",
  delivery: "anomaly",
  kind: "combat_anomaly",
  missionType: "combat",
  scopeMode: "any_eligible",
  securityBands: ["highsec", "lowsec", "nullsec", "wormhole"],
  anchorKind: "system",
  selectedSystem: null,
  selectedGate: null,
  baseTemplate: null,
  selectedTemplateRaw: null,
  templateOptions: [],
  templateOptionsRequest: 0,
  rooms: [],
  gates: [],
  encounters: [],
  resources: [],
  npcOverrides: [],
  lootTables: [],
  lootProfiles: [],
  completion: null,
  missionSecurity: null,
  sourceLinks: [],
  lookup: {
    npcProfiles: [],
    npcLoadouts: [],
    npcBehaviors: [],
    npcSpawnGroups: [],
    npcSpawnPools: [],
    npcLootTables: [],
    resources: [],
  },
  loadedOverlayId: "",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function icon(name) {
  return `<i data-lucide="${name}" class="icon" aria-hidden="true"></i>`;
}

function iconText(name, text) {
  return `${icon(name)}<span>${text}</span>`;
}

function hydrateIcons(root = document) {
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons({
      root,
      attrs: {
        class: "icon",
        "aria-hidden": "true",
      },
    });
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || data.errorMsg || `Request failed: ${response.status}`);
  }
  return data;
}

function showNotice(message) {
  const notice = $("#notice");
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => {
    notice.hidden = true;
  }, 5200);
}

function familyByID(id) {
  return CONTENT_FAMILIES.find((family) => family.id === id) || CONTENT_FAMILIES[0];
}

function deliveryLabel(id) {
  return DELIVERY_OPTIONS[id] ? DELIVERY_OPTIONS[id].label : id;
}

function missionTypeLabel(type) {
  return {
    combat: "Security",
    courier: "Courier",
    mining: "Mining",
    trade: "Trade",
    talk_to_agent: "Talk To Agent",
    agent_interaction: "Agent Interaction",
    other: "Other",
  }[type] || type || "Unknown";
}

function smallMeta(parts) {
  return parts.filter((part) => part !== null && part !== undefined && String(part).trim()).join(" - ");
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function rowID(row) {
  return row.profileID || row.loadoutID || row.behaviorProfileID || row.spawnGroupID || row.spawnPoolID || row.lootTableID || row.id || "";
}

function legacyKindFromSelection(contentFamily = state.contentFamily, delivery = state.delivery) {
  if (contentFamily === "combat" && delivery === "anomaly") return "combat_anomaly";
  if (contentFamily === "combat" && delivery === "signature") return "combat_signature";
  if (contentFamily === "resource" && delivery === "anomaly") return "ore_anomaly";
  if (contentFamily === "resource") return "resource_signature";
  if (contentFamily === "mission") return "mission_combat";
  if (contentFamily === "hacking") return "hacking_signature";
  if (contentFamily === "wormhole") return "wormhole_signature";
  if (contentFamily === "static_world") return "static_world";
  if (contentFamily === "npc_presence") return "npc_presence";
  return "special_signature";
}

function contentFamilyFromKind(kind) {
  if (kind === "combat_anomaly" || kind === "combat_signature") return "combat";
  if (kind === "ore_anomaly" || kind === "resource_signature") return "resource";
  if (kind === "mission_combat") return "mission";
  if (kind === "hacking_signature") return "hacking";
  if (kind === "wormhole_signature") return "wormhole";
  if (kind === "static_world") return "static_world";
  if (kind === "npc_presence") return "npc_presence";
  return "special";
}

function deliveryFromKind(kind) {
  if (kind === "combat_anomaly" || kind === "ore_anomaly") return "anomaly";
  if (kind === "mission_combat") return "mission_private";
  if (kind === "static_world") return "static_beacon";
  if (kind === "npc_presence") return "startup_rule";
  if (kind && kind.endsWith("_signature")) return "signature";
  return "signature";
}

function scannerVisibility() {
  return DELIVERY_OPTIONS[state.delivery] ? DELIVERY_OPTIONS[state.delivery].scanner : "anomaly";
}

function defaultCompletionMode() {
  if (state.contentFamily === "resource") return "resources_depleted";
  if (state.contentFamily === "mission") return "mission_objective_complete";
  if (state.contentFamily === "hacking") return "containers_completed";
  if (state.contentFamily === "npc_presence") return "manual_or_runtime";
  return "encounters_cleared";
}

function selectedSecurityBands() {
  return [...document.querySelectorAll("#securityBandControl input:checked")]
    .map((input) => input.value);
}

function shouldShowSystemScope() {
  return (
    state.scopeMode === "specific_system" ||
    state.scopeMode === "specific_stargate" ||
    state.anchorKind === "coordinate"
  );
}

function spawnScopeFromForm() {
  return {
    mode: state.scopeMode,
    securityBands: selectedSecurityBands(),
    maxConcurrentPerSystem: Math.max(1, Number($("#maxPerSystemInput").value) || 1),
    weight: Math.max(0, Number($("#spawnWeightInput").value) || 0),
    respawnMinutes: Math.max(1, Number($("#respawnMinutesInput").value) || 60),
    slotCount: Math.max(1, Number($("#slotCountInput").value) || 1),
    solarSystemID: state.scopeMode === "specific_system" || state.scopeMode === "specific_stargate"
      ? (state.selectedSystem ? state.selectedSystem.solarSystemID : 0)
      : 0,
    stargateID: state.scopeMode === "specific_stargate" && state.selectedGate
      ? state.selectedGate.itemID
      : 0,
  };
}

function inferScopeModeFromOverlay(overlay = {}) {
  if (overlay.spawnScope && overlay.spawnScope.mode) {
    return overlay.spawnScope.mode;
  }
  const placement = overlay.placement || {};
  if (placement.anchorKind === "stargate" && placement.anchorID) {
    return "specific_stargate";
  }
  if (overlay.solarSystemID) {
    return "specific_system";
  }
  return "any_eligible";
}

function setSecurityBandChecks(bands) {
  const selected = new Set(Array.isArray(bands) && bands.length > 0
    ? bands
    : ["highsec", "lowsec", "nullsec", "wormhole"]);
  $$("#securityBandControl input").forEach((input) => {
    input.checked = selected.has(input.value);
  });
}

function scopeHelperText() {
  if (state.scopeMode === "specific_stargate") {
    return "<strong>Specific gate.</strong> This rule only spawns at the selected stargate.";
  }
  if (state.scopeMode === "specific_system") {
    return "<strong>Specific system.</strong> This rule only spawns in the selected solar system.";
  }
  if (state.scopeMode === "security_bands") {
    return "<strong>Security bands.</strong> This rule can spawn in any system matching the checked bands.";
  }
  return "<strong>Any eligible system.</strong> This rule is not tied to one solar system; limits and bands control where it can appear.";
}

function renderSpawnScope() {
  $$("#scopeModeControl button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.scopeMode === state.scopeMode);
  });
  $("#scopeHelper").innerHTML = scopeHelperText();
  $("#systemScopeBlock").hidden = !shouldShowSystemScope();
  if (state.scopeMode === "specific_stargate" && state.anchorKind !== "stargate") {
    state.anchorKind = "stargate";
  }
  $$("#anchorKindControl button").forEach((button) => button.classList.toggle("is-active", button.dataset.anchorKind === state.anchorKind));
}

function setScopeMode(scopeMode) {
  state.scopeMode = scopeMode;
  if (scopeMode === "specific_stargate") {
    state.anchorKind = "stargate";
  }
  renderSpawnScope();
  renderSelectedSystem();
  updatePreview();
}

const VIEW_META = {
  builder: { title: "Site Builder", eyebrow: "Server-side template authoring" },
  missions: { title: "Mission Designer", eyebrow: "Agent mission authoring" },
  systems: { title: "Systems", eyebrow: "Solar system reference" },
  npcs: { title: "NPCs", eyebrow: "Server-side NPC catalog" },
  loot: { title: "Loot Profiles", eyebrow: "Reusable NPC loot tables" },
  pack: { title: "Template Pack", eyebrow: "Generated output for EveJS" },
  research: { title: "Research", eyebrow: "Content customization notes" },
};

function setView(view) {
  state.view = view;
  $$(".nav-button").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  $$(".view").forEach((panel) => panel.classList.toggle("is-active", panel.id === `view-${view}`));
  const meta = VIEW_META[view] || VIEW_META.builder;
  $("#viewTitle").textContent = meta.title;
  $("#viewEyebrow").textContent = meta.eyebrow;
}

const BUILDER_STEPS = ["define", "placement", "contents", "review"];

// Which Contents sections are relevant per content family.
const CONTENTS_SECTIONS = {
  encounters: ["combat", "special", "wormhole"],
  resources: ["resource"],
  npcOverrides: ["combat", "resource", "wormhole", "special", "static_world", "npc_presence"],
  lootTables: ["combat", "hacking", "wormhole", "special", "npc_presence"],
};

function setBuilderStep(step) {
  state.builderStep = BUILDER_STEPS.includes(step) ? step : "define";
  $$("#builderSteps .step-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.step === state.builderStep);
  });
  $$("#view-builder .builder-step").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.stepPanel === state.builderStep);
  });
}

function syncContentsVisibility() {
  let visible = 0;
  $$('#view-builder [data-section]').forEach((block) => {
    const families = CONTENTS_SECTIONS[block.dataset.section] || [];
    const show = families.includes(state.contentFamily);
    block.hidden = !show;
    if (show) visible += 1;
  });
  const empty = $("#contentsEmpty");
  if (empty) empty.hidden = visible > 0;
}

function renderFamilyControl() {
  const container = $("#familyControl");
  container.innerHTML = "";
  CONTENT_FAMILIES.forEach((family) => {
    const button = document.createElement("button");
    button.className = "family-button";
    button.type = "button";
    button.dataset.family = family.id;
    button.innerHTML = `
      <span class="family-icon">${icon(family.icon)}</span>
      <span>
        <strong>${family.label}</strong>
        <small>${family.description}</small>
      </span>
    `;
    button.addEventListener("click", () => setContentFamily(family.id));
    container.appendChild(button);
  });
  hydrateIcons(container);
}

function syncContentControls() {
  state.kind = legacyKindFromSelection();
  $$("#familyControl .family-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.family === state.contentFamily);
  });
  const family = familyByID(state.contentFamily);
  const select = $("#deliverySelect");
  select.innerHTML = "";
  family.deliveries.forEach((delivery) => {
    const option = document.createElement("option");
    option.value = delivery;
    option.textContent = deliveryLabel(delivery);
    select.appendChild(option);
  });
  select.value = state.delivery;
  $("#contentSummary").innerHTML = `
    <span>${icon(family.icon)}${family.label}</span>
    <span>${icon(DELIVERY_OPTIONS[state.delivery]?.icon || "circle")} ${deliveryLabel(state.delivery)}</span>
    <span>${icon("eye")} Scanner: ${scannerVisibility()}</span>
  `;
  hydrateIcons($("#contentSummary"));
  syncContentsVisibility();
}

function setContentFamily(contentFamily, options = {}) {
  const previousFamily = state.contentFamily;
  const family = familyByID(contentFamily);
  state.contentFamily = family.id;
  if (previousFamily !== state.contentFamily) {
    state.missionType = "combat";
  }
  if (!family.deliveries.includes(state.delivery) || options.resetDelivery === true) {
    state.delivery = family.defaultDelivery;
  }
  if (options.resetDraft !== false && previousFamily !== state.contentFamily) {
    resetDraftFields();
  }
  if (options.preserveTemplate !== true) {
    clearSelectedTemplate();
    $("#templateSearchInput").value = "";
  }
  syncContentControls();
  void loadTemplateOptions();
  if (options.applyDefaults !== false) {
    applyDefaultsForCurrentContent();
  }
  renderAll();
}

function setDelivery(delivery, options = {}) {
  const family = familyByID(state.contentFamily);
  const previousDelivery = state.delivery;
  state.delivery = family.deliveries.includes(delivery) ? delivery : family.defaultDelivery;
  if (options.resetDraft !== false && previousDelivery !== state.delivery) {
    resetDraftFields();
  }
  if (options.preserveTemplate !== true) {
    clearSelectedTemplate();
    $("#templateSearchInput").value = "";
  }
  syncContentControls();
  void loadTemplateOptions();
  if (options.applyDefaults !== false) {
    applyDefaultsForCurrentContent();
  }
  renderAll();
}

function setKind(kind) {
  state.contentFamily = contentFamilyFromKind(kind);
  state.delivery = deliveryFromKind(kind);
  state.missionType = kind === "mission_combat" ? "combat" : state.missionType;
  clearSelectedTemplate();
  $("#templateSearchInput").value = "";
  syncContentControls();
  void loadTemplateOptions();
  applyDefaultsForCurrentContent();
  renderAll();
}

function applyDefaultsForCurrentContent() {
  if (state.contentFamily === "resource" && state.resources.length === 0) {
    state.resources.push({ ...defaultResource(), quantity: 250000, radiusMeters: 45000 });
  }
  if (state.contentFamily === "combat" && state.encounters.length === 0) {
    state.encounters.push({ profileID: "generic_hostile", count: 3, trigger: "on_load", targetPolicy: "nearest_player" });
  }
}

function setAnchorKind(anchorKind) {
  state.anchorKind = anchorKind;
  if (anchorKind === "coordinate" && (state.scopeMode === "any_eligible" || state.scopeMode === "security_bands")) {
    state.scopeMode = "specific_system";
  }
  $$("#anchorKindControl button").forEach((button) => button.classList.toggle("is-active", button.dataset.anchorKind === anchorKind));
  $("#coordinateGrid").hidden = anchorKind !== "coordinate";
  renderSpawnScope();
  renderSelectedSystem();
  updatePreview();
}

function overlayFromForm() {
  const spawnScope = spawnScopeFromForm();
  const placement = {
    anchorKind: state.anchorKind,
  };
  if (state.anchorKind === "stargate" && state.scopeMode === "specific_stargate" && state.selectedGate) {
    placement.anchorID = state.selectedGate.itemID;
    placement.distanceFromSurfaceMeters = 25000;
    placement.spreadMeters = 6000;
  }
  if (state.anchorKind === "coordinate") {
    placement.position = {
      x: Number($("#coordX").value) || 0,
      y: Number($("#coordY").value) || 0,
      z: Number($("#coordZ").value) || 0,
    };
  }

  return {
    id: state.loadedOverlayId || undefined,
    title: $("#titleInput").value.trim(),
    templateID: $("#templateIdInput").value.trim(),
    contentFamily: state.contentFamily,
    delivery: state.delivery,
    kind: legacyKindFromSelection(),
    missionType: state.contentFamily === "mission" ? state.missionType : "",
    status: $("#statusInput").value,
    baseTemplateID: state.baseTemplate ? state.baseTemplate.templateID : "",
    spawnScope,
    solarSystemID: spawnScope.solarSystemID || 0,
    placement,
    scanner: {
      visibility: scannerVisibility(),
      signalStrength: state.delivery === "anomaly" ? 100 : null,
    },
    rooms: state.rooms,
    gates: state.gates,
    encounters: state.encounters,
    resources: state.resources,
    npcOverrides: state.npcOverrides,
    lootTables: state.lootTables,
    completion: state.completion || {
      mode: defaultCompletionMode(),
      despawnDelaySeconds: state.delivery === "mission_private" ? 0 : 20,
    },
    missionSecurity: state.missionSecurity,
    sourceLinks: state.sourceLinks,
    notes: $("#notesInput").value.trim(),
  };
}

function updatePreview() {
  $("#overlayPreview").textContent = JSON.stringify(overlayFromForm(), null, 2);
}

function defaultResource() {
  return { typeID: 1230, quantity: 100000, radiusMeters: 40000, cluster: "main" };
}

function resourceByTypeID(typeID) {
  const id = Number(typeID) || 0;
  return state.lookup.resources.find((resource) => resource.typeID === id) || null;
}

function resourceKindLabel(kind) {
  if (kind === "ice") return "individual ice type";
  if (kind === "gas") return "individual gas cloud type";
  return "individual ore type";
}

function resourceOptionsHTML(selectedTypeID) {
  const selected = Number(selectedTypeID) || 0;
  const options = ['<option value="">Select an individual resource...</option>'];
  state.lookup.resources.forEach((resource) => {
    const typeID = Number(resource.typeID) || 0;
    const isSelected = typeID === selected ? " selected" : "";
    options.push(`<option value="${typeID}"${isSelected}>${escapeHTML(smallMeta([resource.name, resourceKindLabel(resource.kind)]))}</option>`);
  });
  return options.join("");
}

function resourceChipHTML(resource) {
  const typeID = Number(resource && resource.typeID) || 0;
  const resolved = resourceByTypeID(typeID);
  if (!typeID) {
    return `${icon("circle-help")}<div><strong>No resource selected</strong><span>Search by name and select a mineable resource type.</span></div>`;
  }
  if (!resolved) {
    return `${icon("circle-alert")}<div><strong>Unknown typeID ${typeID}</strong><span>This must resolve to a resource type before saving.</span></div>`;
  }
  return `${icon(resolved.kind === "ice" ? "snowflake" : resolved.kind === "gas" ? "cloud" : "gem")}<div><strong>${resolved.name}</strong><span>${smallMeta([`typeID ${resolved.typeID}`, resourceKindLabel(resolved.kind)])}</span></div>`;
}

function renderDatalist(selector, rows, metaBuilder) {
  const list = $(selector);
  list.innerHTML = "";
  rows.forEach((row) => {
    const id = rowID(row);
    if (!id) return;
    const option = document.createElement("option");
    option.value = id;
    option.label = metaBuilder ? metaBuilder(row) : (row.name || id);
    list.appendChild(option);
  });
}

function lootTableOptionRows() {
  const byID = new Map();
  state.lookup.npcLootTables.forEach((row) => {
    byID.set(rowID(row), row);
  });
  state.lootProfiles.forEach((row) => {
    const id = String(row.lootTableID || "").trim();
    if (!id) return;
    byID.set(id, {
      id,
      name: row.name,
      entriesCount: Array.isArray(row.entries) ? row.entries.length : 0,
      guaranteedEntriesCount: Array.isArray(row.guaranteedEntries) ? row.guaranteedEntries.length : 0,
    });
  });
  return [...byID.values()];
}

function renderLootTableOptions() {
  renderDatalist("#npcLootTableOptions", lootTableOptionRows(), (row) => smallMeta([row.name, `${row.entriesCount || 0} weighted`, `${row.guaranteedEntriesCount || 0} guaranteed`]));
}

async function loadBuilderLookups() {
  const [profiles, loadouts, behaviors, spawnGroups, spawnPools, lootTables, resources] = await Promise.all([
    api("/api/npcs?kind=profiles&limit=500"),
    api("/api/npcs?kind=loadouts&limit=500"),
    api("/api/npcs?kind=behaviorProfiles&limit=500"),
    api("/api/npcs?kind=spawnGroups&limit=500"),
    api("/api/npcs?kind=spawnPools&limit=500"),
    api("/api/npcs?kind=lootTables&limit=500"),
    api("/api/resources?limit=500"),
  ]);
  state.lookup.npcProfiles = profiles.npcs || [];
  state.lookup.npcLoadouts = loadouts.npcs || [];
  state.lookup.npcBehaviors = behaviors.npcs || [];
  state.lookup.npcSpawnGroups = spawnGroups.npcs || [];
  state.lookup.npcSpawnPools = spawnPools.npcs || [];
  state.lookup.npcLootTables = lootTables.npcs || [];
  state.lookup.resources = resources.resources || [];

  renderDatalist("#npcProfileOptions", state.lookup.npcProfiles, (row) => smallMeta([row.name, row.shipTypeName, row.bounty ? `${row.bounty} ISK` : ""]));
  renderDatalist("#npcLoadoutOptions", state.lookup.npcLoadouts, (row) => smallMeta([row.name, `${row.modulesCount || 0} modules`, `${row.chargesCount || 0} charges`]));
  renderDatalist("#npcBehaviorOptions", state.lookup.npcBehaviors, (row) => smallMeta([row.name, row.attackProfile, row.rangeBand]));
  renderDatalist("#npcSpawnGroupOptions", state.lookup.npcSpawnGroups, (row) => smallMeta([row.name, `${row.entriesCount || 0} entries`, `${row.memberCount || 0} members`]));
  renderDatalist("#npcSpawnPoolOptions", state.lookup.npcSpawnPools, (row) => smallMeta([row.name, `${row.entriesCount || 0} weighted entries`, row.entityType]));
  renderLootTableOptions();
  renderDatalist("#resourceTypeOptions", state.lookup.resources.map((row) => ({ ...row, id: row.typeID })), (row) => smallMeta([row.name, resourceKindLabel(row.kind)]));
}

function renderResultList(container, rows, onPick, metaBuilder) {
  container.innerHTML = "";
  rows.forEach((row) => {
    const item = document.createElement("div");
    item.className = "result-item";
    item.innerHTML = `
      <div>
        <div class="item-title"></div>
        <div class="item-meta"></div>
      </div>
      <button class="secondary">${iconText("check", "Select")}</button>
    `;
    item.querySelector(".item-title").textContent = row.name || row.title || row.id || row.templateID || String(row.solarSystemID || "");
    item.querySelector(".item-meta").textContent = metaBuilder ? metaBuilder(row) : "";
    item.querySelector("button").addEventListener("click", () => onPick(row));
    container.appendChild(item);
    hydrateIcons(item);
  });
}

function clearSelectedTemplate() {
  state.baseTemplate = null;
  state.selectedTemplateRaw = null;
  $("#templateIdInput").value = "";
}

function templateOptionLabel(template) {
  return smallMeta([
    template.name || template.templateID,
    template.templateID,
    state.contentFamily === "mission" && template.primaryMissionType ? missionTypeLabel(template.primaryMissionType) : "",
    `${template.siteFamily}/${template.siteKind}`,
    `difficulty ${template.difficulty || 0}`,
    `${template.encounterCount || 0} waves`,
    `${template.resourceCount || 0} resources`,
  ]);
}

function renderTemplateDropdown(templates, selectedTemplateID = "") {
  const select = $("#templateSelect");
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = templates.length
    ? "Select an existing filtered template..."
    : "No templates match the current filters.";
  select.appendChild(placeholder);

  templates.forEach((template) => {
    const option = document.createElement("option");
    option.value = template.templateID;
    option.textContent = templateOptionLabel(template);
    select.appendChild(option);
  });

  if (selectedTemplateID && templates.some((template) => template.templateID === selectedTemplateID)) {
    select.value = selectedTemplateID;
  } else {
    select.value = "";
  }

  const filter = $("#templateSearchInput").value.trim();
  const missionCategory = state.contentFamily === "mission" ? ` ${missionTypeLabel(state.missionType).toLowerCase()}` : "";
  $("#templateSelectMeta").textContent = templates.length
    ? `Showing ${templates.length.toLocaleString()} ${deliveryLabel(state.delivery).toLowerCase()}${missionCategory} ${familyByID(state.contentFamily).label.toLowerCase()} templates${filter ? ` matching "${filter}"` : ""}.`
    : `No ${deliveryLabel(state.delivery).toLowerCase()}${missionCategory} ${familyByID(state.contentFamily).label.toLowerCase()} templates found${filter ? ` for "${filter}"` : ""}.`;
}

async function loadTemplateOptions(options = {}) {
  const requestID = state.templateOptionsRequest + 1;
  state.templateOptionsRequest = requestID;
  const selectedTemplateID = options.selectedTemplateID || "";
  const q = options.q == null ? $("#templateSearchInput").value.trim() : String(options.q || "").trim();
  const select = $("#templateSelect");
  select.innerHTML = '<option value="">Loading filtered templates...</option>';
  $("#templateSelectMeta").textContent = "Loading templates from the cloned EveJS catalog.";

  const params = new URLSearchParams({
    contentFamily: state.contentFamily,
    delivery: state.delivery,
    q,
    limit: "500",
  });
  if (state.contentFamily === "mission") {
    params.set("missionType", state.missionType || "combat");
  }
  const data = await api(`/api/templates?${params.toString()}`);
  if (requestID !== state.templateOptionsRequest) {
    return;
  }
  state.templateOptions = data.templates || [];
  renderTemplateDropdown(state.templateOptions, selectedTemplateID);
}

async function useSelectedTemplate() {
  const templateID = $("#templateSelect").value;
  if (!templateID) {
    showNotice("Select a template from the filtered dropdown first.");
    return;
  }
  const template = state.templateOptions.find((entry) => entry.templateID === templateID);
  await loadExistingTemplate(template || { templateID });
}

function renderSelectedTemplate() {
  const card = $("#selectedTemplateCard");
  const templateID = $("#templateIdInput").value.trim();
  if (!state.baseTemplate) {
    card.innerHTML = `
      <div class="blank-state">
        ${icon("file-plus-2")}
        <div>
          <strong>${templateID ? "New custom template" : "No template selected"}</strong>
          <span>${templateID ? `The ID ${templateID} does not exist in the cloned EveJS catalog yet.` : "Pick an existing template or enter a new template ID."}</span>
        </div>
      </div>
    `;
    $("#templateDataPreview").textContent = "{}";
    hydrateIcons(card);
    return;
  }

  const template = state.baseTemplate;
  card.innerHTML = `
    <div class="template-card-head">
      <div>
        <strong>${template.name || template.templateID}</strong>
        <span>${template.templateID}</span>
      </div>
      <span class="status-pill">${deliveryLabel(template.delivery)}</span>
    </div>
    <div class="template-facts">
      <span>${icon("layers-3")}${template.contentFamily}</span>
      <span>${icon("radar")}${template.siteFamily}/${template.siteKind}</span>
      <span>${icon("activity")}difficulty ${template.difficulty || 0}</span>
      <span>${icon("waves")}${template.encounterCount || 0} waves</span>
      <span>${icon("gem")}${template.resourceCount || 0} resources</span>
      <span>${icon("door-open")}${template.gateCount || 0} gates</span>
    </div>
    <div class="template-card-actions">
      <button class="danger" id="deleteTemplateButton" type="button">${iconText("trash-2", "Delete Server Template")}</button>
    </div>
  `;
  card.querySelector("#deleteTemplateButton").addEventListener("click", deleteSelectedTemplate);
  $("#templateDataPreview").textContent = JSON.stringify(state.selectedTemplateRaw || template.raw || {}, null, 2);
  hydrateIcons(card);
}

function importResourcesFromTemplate(template) {
  if (!Array.isArray(template && template.resourceNames) || template.resourceNames.length === 0) {
    return;
  }
  state.resources = template.resourceNames.map((resource) => ({
    typeID: resource.typeID,
    quantity: resource.kind === "gas" ? 12000 : 100000,
    radiusMeters: resource.kind === "gas" ? 22000 : 40000,
    cluster: "main",
  }));
}

async function loadExistingTemplate(row) {
  const data = row.raw ? { template: row } : await api(`/api/templates/${encodeURIComponent(row.templateID)}`);
  const template = data.template;
  state.baseTemplate = template;
  state.selectedTemplateRaw = template.raw || null;
  state.contentFamily = template.contentFamily || state.contentFamily;
  state.delivery = template.delivery || state.delivery;
  if (state.contentFamily === "mission") {
    state.missionType = template.primaryMissionType || state.missionType || "combat";
  }
  syncContentControls();
  $("#templateIdInput").value = template.templateID;
  $("#templateSearchInput").value = "";
  await loadTemplateOptions({ selectedTemplateID: template.templateID, q: "" });
  if (!$("#titleInput").value.trim()) {
    $("#titleInput").value = template.name || template.templateID;
  }
  if (state.contentFamily === "resource") {
    importResourcesFromTemplate(template);
  }
  renderAll();
  showNotice(`Loaded template ${template.templateID}.`);
}

async function loadTemplateID() {
  const templateID = $("#templateIdInput").value.trim();
  if (!templateID) {
    showNotice("Enter an existing or new template ID first.");
    return;
  }
  try {
    const data = await api(`/api/templates/${encodeURIComponent(templateID)}`);
    await loadExistingTemplate(data.template);
  } catch (error) {
    state.baseTemplate = null;
    state.selectedTemplateRaw = null;
    state.encounters = [];
    state.resources = [];
    state.npcOverrides = [];
    state.lootTables = [];
    applyDefaultsForCurrentContent();
    if (!$("#titleInput").value.trim()) {
      $("#titleInput").value = templateID.replace(/^admin[:/-]?/i, "").replace(/[-_:]+/g, " ");
    }
    $("#templateSearchInput").value = "";
    renderTemplateDropdown(state.templateOptions);
    renderAll();
    showNotice(`Template ID ${templateID} is new. Starting from an empty ${familyByID(state.contentFamily).label} template.`);
  }
}

async function searchTemplates() {
  await loadTemplateOptions();
}

async function searchSystems(target = "builder") {
  const input = target === "builder" ? $("#systemSearchInput") : $("#systemsViewSearch");
  const data = await api(`/api/systems?q=${encodeURIComponent(input.value.trim())}&limit=24`);
  if (target === "builder") {
    renderResultList($("#systemResults"), data.systems, async (row) => {
      await selectSystem(row.solarSystemID);
      $("#systemResults").innerHTML = "";
    }, (row) => smallMeta([row.solarSystemID, row.securityBand, `sec ${row.displayedSecurity}`, `${row.stargateCount} gates`]));
  } else {
    renderSystemsView(data.systems);
  }
}

async function searchResources() {
  const q = encodeURIComponent($("#resourceSearchInput").value.trim());
  const data = await api(`/api/resources?q=${q}&limit=24`);
  renderResultList($("#resourceResults"), data.resources, (row) => {
    state.resources.push({
      typeID: row.typeID,
      quantity: 100000,
      radiusMeters: row.kind === "gas" ? 22000 : 40000,
      cluster: "main",
    });
    $("#resourceSearchInput").value = `${row.name} (${row.typeID})`;
    $("#resourceResults").innerHTML = "";
    renderAll();
  }, (row) => smallMeta([`typeID ${row.typeID}`, resourceKindLabel(row.kind)]));
}

async function selectSystem(systemID) {
  const data = await api(`/api/systems/${systemID}`);
  state.selectedSystem = data.system;
  state.selectedGate = null;
  $("#systemSearchInput").value = `${data.system.name} (${data.system.solarSystemID})`;
  renderSelectedSystem();
  updatePreview();
}

function renderSelectedSystem() {
  const box = $("#selectedSystem");
  if (!state.selectedSystem) {
    box.textContent = "No solar system selected.";
    $("#gateList").innerHTML = "";
    return;
  }
  const system = state.selectedSystem;
  box.innerHTML = `<strong>${system.name}</strong><div class="item-meta">${smallMeta([system.solarSystemID, system.securityBand, `sec ${system.displayedSecurity}`, `${system.stargates.length} gates`])}</div>`;
  const gateList = $("#gateList");
  gateList.innerHTML = "";
  if (state.anchorKind !== "stargate") {
    return;
  }
  system.stargates.forEach((gate) => {
    const row = document.createElement("div");
    row.className = "gate-item";
    row.innerHTML = `
      <div>
        <div class="item-title"></div>
        <div class="item-meta"></div>
      </div>
      <button class="secondary"></button>
    `;
    row.querySelector(".item-title").textContent = gate.name;
    row.querySelector(".item-meta").textContent = smallMeta([gate.itemID, `to ${gate.destinationSolarSystemName || gate.destinationName}`, gate.destinationSolarSystemID]);
    row.querySelector("button").innerHTML = state.selectedGate && state.selectedGate.itemID === gate.itemID
      ? iconText("check-circle-2", "Selected")
      : iconText("check", "Select");
    row.querySelector("button").addEventListener("click", () => {
      state.selectedGate = gate;
      renderSelectedSystem();
      updatePreview();
    });
    gateList.appendChild(row);
    hydrateIcons(row);
  });
}

function renderEditorRows() {
  renderEncounters();
  renderResources();
  renderOverrides();
  renderLootTables();
}

function lookupNpcRow(collection, id) {
  const needle = String(id || "").trim();
  if (!needle) return null;
  return (state.lookup[collection] || []).find((row) => rowID(row) === needle) || null;
}

function authoredLootTableByID(id) {
  const needle = String(id || "").trim();
  if (!needle) return null;
  return state.lootTables.find((lootTable) => String(lootTable.lootTableID || "").trim() === needle) ||
    state.lootProfiles.find((lootTable) => String(lootTable.lootTableID || "").trim() === needle) ||
    null;
}

function encounterChipHTML(encounter) {
  const spawnGroup = lookupNpcRow("npcSpawnGroups", encounter.spawnGroupID);
  const spawnPool = lookupNpcRow("npcSpawnPools", encounter.spawnPoolID);
  const profile = lookupNpcRow("npcProfiles", encounter.profileID);
  const spawnQuery = String(encounter.spawnQuery || "").trim();
  if (spawnGroup) {
    return `${icon("users")}<div><strong>${escapeHTML(spawnGroup.name || spawnGroup.id)}</strong><span>${smallMeta(["spawn group", `${spawnGroup.entriesCount || 0} entries`, `${spawnGroup.memberCount || 0} members`, (spawnGroup.sampleMembers || []).join(", ")])}</span></div>`;
  }
  if (spawnPool) {
    return `${icon("shuffle")}<div><strong>${escapeHTML(spawnPool.name || spawnPool.id)}</strong><span>${smallMeta(["spawn pool", `${spawnPool.entriesCount || 0} weighted entries`, spawnPool.entityType, (spawnPool.sampleProfiles || []).join(", ")])}</span></div>`;
  }
  if (profile) {
    return `${icon("crosshair")}<div><strong>${escapeHTML(profile.name || profile.profileID)}</strong><span>${smallMeta(["profile", profile.shipTypeName, profile.loadoutID, profile.lootTableID])}</span></div>`;
  }
  if (spawnQuery) {
    return `${icon("search-code")}<div><strong>${escapeHTML(spawnQuery)}</strong><span>EveJS resolves this query at spawn time against NPC profiles and pools.</span></div>`;
  }
  return `${icon("circle-alert")}<div><strong>No NPC source selected</strong><span>Choose a profile, spawn pool, spawn group, or query before saving.</span></div>`;
}

function renderEncounters(list = $("#encounterList"), encounters = state.encounters, onChange = renderAll) {
  if (!list) return;
  list.innerHTML = "";
  encounters.forEach((encounter, index) => {
    const row = document.createElement("div");
    row.className = "editor-row";
    row.innerHTML = `
      <div class="editor-row-grid">
        <label class="wide"><span>Profile ID</span><input data-field="profileID" list="npcProfileOptions"></label>
        <label class="wide"><span>Spawn Pool</span><input data-field="spawnPoolID" list="npcSpawnPoolOptions"></label>
        <label class="wide"><span>Spawn Group</span><input data-field="spawnGroupID" list="npcSpawnGroupOptions"></label>
        <label class="wide"><span>Spawn Query</span><input data-field="spawnQuery"></label>
        <label><span>Count</span><input data-field="count" type="number" min="1"></label>
        <label><span>Trigger</span><select data-field="trigger"><option value="on_load">On Load</option><option value="on_room_active">Room Active</option><option value="wave_cleared">Wave Cleared</option><option value="visible_countdown">Countdown</option><option value="timer">Timer</option></select></label>
        <label><span>Room</span><input data-field="roomKey"></label>
        <label><span>Target</span><select data-field="targetPolicy"><option value="nearest_player">Nearest Player</option><option value="invoker">Invoker</option><option value="none">None</option></select></label>
        <div class="resource-chip full" data-encounter-chip>${encounterChipHTML(encounter)}</div>
        <button class="remove-row">${iconText("trash-2", "Remove")}</button>
      </div>
    `;
    bindRow(row, encounter, () => {
      encounters.splice(index, 1);
      onChange();
    });
    const chip = row.querySelector("[data-encounter-chip]");
    row.querySelectorAll('[data-field="profileID"], [data-field="spawnPoolID"], [data-field="spawnGroupID"], [data-field="spawnQuery"]').forEach((input) => {
      input.addEventListener("input", () => {
        chip.innerHTML = encounterChipHTML(encounter);
        hydrateIcons(chip);
      });
      input.addEventListener("change", () => {
        chip.innerHTML = encounterChipHTML(encounter);
        hydrateIcons(chip);
      });
    });
    list.appendChild(row);
    hydrateIcons(row);
  });
}

function renderResources() {
  const list = $("#resourceList");
  list.innerHTML = "";
  state.resources.forEach((resource, index) => {
    const row = document.createElement("div");
    row.className = "editor-row";
    row.innerHTML = `
      <div class="editor-row-grid">
        <label class="wide"><span>Individual Resource</span><select data-field="typeID" data-number="true" data-resource-select>${resourceOptionsHTML(resource.typeID)}</select></label>
        <label class="wide"><span>Quantity</span><input data-field="quantity" type="number" min="1"></label>
        <label><span>Radius</span><input data-field="radiusMeters" type="number" min="0"></label>
        <label><span>Cluster</span><input data-field="cluster"></label>
        <div class="resource-chip full">${resourceChipHTML(resource)}</div>
        <button class="remove-row">${iconText("trash-2", "Remove")}</button>
      </div>
    `;
    bindRow(row, resource, () => {
      state.resources.splice(index, 1);
      renderAll();
    });
    const typeInput = row.querySelector('[data-field="typeID"]');
    const chip = row.querySelector(".resource-chip");
    typeInput.addEventListener("change", () => {
      chip.innerHTML = resourceChipHTML(resource);
      hydrateIcons(chip);
    });
    list.appendChild(row);
    hydrateIcons(row);
  });
}

function renderOverrides() {
  const list = $("#overrideList");
  list.innerHTML = "";
  state.npcOverrides.forEach((override, index) => {
    const row = document.createElement("div");
    row.className = "editor-row";
    row.innerHTML = `
      <div class="editor-row-grid">
        <label class="wide"><span>Profile ID</span><input data-field="profileID" list="npcProfileOptions"></label>
        <label class="wide"><span>Loadout ID</span><input data-field="loadoutID" list="npcLoadoutOptions"></label>
        <label class="wide"><span>Behavior ID</span><input data-field="behaviorProfileID" list="npcBehaviorOptions"></label>
        <label class="wide"><span>Loot Table ID</span><input data-field="lootTableID" list="npcLootTableOptions"></label>
        <label><span>Damage</span><input data-field="damageMultiplier" type="number" min="0.1" step="0.1"></label>
        <label><span>Bounty</span><input data-field="bounty" type="number"></label>
        <label class="full"><span>Module Overrides JSON</span><textarea data-field="moduleOverrides" data-json="array" rows="3" placeholder='[{"slot":"high","typeID":12345,"mode":"replace"}]'></textarea></label>
        <button class="remove-row">${iconText("trash-2", "Remove")}</button>
      </div>
    `;
    bindRow(row, override, () => {
      state.npcOverrides.splice(index, 1);
      renderAll();
    });
    list.appendChild(row);
    hydrateIcons(row);
  });
}

function defaultLootTable() {
  return {
    lootTableID: `admin_loot_${Math.max(1, state.lootTables.length + 1)}`,
    name: "Admin Loot Table",
    minEntries: 0,
    maxEntries: 1,
    allowDuplicates: false,
    guaranteedEntries: [],
    entries: [{ typeID: 34, weight: 1, minQuantity: 1, maxQuantity: 10 }],
  };
}

function lootTableChipHTML(lootTable) {
  const existing = lookupNpcRow("npcLootTables", lootTable.lootTableID);
  const authored = authoredLootTableByID(lootTable.lootTableID);
  const entries = Array.isArray(lootTable.entries) ? lootTable.entries : [];
  const guaranteedEntries = Array.isArray(lootTable.guaranteedEntries) ? lootTable.guaranteedEntries : [];
  const source = existing && authored ? "overrides existing EveJS table" : "authored utility table";
  return `${icon(existing ? "package-check" : "package-open")}<div><strong>${escapeHTML(lootTable.name || lootTable.lootTableID || "Unnamed loot table")}</strong><span>${smallMeta([source, `${guaranteedEntries.length} guaranteed`, `${entries.length} weighted`, `rolls ${lootTable.minEntries || 0}-${lootTable.maxEntries || 0}`])}</span></div>`;
}

function renderLootTables(list = $("#lootTableList"), lootTables = state.lootTables, onChange = renderAll) {
  if (!list) return;
  list.innerHTML = "";
  lootTables.forEach((lootTable, index) => {
    const row = document.createElement("div");
    row.className = "editor-row";
    row.innerHTML = `
      <div class="editor-row-grid">
        <label class="wide"><span>Loot Table ID</span><input data-field="lootTableID" list="npcLootTableOptions"></label>
        <label class="wide"><span>Name</span><input data-field="name"></label>
        <label><span>Min Entries</span><input data-field="minEntries" data-number="true" type="number" min="0"></label>
        <label><span>Max Entries</span><input data-field="maxEntries" data-number="true" type="number" min="0"></label>
        <label><span>Stack Min Qty</span><input data-field="stackableMinQuantity" data-number="true" type="number" min="0"></label>
        <label><span>Stack Max Qty</span><input data-field="stackableMaxQuantity" data-number="true" type="number" min="0"></label>
        <label class="checkbox-field"><input data-field="allowDuplicates" data-boolean="true" type="checkbox"><span>Allow Duplicates</span></label>
        <label class="full"><span>Guaranteed Entries JSON</span><textarea data-field="guaranteedEntries" data-json="array" rows="4" placeholder='[{"typeID":34,"quantity":1000}]'></textarea></label>
        <label class="full"><span>Weighted Entries JSON</span><textarea data-field="entries" data-json="array" rows="5" placeholder='[{"typeID":35,"weight":5,"minQuantity":1,"maxQuantity":3}]'></textarea></label>
        <label class="full"><span>Notes</span><textarea data-field="notes" rows="2"></textarea></label>
        <div class="resource-chip full" data-loot-table-chip>${lootTableChipHTML(lootTable)}</div>
        <button class="remove-row">${iconText("trash-2", "Remove")}</button>
      </div>
    `;
    bindRow(row, lootTable, () => {
      lootTables.splice(index, 1);
      onChange();
    });
    const chip = row.querySelector("[data-loot-table-chip]");
    row.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", () => {
        chip.innerHTML = lootTableChipHTML(lootTable);
        hydrateIcons(chip);
      });
      input.addEventListener("change", () => {
        chip.innerHTML = lootTableChipHTML(lootTable);
        hydrateIcons(chip);
      });
    });
    list.appendChild(row);
    hydrateIcons(row);
  });
}

function normalizeLootProfile(row = {}, fallbackID = "") {
  return {
    lootTableID: String(row.lootTableID || row.id || fallbackID || "").trim(),
    name: String(row.name || row.lootTableID || row.id || fallbackID || "Admin Loot Table").trim(),
    minEntries: Number(row.minEntries) || 0,
    maxEntries: Number(row.maxEntries) || Number(row.minEntries) || 0,
    stackableMinQuantity: Number(row.stackableMinQuantity) || 0,
    stackableMaxQuantity: Number(row.stackableMaxQuantity) || 0,
    allowDuplicates: row.allowDuplicates === true,
    guaranteedEntries: Array.isArray(row.guaranteedEntries) ? structuredClone(row.guaranteedEntries) : [],
    entries: Array.isArray(row.entries) ? structuredClone(row.entries) : [],
    notes: String(row.notes || "").trim(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadLootProfiles() {
  const data = await api("/api/npc-authoring/loot-tables");
  state.lootProfiles = (data.lootTables || []).map((row) => normalizeLootProfile(row));
  renderLootTableOptions();
  renderLootProfiles();
}

function lootProfileChipHTML(lootTable) {
  const existing = lookupNpcRow("npcLootTables", lootTable.lootTableID);
  const entries = Array.isArray(lootTable.entries) ? lootTable.entries : [];
  const guaranteedEntries = Array.isArray(lootTable.guaranteedEntries) ? lootTable.guaranteedEntries : [];
  const kind = entries.length || guaranteedEntries.length
    ? "explicit drop profile"
    : "generic random profile";
  const source = existing ? "overrides existing EveJS loot table" : "new utility loot table";
  return `${icon(existing ? "package-check" : "package-open")}<div><strong>${escapeHTML(lootTable.name || lootTable.lootTableID || "Unnamed loot table profile")}</strong><span>${smallMeta([kind, source, `${guaranteedEntries.length} guaranteed`, `${entries.length} weighted`, `rolls ${lootTable.minEntries || 0}-${lootTable.maxEntries || 0}`, `stack ${lootTable.stackableMinQuantity || 0}-${lootTable.stackableMaxQuantity || 0}`])}</span></div>`;
}

function renderLootProfiles() {
  const list = $("#lootProfileList");
  if (!list) return;
  list.innerHTML = "";
  if (state.lootProfiles.length === 0) {
    const blank = document.createElement("div");
    blank.className = "editor-row";
    blank.innerHTML = `<div class="blank-state">${icon("package-open")}<div><strong>No authored loot table profiles yet.</strong><span>Load an existing profile like generic_random_any or create a new profile.</span></div></div>`;
    list.appendChild(blank);
    hydrateIcons(blank);
    return;
  }
  state.lootProfiles.forEach((lootTable, index) => {
    const row = document.createElement("div");
    row.className = "editor-row";
    row.innerHTML = `
      <div class="editor-row-grid">
        <label class="wide"><span>Loot Table Profile ID</span><input data-field="lootTableID" list="npcLootTableOptions"></label>
        <label class="wide"><span>Name</span><input data-field="name"></label>
        <label><span>Min Entries</span><input data-field="minEntries" data-number="true" type="number" min="0"></label>
        <label><span>Max Entries</span><input data-field="maxEntries" data-number="true" type="number" min="0"></label>
        <label><span>Stack Min Qty</span><input data-field="stackableMinQuantity" data-number="true" type="number" min="0"></label>
        <label><span>Stack Max Qty</span><input data-field="stackableMaxQuantity" data-number="true" type="number" min="0"></label>
        <label class="checkbox-field"><input data-field="allowDuplicates" data-boolean="true" type="checkbox"><span>Allow Weighted Duplicates</span></label>
        <label class="full"><span>Guaranteed Entries JSON</span><textarea data-field="guaranteedEntries" data-json="array" rows="4" placeholder='[{"typeID":34,"quantity":1000}]'></textarea></label>
        <label class="full"><span>Weighted Entries JSON</span><textarea data-field="entries" data-json="array" rows="5" placeholder='[{"typeID":35,"weight":5,"minQuantity":1,"maxQuantity":3}]'></textarea></label>
        <label class="full"><span>Notes</span><textarea data-field="notes" rows="2"></textarea></label>
        <div class="resource-chip full" data-loot-profile-chip>${lootProfileChipHTML(lootTable)}</div>
        <div class="editor-actions full">
          <button class="primary save-loot-profile" type="button">${iconText("save", "Save Profile")}</button>
          <button class="secondary copy-loot-profile" type="button">${iconText("copy", "Copy ID")}</button>
          <button class="danger delete-loot-profile" type="button">${iconText("trash-2", "Delete")}</button>
        </div>
      </div>
    `;
    bindRow(row, lootTable, () => {});
    const removeButton = row.querySelector(".remove-row");
    if (removeButton) removeButton.remove();
    const chip = row.querySelector("[data-loot-profile-chip]");
    row.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", () => {
        chip.innerHTML = lootProfileChipHTML(lootTable);
        hydrateIcons(chip);
      });
      input.addEventListener("change", () => {
        chip.innerHTML = lootProfileChipHTML(lootTable);
        hydrateIcons(chip);
      });
    });
    row.querySelector(".save-loot-profile").addEventListener("click", () => saveLootProfile(index));
    row.querySelector(".copy-loot-profile").addEventListener("click", async () => {
      await navigator.clipboard.writeText(lootTable.lootTableID || "");
      showNotice(`Copied ${lootTable.lootTableID}`);
    });
    row.querySelector(".delete-loot-profile").addEventListener("click", () => deleteLootProfile(index));
    list.appendChild(row);
    hydrateIcons(row);
  });
}

async function saveLootProfile(index) {
  const lootTable = state.lootProfiles[index];
  if (!lootTable) return;
  const result = await api("/api/npc-authoring/loot-tables", {
    method: "POST",
    body: lootTable,
  });
  state.lootProfiles[index] = normalizeLootProfile(result.lootTable);
  renderLootTableOptions();
  renderLootProfiles();
  showNotice(`Saved loot table profile ${result.lootTable.lootTableID}.`);
}

async function deleteLootProfile(index) {
  const lootTable = state.lootProfiles[index];
  if (!lootTable) return;
  if (lootTable.lootTableID) {
    const confirmed = window.confirm(`Delete authored loot table profile "${lootTable.lootTableID}"?`);
    if (!confirmed) return;
    const response = await fetch(`/api/npc-authoring/loot-tables/${encodeURIComponent(lootTable.lootTableID)}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 404) {
      const data = await response.json();
      throw new Error(data.error || data.errorMsg || `Delete failed: ${response.status}`);
    }
  }
  state.lootProfiles.splice(index, 1);
  renderLootTableOptions();
  renderLootProfiles();
  showNotice(`Deleted loot table profile ${lootTable.lootTableID || "draft"}.`);
}

async function loadLootProfileFromInput() {
  const requestedID = $("#lootProfileSearchInput").value.trim();
  if (!requestedID) {
    showNotice("Enter a loot table profile ID first.");
    return;
  }
  let row = null;
  const authored = state.lootProfiles.find((entry) => entry.lootTableID === requestedID);
  if (authored) {
    row = authored;
  } else {
    try {
      const existing = await api(`/api/npcs/lootTables/${encodeURIComponent(requestedID)}`);
      row = existing.row;
    } catch (error) {
      showNotice(error.message || `Loot table profile ${requestedID} was not found.`);
      return;
    }
  }
  const normalized = normalizeLootProfile(row, requestedID);
  const index = state.lootProfiles.findIndex((entry) => entry.lootTableID === normalized.lootTableID);
  if (index >= 0) {
    state.lootProfiles[index] = normalized;
  } else {
    state.lootProfiles.push(normalized);
  }
  renderLootTableOptions();
  renderLootProfiles();
  showNotice(`Loaded loot table profile ${normalized.lootTableID}.`);
}

function addNewLootProfile() {
  const seed = $("#lootProfileSearchInput").value.trim();
  state.lootProfiles.push(normalizeLootProfile({
    ...defaultLootTable(),
    lootTableID: seed || `admin_loot_profile_${state.lootProfiles.length + 1}`,
    name: seed || "Admin Loot Table Profile",
    stackableMinQuantity: 1,
    stackableMaxQuantity: 25,
    entries: [],
  }));
  renderLootTableOptions();
  renderLootProfiles();
}

function writeFieldFromInput(input, object, field) {
  if (input.dataset.boolean === "true") {
    object[field] = input.checked === true;
    return;
  }
  if (input.dataset.json === "array") {
    try {
      object[field] = input.value.trim() ? JSON.parse(input.value) : [];
      input.classList.remove("input-error");
    } catch (error) {
      object[field] = input.value;
      input.classList.add("input-error");
    }
    return;
  }
  if (input.dataset.number === "true") {
    object[field] = Number(input.value) || 0;
    return;
  }
  object[field] = input.type === "number" ? Number(input.value) : input.value;
}

function bindRow(row, object, onRemove) {
  row.querySelectorAll("[data-field]").forEach((input) => {
    const field = input.dataset.field;
    if (input.dataset.boolean === "true") {
      input.checked = object[field] === true;
    } else {
      input.value = input.dataset.json === "array"
        ? JSON.stringify(Array.isArray(object[field]) ? object[field] : [], null, 2)
        : object[field] ?? "";
    }
    input.addEventListener("input", () => {
      writeFieldFromInput(input, object, field);
      updatePreview();
    });
    input.addEventListener("change", () => {
      writeFieldFromInput(input, object, field);
      updatePreview();
    });
  });
  const removeButton = row.querySelector(".remove-row");
  if (removeButton) {
    removeButton.addEventListener("click", onRemove);
  }
}

function renderAll() {
  renderSelectedTemplate();
  renderEditorRows();
  renderLootProfiles();
  renderSelectedSystem();
  updatePreview();
}

async function validateCurrent() {
  const data = await api("/api/validate", {
    method: "POST",
    body: overlayFromForm(),
  });
  renderValidation(data.validation);
  return data.validation;
}

function renderValidation(validation) {
  const list = $("#validationList");
  list.innerHTML = "";
  if (!validation.findings.length) {
    const ok = document.createElement("div");
    ok.className = "validation-item ok";
    ok.innerHTML = `${icon("check-circle-2")}<span>Valid template pack entry.</span>`;
    list.appendChild(ok);
    hydrateIcons(ok);
    return;
  }
  validation.findings.forEach((finding) => {
    const item = document.createElement("div");
    item.className = `validation-item ${finding.level}`;
    item.innerHTML = `${icon(finding.level === "error" ? "circle-alert" : "triangle-alert")}<span></span>`;
    item.querySelector("span").textContent = `${finding.path}: ${finding.message}`;
    list.appendChild(item);
    hydrateIcons(item);
  });
}

async function saveOverlay() {
  const result = await api("/api/overlays", {
    method: "POST",
    body: overlayFromForm(),
  });
  state.loadedOverlayId = result.overlay.id;
  renderValidation(result.validation);
  await loadOverlays();
  await loadStatus();
  showNotice("Draft saved to overlay workspace.");
}

async function deleteOverlayDraft(overlay) {
  const label = overlay.title || overlay.id;
  if (!window.confirm(`Delete saved draft "${label}" from the utility workspace?`)) {
    return;
  }
  await api(`/api/overlays/${encodeURIComponent(overlay.id)}`, { method: "DELETE" });
  if (state.loadedOverlayId === overlay.id) {
    resetForm();
  }
  await loadOverlays();
  await loadStatus();
  showNotice(`Deleted saved draft ${label}.`);
}

async function loadOverlays() {
  const data = await api("/api/overlays");
  const list = $("#overlayList");
  list.innerHTML = "";
  data.overlays.forEach((overlay) => {
    const row = document.createElement("div");
    row.className = "overlay-item";
    row.innerHTML = `
      <div>
        <div class="item-title"></div>
        <div class="item-meta"></div>
      </div>
      <div class="overlay-actions">
        <button class="secondary load-overlay" type="button">${iconText("folder-open", "Load")}</button>
        <button class="danger delete-overlay" type="button" title="Delete saved draft">${iconText("trash-2", "Delete")}</button>
      </div>
    `;
    row.querySelector(".item-title").textContent = overlay.title || overlay.id;
    row.querySelector(".item-meta").textContent = smallMeta([
      overlay.templateID || overlay.baseTemplateID,
      overlay.contentFamily || contentFamilyFromKind(overlay.kind),
      overlay.delivery || deliveryFromKind(overlay.kind),
      overlay.spawnScope && overlay.spawnScope.mode,
      overlay.status,
      overlay.validation && overlay.validation.ok ? "valid" : "needs work",
    ]);
    row.querySelector(".load-overlay").addEventListener("click", () => loadOverlayIntoForm(overlay));
    row.querySelector(".delete-overlay").addEventListener("click", () => deleteOverlayDraft(overlay));
    list.appendChild(row);
    hydrateIcons(row);
  });
}

async function deleteSelectedTemplate() {
  if (!state.baseTemplate) {
    showNotice("Load a server template before deleting it.");
    return;
  }
  const templateID = state.baseTemplate.templateID;
  const name = state.baseTemplate.name || templateID;
  const confirmed = window.confirm(
    `Delete server template "${name}" (${templateID}) from the cloned EveJS server data?\n\nThis only edits the utility database clone, not the live server database.`,
  );
  if (!confirmed) {
    return;
  }
  await api(`/api/templates/${encodeURIComponent(templateID)}`, { method: "DELETE" });
  resetDraftFields();
  syncContentControls();
  applyDefaultsForCurrentContent();
  await loadTemplateOptions();
  await loadOverlays();
  await loadStatus();
  renderAll();
  showNotice(`Deleted server template ${templateID} from the cloned catalog.`);
}

async function loadOverlayIntoForm(overlay) {
  const family = overlay.contentFamily || contentFamilyFromKind(overlay.kind);
  if (family === "mission") {
    await loadMissionOverlay(overlay);
    return;
  }
  state.loadedOverlayId = overlay.id;
  state.contentFamily = overlay.contentFamily || contentFamilyFromKind(overlay.kind);
  state.delivery = overlay.delivery || deliveryFromKind(overlay.kind);
  state.missionType = overlay.missionType || overlay.mission && overlay.mission.type || (overlay.kind === "mission_combat" ? "combat" : "combat");
  state.kind = legacyKindFromSelection(state.contentFamily, state.delivery);
  state.baseTemplate = null;
  state.selectedTemplateRaw = null;
  state.rooms = Array.isArray(overlay.rooms) ? structuredClone(overlay.rooms) : [];
  state.gates = Array.isArray(overlay.gates) ? structuredClone(overlay.gates) : [];
  state.encounters = Array.isArray(overlay.encounters) ? structuredClone(overlay.encounters) : [];
  state.resources = Array.isArray(overlay.resources) ? structuredClone(overlay.resources) : [];
  state.npcOverrides = Array.isArray(overlay.npcOverrides) ? structuredClone(overlay.npcOverrides) : [];
  state.lootTables = Array.isArray(overlay.lootTables) ? structuredClone(overlay.lootTables) : [];
  state.completion = overlay.completion && typeof overlay.completion === "object" ? structuredClone(overlay.completion) : null;
  state.missionSecurity = overlay.missionSecurity && typeof overlay.missionSecurity === "object" ? structuredClone(overlay.missionSecurity) : null;
  state.sourceLinks = Array.isArray(overlay.sourceLinks) ? structuredClone(overlay.sourceLinks) : [];
  $("#titleInput").value = overlay.title || "";
  $("#templateIdInput").value = overlay.templateID || overlay.baseTemplateID || "";
  $("#statusInput").value = overlay.status || "draft";
  $("#templateSearchInput").value = overlay.baseTemplateID || "";
  $("#notesInput").value = overlay.notes || "";
  syncContentControls();
  $("#templateSearchInput").value = "";
  if (overlay.baseTemplateID) {
    try {
      const data = await api(`/api/templates/${encodeURIComponent(overlay.baseTemplateID)}`);
      state.baseTemplate = data.template;
      state.selectedTemplateRaw = data.template.raw || null;
    } catch (_error) {
      state.baseTemplate = null;
      state.selectedTemplateRaw = null;
    }
  }
  await loadTemplateOptions({ selectedTemplateID: overlay.baseTemplateID || overlay.templateID || "", q: "" });
  const placement = overlay.placement || {};
  const spawnScope = overlay.spawnScope || {};
  state.scopeMode = inferScopeModeFromOverlay(overlay);
  setSecurityBandChecks(spawnScope.securityBands);
  $("#spawnWeightInput").value = spawnScope.weight ?? 1;
  $("#maxPerSystemInput").value = spawnScope.maxConcurrentPerSystem ?? 1;
  $("#respawnMinutesInput").value = spawnScope.respawnMinutes ?? 60;
  $("#slotCountInput").value = spawnScope.slotCount ?? 1;
  setAnchorKind(placement.anchorKind || "system");
  if (placement.position) {
    $("#coordX").value = placement.position.x || 0;
    $("#coordY").value = placement.position.y || 0;
    $("#coordZ").value = placement.position.z || 0;
  }
  if (overlay.solarSystemID) {
    await selectSystem(overlay.solarSystemID);
    if (placement.anchorKind === "stargate" && placement.anchorID && state.selectedSystem) {
      state.selectedGate = state.selectedSystem.stargates.find((gate) => gate.itemID === placement.anchorID) || null;
    }
  }
  renderAll();
  renderValidation(overlay.validation || { findings: [], ok: true });
}

function resetDraftFields() {
  state.loadedOverlayId = "";
  state.baseTemplate = null;
  state.selectedTemplateRaw = null;
  state.selectedSystem = null;
  state.selectedGate = null;
  state.rooms = [];
  state.gates = [];
  state.encounters = [];
  state.resources = [];
  state.npcOverrides = [];
  state.lootTables = [];
  state.completion = null;
  state.missionSecurity = null;
  state.sourceLinks = [];
  state.scopeMode = "any_eligible";
  state.securityBands = ["highsec", "lowsec", "nullsec", "wormhole"];
  state.anchorKind = "system";

  $("#titleInput").value = "";
  $("#templateIdInput").value = "";
  $("#statusInput").value = "draft";
  $("#templateSearchInput").value = "";
  $("#resourceSearchInput").value = "";
  $("#resourceResults").innerHTML = "";
  $("#systemSearchInput").value = "";
  $("#systemResults").innerHTML = "";
  $("#gateList").innerHTML = "";
  $("#notesInput").value = "";
  $("#coordX").value = 0;
  $("#coordY").value = 0;
  $("#coordZ").value = 0;
  setSecurityBandChecks(state.securityBands);
  $("#spawnWeightInput").value = 1;
  $("#maxPerSystemInput").value = 1;
  $("#respawnMinutesInput").value = 60;
  $("#slotCountInput").value = 1;
  renderSpawnScope();
  renderValidation({ findings: [], ok: true });
}

function resetForm() {
  state.contentFamily = "combat";
  state.delivery = "anomaly";
  state.missionType = "combat";
  resetDraftFields();
  syncContentControls();
  void loadTemplateOptions();
  applyDefaultsForCurrentContent();
  renderAll();
}

async function loadStatus() {
  const data = await api("/api/status");
  $("#dataMode").textContent = data.status.activeReadMode;
  $("#metricTemplates").textContent = data.catalogSummary.templateCount.toLocaleString();
  $("#metricNpcs").textContent = data.catalogSummary.npcProfileCount.toLocaleString();
  $("#metricOverlays").textContent = data.overlayCount.toLocaleString();
}

function renderSystemsView(systems) {
  const grid = $("#systemsViewResults");
  grid.innerHTML = "";
  systems.forEach((system) => {
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `
      <div>
        <div class="item-title"></div>
        <div class="item-meta"></div>
      </div>
      <button class="secondary">${iconText("check", "Use")}</button>
    `;
    row.querySelector(".item-title").textContent = system.name;
    row.querySelector(".item-meta").textContent = smallMeta([system.solarSystemID, system.securityBand, `sec ${system.displayedSecurity}`, `${system.stargateCount} gates`]);
    row.querySelector("button").addEventListener("click", async () => {
      setView("builder");
      await selectSystem(system.solarSystemID);
    });
    grid.appendChild(row);
    hydrateIcons(row);
  });
}

function npcKindLabel(kind) {
  return {
    profiles: "profile",
    loadouts: "loadout",
    behaviorProfiles: "behavior",
    spawnGroups: "spawn group",
    spawnPools: "spawn pool",
    lootTables: "loot table",
    startupRules: "startup rule",
  }[kind] || kind;
}

function npcSearchMeta(kind, row) {
  if (kind === "profiles") {
    return smallMeta([row.profileID, row.shipTypeName, row.entityType, row.loadoutID, row.lootTableID, row.bounty ? `${row.bounty} ISK` : ""]);
  }
  if (kind === "loadouts") {
    return smallMeta([row.id, `${row.modulesCount || 0} modules`, `${row.chargesCount || 0} charges`, `${row.cargoCount || 0} cargo`]);
  }
  if (kind === "spawnGroups") {
    return smallMeta([row.id, `${row.entriesCount || 0} entries`, `${row.memberCount || 0} members`, (row.sampleMembers || []).join(", ")]);
  }
  if (kind === "spawnPools") {
    return smallMeta([row.id, `${row.entriesCount || 0} weighted entries`, row.entityType, (row.sampleProfiles || []).join(", ")]);
  }
  if (kind === "lootTables") {
    return smallMeta([row.id, `${row.guaranteedEntriesCount || 0} guaranteed`, `${row.entriesCount || 0} weighted`, `rolls ${row.minEntries || 0}-${row.maxEntries || 0}`]);
  }
  return smallMeta([row.id, row.name]);
}

function entrySummaryHTML(entries, columns) {
  const rows = Array.isArray(entries) ? entries.slice(0, 16) : [];
  if (!rows.length) {
    return `<div class="detail-empty">No entries.</div>`;
  }
  return `
    <div class="detail-table">
      ${rows.map((entry) => `
        <div class="detail-table-row">
          ${columns.map((column) => `<span>${escapeHTML(entry && entry[column] !== undefined ? entry[column] : "")}</span>`).join("")}
        </div>
      `).join("")}
    </div>
  `;
}

function npcDetailSummaryHTML(kind, row) {
  if (kind === "profiles") {
    return `
      <div class="detail-facts">
        <span>${icon("ship")} ${escapeHTML(smallMeta([row.shipTypeID ? `ship ${row.shipTypeID}` : "", row.entityType]))}</span>
        <span>${icon("brain")} ${escapeHTML(row.behaviorProfileID || "no behavior")}</span>
        <span>${icon("wrench")} ${escapeHTML(row.loadoutID || "no loadout")}</span>
        <span>${icon("package-open")} ${escapeHTML(row.lootTableID || "no loot table")}</span>
        <span>${icon("circle-dollar-sign")} ${escapeHTML(row.bounty || 0)} ISK</span>
      </div>
    `;
  }
  if (kind === "loadouts") {
    return `
      <div class="detail-facts">
        <span>${icon("wrench")} ${(Array.isArray(row.modules) ? row.modules.length : 0)} modules</span>
        <span>${icon("battery-charging")} ${(Array.isArray(row.charges) ? row.charges.length : 0)} charges</span>
        <span>${icon("package")} ${(Array.isArray(row.cargo) ? row.cargo.length : 0)} cargo</span>
      </div>
      <h4>Modules</h4>
      ${entrySummaryHTML(row.modules, ["slot", "typeID", "name"])}
      <h4>Charges</h4>
      ${entrySummaryHTML(row.charges, ["typeID", "quantity"])}
    `;
  }
  if (kind === "spawnPools") {
    return `
      <div class="detail-facts">
        <span>${icon("shuffle")} ${(Array.isArray(row.entries) ? row.entries.length : 0)} weighted entries</span>
        <span>${icon("tag")} ${escapeHTML(row.entityType || "any entity")}</span>
      </div>
      <h4>Weighted Profiles</h4>
      ${entrySummaryHTML(row.entries, ["profileID", "weight"])}
    `;
  }
  if (kind === "spawnGroups") {
    return `
      <div class="detail-facts">
        <span>${icon("users")} ${(Array.isArray(row.entries) ? row.entries.length : 0)} composition entries</span>
        <span>${icon("tag")} ${escapeHTML(row.entityType || "any entity")}</span>
      </div>
      <h4>Composition</h4>
      ${entrySummaryHTML(row.entries, ["profileID", "spawnPoolID", "count", "minCount", "maxCount"])}
    `;
  }
  if (kind === "lootTables") {
    return `
      <div class="detail-facts">
        <span>${icon("dice-5")} rolls ${escapeHTML(row.minEntries || 0)}-${escapeHTML(row.maxEntries || 0)}</span>
        <span>${icon("package-check")} ${(Array.isArray(row.guaranteedEntries) ? row.guaranteedEntries.length : 0)} guaranteed</span>
        <span>${icon("shuffle")} ${(Array.isArray(row.entries) ? row.entries.length : 0)} weighted</span>
        <span>${icon("copy")} ${row.allowDuplicates === true ? "duplicates allowed" : "unique weighted rolls"}</span>
      </div>
      <h4>Guaranteed Entries</h4>
      ${entrySummaryHTML(row.guaranteedEntries, ["typeID", "quantity", "minQuantity", "maxQuantity"])}
      <h4>Weighted Entries</h4>
      ${entrySummaryHTML(row.entries, ["typeID", "weight", "quantity", "minQuantity", "maxQuantity"])}
    `;
  }
  return `<div class="detail-facts"><span>${icon("file-json")} Raw ${escapeHTML(npcKindLabel(kind))} row</span></div>`;
}

async function showNpcDetail(kind, id) {
  const detail = $("#npcDetail");
  const data = await api(`/api/npcs/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
  const row = data.row || {};
  detail.hidden = false;
  detail.innerHTML = `
    <div class="section-heading">
      <h3>${icon("bot")}<span>${escapeHTML(row.name || id)}</span></h3>
      <button class="secondary" data-copy-id>${iconText("copy", "Copy ID")}</button>
    </div>
    <div class="item-meta">${escapeHTML(smallMeta([npcKindLabel(kind), id]))}</div>
    <div class="detail-summary">${npcDetailSummaryHTML(kind, row)}</div>
    <h4>Raw Row</h4>
    <pre class="json-preview"></pre>
  `;
  detail.querySelector("pre").textContent = JSON.stringify(row, null, 2);
  detail.querySelector("[data-copy-id]").addEventListener("click", async () => {
    await navigator.clipboard.writeText(id);
    showNotice(`Copied ${id}`);
  });
  hydrateIcons(detail);
}

async function searchNpcs() {
  const kind = $("#npcKindSelect").value;
  const q = encodeURIComponent($("#npcSearchInput").value.trim());
  const data = await api(`/api/npcs?kind=${kind}&q=${q}&limit=48`);
  const grid = $("#npcResults");
  const detail = $("#npcDetail");
  grid.innerHTML = "";
  detail.hidden = true;
  detail.innerHTML = "";
  data.npcs.forEach((npc) => {
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `
      <div>
        <div class="item-title"></div>
        <div class="item-meta"></div>
      </div>
      <div class="overlay-actions">
        <button class="secondary details-button">${iconText("eye", "Details")}</button>
        <button class="secondary copy-button">${iconText("copy", "Copy")}</button>
      </div>
    `;
    const id = npc.profileID || npc.id;
    row.querySelector(".item-title").textContent = npc.name || id;
    row.querySelector(".item-meta").textContent = npcSearchMeta(kind, npc);
    row.querySelector(".details-button").addEventListener("click", () => {
      showNpcDetail(kind, id).catch((error) => showNotice(error.message));
    });
    row.querySelector(".copy-button").addEventListener("click", async () => {
      await navigator.clipboard.writeText(id);
      showNotice(`Copied ${id}`);
    });
    grid.appendChild(row);
    hydrateIcons(row);
  });
}

function missionObjectiveSummary(mission) {
  const objective = mission.objective || {};
  if (mission.missionType === "combat") {
    return smallMeta([objective.templateID || mission.linkedTemplateID, objective.dungeonID ? `dungeon ${objective.dungeonID}` : ""]);
  }
  if (objective.objectiveTypeName || objective.objectiveTypeID) {
    return smallMeta([
      objective.objectiveTypeName || `typeID ${objective.objectiveTypeID}`,
      objective.objectiveQuantity ? `qty ${objective.objectiveQuantity}` : "",
    ]);
  }
  return "";
}

// ===== Mission Designer =====

const missionState = {
  active: false,
  loadedOverlayId: "",
  missionID: 0,
  missionName: "",
  missionType: "combat",
  baseTemplate: null,
  selectedTemplateRaw: null,
  rooms: [],
  gates: [],
  encounters: [],
  miningRocks: [],
  environmentProps: [],
  objectiveTypeID: 0,
  objectiveQuantity: 0,
  missionRecord: null,
  lootTables: [],
  completion: null,
  missionSecurity: null,
  sourceLinks: [],
};

function blankMissionState() {
  missionState.active = true;
  missionState.loadedOverlayId = "";
  missionState.missionID = 0;
  missionState.missionName = "";
  missionState.missionType = "combat";
  missionState.baseTemplate = null;
  missionState.selectedTemplateRaw = null;
  missionState.rooms = [];
  missionState.gates = [];
  missionState.encounters = [];
  missionState.miningRocks = [];
  missionState.environmentProps = [];
  missionState.objectiveTypeID = 0;
  missionState.objectiveQuantity = 0;
  missionState.missionRecord = null;
  missionState.lootTables = [];
  missionState.completion = null;
  missionState.missionSecurity = null;
  missionState.sourceLinks = [];
}

function missionOverlayFromForm() {
  return {
    id: missionState.loadedOverlayId || undefined,
    title: $("#missionTitleInput").value.trim(),
    templateID: $("#missionTemplateIdInput").value.trim(),
    contentFamily: "mission",
    delivery: "mission_private",
    kind: "mission_combat",
    missionType: $("#missionCategorySelect").value || "combat",
    status: $("#missionStatusInput").value,
    baseTemplateID: missionState.baseTemplate ? missionState.baseTemplate.templateID : "",
    spawnScope: {
      mode: "any_eligible",
      securityBands: ["highsec", "lowsec", "nullsec", "wormhole"],
      maxConcurrentPerSystem: 1,
      weight: 1,
      respawnMinutes: 60,
      slotCount: 1,
      solarSystemID: 0,
      stargateID: 0,
    },
    solarSystemID: 0,
    placement: { anchorKind: "system" },
    scanner: { visibility: "private_mission", signalStrength: null },
    rooms: missionState.rooms,
    gates: missionState.gates,
    encounters: missionState.encounters,
    miningRocks: missionState.miningRocks,
    environmentProps: missionState.environmentProps,
    objectiveTypeID: Number(missionState.objectiveTypeID) || 0,
    objectiveQuantity: Number(missionState.objectiveQuantity) || 0,
    missionRecord: missionState.missionRecord,
    resources: [],
    npcOverrides: [],
    lootTables: missionState.lootTables,
    completion: deriveMissionCompletion(),
    missionSecurity: missionState.missionSecurity,
    sourceLinks: missionState.sourceLinks,
    notes: $("#missionNotesInput").value.trim(),
  };
}

// --- NPC name resolution (id -> {name, ship, ...}), cached client-side ---
const npcCache = new Map();

function npcSourceId(encounter) {
  const candidate = encounter && Array.isArray(encounter.candidateNames) ? encounter.candidateNames[0] : "";
  return String(
    (encounter && (encounter.profileID || encounter.spawnPoolID || encounter.spawnGroupID || encounter.spawnQuery)) || candidate || "",
  ).trim();
}

function npcSourceIcon(encounter) {
  if (encounter && encounter.spawnPoolID) return "shuffle";
  if (encounter && encounter.spawnGroupID) return "users";
  if (encounter && encounter.spawnQuery && !encounter.profileID) return "search-code";
  return "crosshair";
}

async function resolveNpcIds(ids) {
  const missing = [...new Set((ids || []).filter((id) => id && !npcCache.has(id)))];
  if (!missing.length) return;
  try {
    const data = await api(`/api/npcs/resolve?ids=${encodeURIComponent(missing.join(","))}`);
    (data.npcs || []).forEach((npc) => npcCache.set(npc.id, npc));
  } catch (_error) {
    /* leave unresolved ids to render as raw id */
  }
}

function npcDisplay(id) {
  const npc = npcCache.get(id);
  if (!npc) return { name: id, meta: "resolving..." };
  if (npc.kind === "profile") {
    return { name: npc.name, meta: smallMeta([npc.shipTypeName, npc.bounty ? `${Number(npc.bounty).toLocaleString()} ISK` : ""]) };
  }
  if (npc.kind === "pool") {
    return { name: npc.name, meta: smallMeta(["faction pool", `${(npc.sampleProfiles || []).length} ship types`]) };
  }
  if (npc.kind === "group") {
    return { name: npc.name, meta: "spawn group" };
  }
  return { name: npc.name || id, meta: "unresolved id" };
}

function genEncounterKey() {
  return `enc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function ensureEncounterKeys() {
  missionState.encounters.forEach((encounter) => {
    if (!encounter.key) encounter.key = genEncounterKey();
  });
}

// Group the flat encounter list into displayable groups keyed by (room, sourceGroup).
function missionGroups() {
  const order = [];
  const byID = new Map();
  const fallbackRoom = (missionState.rooms[0] && missionState.rooms[0].roomKey) || "room:combat";
  missionState.encounters.forEach((encounter) => {
    const roomKey = encounter.roomKey || fallbackRoom;
    const name = encounter.sourceGroup || encounter.label || encounter.key || "Group";
    const gid = `${roomKey}::${name}`;
    if (!byID.has(gid)) {
      const group = { gid, roomKey, name, encounters: [] };
      byID.set(gid, group);
      order.push(group);
    }
    byID.get(gid).encounters.push(encounter);
  });
  return order;
}

function groupIsObjective(group) {
  return group.encounters.some((encounter) => encounter.objective === true);
}

function nextGroupName(roomKey) {
  const used = new Set(missionState.encounters.filter((e) => (e.roomKey || "") === roomKey).map((e) => e.sourceGroup));
  let index = 1;
  while (used.has(`Group ${index}`)) index += 1;
  return `Group ${index}`;
}

function objectiveGroupNames() {
  return [...new Set(missionState.encounters.filter((e) => e.objective).map((e) => e.sourceGroup).filter(Boolean))];
}

function deriveMissionCompletion() {
  if (missionState.missionType === "mining") {
    return {
      mode: "mine_quantity",
      objectiveTypeID: Number(missionState.objectiveTypeID) || 0,
      objectiveQuantity: Number(missionState.objectiveQuantity) || 0,
      despawnDelaySeconds: 0,
    };
  }
  const objectiveKeys = missionState.encounters.filter((e) => e.objective && e.key).map((e) => e.key);
  if (objectiveKeys.length) {
    return { mode: "encounter_group_cleared", encounterKeys: objectiveKeys, despawnDelaySeconds: 0 };
  }
  return { mode: "encounters_cleared", despawnDelaySeconds: 0 };
}

function triggerOptionsHTML(selected) {
  const options = [
    ["on_load", "On warp-in"],
    ["on_room_active", "When pocket entered"],
    ["wave_cleared", "After previous group"],
    ["timer", "On timer"],
  ];
  return options.map(([value, label]) => `<option value="${value}"${value === (selected || "on_load") ? " selected" : ""}>${label}</option>`).join("");
}

function roleOptionsHTML(selected) {
  const options = [
    ["combat", "Combat pocket"],
    ["mining", "Mining pocket"],
    ["gate_only", "Gate-only entry"],
    ["open", "Open pocket"],
    ["entry", "Entry pocket"],
  ];
  return options.map(([value, label]) => `<option value="${value}"${value === (selected || "combat") ? " selected" : ""}>${label}</option>`).join("");
}

function renderMissionOverview() {
  const host = $("#missionOverview");
  if (!host) return;
  const sec = missionState.missionSecurity || {};
  const facts = [`${icon("briefcase")} ${missionTypeLabel($("#missionCategorySelect").value)}`];
  if (missionState.missionID) facts.push(`${icon("hash")} mission ${missionState.missionID}`);
  if (sec.faction) facts.push(`${icon("flag")} ${escapeHTML(sec.faction)}`);
  if (sec.level) facts.push(`${icon("bar-chart-3")} Level ${escapeHTML(String(sec.level))}`);
  facts.push(`${icon("door-open")} ${missionState.rooms.length} pocket${missionState.rooms.length === 1 ? "" : "s"}`);
  facts.push(`${icon("radar")} ${missionState.encounters.length} NPC line${missionState.encounters.length === 1 ? "" : "s"}`);
  if (missionState.missionType === "mining") {
    if (missionState.objectiveTypeID) facts.push(`${icon("pickaxe")} type ${escapeHTML(String(missionState.objectiveTypeID))}`);
    if (missionState.objectiveQuantity) facts.push(`${icon("hash")} qty ${escapeHTML(String(missionState.objectiveQuantity))}`);
    facts.push(`${icon("asterisk")} ${missionState.miningRocks.length} rock spec${missionState.miningRocks.length === 1 ? "" : "s"}`);
    facts.push(`${icon("boxes")} ${missionState.environmentProps.length} prop${missionState.environmentProps.length === 1 ? "" : "s"}`);
  }
  if (sec.damageProfile) facts.push(`${icon("zap")} ${escapeHTML(sec.damageProfile)}`);
  if (sec.ewar) facts.push(`${icon("radio")} ${escapeHTML(sec.ewar)}`);
  if (sec.recommendedShip) facts.push(`${icon("ship")} ${escapeHTML(sec.recommendedShip)}`);
  const objective = sec.objectiveSummary
    ? `<div class="overview-objective">${icon("target")}<span>${escapeHTML(sec.objectiveSummary)}</span></div>`
    : "";
  const source = sec.sourceUrl
    ? `<a class="overview-source" href="${escapeHTML(sec.sourceUrl)}" target="_blank" rel="noreferrer">${iconText("external-link", sec.sourceName || "Source")}</a>`
    : "";
  host.innerHTML = `<div class="fact-row">${facts.map((fact) => `<span>${fact}</span>`).join("")}</div>${objective}${source}`;
  hydrateIcons(host);
}

function renderMissionCompletionSummary() {
  const host = $("#missionCompletionSummary");
  if (!host) return;
  if (missionState.missionType === "mining") {
    host.innerHTML = `${icon("pickaxe")}<span>Mission completes after mining <strong>${escapeHTML(String(missionState.objectiveQuantity || 0))}</strong> units of type <strong>${escapeHTML(String(missionState.objectiveTypeID || "?"))}</strong>.</span>`;
    hydrateIcons(host);
    return;
  }
  const names = objectiveGroupNames();
  host.innerHTML = names.length
    ? `${icon("flag")}<span>Mission completes when <strong>${names.map(escapeHTML).join(", ")}</strong> ${names.length > 1 ? "are" : "is"} destroyed.</span>`
    : `${icon("flag")}<span>Mission completes when <strong>all hostiles</strong> are cleared.</span>`;
  hydrateIcons(host);
}

function setEncounterNpc(encounter, choice) {
  encounter.profileID = choice.kind === "profile" ? choice.id : "";
  encounter.spawnPoolID = choice.kind === "pool" ? choice.id : "";
  encounter.spawnGroupID = "";
  encounter.spawnQuery = "";
  npcCache.set(choice.id, {
    id: choice.id,
    kind: choice.kind,
    name: choice.name,
    shipTypeName: choice.shipTypeName || "",
    bounty: choice.bounty || 0,
    sampleProfiles: choice.sampleProfiles || [],
  });
  missionState.pickerKey = "";
  renderMission();
}

async function runNpcPickerSearch(encounter, row) {
  const query = row.querySelector(".npc-search").value.trim();
  const results = row.querySelector(".npc-results");
  results.innerHTML = `<div class="empty-hint">Searching NPCs...</div>`;
  const [profiles, pools] = await Promise.all([
    api(`/api/npcs?kind=profiles&q=${encodeURIComponent(query)}&limit=12`),
    api(`/api/npcs?kind=spawnPools&q=${encodeURIComponent(query)}&limit=6`),
  ]);
  const choices = [
    ...(pools.npcs || []).map((pool) => ({
      kind: "pool",
      id: pool.id,
      name: pool.name || pool.id,
      sampleProfiles: pool.sampleProfiles || [],
      meta: smallMeta(["Faction pool", `${(pool.sampleProfiles || []).length} ship types`]),
    })),
    ...(profiles.npcs || []).map((profile) => ({
      kind: "profile",
      id: profile.profileID,
      name: profile.name || profile.profileID,
      shipTypeName: profile.shipTypeName || "",
      bounty: profile.bounty || 0,
      meta: smallMeta([profile.shipTypeName, profile.bounty ? `${Number(profile.bounty).toLocaleString()} ISK` : ""]),
    })),
  ];
  results.innerHTML = "";
  if (!choices.length) {
    results.innerHTML = `<div class="empty-hint">No NPCs match "${escapeHTML(query)}".</div>`;
    return;
  }
  choices.forEach((choice) => {
    const item = document.createElement("div");
    item.className = "result-item";
    item.innerHTML = `<div><div class="item-title"></div><div class="item-meta"></div></div><button class="secondary">${iconText("check", "Use")}</button>`;
    item.querySelector(".item-title").textContent = choice.name;
    item.querySelector(".item-meta").textContent = choice.meta;
    item.querySelector("button").addEventListener("click", () => setEncounterNpc(encounter, choice));
    results.appendChild(item);
    hydrateIcons(item);
  });
}

function renderNpcLine(encounter, group) {
  const row = document.createElement("div");
  const sourceId = npcSourceId(encounter);
  const picking = missionState.pickerKey === encounter.key || !sourceId;
  if (picking) {
    row.className = "npc-line is-picking";
    row.innerHTML = `
      <div class="npc-picker">
        <div class="search-row">
          <input class="npc-search" placeholder="Search NPC by name or ship (e.g. Guristas, Kestrel)">
          <button class="secondary square npc-search-btn">${iconText("search", "Search")}</button>
          <button class="secondary npc-cancel">${iconText("x", "Cancel")}</button>
        </div>
        <div class="npc-results"></div>
      </div>
    `;
    const search = row.querySelector(".npc-search");
    row.querySelector(".npc-search-btn").addEventListener("click", () => runNpcPickerSearch(encounter, row));
    search.addEventListener("keydown", (event) => { if (event.key === "Enter") runNpcPickerSearch(encounter, row); });
    row.querySelector(".npc-cancel").addEventListener("click", () => {
      if (!sourceId) {
        const idx = missionState.encounters.indexOf(encounter);
        if (idx >= 0) missionState.encounters.splice(idx, 1);
      }
      missionState.pickerKey = "";
      renderMission();
    });
    runNpcPickerSearch(encounter, row);
    return row;
  }
  row.className = "npc-line";
  // Scraped spawns carry ship names (candidateNames) rather than a resolved NPC profile.
  const display = (Array.isArray(encounter.candidateNames) && encounter.candidateNames.length)
    ? { name: encounter.shipClass || "NPC", meta: encounter.candidateNames.join(" / ") }
    : npcDisplay(sourceId);
  row.innerHTML = `
    <input type="number" class="npc-count" min="1" value="${Math.max(1, Number(encounter.count) || 1)}" title="Count">
    <span class="npc-times">${icon("x")}</span>
    <div class="npc-chip">${icon(npcSourceIcon(encounter))}<div><strong>${escapeHTML(display.name)}</strong><span>${escapeHTML(display.meta)}</span></div></div>
    <button class="secondary npc-change" title="Change NPC">${iconText("repeat", "")}</button>
    <button class="remove-row npc-remove" title="Remove">${iconText("trash-2", "")}</button>
  `;
  row.querySelector(".npc-count").addEventListener("input", (event) => {
    encounter.count = Math.max(1, Number(event.target.value) || 1);
    encounter.amount = encounter.count;
  });
  row.querySelector(".npc-change").addEventListener("click", () => { missionState.pickerKey = encounter.key; renderMission(); });
  row.querySelector(".npc-remove").addEventListener("click", () => {
    const idx = missionState.encounters.indexOf(encounter);
    if (idx >= 0) missionState.encounters.splice(idx, 1);
    renderMission();
  });
  return row;
}

function applyToGroup(group, mutate) {
  group.encounters.forEach(mutate);
}

function renderGroupCard(group) {
  const objective = groupIsObjective(group);
  const first = group.encounters[0] || {};
  const card = document.createElement("div");
  card.className = `spawn-group${objective ? " is-objective" : ""}`;
  card.innerHTML = `
    <div class="group-head">
      <input class="group-name" value="${escapeHTML(group.name)}" title="Group name">
      <label class="objective-flag"><input type="checkbox" class="group-objective"${objective ? " checked" : ""}><span>${iconText("target", "Objective")}</span></label>
      <button class="remove-row remove-group" title="Remove group">${iconText("trash-2", "")}</button>
    </div>
    <div class="group-meta">
      <label><span>Spawns</span><select class="group-trigger">${triggerOptionsHTML(first.trigger)}</select></label>
      <label><span>Distance (m)</span><input type="number" class="group-distance" min="0" step="1000" value="${Number(first.distanceMeters) || 0}"></label>
    </div>
    <div class="npc-lines"></div>
    <button class="secondary add-npc-btn">${iconText("plus", "Add NPC")}</button>
  `;
  const linesHost = card.querySelector(".npc-lines");
  group.encounters.forEach((encounter) => linesHost.appendChild(renderNpcLine(encounter, group)));
  card.querySelector(".group-name").addEventListener("change", (event) => {
    const value = event.target.value.trim() || group.name;
    applyToGroup(group, (e) => { e.sourceGroup = value; });
    renderMission();
  });
  card.querySelector(".group-objective").addEventListener("change", (event) => {
    const on = event.target.checked;
    applyToGroup(group, (e) => { e.objective = on; e.completionRole = on ? "objective" : null; });
    renderMission();
  });
  card.querySelector(".group-trigger").addEventListener("change", (event) => {
    applyToGroup(group, (e) => { e.trigger = event.target.value; });
  });
  card.querySelector(".group-distance").addEventListener("input", (event) => {
    const value = Number(event.target.value) || 0;
    applyToGroup(group, (e) => { e.distanceMeters = value; });
  });
  card.querySelector(".add-npc-btn").addEventListener("click", () => {
    const encounter = {
      key: genEncounterKey(),
      sourceGroup: group.name,
      roomKey: group.roomKey,
      trigger: first.trigger || "on_load",
      distanceMeters: Number(first.distanceMeters) || 30000,
      objective,
      completionRole: objective ? "objective" : null,
      count: 1,
      profileID: "",
    };
    missionState.encounters.push(encounter);
    missionState.pickerKey = encounter.key;
    renderMission();
  });
  hydrateIcons(card);
  return card;
}

function renderMissionPockets() {
  const host = $("#missionPockets");
  if (!host) return;
  host.innerHTML = "";
  if (!missionState.rooms.length) {
    missionState.rooms = [{ roomKey: "room:combat", label: "Pocket 1", role: "combat", initialState: "active" }];
  }
  const groups = missionGroups();
  missionState.rooms.forEach((room, roomIndex) => {
    const pocket = document.createElement("div");
    pocket.className = "pocket";
    pocket.innerHTML = `
      <div class="pocket-head">
        <div class="pocket-title">
          <span class="pocket-index">${roomIndex + 1}</span>
          <input class="pocket-name" value="${escapeHTML(room.label || `Pocket ${roomIndex + 1}`)}" title="Pocket name">
        </div>
        <div class="pocket-tools">
          <select class="pocket-role">${roleOptionsHTML(room.role)}</select>
          <button class="secondary add-group-btn">${iconText("plus", "Group")}</button>
          ${missionState.rooms.length > 1 ? `<button class="remove-row remove-pocket" title="Remove pocket">${iconText("trash-2", "")}</button>` : ""}
        </div>
      </div>
      <div class="pocket-groups"></div>
    `;
    const groupsHost = pocket.querySelector(".pocket-groups");
    const roomGroups = groups.filter((group) => group.roomKey === room.roomKey);
    if (!roomGroups.length) {
      groupsHost.innerHTML = `<div class="empty-hint">No spawn groups yet. Add a group of NPCs.</div>`;
    }
    roomGroups.forEach((group) => groupsHost.appendChild(renderGroupCard(group)));
    pocket.querySelector(".pocket-name").addEventListener("change", (event) => { room.label = event.target.value.trim() || room.label; renderMissionOverview(); });
    pocket.querySelector(".pocket-role").addEventListener("change", (event) => { room.role = event.target.value; });
    pocket.querySelector(".add-group-btn").addEventListener("click", () => {
      const encounter = {
        key: genEncounterKey(),
        sourceGroup: nextGroupName(room.roomKey),
        roomKey: room.roomKey,
        trigger: "on_load",
        distanceMeters: 30000,
        count: 1,
        profileID: "",
      };
      missionState.encounters.push(encounter);
      missionState.pickerKey = encounter.key;
      renderMission();
    });
    const removePocket = pocket.querySelector(".remove-pocket");
    if (removePocket) {
      removePocket.addEventListener("click", () => {
        missionState.encounters = missionState.encounters.filter((e) => (e.roomKey || "") !== room.roomKey);
        missionState.rooms = missionState.rooms.filter((r) => r !== room);
        renderMission();
      });
    }
    host.appendChild(pocket);
    hydrateIcons(pocket);
  });
}

function renderMissionGates() {
  const list = $("#missionGateList");
  if (!list) return;
  list.innerHTML = "";
  if (!missionState.gates.length) {
    list.innerHTML = `<div class="empty-hint">No acceleration gates. Single-pocket missions don't need one; add a gate to connect multiple pockets.</div>`;
    return;
  }
  missionState.gates.forEach((gate, index) => {
    const row = document.createElement("div");
    row.className = "editor-row";
    const roomOptions = missionState.rooms
      .map((room) => `<option value="${escapeHTML(room.roomKey)}"${room.roomKey === gate.destinationRoomKey ? " selected" : ""}>${escapeHTML(room.label || room.roomKey)}</option>`)
      .join("");
    row.innerHTML = `
      <div class="editor-row-grid">
        <label class="wide"><span>Leads To Pocket</span><select data-field="destinationRoomKey">${roomOptions}</select></label>
        <label><span>Initial State</span><select data-field="initialState"><option value="unlocked">Unlocked</option><option value="locked">Locked</option></select></label>
        <button class="remove-row">${iconText("trash-2", "Remove")}</button>
      </div>
    `;
    bindRow(row, gate, () => { missionState.gates.splice(index, 1); renderMission(); });
    list.appendChild(row);
    hydrateIcons(row);
  });
}

function formatJson(value) {
  return JSON.stringify(value || [], null, 2);
}

function parseArrayJsonField(field, label) {
  const raw = field.value.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array.`);
  }
  return parsed;
}

function parseObjectJsonField(field, label) {
  const raw = field.value.trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function renderMissionRecord() {
  const panel = $("#missionRecordPanel");
  if (!panel) return;
  const field = $("#missionRecordJson");
  const hasRecord = missionState.missionRecord && typeof missionState.missionRecord === "object";
  panel.hidden = !hasRecord;
  if (!hasRecord) return;
  field.value = JSON.stringify(missionState.missionRecord, null, 2);
  field.onchange = () => {
    try {
      missionState.missionRecord = parseObjectJsonField(field, "Mission record");
      field.value = JSON.stringify(missionState.missionRecord, null, 2);
      showNotice("Mission record JSON accepted.");
    } catch (error) {
      showNotice(error.message);
      field.value = JSON.stringify(missionState.missionRecord || {}, null, 2);
    }
  };
}

function renderMissionMining() {
  const panel = $("#missionMiningPanel");
  if (!panel) return;
  const isMining = missionState.missionType === "mining" || $("#missionCategorySelect").value === "mining";
  panel.hidden = !isMining;
  if (!isMining) return;
  const objectiveTypeInput = $("#missionObjectiveTypeInput");
  const objectiveQuantityInput = $("#missionObjectiveQuantityInput");
  const rocksJson = $("#missionMiningRocksJson");
  const propsJson = $("#missionEnvironmentPropsJson");
  objectiveTypeInput.value = missionState.objectiveTypeID || "";
  objectiveQuantityInput.value = missionState.objectiveQuantity || "";
  rocksJson.value = formatJson(missionState.miningRocks);
  propsJson.value = formatJson(missionState.environmentProps);
  objectiveTypeInput.oninput = () => {
    missionState.objectiveTypeID = Number(objectiveTypeInput.value) || 0;
    renderMissionOverview();
    renderMissionCompletionSummary();
  };
  objectiveQuantityInput.oninput = () => {
    missionState.objectiveQuantity = Number(objectiveQuantityInput.value) || 0;
    renderMissionOverview();
    renderMissionCompletionSummary();
  };
  rocksJson.onchange = () => {
    try {
      missionState.miningRocks = parseArrayJsonField(rocksJson, "Mining rocks");
      rocksJson.value = formatJson(missionState.miningRocks);
      showNotice("Mining rocks JSON accepted.");
    } catch (error) {
      showNotice(error.message);
      rocksJson.value = formatJson(missionState.miningRocks);
    }
  };
  propsJson.onchange = () => {
    try {
      missionState.environmentProps = parseArrayJsonField(propsJson, "Environment props");
      propsJson.value = formatJson(missionState.environmentProps);
      showNotice("Environment props JSON accepted.");
    } catch (error) {
      showNotice(error.message);
      propsJson.value = formatJson(missionState.environmentProps);
    }
  };
}

function renderMissionSelectedTemplate() {
  const card = $("#missionSelectedTemplateCard");
  if (!card) return;
  const templateID = $("#missionTemplateIdInput").value.trim();
  if (!missionState.baseTemplate) {
    card.innerHTML = `
      <div class="blank-state">
        ${icon("file-plus-2")}
        <div>
          <strong>${missionState.missionID ? "Blank mission site" : "No linked dungeon template"}</strong>
          <span>${templateID ? `Authoring ${escapeHTML(templateID)} as a private mission site.` : "Add mission mechanics to define the site."}</span>
        </div>
      </div>
    `;
    hydrateIcons(card);
    return;
  }
  const template = missionState.baseTemplate;
  card.innerHTML = `
    <div class="template-card-head">
      <div>
        <strong>${escapeHTML(template.name || template.templateID)}</strong>
        <span>${escapeHTML(template.templateID)}</span>
      </div>
      <span class="status-pill">${deliveryLabel(template.delivery)}</span>
    </div>
    <div class="template-facts">
      <span>${icon("radar")}${escapeHTML(`${template.siteFamily}/${template.siteKind}`)}</span>
      <span>${icon("activity")}difficulty ${template.difficulty || 0}</span>
      <span>${icon("waves")}${template.encounterCount || 0} waves</span>
      <span>${icon("door-open")}${template.gateCount || 0} gates</span>
    </div>
  `;
  hydrateIcons(card);
}

function renderMission() {
  $("#missionEmpty").hidden = missionState.active;
  $("#missionAuthoring").hidden = !missionState.active;
  if (!missionState.active) return;
  ensureEncounterKeys();
  renderMissionOverview();
  renderMissionSelectedTemplate();
  renderMissionRecord();
  renderMissionCompletionSummary();
  renderMissionPockets();
  renderMissionGates();
  renderMissionMining();
  renderLootTables($("#missionLootList"), missionState.lootTables, renderMission);
}

function populateMissionForm({ title, templateID, status, missionType }) {
  $("#missionTitleInput").value = title || "";
  $("#missionTemplateIdInput").value = templateID || "";
  $("#missionStatusInput").value = status || "draft";
  $("#missionCategorySelect").value = missionType || "combat";
}

function renderMissionValidation(validation) {
  const list = $("#missionValidationList");
  if (!list) return;
  list.innerHTML = "";
  if (!validation.findings.length) {
    const ok = document.createElement("div");
    ok.className = "validation-item ok";
    ok.innerHTML = `${icon("check-circle-2")}<span>Valid mission template entry.</span>`;
    list.appendChild(ok);
    hydrateIcons(ok);
    return;
  }
  validation.findings.forEach((finding) => {
    const item = document.createElement("div");
    item.className = `validation-item ${finding.level}`;
    item.innerHTML = `${icon(finding.level === "error" ? "circle-alert" : "triangle-alert")}<span></span>`;
    item.querySelector("span").textContent = `${finding.path}: ${finding.message}`;
    list.appendChild(item);
    hydrateIcons(item);
  });
}

async function openMissionFromCatalog(mission) {
  setView("missions");
  let draft = {};
  let baseTemplate = null;
  try {
    const data = await api(`/api/mission-security/draft?missionID=${encodeURIComponent(mission.missionID)}`);
    draft = data.draft || {};
    baseTemplate = data.baseTemplate || null;
  } catch (error) {
    showNotice(`Could not load mission site: ${error.message}`);
  }
  blankMissionState();
  missionState.missionID = mission.missionID;
  missionState.missionName = mission.name || "";
  missionState.missionType = draft.missionType || mission.missionType || "combat";
  missionState.rooms = Array.isArray(draft.rooms) ? structuredClone(draft.rooms) : [];
  missionState.gates = Array.isArray(draft.gates) ? structuredClone(draft.gates) : [];
  missionState.encounters = Array.isArray(draft.encounters) ? structuredClone(draft.encounters) : [];
  missionState.miningRocks = Array.isArray(draft.miningRocks) ? structuredClone(draft.miningRocks) : [];
  missionState.environmentProps = Array.isArray(draft.environmentProps) ? structuredClone(draft.environmentProps) : [];
  missionState.objectiveTypeID = Number(draft.objectiveTypeID) || Number(draft.completion && draft.completion.objectiveTypeID) || 0;
  missionState.objectiveQuantity = Number(draft.objectiveQuantity) || Number(draft.completion && draft.completion.objectiveQuantity) || 0;
  missionState.missionRecord = draft.missionRecord && typeof draft.missionRecord === "object" ? structuredClone(draft.missionRecord) : null;
  missionState.lootTables = Array.isArray(draft.lootTables) ? structuredClone(draft.lootTables) : [];
  missionState.completion = draft.completion && typeof draft.completion === "object" ? structuredClone(draft.completion) : null;
  missionState.missionSecurity = draft.missionSecurity && typeof draft.missionSecurity === "object" ? structuredClone(draft.missionSecurity) : null;
  missionState.sourceLinks = Array.isArray(draft.sourceLinks) ? structuredClone(draft.sourceLinks) : [];
  missionState.baseTemplate = baseTemplate;
  missionState.selectedTemplateRaw = baseTemplate && baseTemplate.raw ? baseTemplate.raw : null;
  ensureEncounterKeys();
  await resolveNpcIds(missionState.encounters.map(npcSourceId));
  populateMissionForm({
    title: draft.title || mission.name || `Mission ${mission.missionID}`,
    templateID: draft.templateID || `admin:mission-security:${mission.missionID}`,
    status: draft.status || "draft",
    missionType: missionState.missionType,
  });
  $("#missionNotesInput").value = draft.notes || "";
  renderMissionValidation({ findings: [], ok: true });
  renderMission();
  showNotice(`Loaded mission ${mission.missionID} into the Mission Designer.`);
}

function startBlankMission() {
  setView("missions");
  blankMissionState();
  missionState.rooms = [{ roomKey: "room:combat", label: "Pocket 1", role: "combat", initialState: "active" }];
  missionState.encounters = [];
  populateMissionForm({ title: "", templateID: "", status: "draft", missionType: "combat" });
  $("#missionNotesInput").value = "";
  renderMissionValidation({ findings: [], ok: true });
  renderMission();
}

function closeMission() {
  missionState.active = false;
  renderMission();
}

async function loadMissionOverlay(overlay) {
  setView("missions");
  blankMissionState();
  missionState.loadedOverlayId = overlay.id;
  missionState.missionType = overlay.missionType || "combat";
  missionState.rooms = Array.isArray(overlay.rooms) ? structuredClone(overlay.rooms) : [];
  missionState.gates = Array.isArray(overlay.gates) ? structuredClone(overlay.gates) : [];
  missionState.encounters = Array.isArray(overlay.encounters) ? structuredClone(overlay.encounters) : [];
  missionState.miningRocks = Array.isArray(overlay.miningRocks) ? structuredClone(overlay.miningRocks) : [];
  missionState.environmentProps = Array.isArray(overlay.environmentProps) ? structuredClone(overlay.environmentProps) : [];
  missionState.objectiveTypeID = Number(overlay.objectiveTypeID) || Number(overlay.completion && overlay.completion.objectiveTypeID) || 0;
  missionState.objectiveQuantity = Number(overlay.objectiveQuantity) || Number(overlay.completion && overlay.completion.objectiveQuantity) || 0;
  missionState.missionRecord = overlay.missionRecord && typeof overlay.missionRecord === "object" ? structuredClone(overlay.missionRecord) : null;
  missionState.lootTables = Array.isArray(overlay.lootTables) ? structuredClone(overlay.lootTables) : [];
  missionState.completion = overlay.completion && typeof overlay.completion === "object" ? structuredClone(overlay.completion) : null;
  missionState.missionSecurity = overlay.missionSecurity && typeof overlay.missionSecurity === "object" ? structuredClone(overlay.missionSecurity) : null;
  missionState.sourceLinks = Array.isArray(overlay.sourceLinks) ? structuredClone(overlay.sourceLinks) : [];
  if (overlay.baseTemplateID) {
    try {
      const data = await api(`/api/templates/${encodeURIComponent(overlay.baseTemplateID)}`);
      missionState.baseTemplate = data.template;
      missionState.selectedTemplateRaw = data.template.raw || null;
    } catch (_error) {
      missionState.baseTemplate = null;
    }
  }
  ensureEncounterKeys();
  await resolveNpcIds(missionState.encounters.map(npcSourceId));
  populateMissionForm({
    title: overlay.title,
    templateID: overlay.templateID || overlay.baseTemplateID || "",
    status: overlay.status,
    missionType: missionState.missionType,
  });
  $("#missionNotesInput").value = overlay.notes || "";
  renderMissionValidation(overlay.validation || { findings: [], ok: true });
  renderMission();
  showNotice(`Loaded saved mission draft "${overlay.title || overlay.id}".`);
}

async function validateMission() {
  const data = await api("/api/validate", { method: "POST", body: missionOverlayFromForm() });
  renderMissionValidation(data.validation);
  return data.validation;
}

async function saveMission() {
  const result = await api("/api/overlays", { method: "POST", body: missionOverlayFromForm() });
  missionState.loadedOverlayId = result.overlay.id;
  renderMissionValidation(result.validation);
  await loadOverlays();
  await loadStatus();
  showNotice("Mission draft saved to overlay workspace.");
}

// Load a scraped eve-survival mission into the Pockets -> Groups -> NPC editor.
function loadScrapedMission(mission) {
  setView("missions");
  blankMissionState();
  missionState.wakka = mission.wakka || "";
  missionState.missionType = "combat";
  missionState.missionSecurity = {
    faction: mission.faction || "",
    level: mission.level || null,
    objectiveSummary: mission.blitz || "",
    damageProfile: mission.damageToDeal || "",
    ewar: mission.ewar || "",
    recommendedShip: mission.recommendedShip || "",
    sourceName: "EVE-Survival",
    sourceUrl: mission.url || "",
  };
  missionState.rooms = (mission.rooms || []).map((room, index) => ({
    roomKey: `room:${index + 1}`,
    label: room.title || `Pocket ${index + 1}`,
    role: "combat",
    initialState: index === 0 ? "active" : "pending",
  }));
  if (!missionState.rooms.length) missionState.rooms = [{ roomKey: "room:1", label: "Pocket 1", role: "combat", initialState: "active" }];
  missionState.encounters = [];
  (mission.rooms || []).forEach((room, roomIndex) => {
    const roomKey = missionState.rooms[roomIndex].roomKey;
    (room.groups || []).forEach((group) => {
      (group.spawns || []).forEach((spawn) => {
        missionState.encounters.push({
          key: genEncounterKey(),
          sourceGroup: group.title || "Group",
          roomKey,
          trigger: "on_load",
          distanceMeters: group.distance ? group.distance.minMeters : 0,
          objective: group.objective === true,
          completionRole: group.objective ? "objective" : null,
          count: Math.max(1, Number(spawn.count) || 1),
          shipClass: spawn.shipClass || "",
          candidateNames: Array.isArray(spawn.shipNames) ? spawn.shipNames.slice() : [],
          spawnQuery: (spawn.shipNames || [])[0] || "",
        });
      });
    });
  });
  populateMissionForm({ title: mission.title || mission.wakka, templateID: `eve-survival:${mission.wakka}`, status: "draft", missionType: "combat" });
  $("#missionNotesInput").value = [mission.blitz ? `Blitz: ${mission.blitz}` : "", mission.ewar ? `EWAR: ${mission.ewar}` : ""].filter(Boolean).join("\n");
  renderMissionValidation({ findings: [], ok: true });
  renderMission();
}

async function importScrapedMission() {
  const input = $("#scrapeInput").value.trim();
  if (!input) { showNotice("Enter an eve-survival wakka or URL (e.g. Score1gu)."); return; }
  $("#scrapeMeta").textContent = "Scraping eve-survival...";
  try {
    const data = await api(`/api/scrape?wakka=${encodeURIComponent(input)}`);
    const mission = data.mission;
    const npc = (mission.rooms || []).reduce((n, r) => n + (r.groups || []).reduce((m, g) => m + (g.spawns || []).length, 0), 0);
    $("#scrapeMeta").textContent = `Imported ${mission.title} — ${mission.faction || "?"} (${(mission.rooms || []).length} pocket(s), ${npc} spawn lines).`;
    loadScrapedMission(mission);
    showNotice(`Imported "${mission.title}" from eve-survival. Review and apply to the test emulator.`);
  } catch (error) {
    $("#scrapeMeta").textContent = `Scrape failed: ${error.message}`;
  }
}

// --- TQ-log mission packs (decoded ground-truth) ---
async function importMissionPack() {
  const dir = $("#packInput").value.trim();
  if (!dir) { showNotice("Enter the mission pack folder path."); return; }
  $("#packMeta").textContent = "Loading pack...";
  try {
    const data = await api(`/api/pack?dir=${encodeURIComponent(dir)}`);
    renderMissionPackSummary(data.summary, dir);
  } catch (error) {
    $("#packMeta").textContent = `Pack load failed: ${error.message}`;
  }
}

function renderMissionPackSummary(summary, dir) {
  const meta = $("#packMeta");
  meta.textContent = "";
  const triggers = Object.entries(summary.triggers || {})
    .map(([trigger, count]) => `${count}x ${trigger}`).join(", ") || "none";
  const facts = [
    `Mission ${summary.missionID || "?"} · dungeon ${summary.dungeonID || "?"}`,
    `Objective: ${summary.objectiveMode || "kill"}`,
    `${summary.encounterCount} encounters (${triggers})`,
    `${summary.explicitSpawnEntries} spawn entries · ${summary.gateCount} gate(s) · ${summary.environmentPropCount} props`,
  ];
  const wrap = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = summary.title;
  const sub = document.createElement("div");
  sub.className = "picker-sub";
  sub.textContent = summary.templateID;
  const list = document.createElement("ul");
  list.className = "pack-facts";
  for (const fact of facts) {
    const li = document.createElement("li");
    li.textContent = fact;
    list.appendChild(li);
  }
  const applyBtn = document.createElement("button");
  applyBtn.className = "primary";
  applyBtn.textContent = "Apply pack to Static Tables";
  applyBtn.addEventListener("click", () => applyMissionPack(dir, summary));
  wrap.append(title, sub, list, applyBtn);
  meta.appendChild(wrap);
}

async function applyMissionPack(dir, summary) {
  if (!window.confirm(`Write ${summary.templateID} to EveJS static tables? Build with CreateDatabase --force afterward.`)) return;
  try {
    const result = await api("/api/pack/apply", { method: "POST", body: { dir, target: "static" } });
    const flags = [
      summary.missionID ? `EVEJS_FORCE_MISSION_ID=${summary.missionID}` : null,
      `EVEJS_FORCE_MISSION_TEMPLATE=${result.templateID}`,
      summary.dungeonID ? `EVEJS_FORCE_MISSION_DUNGEON_ID=${summary.dungeonID}` : null,
    ].filter(Boolean).join("  ");
    showNotice(`Wrote ${result.templateID} to static tables (${result.action}). Run CreateDatabase --force, then start EveJS with: ${flags}`);
  } catch (error) {
    showNotice(`Pack apply failed: ${error.message}`);
  }
}

// --- Load / save any existing template (D3) ---
async function loadTemplateById() {
  const id = $("#templateInput").value.trim();
  if (!id) { showNotice("Enter a template id (e.g. eve-survival:Score1gu)."); return; }
  $("#templateMeta").textContent = "Loading template...";
  try {
    const data = await api(`/api/template?id=${encodeURIComponent(id)}`);
    renderTemplateSummary(data.template, data.source);
  } catch (error) {
    $("#templateMeta").textContent = `Template load failed: ${error.message}`;
  }
}

function summarizeTemplateForView(template) {
  const ph = template.populationHints || {};
  const encounters = Array.isArray(ph.encounters) ? ph.encounters : [];
  const triggers = {};
  for (const e of encounters) { const t = (e && e.trigger) || "on_load"; triggers[t] = (triggers[t] || 0) + 1; }
  const gates = (template.siteSceneProfile && template.siteSceneProfile.gateProfiles) || [];
  const miningRocks = Array.isArray(ph.miningRocks) ? ph.miningRocks : [];
  return {
    templateID: template.templateID,
    title: template.title || template.templateID,
    siteFamily: template.siteFamily, siteKind: template.siteKind,
    objectiveMode: ph.objectiveMode || null,
    objectiveQuantity: Number(ph.objectiveQuantity) || 0,
    encounterCount: encounters.length, triggers,
    gateCount: Array.isArray(gates) ? gates.length : 0,
    miningRockCount: miningRocks.reduce((n, r) => n + (Number(r && r.count) || 0), 0),
  };
}

function renderTemplateSummary(template, source) {
  const meta = $("#templateMeta");
  meta.textContent = "";
  const s = summarizeTemplateForView(template);
  const triggers = Object.entries(s.triggers).map(([t, c]) => `${c}x ${t}`).join(", ") || "none";
  const facts = [
    `${s.siteFamily || "?"} / ${s.siteKind || "?"} · source: ${source}`,
    `${s.encounterCount} encounters (${triggers})`,
    `gates: ${s.gateCount}`,
    s.objectiveMode ? `objective: ${s.objectiveMode}${s.objectiveQuantity ? ` (qty ${s.objectiveQuantity})` : ""}` : null,
    s.miningRockCount ? `mining rocks: ${s.miningRockCount}` : null,
  ].filter(Boolean);
  const wrap = document.createElement("div");
  const title = document.createElement("strong"); title.textContent = s.title;
  const sub = document.createElement("div"); sub.className = "picker-sub"; sub.textContent = s.templateID;
  const list = document.createElement("ul"); list.className = "pack-facts";
  for (const f of facts) { const li = document.createElement("li"); li.textContent = f; list.appendChild(li); }
  const saveBtn = document.createElement("button"); saveBtn.className = "primary"; saveBtn.textContent = "Save to static tables";
  saveBtn.addEventListener("click", () => saveTemplate(template));
  wrap.append(title, sub, list, saveBtn);
  meta.appendChild(wrap);
}

async function saveTemplate(template) {
  if (!window.confirm(`Save ${template.templateID} to the static-table source of truth? Build with CreateDatabase --force to apply.`)) return;
  try {
    const result = await api("/api/template/save", { method: "POST", body: { templateID: template.templateID, template } });
    showNotice(`Saved ${result.templateID} to ${result.target} (${result.action}). Run CreateDatabase --force to build it in.`);
  } catch (error) {
    showNotice(`Save failed: ${error.message}`);
  }
}

async function applyMissionToEmulator(target = "static") {
  const wakka = missionState.wakka || $("#missionTemplateIdInput").value.replace(/^eve-survival:/, "").trim();
  if (!wakka) { showNotice("This mission has no eve-survival source. Import from a wakka/URL first."); return; }
  const where = target === "sandbox" ? "the test sandbox" : "EveJS static tables";
  if (!window.confirm(`Scrape eve-survival:${wakka} and write it to ${where}? The original template is backed up first.`)) return;
  try {
    const result = await api("/api/scrape/apply", { method: "POST", body: { wakka, target } });
    const note = result.target === "static"
      ? `Wrote ${result.templateID} to static tables. Run CreateDatabase --force to build it.`
      : `${result.action} ${result.templateID} in the sandbox. Verify: npm run emu-test -- --wakka ${wakka}`;
    showNotice(note);
  } catch (error) {
    showNotice(`Apply failed: ${error.message}`);
  }
}

async function searchMissions() {
  const missionType = $("#missionCatalogType").value;
  const q = encodeURIComponent($("#missionCatalogSearch").value.trim());
  const data = await api(`/api/missions?missionType=${encodeURIComponent(missionType)}&q=${q}&limit=96`);
  const grid = $("#missionResults");
  grid.innerHTML = "";
  data.missions.forEach((mission) => {
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `
      <div>
        <div class="item-title"></div>
        <div class="item-meta"></div>
      </div>
      <button class="secondary"></button>
    `;
    row.querySelector(".item-title").textContent = mission.name || `Mission ${mission.missionID}`;
    row.querySelector(".item-meta").textContent = smallMeta([
      `mission ${mission.missionID}`,
      missionTypeLabel(mission.missionType),
      mission.missionFlavor,
      missionObjectiveSummary(mission),
    ]);
    const button = row.querySelector("button");
    if (["combat", "mining"].includes(mission.missionType) && mission.linkedTemplateID) {
      button.innerHTML = iconText("file-input", "Author");
      button.addEventListener("click", () => openMissionFromCatalog(mission));
    } else {
      button.innerHTML = iconText("info", mission.missionType === "courier" ? "Hauling" : "No Site");
      button.disabled = true;
    }
    grid.appendChild(row);
    hydrateIcons(row);
  });
}

async function previewPack(write = false) {
  const data = await api(write ? "/api/template-pack/generate" : "/api/template-pack", {
    method: write ? "POST" : "GET",
  });
  const pack = data.pack;
  $("#packSummary").innerHTML = `
    <div class="summary-tile"><span>${icon("file-stack")}Templates</span><strong>${pack.templates.length}</strong></div>
    <div class="summary-tile"><span>${icon("crosshair")}Assignments</span><strong>${pack.assignments.length}</strong></div>
    <div class="summary-tile"><span>${icon("database")}Mission Records</span><strong>${(pack.missionRecords || []).length}</strong></div>
    <div class="summary-tile"><span>${icon("package-open")}NPC Loot Tables</span><strong>${(pack.npcLootTables || []).length}</strong></div>
    <div class="summary-tile"><span>${icon("circle-alert")}Invalid</span><strong>${pack.validation.invalidOverlayCount}</strong></div>
    <div class="summary-tile"><span>${icon(write ? "file-check-2" : "eye")}Output</span><strong>${write ? "Written" : "Preview"}</strong></div>
  `;
  hydrateIcons($("#packSummary"));
  $("#packPreview").textContent = JSON.stringify({ outputPath: data.outputPath, ...pack }, null, 2);
  if (write) showNotice(`Template pack written to ${data.outputPath}`);
}

async function applyPackToStaticTables() {
  if (!window.confirm("Write all valid generated templates to EveJS static dungeonAuthority? Build with CreateDatabase --force afterward.")) return;
  const data = await api("/api/template-pack/apply-static", { method: "POST" });
  $("#packPreview").textContent = JSON.stringify({
    outputPath: data.outputPath,
    target: data.target,
    dataDir: data.dataDir,
    applied: data.applied,
    appliedMissionRecords: data.appliedMissionRecords,
    backupCount: data.backupCount,
    pack: data.pack,
  }, null, 2);
  showNotice(`Wrote ${data.applied.length} template(s) and ${(data.appliedMissionRecords || []).length} mission record(s) to static tables. Run CreateDatabase --force to build them into _local.`);
}

async function loadResearch() {
  const response = await fetch("/api/research");
  $("#researchText").textContent = await response.text();
}

function bindEvents() {
  $$(".nav-button").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $$("#builderSteps .step-button").forEach((button) => button.addEventListener("click", () => setBuilderStep(button.dataset.step)));
  $("#deliverySelect").addEventListener("change", (event) => setDelivery(event.target.value));
  $("#loadTemplateButton").addEventListener("click", loadTemplateID);
  $("#templateIdInput").addEventListener("keydown", (event) => { if (event.key === "Enter") loadTemplateID(); });
  $$("#scopeModeControl button").forEach((button) => button.addEventListener("click", () => setScopeMode(button.dataset.scopeMode)));
  $$("#securityBandControl input").forEach((input) => input.addEventListener("change", updatePreview));
  $$("#anchorKindControl button").forEach((button) => button.addEventListener("click", () => setAnchorKind(button.dataset.anchorKind)));
  $("#templateSearchButton").addEventListener("click", searchTemplates);
  $("#templateSearchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") searchTemplates(); });
  $("#templateSelect").addEventListener("change", useSelectedTemplate);
  $("#useTemplateButton").addEventListener("click", useSelectedTemplate);
  $("#systemSearchButton").addEventListener("click", () => searchSystems("builder"));
  $("#systemSearchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") searchSystems("builder"); });
  $("#resourceSearchButton").addEventListener("click", searchResources);
  $("#resourceSearchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") searchResources(); });
  $("#systemsViewButton").addEventListener("click", () => searchSystems("systems"));
  $("#missionCatalogSearchBtn").addEventListener("click", searchMissions);
  $("#missionCatalogSearch").addEventListener("keydown", (event) => { if (event.key === "Enter") searchMissions(); });
  $("#missionCatalogType").addEventListener("change", searchMissions);
  $("#missionNewButton").addEventListener("click", startBlankMission);
  $("#missionCloseBtn").addEventListener("click", closeMission);
  $("#missionSaveBtn").addEventListener("click", saveMission);
  $("#scrapeImportBtn").addEventListener("click", importScrapedMission);
  $("#scrapeInput").addEventListener("keydown", (event) => { if (event.key === "Enter") importScrapedMission(); });
  $("#packImportBtn").addEventListener("click", importMissionPack);
  $("#packInput").addEventListener("keydown", (event) => { if (event.key === "Enter") importMissionPack(); });
  $("#templateLoadBtn").addEventListener("click", loadTemplateById);
  $("#templateInput").addEventListener("keydown", (event) => { if (event.key === "Enter") loadTemplateById(); });
  $("#missionApplyEmuBtn").addEventListener("click", applyMissionToEmulator);
  $("#missionValidateBtn").addEventListener("click", validateMission);
  $("#missionCategorySelect").addEventListener("change", () => { missionState.missionType = $("#missionCategorySelect").value; renderMission(); });
  $("#missionTitleInput").addEventListener("input", renderMissionOverview);
  $("#missionTemplateIdInput").addEventListener("input", renderMissionSelectedTemplate);
  $("#addPocketBtn").addEventListener("click", () => {
    const index = missionState.rooms.length + 1;
    missionState.rooms.push({
      roomKey: `room:pocket_${index}`,
      label: `Pocket ${index}`,
      role: "combat",
      initialState: missionState.rooms.length === 0 ? "active" : "pending",
    });
    renderMission();
  });
  $("#addMissionGateBtn").addEventListener("click", () => {
    missionState.gates.push({
      gateKey: `gate:${missionState.gates.length + 1}`,
      label: "Acceleration Gate",
      typeID: 17831,
      destinationRoomKey: (missionState.rooms[missionState.rooms.length - 1] && missionState.rooms[missionState.rooms.length - 1].roomKey) || "room:combat",
      initialState: "unlocked",
    });
    renderMission();
  });
  $("#addMissionLootBtn").addEventListener("click", () => {
    missionState.lootTables.push(defaultLootTable());
    renderMission();
  });
  $("#npcSearchButton").addEventListener("click", searchNpcs);
  $("#npcSearchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") searchNpcs(); });
  $("#npcKindSelect").addEventListener("change", searchNpcs);
  $("#loadLootProfileButton").addEventListener("click", loadLootProfileFromInput);
  $("#lootProfileSearchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") loadLootProfileFromInput(); });
  $("#newLootProfileButton").addEventListener("click", addNewLootProfile);
  $("#addEncounterButton").addEventListener("click", () => {
    state.encounters.push({ profileID: "generic_hostile", count: 1, trigger: state.encounters.length ? "wave_cleared" : "on_load", targetPolicy: "nearest_player" });
    renderAll();
  });
  $("#addResourceButton").addEventListener("click", () => {
    state.resources.push(defaultResource());
    renderAll();
  });
  $("#addOverrideButton").addEventListener("click", () => {
    state.npcOverrides.push({ profileID: "generic_hostile", damageMultiplier: 1 });
    renderAll();
  });
  $("#addLootTableButton").addEventListener("click", () => {
    state.lootTables.push(defaultLootTable());
    renderAll();
  });
  $("#validateButton").addEventListener("click", validateCurrent);
  $("#saveOverlayButton").addEventListener("click", saveOverlay);
  $("#newOverlayButton").addEventListener("click", resetForm);
  $("#refreshPackButton").addEventListener("click", () => previewPack(false));
  $("#writePackButton").addEventListener("click", () => previewPack(true));
  $("#applyStaticPackButton").addEventListener("click", applyPackToStaticTables);
  $("#loadResearchButton").addEventListener("click", loadResearch);
  $("#cloneDbButton").addEventListener("click", async () => {
    await api("/api/clone", { method: "POST", body: { force: false } });
    await loadStatus();
    showNotice("Database clone is ready for catalog reads.");
  });
  ["titleInput", "templateIdInput", "statusInput", "notesInput", "coordX", "coordY", "coordZ", "spawnWeightInput", "maxPerSystemInput", "respawnMinutesInput", "slotCountInput"].forEach((id) => {
    $(`#${id}`).addEventListener("input", updatePreview);
  });
}

async function init() {
  renderFamilyControl();
  bindEvents();
  setBuilderStep("define");
  syncContentControls();
  applyDefaultsForCurrentContent();
  renderSpawnScope();
  setAnchorKind("system");
  renderMission();
  await loadStatus();
  await loadBuilderLookups();
  await loadLootProfiles();
  await loadTemplateOptions();
  await loadOverlays();
  await searchSystems("systems");
  await searchMissions();
  await searchNpcs();
  await loadResearch();
  renderAll();
  hydrateIcons();
}

init().catch((error) => {
  console.error(error);
  showNotice(error.message);
});
