const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const SCREENSHOT_DIR = path.join(ROOT, "workspace", "screenshots");
const REPORT_PATH = path.join(SCREENSHOT_DIR, "visual-report.json");
const URL = process.env.EVE_ANOM_UTILITY_URL || "http://127.0.0.1:4732";
const TARGET_VIEWPORT = { width: 1920, height: 1080 };

const desktopViews = [
  ["builder", "builder-1920x1080.png"],
  ["missions", "missions-1920x1080.png"],
  ["systems", "systems-1920x1080.png"],
  ["npcs", "npcs-1920x1080.png"],
  ["loot", "loot-1920x1080.png"],
  ["pack", "pack-1920x1080.png"],
  ["research", "research-1920x1080.png"],
];

async function captureView(page, view, filename) {
  await page.locator(`.nav-button[data-view="${view}"]`).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  if (view === "pack") {
    await page.locator("#refreshPackButton").click();
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename) });
  return health(page, filename);
}

async function gotoStep(page, step) {
  await page.locator('.nav-button[data-view="builder"]').click();
  await page.locator(`#builderSteps .step-button[data-step="${step}"]`).click();
  await page.waitForTimeout(150);
}

// The family grid lives in the Define step, so always return there before selecting.
async function selectFamily(page, family) {
  await page.locator('.nav-button[data-view="builder"]').click();
  await page.locator('#builderSteps .step-button[data-step="define"]').click();
  await page.locator(`[data-family="${family}"]`).click();
}

async function captureBuilderContents(page) {
  await selectFamily(page, "combat");
  await page.locator("#deliverySelect").selectOption("anomaly");
  await gotoStep(page, "contents");
  await page.locator("#addOverrideButton").click();
  await page.locator("#overrideList").scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const filename = "builder-contents-1920x1080.png";
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename) });
  return health(page, filename);
}

async function captureLootProfileEditor(page) {
  await page.locator('.nav-button[data-view="loot"]').click();
  await page.locator("#lootProfileSearchInput").fill("generic_random_any");
  await page.locator("#loadLootProfileButton").click();
  await page.waitForFunction(() => /generic_random_any/.test(document.querySelector("#lootProfileList")?.textContent || ""));
  await page.waitForTimeout(250);
  const filename = "loot-profile-generic-random-any-1920x1080.png";
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename) });
  return health(page, filename);
}

async function captureBuilderResources(page) {
  await selectFamily(page, "resource");
  await page.locator("#deliverySelect").selectOption("anomaly");
  await gotoStep(page, "contents");
  await page.locator("#resourceList").scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const filename = "builder-resources-1920x1080.png";
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename) });
  return health(page, filename);
}

// Per-family Contents visibility: resource shows resources, hides encounters.
async function verifyContentsVisibility(page) {
  await selectFamily(page, "combat");
  await page.locator('#builderSteps .step-button[data-step="contents"]').click();
  await page.waitForTimeout(150);
  const combat = await page.evaluate(() => ({
    encounters: !document.querySelector('[data-section="encounters"]').hidden,
    resources: !document.querySelector('[data-section="resources"]').hidden,
  }));
  await selectFamily(page, "resource");
  await page.locator('#builderSteps .step-button[data-step="contents"]').click();
  await page.waitForTimeout(150);
  const resource = await page.evaluate(() => ({
    encounters: !document.querySelector('[data-section="encounters"]').hidden,
    resources: !document.querySelector('[data-section="resources"]').hidden,
  }));
  return { combat, resource };
}

async function verifyTypeSwitchReset(page) {
  await selectFamily(page, "resource");
  await page.locator("#titleInput").fill("Stale resource draft");
  await page.locator("#templateIdInput").fill("admin:resource:stale-draft");
  await page.locator('[data-family="combat"]').click();
  await page.waitForTimeout(250);

  return page.evaluate(() => ({
    activeFamily: document.querySelector("#familyControl .family-button.is-active")?.dataset.family || "",
    title: document.querySelector("#titleInput")?.value || "",
    templateID: document.querySelector("#templateIdInput")?.value || "",
    resourceRows: document.querySelectorAll("#resourceList .editor-row").length,
    encounterRows: document.querySelectorAll("#encounterList .editor-row").length,
  }));
}

async function verifyDeletionControls(page) {
  await selectFamily(page, "combat");
  await page.locator("#deliverySelect").selectOption("anomaly");
  await page.waitForFunction(() => document.querySelector("#templateSelect")?.options.length > 1);
  const firstTemplateID = await page.locator("#templateSelect option").nth(1).getAttribute("value");
  if (firstTemplateID) {
    await page.locator("#templateSelect").selectOption(firstTemplateID);
    await page.locator("#useTemplateButton").click();
    await page.waitForTimeout(250);
  }
  return page.evaluate(() => ({
    serverTemplateDeleteVisible: Boolean(document.querySelector("#deleteTemplateButton")?.offsetParent),
  }));
}

// Mission Designer catalog: combat rows are authorable, courier rows are info-only.
async function verifyMissionFilters(page) {
  await page.locator('.nav-button[data-view="missions"]').click();
  await page.locator("#missionCatalogType").selectOption("combat");
  await page.locator("#missionCatalogSearchBtn").click();
  await page.waitForFunction(() => document.querySelectorAll("#missionResults .data-row").length > 0);
  const combat = await page.evaluate(() => ({
    rows: document.querySelectorAll("#missionResults .data-row").length,
    authorButtons: [...document.querySelectorAll("#missionResults .data-row button")]
      .filter((button) => /Author/i.test(button.textContent || "") && !button.disabled).length,
    text: document.querySelector("#missionResults")?.textContent || "",
  }));
  await page.locator("#missionCatalogType").selectOption("courier");
  await page.locator("#missionCatalogSearchBtn").click();
  await page.waitForFunction(() => {
    const text = document.querySelector("#missionResults")?.textContent || "";
    return /Courier/i.test(text);
  });
  const courier = await page.evaluate(() => ({
    rows: document.querySelectorAll("#missionResults .data-row").length,
    haulingButtons: [...document.querySelectorAll("#missionResults .data-row button")]
      .filter((button) => /Hauling/i.test(button.textContent || "") && button.disabled).length,
    text: document.querySelector("#missionResults")?.textContent || "",
  }));
  return { combat, courier };
}

// Author a combat mission entirely inside the Mission Designer (no Builder hand-off).
async function verifyMissionAuthoring(page) {
  await page.locator('.nav-button[data-view="missions"]').click();
  await page.locator("#missionCatalogType").selectOption("combat");
  await page.locator("#missionCatalogSearch").fill("2391");
  await page.locator("#missionCatalogSearchBtn").click();
  await page.waitForFunction(() => document.querySelectorAll("#missionResults .data-row").length > 0);
  await page.locator("#missionResults .data-row", { hasText: "mission 2391" }).first().locator("button").click();
  await page.waitForFunction(() => document.querySelector("#missionAuthoring") && !document.querySelector("#missionAuthoring").hidden);
  // wait for NPC chips to resolve to ship names
  await page.waitForFunction(() => document.querySelectorAll("#missionPockets .npc-chip strong").length >= 4, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(250);
  const filename = "mission-designer-the-score-1920x1080.png";
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename) });
  return page.evaluate((screenshot) => ({
    screenshot,
    activeView: document.querySelector(".view.is-active")?.id || "",
    emptyHidden: document.querySelector("#missionEmpty").hidden,
    authoringHidden: document.querySelector("#missionAuthoring").hidden,
    title: document.querySelector("#missionTitleInput")?.value || "",
    templateID: document.querySelector("#missionTemplateIdInput")?.value || "",
    category: document.querySelector("#missionCategorySelect")?.value || "",
    pockets: document.querySelectorAll("#missionPockets .pocket").length,
    groups: document.querySelectorAll("#missionPockets .spawn-group").length,
    objectiveGroups: document.querySelectorAll("#missionPockets .spawn-group.is-objective").length,
    npcChipText: [...document.querySelectorAll("#missionPockets .npc-chip")].map((c) => c.textContent).join(" | "),
    completionSummary: document.querySelector("#missionCompletionSummary")?.textContent || "",
    overview: document.querySelector("#missionOverview")?.textContent || "",
  }), filename);
}

async function health(page, label) {
  return page.evaluate((label) => {
    const visible = (el) => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const docOverflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth;
    const overflowingRows = [...document.querySelectorAll(".editor-row-grid")]
      .filter(visible)
      .map((el) => ({
        overflow: el.scrollWidth - el.clientWidth,
        width: el.clientWidth,
        childCount: el.children.length,
      }))
      .filter((item) => item.overflow > 1);
    const overflowingButtons = [...document.querySelectorAll("button")]
      .filter(visible)
      .map((el) => ({
        text: el.textContent.trim(),
        overflow: el.scrollWidth - el.clientWidth,
        width: el.clientWidth,
      }))
      .filter((item) => item.overflow > 1);
    const unresolvedIcons = [...document.querySelectorAll("i[data-lucide]")]
      .filter(visible)
      .map((el) => el.getAttribute("data-lucide"));
    const svgIconCount = [...document.querySelectorAll("svg.icon")].filter(visible).length;
    const templateSelect = document.querySelector("#templateSelect");
    const resourceSelect = document.querySelector("[data-resource-select]");

    return {
      label,
      activeView: document.querySelector(".view.is-active")?.id || null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      docOverflow,
      overflowingRows,
      overflowingButtons,
      unresolvedIcons,
      svgIconCount,
      templateSelectOptionCount: templateSelect ? templateSelect.options.length : 0,
      resourceSelectText: resourceSelect ? resourceSelect.options[resourceSelect.selectedIndex]?.textContent || "" : "",
      resourceSelectValue: resourceSelect ? resourceSelect.value : "",
    };
  }, label);
}

async function run() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: TARGET_VIEWPORT });
  const consoleMessages = [];
  const pageErrors = [];

  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      consoleMessages.push({ type: message.type(), text: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto(URL, { waitUntil: "networkidle" });

  const results = [];
  for (const [view, filename] of desktopViews) {
    results.push(await captureView(page, view, filename));
  }
  results.push(await captureBuilderResources(page));
  results.push(await captureBuilderContents(page));
  results.push(await captureLootProfileEditor(page));
  const contentsVisibility = await verifyContentsVisibility(page);
  const typeSwitchReset = await verifyTypeSwitchReset(page);
  const deletionControls = await verifyDeletionControls(page);
  const missionFilters = await verifyMissionFilters(page);
  const missionAuthoring = await verifyMissionAuthoring(page);

  await browser.close();

  const report = {
    url: URL,
    targetViewport: TARGET_VIEWPORT,
    generatedAt: new Date().toISOString(),
    results,
    contentsVisibility,
    typeSwitchReset,
    deletionControls,
    missionFilters,
    missionAuthoring,
    consoleMessages,
    pageErrors,
  };
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

  const overflowFailures = results.filter((result) => (
    result.docOverflow > 1
    || result.overflowingRows.length > 0
    || result.overflowingButtons.length > 0
  ));
  const iconFailures = results.filter((result) => result.unresolvedIcons.length > 0 || result.svgIconCount < 8);
  const templateSelectFailures = results.filter((result) => (
    result.activeView === "view-builder" &&
    result.templateSelectOptionCount < 2
  ));
  const resourceSelectFailures = results.filter((result) => (
    result.label === "builder-resources-1920x1080.png" &&
    (!/Veldspar/i.test(result.resourceSelectText || "") || /^\d+$/.test(result.resourceSelectText || ""))
  ));
  const contentsVisibilityFailures = contentsVisibility.combat.encounters !== true
    || contentsVisibility.combat.resources !== false
    || contentsVisibility.resource.resources !== true
    || contentsVisibility.resource.encounters !== false;
  const typeSwitchResetFailures = typeSwitchReset.activeFamily !== "combat"
    || typeSwitchReset.title
    || typeSwitchReset.templateID
    || typeSwitchReset.resourceRows !== 0
    || typeSwitchReset.encounterRows < 1;
  const deletionControlFailures = deletionControls.serverTemplateDeleteVisible !== true;
  const missionFilterFailures = missionFilters.combat.rows < 1
    || missionFilters.combat.authorButtons < 1
    || !/Security/i.test(missionFilters.combat.text)
    || missionFilters.courier.rows < 1
    || missionFilters.courier.haulingButtons < 1
    || !/Courier/i.test(missionFilters.courier.text);
  const missionAuthoringFailures = missionAuthoring.activeView !== "view-missions"
    || missionAuthoring.emptyHidden !== true
    || missionAuthoring.authoringHidden !== false
    || !/The Score/i.test(missionAuthoring.title)
    || !/the-score-l1-guristas/.test(missionAuthoring.templateID)
    || missionAuthoring.category !== "combat"
    || missionAuthoring.pockets < 1
    || missionAuthoring.groups < 3
    || missionAuthoring.objectiveGroups < 1
    || !/Kestrel/i.test(missionAuthoring.npcChipText)
    || !/Group 2/i.test(missionAuthoring.completionSummary)
    || !/Guristas/i.test(missionAuthoring.overview);

  if (
    consoleMessages.length || pageErrors.length || overflowFailures.length || iconFailures.length
    || templateSelectFailures.length || resourceSelectFailures.length || contentsVisibilityFailures
    || typeSwitchResetFailures || deletionControlFailures || missionFilterFailures || missionAuthoringFailures
  ) {
    console.error(JSON.stringify({
      consoleMessages, pageErrors, overflowFailures, iconFailures, templateSelectFailures,
      resourceSelectFailures, contentsVisibility, typeSwitchReset, deletionControls, missionFilters, missionAuthoring,
    }, null, 2));
    process.exit(1);
  }

  console.log(`Visual check passed. Report: ${REPORT_PATH}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
