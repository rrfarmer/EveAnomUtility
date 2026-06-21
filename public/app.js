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
    id: "mission",
    label: "Mission",
    icon: "briefcase",
    description: "Private agent mission pockets and generated mission combat.",
    deliveries: ["mission_private"],
    defaultDelivery: "mission_private",
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
  encounters: [],
  resources: [],
  npcOverrides: [],
  lookup: {
    npcProfiles: [],
    npcLoadouts: [],
    npcBehaviors: [],
    npcSpawnGroups: [],
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
    combat: "Combat",
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
  return row.profileID || row.loadoutID || row.behaviorProfileID || row.spawnGroupID || row.id || "";
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

function setView(view) {
  state.view = view;
  $$(".nav-button").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  $$(".view").forEach((panel) => panel.classList.toggle("is-active", panel.id === `view-${view}`));
  $("#viewTitle").textContent = {
    builder: "Builder",
    systems: "Systems",
    missions: "Missions",
    npcs: "NPCs",
    pack: "Template Pack",
    research: "Research",
  }[view] || "Builder";
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
  const missionCategoryField = $("#missionCategoryField");
  const builderMissionTypeSelect = $("#builderMissionTypeSelect");
  if (missionCategoryField && builderMissionTypeSelect) {
    const isMission = state.contentFamily === "mission";
    missionCategoryField.hidden = !isMission;
    missionCategoryField.classList.toggle("is-visible", isMission);
    missionCategoryField.setAttribute("aria-hidden", isMission ? "false" : "true");
    builderMissionTypeSelect.value = state.missionType || "combat";
  }
  $("#contentSummary").innerHTML = `
    <span>${icon(family.icon)}${family.label}</span>
    <span>${icon(DELIVERY_OPTIONS[state.delivery]?.icon || "circle")} ${deliveryLabel(state.delivery)}</span>
    ${state.contentFamily === "mission" ? `<span>${icon("briefcase")} ${missionTypeLabel(state.missionType)}</span>` : ""}
    <span>${icon("eye")} Scanner: ${scannerVisibility()}</span>
  `;
  hydrateIcons($("#contentSummary"));
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

function setMissionType(missionType, options = {}) {
  const allowed = new Set(["combat", "courier", "mining", "trade", "talk_to_agent", "agent_interaction", "other"]);
  const next = allowed.has(missionType) ? missionType : "combat";
  const previous = state.missionType;
  state.missionType = next;
  if (options.resetDraft !== false && state.contentFamily === "mission" && previous !== state.missionType) {
    resetDraftFields();
  }
  if (options.preserveTemplate !== true && previous !== state.missionType) {
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
  if ((state.contentFamily === "combat" || (state.contentFamily === "mission" && state.missionType === "combat")) && state.encounters.length === 0) {
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
    encounters: state.encounters,
    resources: state.resources,
    npcOverrides: state.npcOverrides,
    completion: {
      mode: defaultCompletionMode(),
      despawnDelaySeconds: state.delivery === "mission_private" ? 0 : 20,
    },
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

async function loadBuilderLookups() {
  const [profiles, loadouts, behaviors, spawnGroups, resources] = await Promise.all([
    api("/api/npcs?kind=profiles&limit=500"),
    api("/api/npcs?kind=loadouts&limit=500"),
    api("/api/npcs?kind=behaviorProfiles&limit=500"),
    api("/api/npcs?kind=spawnGroups&limit=500"),
    api("/api/resources?limit=500"),
  ]);
  state.lookup.npcProfiles = profiles.npcs || [];
  state.lookup.npcLoadouts = loadouts.npcs || [];
  state.lookup.npcBehaviors = behaviors.npcs || [];
  state.lookup.npcSpawnGroups = spawnGroups.npcs || [];
  state.lookup.resources = resources.resources || [];

  renderDatalist("#npcProfileOptions", state.lookup.npcProfiles, (row) => smallMeta([row.name, row.shipTypeName, row.bounty ? `${row.bounty} ISK` : ""]));
  renderDatalist("#npcLoadoutOptions", state.lookup.npcLoadouts, (row) => smallMeta([row.name, row.weaponSystem, row.tankMode]));
  renderDatalist("#npcBehaviorOptions", state.lookup.npcBehaviors, (row) => smallMeta([row.name, row.attackProfile, row.rangeBand]));
  renderDatalist("#npcSpawnGroupOptions", state.lookup.npcSpawnGroups, (row) => smallMeta([row.name, `${row.members ? row.members.length : 0} members`]));
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
}

function renderEncounters() {
  const list = $("#encounterList");
  list.innerHTML = "";
  state.encounters.forEach((encounter, index) => {
    const row = document.createElement("div");
    row.className = "editor-row";
    row.innerHTML = `
      <div class="editor-row-grid">
        <label class="wide"><span>Profile ID</span><input data-field="profileID" list="npcProfileOptions"></label>
        <label class="wide"><span>Spawn Group</span><input data-field="spawnGroupID" list="npcSpawnGroupOptions"></label>
        <label><span>Count</span><input data-field="count" type="number" min="1"></label>
        <label><span>Trigger</span><select data-field="trigger"><option value="on_load">On Load</option><option value="wave_cleared">Wave Cleared</option><option value="timer">Timer</option></select></label>
        <label><span>Target</span><select data-field="targetPolicy"><option value="nearest_player">Nearest Player</option><option value="invoker">Invoker</option><option value="none">None</option></select></label>
        <button class="remove-row">${iconText("trash-2", "Remove")}</button>
      </div>
    `;
    bindRow(row, encounter, () => {
      state.encounters.splice(index, 1);
      renderAll();
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

function writeFieldFromInput(input, object, field) {
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
    input.value = input.dataset.json === "array"
      ? JSON.stringify(Array.isArray(object[field]) ? object[field] : [], null, 2)
      : object[field] ?? "";
    input.addEventListener("input", () => {
      writeFieldFromInput(input, object, field);
      updatePreview();
    });
    input.addEventListener("change", () => {
      writeFieldFromInput(input, object, field);
      updatePreview();
    });
  });
  row.querySelector(".remove-row").addEventListener("click", onRemove);
}

function renderAll() {
  renderSelectedTemplate();
  renderEditorRows();
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
  state.loadedOverlayId = overlay.id;
  state.contentFamily = overlay.contentFamily || contentFamilyFromKind(overlay.kind);
  state.delivery = overlay.delivery || deliveryFromKind(overlay.kind);
  state.missionType = overlay.missionType || overlay.mission && overlay.mission.type || (overlay.kind === "mission_combat" ? "combat" : "combat");
  state.kind = legacyKindFromSelection(state.contentFamily, state.delivery);
  state.baseTemplate = null;
  state.selectedTemplateRaw = null;
  state.encounters = Array.isArray(overlay.encounters) ? structuredClone(overlay.encounters) : [];
  state.resources = Array.isArray(overlay.resources) ? structuredClone(overlay.resources) : [];
  state.npcOverrides = Array.isArray(overlay.npcOverrides) ? structuredClone(overlay.npcOverrides) : [];
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
  state.encounters = [];
  state.resources = [];
  state.npcOverrides = [];
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

async function searchNpcs() {
  const kind = $("#npcKindSelect").value;
  const q = encodeURIComponent($("#npcSearchInput").value.trim());
  const data = await api(`/api/npcs?kind=${kind}&q=${q}&limit=48`);
  const grid = $("#npcResults");
  grid.innerHTML = "";
  data.npcs.forEach((npc) => {
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `
      <div>
        <div class="item-title"></div>
        <div class="item-meta"></div>
      </div>
      <button class="secondary">${iconText("copy", "Copy")}</button>
    `;
    const id = npc.profileID || npc.id;
    row.querySelector(".item-title").textContent = npc.name || id;
    row.querySelector(".item-meta").textContent = smallMeta([id, npc.shipTypeName, npc.entityType, npc.bounty ? `${npc.bounty} ISK` : ""]);
    row.querySelector("button").addEventListener("click", async () => {
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

async function loadMissionIntoBuilder(mission) {
  setView("builder");
  state.contentFamily = "mission";
  state.delivery = "mission_private";
  state.missionType = mission.missionType || "combat";
  resetDraftFields();
  syncContentControls();
  $("#titleInput").value = mission.name || `Mission ${mission.missionID}`;
  $("#templateIdInput").value = mission.linkedTemplateID || `mission:${mission.missionID}`;
  if (mission.linkedTemplateID) {
    const data = await api(`/api/templates/${encodeURIComponent(mission.linkedTemplateID)}`);
    state.baseTemplate = data.template;
    state.selectedTemplateRaw = data.template.raw || null;
  }
  await loadTemplateOptions();
  applyDefaultsForCurrentContent();
  renderAll();
  showNotice(`Loaded mission ${mission.missionID} as mission-combat content.`);
}

async function searchMissions() {
  const missionType = $("#missionTypeSelect").value;
  const q = encodeURIComponent($("#missionSearchInput").value.trim());
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
      mission.contentTemplate,
      missionObjectiveSummary(mission),
    ]);
    const button = row.querySelector("button");
    if (mission.missionType === "combat" && mission.linkedTemplateID) {
      button.innerHTML = iconText("file-input", "Use");
      button.addEventListener("click", () => loadMissionIntoBuilder(mission));
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
    <div class="summary-tile"><span>${icon("circle-alert")}Invalid</span><strong>${pack.validation.invalidOverlayCount}</strong></div>
    <div class="summary-tile"><span>${icon(write ? "file-check-2" : "eye")}Output</span><strong>${write ? "Written" : "Preview"}</strong></div>
  `;
  hydrateIcons($("#packSummary"));
  $("#packPreview").textContent = JSON.stringify({ outputPath: data.outputPath, ...pack }, null, 2);
  if (write) showNotice(`Template pack written to ${data.outputPath}`);
}

async function loadResearch() {
  const response = await fetch("/api/research");
  $("#researchText").textContent = await response.text();
}

function bindEvents() {
  $$(".nav-button").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $("#deliverySelect").addEventListener("change", (event) => setDelivery(event.target.value));
  $("#builderMissionTypeSelect").addEventListener("change", (event) => setMissionType(event.target.value));
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
  $("#missionSearchButton").addEventListener("click", searchMissions);
  $("#missionSearchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") searchMissions(); });
  $("#missionTypeSelect").addEventListener("change", searchMissions);
  $("#npcSearchButton").addEventListener("click", searchNpcs);
  $("#npcSearchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") searchNpcs(); });
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
  $("#validateButton").addEventListener("click", validateCurrent);
  $("#saveOverlayButton").addEventListener("click", saveOverlay);
  $("#newOverlayButton").addEventListener("click", resetForm);
  $("#generatePackButton").addEventListener("click", () => previewPack(true));
  $("#refreshPackButton").addEventListener("click", () => previewPack(false));
  $("#writePackButton").addEventListener("click", () => previewPack(true));
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
  syncContentControls();
  applyDefaultsForCurrentContent();
  renderSpawnScope();
  setAnchorKind("system");
  await loadStatus();
  await loadBuilderLookups();
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
