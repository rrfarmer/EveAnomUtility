const fs = require("node:fs");
const http = require("node:http");

const { handleRequest } = require("../src/server");
const {
  CLONE_DATA_DIR,
  readJsonFile,
  tablePath,
  writeJsonFileAtomic,
} = require("../src/lib/dataStore");

function request(server, path, options = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const payload = options.body ? JSON.stringify(options.body) : null;
    const req = http.request({
      hostname: "127.0.0.1",
      port: address.port,
      path,
      method: options.method || "GET",
      headers: payload
        ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        }
        : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const server = http.createServer(handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const status = await request(server, "/api/status");
    if (status.statusCode !== 200) throw new Error(`/api/status failed: ${status.body}`);
    const systems = await request(server, "/api/systems?q=Jita&limit=5");
    if (systems.statusCode !== 200 || !systems.body.includes("Jita")) {
      throw new Error(`/api/systems did not return Jita: ${systems.body}`);
    }
    const combatMissions = await request(server, "/api/missions?missionType=combat&limit=5");
    if (combatMissions.statusCode !== 200) throw new Error(`/api/missions combat failed: ${combatMissions.body}`);
    const spawnPools = await request(server, "/api/npcs?kind=spawnPools&limit=5");
    if (spawnPools.statusCode !== 200 || !JSON.parse(spawnPools.body).npcs.length) {
      throw new Error(`/api/npcs spawnPools failed: ${spawnPools.body}`);
    }
    const lootTables = await request(server, "/api/npcs?kind=lootTables&limit=5");
    if (lootTables.statusCode !== 200 || !JSON.parse(lootTables.body).npcs.length) {
      throw new Error(`/api/npcs lootTables failed: ${lootTables.body}`);
    }
    const authoredLootTableID = `admin_smoke_global_loot_${Date.now()}`;
    const savedAuthoredLoot = await request(server, "/api/npc-authoring/loot-tables", {
      method: "POST",
      body: {
        lootTableID: authoredLootTableID,
        name: "Smoke Global Loot Profile",
        minEntries: 1,
        maxEntries: 2,
        stackableMinQuantity: 1,
        stackableMaxQuantity: 25,
        entries: [],
        guaranteedEntries: [{ typeID: 34, quantity: 100 }],
      },
    });
    if (savedAuthoredLoot.statusCode !== 200) {
      throw new Error(`/api/npc-authoring/loot-tables save failed: ${savedAuthoredLoot.body}`);
    }
    const authoredLootLookup = await request(server, `/api/npc-authoring/loot-tables/${encodeURIComponent(authoredLootTableID)}`);
    if (authoredLootLookup.statusCode !== 200 || !authoredLootLookup.body.includes(authoredLootTableID)) {
      throw new Error(`/api/npc-authoring/loot-tables lookup failed: ${authoredLootLookup.body}`);
    }
    const authoredLootPack = await request(server, "/api/template-pack");
    if (authoredLootPack.statusCode !== 200) throw new Error(`/api/template-pack authored loot failed: ${authoredLootPack.body}`);
    if (!JSON.parse(authoredLootPack.body).pack.npcLootTables.some((lootTable) => lootTable.lootTableID === authoredLootTableID)) {
      throw new Error(`global authored loot profile was not emitted: ${authoredLootPack.body}`);
    }
    const authoredLootDelete = await request(server, `/api/npc-authoring/loot-tables/${encodeURIComponent(authoredLootTableID)}`, { method: "DELETE" });
    if (authoredLootDelete.statusCode !== 200) {
      throw new Error(`/api/npc-authoring/loot-tables delete failed: ${authoredLootDelete.body}`);
    }
    const parsedCombatMissions = JSON.parse(combatMissions.body);
    if (!parsedCombatMissions.missions.length || parsedCombatMissions.missions.some((mission) => mission.missionType !== "combat" || !mission.linkedTemplateID)) {
      throw new Error(`combat mission classification failed: ${combatMissions.body}`);
    }
    const securityDraft = await request(server, "/api/mission-security/draft?missionID=2391");
    if (securityDraft.statusCode !== 200) throw new Error(`/api/mission-security/draft failed: ${securityDraft.body}`);
    const parsedSecurityDraft = JSON.parse(securityDraft.body);
    if (
      !parsedSecurityDraft.draft ||
      parsedSecurityDraft.draft.rooms.length !== 2 ||
      parsedSecurityDraft.draft.gates.length !== 1 ||
      parsedSecurityDraft.draft.encounters.length < 4 ||
      parsedSecurityDraft.draft.completion.encounterKeys.length !== 2
    ) {
      throw new Error(`The Score Security draft is incomplete: ${securityDraft.body}`);
    }
    const securityValidation = await request(server, "/api/validate", {
      method: "POST",
      body: parsedSecurityDraft.draft,
    });
    if (securityValidation.statusCode !== 200) throw new Error(`/api/validate Security draft failed: ${securityValidation.body}`);
    const parsedSecurityValidation = JSON.parse(securityValidation.body);
    if (!parsedSecurityValidation.validation || parsedSecurityValidation.validation.ok !== true) {
      throw new Error(`expected Security draft validation ok: ${securityValidation.body}`);
    }
    const securityOverlay = {
      ...parsedSecurityDraft.draft,
      id: `overlay_smoke_security_${Date.now()}`,
      templateID: `admin:smoke:security-the-score:${Date.now()}`,
      title: "Smoke Security The Score",
    };
    const savedSecurity = await request(server, "/api/overlays", {
      method: "POST",
      body: securityOverlay,
    });
    if (savedSecurity.statusCode !== 200) throw new Error(`/api/overlays save Security failed: ${savedSecurity.body}`);
    const securityPack = await request(server, "/api/template-pack");
    if (securityPack.statusCode !== 200) throw new Error(`/api/template-pack Security failed: ${securityPack.body}`);
    const parsedSecurityPack = JSON.parse(securityPack.body);
    const generatedSecurityTemplate = parsedSecurityPack.pack.templates.find((template) => template.templateID === securityOverlay.templateID);
    if (
      !generatedSecurityTemplate ||
      generatedSecurityTemplate.siteSceneProfile.roomProfiles.length !== 2 ||
      generatedSecurityTemplate.siteSceneProfile.gateProfiles.length !== 1 ||
      generatedSecurityTemplate.populationHints.completion.encounterKeys.length !== 2
    ) {
      throw new Error(`Security draft did not emit room/gate template data: ${securityPack.body}`);
    }
    const securityOverlayDelete = await request(server, `/api/overlays/${encodeURIComponent(securityOverlay.id)}`, { method: "DELETE" });
    if (securityOverlayDelete.statusCode !== 200) throw new Error(`/api/overlays delete Security failed: ${securityOverlayDelete.body}`);
    const courierMissions = await request(server, "/api/missions?missionType=courier&limit=5");
    if (courierMissions.statusCode !== 200) throw new Error(`/api/missions courier failed: ${courierMissions.body}`);
    const parsedCourierMissions = JSON.parse(courierMissions.body);
    if (!parsedCourierMissions.missions.length || parsedCourierMissions.missions.some((mission) => mission.missionType !== "courier" || mission.linkedTemplateID)) {
      throw new Error(`courier mission classification failed: ${courierMissions.body}`);
    }
    const combatMissionTemplates = await request(server, "/api/templates?contentFamily=mission&delivery=mission_private&missionType=combat&limit=5");
    if (combatMissionTemplates.statusCode !== 200) throw new Error(`/api/templates mission combat failed: ${combatMissionTemplates.body}`);
    const parsedCombatMissionTemplates = JSON.parse(combatMissionTemplates.body);
    if (!parsedCombatMissionTemplates.templates.length || parsedCombatMissionTemplates.templates.some((template) => !template.missionTypes.includes("combat"))) {
      throw new Error(`mission combat template filtering failed: ${combatMissionTemplates.body}`);
    }
    const courierMissionTemplates = await request(server, "/api/templates?contentFamily=mission&delivery=mission_private&missionType=courier&limit=5");
    if (courierMissionTemplates.statusCode !== 200) throw new Error(`/api/templates mission courier failed: ${courierMissionTemplates.body}`);
    const parsedCourierMissionTemplates = JSON.parse(courierMissionTemplates.body);
    if (parsedCourierMissionTemplates.templates.length !== 0) {
      throw new Error(`courier missions should not expose dungeon templates: ${courierMissionTemplates.body}`);
    }
    const validation = await request(server, "/api/validate", {
      method: "POST",
      body: {
        title: "Smoke Test Combat Site",
        templateID: "admin:smoke:combat-site",
        contentFamily: "combat",
        delivery: "anomaly",
        kind: "combat_anomaly",
        spawnScope: {
          mode: "any_eligible",
          securityBands: ["highsec", "lowsec", "nullsec", "wormhole"],
          maxConcurrentPerSystem: 1,
          weight: 1,
          respawnMinutes: 60,
          slotCount: 1,
        },
        placement: { anchorKind: "system" },
        scanner: { visibility: "anomaly", signalStrength: 100 },
        encounters: [{ profileID: "generic_hostile", count: 1 }],
      },
    });
    if (validation.statusCode !== 200) throw new Error(`/api/validate failed: ${validation.body}`);
    const parsed = JSON.parse(validation.body);
    if (!parsed.validation || parsed.validation.ok !== true) {
      throw new Error(`expected validation ok: ${validation.body}`);
    }

    const smokeOverlay = {
      id: `overlay_smoke_delete_${Date.now()}`,
      title: "Smoke Delete Draft",
      templateID: `admin:smoke:delete-draft:${Date.now()}`,
      contentFamily: "combat",
      delivery: "anomaly",
      kind: "combat_anomaly",
      status: "draft",
      spawnScope: {
        mode: "any_eligible",
        securityBands: ["highsec", "lowsec", "nullsec", "wormhole"],
        maxConcurrentPerSystem: 1,
        weight: 1,
        respawnMinutes: 60,
        slotCount: 1,
      },
      placement: { anchorKind: "system" },
      scanner: { visibility: "anomaly", signalStrength: 100 },
      encounters: [{ profileID: "generic_hostile", count: 1 }],
      npcOverrides: [{ profileID: "generic_hostile", lootTableID: "admin_smoke_loot", damageMultiplier: 1 }],
      lootTables: [{
        lootTableID: "admin_smoke_loot",
        name: "Smoke Loot Table",
        minEntries: 1,
        maxEntries: 1,
        guaranteedEntries: [{ typeID: 34, quantity: 100 }],
        entries: [{ typeID: 35, weight: 1, minQuantity: 1, maxQuantity: 3 }],
      }],
    };
    const saved = await request(server, "/api/overlays", {
      method: "POST",
      body: smokeOverlay,
    });
    if (saved.statusCode !== 200) throw new Error(`/api/overlays save failed: ${saved.body}`);
    const smokePack = await request(server, "/api/template-pack");
    if (smokePack.statusCode !== 200) throw new Error(`/api/template-pack smoke loot failed: ${smokePack.body}`);
    const parsedSmokePack = JSON.parse(smokePack.body);
    if (!parsedSmokePack.pack.npcLootTables.some((lootTable) => lootTable.lootTableID === "admin_smoke_loot")) {
      throw new Error(`authored loot table was not emitted: ${smokePack.body}`);
    }
    const overlayDelete = await request(server, `/api/overlays/${encodeURIComponent(smokeOverlay.id)}`, { method: "DELETE" });
    if (overlayDelete.statusCode !== 200) throw new Error(`/api/overlays delete failed: ${overlayDelete.body}`);
    const deletedOverlayLookup = await request(server, `/api/overlays/${encodeURIComponent(smokeOverlay.id)}`);
    if (deletedOverlayLookup.statusCode !== 404) {
      throw new Error(`deleted overlay should 404: ${deletedOverlayLookup.body}`);
    }

    if (fs.existsSync(CLONE_DATA_DIR)) {
      const tempTemplateID = `admin:smoke:delete-template:${Date.now()}`;
      const filePath = tablePath(CLONE_DATA_DIR, "dungeonAuthority");
      const authority = readJsonFile(filePath);
      authority.templatesByID = authority.templatesByID || {};
      authority.templatesByID[tempTemplateID] = {
        title: "Smoke Delete Template",
        siteFamily: "combat",
        siteKind: "anomaly",
        populationHints: {
          siteKind: "anomaly",
          encounters: [],
        },
      };
      if (authority.counts && typeof authority.counts === "object") {
        authority.counts.templateCount = Object.keys(authority.templatesByID).length;
      }
      await writeJsonFileAtomic(filePath, authority);

      try {
        const templateDelete = await request(server, `/api/templates/${encodeURIComponent(tempTemplateID)}`, { method: "DELETE" });
        if (templateDelete.statusCode !== 200) throw new Error(`/api/templates delete failed: ${templateDelete.body}`);
        const deletedTemplateLookup = await request(server, `/api/templates/${encodeURIComponent(tempTemplateID)}`);
        if (deletedTemplateLookup.statusCode !== 404) {
          throw new Error(`deleted template should 404: ${deletedTemplateLookup.body}`);
        }
      } finally {
        const cleanup = readJsonFile(filePath);
        if (cleanup.templatesByID && cleanup.templatesByID[tempTemplateID]) {
          delete cleanup.templatesByID[tempTemplateID];
          if (cleanup.counts && typeof cleanup.counts === "object") {
            cleanup.counts.templateCount = Object.keys(cleanup.templatesByID).length;
          }
          await writeJsonFileAtomic(filePath, cleanup);
        }
      }
    }
    console.log("Smoke test passed.");
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
