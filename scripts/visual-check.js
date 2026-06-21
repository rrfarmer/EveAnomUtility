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
  ["systems", "systems-1920x1080.png"],
  ["missions", "missions-1920x1080.png"],
  ["npcs", "npcs-1920x1080.png"],
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

async function captureBuilderOverrides(page) {
  await page.locator('.nav-button[data-view="builder"]').click();
  await page.locator('[data-family="combat"]').click();
  await page.locator("#deliverySelect").selectOption("anomaly");
  await page.locator("#addOverrideButton").click();
  await page.locator("#overrideList").scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const filename = "builder-overrides-1920x1080.png";
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename) });
  return health(page, filename);
}

async function captureBuilderResources(page) {
  await page.locator('.nav-button[data-view="builder"]').click();
  await page.locator('[data-family="resource"]').click();
  await page.locator("#deliverySelect").selectOption("anomaly");
  await page.locator("#resourceList").scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const filename = "builder-resources-1920x1080.png";
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename) });
  return health(page, filename);
}

async function captureBuilderMissionCategory(page) {
  await page.locator('.nav-button[data-view="builder"]').click();
  await page.locator('[data-family="mission"]').click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  const filename = "builder-mission-category-1920x1080.png";
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename) });
  return health(page, filename);
}

async function verifyTypeSwitchReset(page) {
  await page.locator('.nav-button[data-view="builder"]').click();
  await page.locator('[data-family="resource"]').click();
  await page.locator("#titleInput").fill("Stale resource draft");
  await page.locator("#templateIdInput").fill("admin:resource:stale-draft");
  await page.locator("#notesInput").fill("Stale notes that should be cleared by a type switch.");
  await page.locator('[data-family="combat"]').click();
  await page.waitForTimeout(250);

  return page.evaluate(() => ({
    activeFamily: document.querySelector("#familyControl .family-button.is-active")?.dataset.family || "",
    title: document.querySelector("#titleInput")?.value || "",
    templateID: document.querySelector("#templateIdInput")?.value || "",
    notes: document.querySelector("#notesInput")?.value || "",
    resourceRows: document.querySelectorAll("#resourceList .editor-row").length,
    encounterRows: document.querySelectorAll("#encounterList .editor-row").length,
  }));
}

async function verifyDeletionControls(page) {
  await page.locator('.nav-button[data-view="builder"]').click();
  await page.locator('[data-family="combat"]').click();
  await page.locator("#deliverySelect").selectOption("anomaly");
  await page.waitForFunction(() => document.querySelector("#templateSelect")?.options.length > 1);
  const firstTemplateID = await page.locator("#templateSelect option").nth(1).getAttribute("value");
  if (firstTemplateID) {
    await page.locator("#templateSelect").selectOption(firstTemplateID);
    await page.locator("#useTemplateButton").click();
    await page.waitForTimeout(250);
  }
  const filename = "builder-delete-controls-1920x1080.png";
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename) });

  return page.evaluate((screenshot) => ({
    screenshot,
    overlayRows: document.querySelectorAll("#overlayList .overlay-item").length,
    overlayDeleteButtons: document.querySelectorAll("#overlayList .delete-overlay").length,
    serverTemplateDeleteVisible: Boolean(document.querySelector("#deleteTemplateButton")?.offsetParent),
  }), filename);
}

async function verifyMissionFilters(page) {
  await page.locator('.nav-button[data-view="missions"]').click();
  await page.locator("#missionTypeSelect").selectOption("combat");
  await page.waitForTimeout(250);
  const combat = await page.evaluate(() => ({
    rows: document.querySelectorAll("#missionResults .data-row").length,
    useButtons: [...document.querySelectorAll("#missionResults .data-row button")]
      .filter((button) => /Use/i.test(button.textContent || "") && !button.disabled).length,
    text: document.querySelector("#missionResults")?.textContent || "",
  }));
  await page.locator("#missionTypeSelect").selectOption("courier");
  await page.waitForTimeout(250);
  const courier = await page.evaluate(() => ({
    rows: document.querySelectorAll("#missionResults .data-row").length,
    haulingButtons: [...document.querySelectorAll("#missionResults .data-row button")]
      .filter((button) => /Hauling/i.test(button.textContent || "") && button.disabled).length,
    text: document.querySelector("#missionResults")?.textContent || "",
  }));
  return { combat, courier };
}

async function verifyBuilderMissionTemplateFilters(page) {
  await page.locator('.nav-button[data-view="builder"]').click();
  await page.locator('[data-family="mission"]').click();
  await page.waitForFunction(() => document.querySelector("#templateSelect")?.options.length > 1);
  const combat = await page.evaluate(() => ({
    category: document.querySelector("#builderMissionTypeSelect")?.value || "",
    optionCount: document.querySelector("#templateSelect")?.options.length || 0,
    meta: document.querySelector("#templateSelectMeta")?.textContent || "",
  }));
  await page.locator("#builderMissionTypeSelect").selectOption("courier");
  await page.waitForFunction(() => {
    const meta = document.querySelector("#templateSelectMeta")?.textContent || "";
    return /courier/i.test(meta);
  });
  const courier = await page.evaluate(() => ({
    category: document.querySelector("#builderMissionTypeSelect")?.value || "",
    optionCount: document.querySelector("#templateSelect")?.options.length || 0,
    meta: document.querySelector("#templateSelectMeta")?.textContent || "",
    encounterRows: document.querySelectorAll("#encounterList .editor-row").length,
  }));
  return { combat, courier };
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
      const missionCategoryField = document.querySelector("#missionCategoryField");
      const builderMissionTypeSelect = document.querySelector("#builderMissionTypeSelect");

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
        builderMissionCategoryVisible: missionCategoryField ? !missionCategoryField.hidden && visible(missionCategoryField) : false,
        builderMissionCategoryValue: builderMissionTypeSelect ? builderMissionTypeSelect.value : "",
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
  results.push(await captureBuilderMissionCategory(page));
  results.push(await captureBuilderResources(page));
  results.push(await captureBuilderOverrides(page));
  const typeSwitchReset = await verifyTypeSwitchReset(page);
  const deletionControls = await verifyDeletionControls(page);
  const missionFilters = await verifyMissionFilters(page);
  const builderMissionTemplateFilters = await verifyBuilderMissionTemplateFilters(page);

  await browser.close();

  const report = {
    url: URL,
    targetViewport: TARGET_VIEWPORT,
    generatedAt: new Date().toISOString(),
    results,
    typeSwitchReset,
    deletionControls,
    missionFilters,
    builderMissionTemplateFilters,
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
  const builderMissionCategoryFailures = results.filter((result) => (
    result.label === "builder-mission-category-1920x1080.png" &&
    (result.builderMissionCategoryVisible !== true || result.builderMissionCategoryValue !== "combat")
  ));
  const builderMissionCategoryNonMissionFailures = results.filter((result) => (
    ["builder-1920x1080.png", "builder-resources-1920x1080.png", "builder-overrides-1920x1080.png"].includes(result.label) &&
    result.builderMissionCategoryVisible === true
  ));
  const typeSwitchResetFailures = typeSwitchReset.activeFamily !== "combat"
    || typeSwitchReset.title
    || typeSwitchReset.templateID
    || typeSwitchReset.notes
    || typeSwitchReset.resourceRows !== 0
    || typeSwitchReset.encounterRows < 1;
  const deletionControlFailures = deletionControls.serverTemplateDeleteVisible !== true
    || (deletionControls.overlayRows > 0 && deletionControls.overlayDeleteButtons !== deletionControls.overlayRows);
  const missionFilterFailures = missionFilters.combat.rows < 1
    || missionFilters.combat.useButtons < 1
    || !/Combat/i.test(missionFilters.combat.text)
    || missionFilters.courier.rows < 1
    || missionFilters.courier.haulingButtons < 1
    || !/Courier/i.test(missionFilters.courier.text);
  const builderMissionTemplateFilterFailures = builderMissionTemplateFilters.combat.category !== "combat"
    || builderMissionTemplateFilters.combat.optionCount < 2
    || !/combat/i.test(builderMissionTemplateFilters.combat.meta)
    || builderMissionTemplateFilters.courier.category !== "courier"
    || builderMissionTemplateFilters.courier.optionCount !== 1
    || !/courier/i.test(builderMissionTemplateFilters.courier.meta)
    || builderMissionTemplateFilters.courier.encounterRows !== 0;
  if (consoleMessages.length || pageErrors.length || overflowFailures.length || iconFailures.length || templateSelectFailures.length || resourceSelectFailures.length || builderMissionCategoryFailures.length || builderMissionCategoryNonMissionFailures.length || typeSwitchResetFailures || deletionControlFailures || missionFilterFailures || builderMissionTemplateFilterFailures) {
    console.error(JSON.stringify({ consoleMessages, pageErrors, overflowFailures, iconFailures, templateSelectFailures, resourceSelectFailures, builderMissionCategoryFailures, builderMissionCategoryNonMissionFailures, typeSwitchReset, deletionControls, missionFilters, builderMissionTemplateFilters }, null, 2));
    process.exit(1);
  }

  console.log(`Visual check passed. Report: ${REPORT_PATH}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
