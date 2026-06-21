const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const {
  cloneDatabase,
  getStatus,
} = require("./lib/dataStore");
const {
  deleteTemplateFromClone,
  getCatalog,
  getRawNpc,
  getSystem,
  getTemplateByID,
  listMissions,
  listNpc,
  listResourceTypes,
  listSystems,
  listTemplates,
} = require("./lib/catalog");
const {
  deleteOverlay,
  getOverlay,
  listOverlays,
  saveOverlay,
} = require("./lib/overlayStore");
const {
  validateOverlay,
} = require("./lib/validator");
const {
  PACK_FILE,
  buildTemplatePack,
} = require("./lib/templatePack");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const LUCIDE_FILE = path.join(__dirname, "..", "node_modules", "lucide", "dist", "umd", "lucide.min.js");
const RESEARCH_FILE = path.join(__dirname, "..", "RESEARCH.md");
const HANDOVER_FILE = path.join(__dirname, "..", "HANDOVER.md");

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, value, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(value);
}

function sendError(res, statusCode, message, extra = {}) {
  sendJson(res, statusCode, {
    success: false,
    error: message,
    ...extra,
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  }[ext] || "application/octet-stream";
}

function safePublicPath(urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, normalized);
  if (!path.resolve(filePath).startsWith(path.resolve(PUBLIC_DIR))) {
    return null;
  }
  return filePath;
}

async function routeApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/status") {
    const [status, overlays] = await Promise.all([getStatus(), listOverlays()]);
    sendJson(res, 200, {
      success: true,
      status,
      overlayCount: overlays.length,
      catalogSummary: getCatalog().summary,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/clone") {
    const body = await readBody(req);
    const result = await cloneDatabase({ force: body.force === true });
    getCatalog({ force: true });
    sendJson(res, 200, {
      success: true,
      result,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/systems") {
    sendJson(res, 200, {
      success: true,
      systems: listSystems(url.searchParams.get("q"), url.searchParams.get("limit")),
    });
    return true;
  }

  const systemMatch = url.pathname.match(/^\/api\/systems\/(\d+)$/);
  if (req.method === "GET" && systemMatch) {
    const system = getSystem(systemMatch[1]);
    if (!system) {
      sendError(res, 404, "Solar system not found.");
      return true;
    }
    sendJson(res, 200, {
      success: true,
      system,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/templates") {
    sendJson(res, 200, {
      success: true,
      templates: listTemplates(
        {
          kind: url.searchParams.get("kind"),
          contentFamily: url.searchParams.get("contentFamily"),
          delivery: url.searchParams.get("delivery"),
          missionType: url.searchParams.get("missionType"),
        },
        url.searchParams.get("q"),
        url.searchParams.get("limit"),
      ),
    });
    return true;
  }

  const templateMatch = url.pathname.match(/^\/api\/templates\/(.+)$/);
  if (req.method === "GET" && templateMatch) {
    const template = getTemplateByID(decodeURIComponent(templateMatch[1]));
    if (!template) {
      sendError(res, 404, "Template not found.");
      return true;
    }
    sendJson(res, 200, {
      success: true,
      template,
    });
    return true;
  }

  if (req.method === "DELETE" && templateMatch) {
    const result = await deleteTemplateFromClone(decodeURIComponent(templateMatch[1]));
    sendJson(res, result.success ? 200 : result.errorMsg === "CLONE_REQUIRED" ? 409 : 404, result);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/missions") {
    sendJson(res, 200, {
      success: true,
      missions: listMissions(
        url.searchParams.get("q"),
        url.searchParams.get("limit"),
        {
          missionType: url.searchParams.get("missionType"),
        },
      ),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/npcs") {
    sendJson(res, 200, {
      success: true,
      npcs: listNpc(
        url.searchParams.get("kind"),
        url.searchParams.get("q"),
        url.searchParams.get("limit"),
      ),
    });
    return true;
  }

  const npcMatch = url.pathname.match(/^\/api\/npcs\/([^/]+)\/(.+)$/);
  if (req.method === "GET" && npcMatch) {
    const raw = getRawNpc(decodeURIComponent(npcMatch[1]), decodeURIComponent(npcMatch[2]));
    if (!raw) {
      sendError(res, 404, "NPC row not found.");
      return true;
    }
    sendJson(res, 200, {
      success: true,
      row: raw,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/resources") {
    sendJson(res, 200, {
      success: true,
      resources: listResourceTypes(url.searchParams.get("q"), url.searchParams.get("limit")),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/overlays") {
    sendJson(res, 200, {
      success: true,
      overlays: await listOverlays(),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/template-pack") {
    const pack = await buildTemplatePack({ write: false });
    sendJson(res, 200, {
      success: true,
      pack,
      outputPath: PACK_FILE,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/template-pack/generate") {
    const pack = await buildTemplatePack({ write: true });
    sendJson(res, 200, {
      success: true,
      pack,
      outputPath: PACK_FILE,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/overlays") {
    const result = await saveOverlay(await readBody(req));
    sendJson(res, result.success ? 200 : 422, result);
    return true;
  }

  const overlayMatch = url.pathname.match(/^\/api\/overlays\/([^/]+)$/);
  if (req.method === "GET" && overlayMatch) {
    const overlay = await getOverlay(decodeURIComponent(overlayMatch[1]));
    if (!overlay) {
      sendError(res, 404, "Overlay not found.");
      return true;
    }
    sendJson(res, 200, {
      success: true,
      overlay,
      validation: validateOverlay(overlay),
    });
    return true;
  }

  if (req.method === "DELETE" && overlayMatch) {
    const result = await deleteOverlay(decodeURIComponent(overlayMatch[1]));
    sendJson(res, result.success ? 200 : 404, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/validate") {
    sendJson(res, 200, {
      success: true,
      validation: validateOverlay(await readBody(req)),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/research") {
    sendText(res, 200, fs.readFileSync(RESEARCH_FILE, "utf8"), "text/markdown; charset=utf-8");
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/handover") {
    sendText(res, 200, fs.readFileSync(HANDOVER_FILE, "utf8"), "text/markdown; charset=utf-8");
    return true;
  }

  return false;
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "GET" && url.pathname === "/vendor/lucide.js") {
      sendText(res, 200, fs.readFileSync(LUCIDE_FILE), "text/javascript; charset=utf-8");
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const handled = await routeApi(req, res, url);
      if (!handled) {
        sendError(res, 404, "API route not found.");
      }
      return;
    }

    const filePath = safePublicPath(url.pathname);
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      sendError(res, 404, "File not found.");
      return;
    }
    sendText(res, 200, fs.readFileSync(filePath), contentTypeFor(filePath));
  } catch (error) {
    sendError(res, 500, error.message);
  }
}

function start() {
  const port = Number(process.env.PORT || 4732);
  const host = process.env.HOST || "127.0.0.1";
  const server = http.createServer(handleRequest);
  server.listen(port, host, () => {
    console.log(`EveAnomUtility listening at http://${host}:${port}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = {
  handleRequest,
  start,
};
