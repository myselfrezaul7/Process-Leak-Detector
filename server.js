const http = require("http");
const fs = require("fs");
const path = require("path");
const { readEvents, aggregate } = require("./src/analytics");
const { createRecommendations } = require("./src/recommendations");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const ROSSMANN_REPORT_PATH = path.join(__dirname, "data", "rossmann_report.json");
const EXPERIMENTS_PATH = path.join(__dirname, "data", "interventions.json");

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

function getLeakEntries(report) {
  const leaks = (report.summary && report.summary.leakByType) || {};
  return Object.entries(leaks).filter(([, v]) => Number.isFinite(v));
}

function buildLiveSnapshot(report) {
  const summary = report.summary || {};
  const now = new Date();
  const leakRatePerMin = (summary.estimatedLeakEur || 0) / Math.max(1, 30 * 24 * 60);
  const activeAlerts = Math.max(1, Math.round(((summary.riskStores || 0) + (summary.criticalStores || 0)) / 12));
  const alerts = (report.bottlenecks || []).slice(0, 3).map((b, idx) => ({
    id: `alert-${idx + 1}`,
    title: b.driver || b.transition || "Leak pressure rising",
    severity: idx === 0 ? "high" : idx === 1 ? "medium" : "low"
  }));

  return {
    timestamp: now.toISOString(),
    leakRatePerMin,
    activeAlerts,
    moneyLeakingNow: leakRatePerMin * (now.getSeconds() / 60),
    alerts
  };
}

function readInterventions() {
  if (!fs.existsSync(EXPERIMENTS_PATH)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(EXPERIMENTS_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn("Failed to read interventions:", err.message);
    return [];
  }
}

function writeInterventions(items) {
  fs.writeFileSync(EXPERIMENTS_PATH, JSON.stringify(items, null, 2), "utf8");
}

function buildGeoData(report) {
  const cases = (report.cases || []).slice(0, 160);
  return cases.map((c, idx) => {
    const lat = 47.35 + ((idx * 17) % 100) * 0.06;
    const lon = 6.9 + ((idx * 29) % 100) * 0.08;
    return {
      id: c.entityId || c.caseId || `entity-${idx + 1}`,
      leakEur: c.leakEur || 0,
      risk: c.status || "open",
      lat: Number(lat.toFixed(3)),
      lon: Number(lon.toFixed(3))
    };
  });
}

function buildForecast(report) {
  const current = (report.summary && report.summary.estimatedLeakEur) || 0;
  const base = current / 30;
  const points = [];
  for (let i = 1; i <= 30; i += 1) {
    const trend = 1 + Math.sin(i / 5) * 0.04 + (i / 30) * 0.08;
    const projected = base * i * trend;
    const confidence = Math.max(0.6, 0.95 - i * 0.008);
    points.push({
      day: i,
      projectedLeakEur: Math.round(projected),
      lower: Math.round(projected * (1 - (1 - confidence))),
      upper: Math.round(projected * (1 + (1 - confidence))),
      confidence: Number(confidence.toFixed(2))
    });
  }
  return points;
}

function buildStory(report) {
  const summary = report.summary || {};
  const top = (report.bottlenecks || [])[0];
  const total = summary.estimatedLeakEur || 0;
  const topLeak = summary.topLeakArea || (top && (top.driver || top.transition)) || "unknown";
  return {
    title: "Executive transformation story",
    bullets: [
      `Current leakage exposure is ${Math.round(total).toLocaleString("en-US")} EUR.`,
      `Primary pressure point: ${topLeak}.`,
      `Immediate focus: ${((summary.riskStores || 0) + (summary.criticalStores || 0)).toLocaleString("en-US")} entities at risk.`,
      "Recommended path: fix top driver, enforce owner accountability, and track intervention ROI weekly."
    ]
  };
}

function runSimulation(report, query) {
  const summary = report.summary || {};
  const baseLeak = summary.estimatedLeakEur || 0;
  const promo = Math.max(-30, Math.min(40, Number(query.promo || 0)));
  const closure = Math.max(-40, Math.min(40, Number(query.closure || 0)));
  const conversion = Math.max(-30, Math.min(40, Number(query.conversion || 0)));

  const impactFactor = promo * 0.002 + closure * 0.003 + conversion * 0.004;
  const projectedLeak = Math.max(0, baseLeak * (1 - impactFactor));
  const recovered = Math.max(0, baseLeak - projectedLeak);

  return {
    inputs: { promo, closure, conversion },
    baselineLeakEur: Math.round(baseLeak),
    projectedLeakEur: Math.round(projectedLeak),
    recoveredEur: Math.round(recovered),
    roiScore: Math.round((recovered / Math.max(1, baseLeak)) * 100)
  };
}

function answerCopilot(report, question) {
  const q = String(question || "").toLowerCase();
  const summary = report.summary || {};
  const top = (report.bottlenecks || [])[0];
  const topRisk = (report.cases || [])[0];
  const total = Math.round(summary.estimatedLeakEur || 0).toLocaleString("en-US");

  if (!q.trim()) {
    return "Ask about leak drivers, forecast, or what action should come first.";
  }
  if (q.includes("why") || q.includes("driver")) {
    return `The main driver is ${summary.topLeakArea || (top && (top.driver || top.transition)) || "unknown"}, which is the largest share of the ${total} EUR estimated leakage.`;
  }
  if (q.includes("store") || q.includes("entity")) {
    return `Highest-risk entity right now is ${topRisk ? (topRisk.entityId || topRisk.caseId) : "not available"} with estimated leak ${topRisk ? Math.round(topRisk.leakEur).toLocaleString("en-US") : "n/a"} EUR.`;
  }
  if (q.includes("forecast") || q.includes("next")) {
    return "The 30-day forecast shows rising leakage risk unless top driver interventions are started immediately and tracked weekly.";
  }
  if (q.includes("action") || q.includes("do")) {
    return "Start with one intervention on the top leakage driver, assign a single owner, and target a 10-15% recovery in 2 weeks.";
  }
  return "Current state: leakage is concentrated in a few drivers, so focused interventions will outperform broad initiatives.";
}

function routeApi(pathname, res) {
  const report = buildReport();
  const url = new URL(`http://localhost${pathname}`);

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

  if (pathname === "/api/live") {
    sendJson(res, 200, buildLiveSnapshot(report));
    return true;
  }

  if (pathname.startsWith("/api/simulate")) {
    sendJson(res, 200, runSimulation(report, url.searchParams));
    return true;
  }

  if (pathname.startsWith("/api/copilot")) {
    const question = url.searchParams.get("q") || "";
    sendJson(res, 200, { answer: answerCopilot(report, question) });
    return true;
  }

  if (pathname === "/api/geo") {
    sendJson(res, 200, buildGeoData(report));
    return true;
  }

  if (pathname === "/api/forecast") {
    sendJson(res, 200, buildForecast(report));
    return true;
  }

  if (pathname === "/api/story") {
    sendJson(res, 200, buildStory(report));
    return true;
  }

  if (pathname === "/api/interventions") {
    sendJson(res, 200, readInterventions());
    return true;
  }

  return false;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith("/api/")) {
    if (pathname === "/api/interventions" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const payload = JSON.parse(body || "{}");
          const items = readInterventions();
          const now = new Date().toISOString();
          const item = {
            id: `exp-${Date.now()}`,
            owner: payload.owner || "Unassigned",
            action: payload.action || "Intervention",
            expectedUpliftEur: Number(payload.expectedUpliftEur || 0),
            actualUpliftEur: Number(payload.actualUpliftEur || 0),
            status: payload.status || "planned",
            createdAt: now
          };
          items.unshift(item);
          writeInterventions(items.slice(0, 80));
          sendJson(res, 201, item);
        } catch (err) {
          sendJson(res, 400, { error: "Invalid JSON payload" });
        }
      });
      return;
    }

    const apiPath = `${pathname}${url.search || ""}`;
    const handled = routeApi(apiPath, res);
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

