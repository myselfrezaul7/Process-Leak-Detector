const http = require("http");
const fs = require("fs");
const path = require("path");
const { readEvents, aggregate } = require("./src/analytics");
const { createRecommendations } = require("./src/recommendations");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const ROSSMANN_REPORT_PATH = path.join(__dirname, "data", "rossmann_report.json");

function sendJson(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendFile(res, filepath) {
  if (!fs.existsSync(filepath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filepath).toLowerCase();
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };

  const contentType = contentTypes[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filepath).pipe(res);
}

function loadRossmannReport() {
  if (!fs.existsSync(ROSSMANN_REPORT_PATH)) return null;
  try {
    const raw = fs.readFileSync(ROSSMANN_REPORT_PATH, "utf8");
    const report = JSON.parse(raw);
    return report;
  } catch (err) {
    console.warn("Failed to parse Rossmann report:", err.message);
    return null;
  }
}

function buildEventReport() {
  const events = readEvents();
  const report = aggregate(events);
  return {
    ...report,
    dataset: "process-events",
    recommendations: createRecommendations(report)
  };
}

function buildReport() {
  const rossmann = loadRossmannReport();
  if (rossmann) return rossmann;
  return buildEventReport();
}

function routeApi(pathname, res) {
  const report = buildReport();

  if (pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "process-leak-detector",
      dataset: report.dataset || "unknown"
    });
    return true;
  }

  if (pathname === "/api/report") {
    sendJson(res, 200, report);
    return true;
  }

  if (pathname === "/api/summary") {
    sendJson(res, 200, report.summary);
    return true;
  }

  if (pathname === "/api/bottlenecks") {
    sendJson(res, 200, report.bottlenecks);
    return true;
  }

  if (pathname === "/api/cases") {
    sendJson(res, 200, report.cases);
    return true;
  }

  if (pathname === "/api/recommendations") {
    sendJson(res, 200, report.recommendations || []);
    return true;
  }

  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith("/api/")) {
    const handled = routeApi(pathname, res);
    if (!handled) {
      sendJson(res, 404, { error: "Unknown API route" });
    }
    return;
  }

  if (pathname === "/") {
    sendFile(res, path.join(PUBLIC_DIR, "index.html"));
    return;
  }

  const requested = path.join(PUBLIC_DIR, pathname.replace(/^\//, ""));
  if (!requested.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  sendFile(res, requested);
});

server.listen(PORT, () => {
  console.log(`Process Leak Detector running on http://localhost:${PORT}`);
});
