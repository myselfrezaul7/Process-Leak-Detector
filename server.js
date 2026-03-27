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

function sendText(res, code, payload, contentType = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": contentType });
  res.end(payload);
}

function escapeCsv(value) {
  const s = String(value == null ? "" : value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function sendFile(res, filepath) {
  if (!fs.existsSync(filepath)) {
    sendText(res, 404, "Not found");
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
    return JSON.parse(fs.readFileSync(ROSSMANN_REPORT_PATH, "utf8"));
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
    const data = JSON.parse(fs.readFileSync(EXPERIMENTS_PATH, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn("Failed to read interventions:", err.message);
    return [];
  }
}

function writeInterventions(items) {
  fs.writeFileSync(EXPERIMENTS_PATH, JSON.stringify(items, null, 2), "utf8");
}

function withInterventionMetrics(item) {
  const baseline = Number(item.baselineLeakEur || 0);
  const after = Number(item.actualLeakAfterEur || 0);
  const expected = Number(item.expectedUpliftEur || 0);
  const computedActual = item.actualLeakAfterEur != null ? Math.max(0, baseline - after) : Number(item.actualUpliftEur || 0);
  const progressPct = expected > 0 ? Math.round((computedActual / expected) * 100) : 0;
  const windowDays = item.measurementStart && item.measurementEnd
    ? Math.max(1, Math.round((new Date(item.measurementEnd) - new Date(item.measurementStart)) / (1000 * 60 * 60 * 24)))
    : 0;
  return {
    ...item,
    actualUpliftEur: Math.round(computedActual),
    progressPct,
    windowDays
  };
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
  const promo = Math.max(-30, Math.min(40, Number(query.get("promo") || 0)));
  const closure = Math.max(-40, Math.min(40, Number(query.get("closure") || 0)));
  const conversion = Math.max(-30, Math.min(40, Number(query.get("conversion") || 0)));

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

  if (!q.trim()) return "Ask about leak drivers, forecast, or which action to prioritize first.";
  if (q.includes("why") || q.includes("driver")) {
    return `The main driver is ${summary.topLeakArea || (top && (top.driver || top.transition)) || "unknown"}, and it explains the largest share of the ${total} EUR estimated leakage.`;
  }
  if (q.includes("store") || q.includes("entity")) {
    return `Highest-risk entity now: ${topRisk ? (topRisk.entityId || topRisk.caseId) : "not available"}, with estimated leak ${topRisk ? Math.round(topRisk.leakEur).toLocaleString("en-US") : "n/a"} EUR.`;
  }
  if (q.includes("forecast") || q.includes("next")) {
    return "The 30-day forecast trends upward unless we launch targeted interventions on top bottlenecks this week.";
  }
  if (q.includes("action") || q.includes("do")) {
    return "Start with one intervention on the top leakage driver, assign one owner, and track expected vs actual uplift after 14 days.";
  }
  return "Leakage is concentrated in a few drivers; focused interventions with owner accountability will recover value faster than broad campaigns.";
}

function buildExecutiveBrief(report, interventions) {
  const summary = report.summary || {};
  const story = buildStory(report);
  const totalExpected = interventions.reduce((acc, i) => acc + Number(i.expectedUpliftEur || 0), 0);
  const totalActual = interventions.reduce((acc, i) => acc + Number(i.actualUpliftEur || 0), 0);
  return [
    "Process Leak Detector - Executive Brief",
    `Generated: ${new Date().toISOString()}`,
    "",
    `Dataset: ${report.dataset || "unknown"}`,
    `Leakage estimate: ${Math.round(summary.estimatedLeakEur || 0).toLocaleString("en-US")} EUR`,
    `Top driver: ${summary.topLeakArea || "n/a"}`,
    `Risk entities: ${((summary.riskStores || 0) + (summary.criticalStores || 0)).toLocaleString("en-US")}`,
    "",
    "Story:",
    ...story.bullets.map((b) => `- ${b}`),
    "",
    "Intervention tracking:",
    `- Active interventions: ${interventions.length}`,
    `- Expected uplift total: ${Math.round(totalExpected).toLocaleString("en-US")} EUR`,
    `- Actual uplift total: ${Math.round(totalActual).toLocaleString("en-US")} EUR`
  ].join("\n");
}

function buildActionsCsv(report, interventions) {
  const rows = [
    ["type", "title_or_action", "owner", "impact_or_status", "expected_uplift_eur", "actual_uplift_eur"]
  ];
  (report.recommendations || []).forEach((r) => {
    rows.push(["recommendation", r.title || "", "", r.impact || "", "", ""]);
  });
  interventions.forEach((i) => {
    rows.push([
      "intervention",
      i.action || "",
      i.owner || "",
      i.status || "",
      Number(i.expectedUpliftEur || 0),
      Number(i.actualUpliftEur || 0)
    ]);
  });
  return rows.map((r) => r.map(escapeCsv).join(",")).join("\n");
}

function buildBriefHtml(report, interventions) {
  const brief = buildExecutiveBrief(report, interventions).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Executive Brief</title><style>
  body{font-family:Arial,sans-serif;padding:28px;line-height:1.5;color:#111}
  h1{font-size:22px}
  pre{white-space:pre-wrap;font-family:inherit}
  .hint{margin-top:20px;font-size:12px;color:#555}
  </style></head><body><h1>Executive Brief</h1><pre>${brief}</pre><p class="hint">Use browser print to export as PDF.</p></body></html>`;
}

function handleGetApi(pathname, urlObj, report, res) {
  if (pathname === "/api/health") return sendJson(res, 200, { ok: true, service: "process-leak-detector", dataset: report.dataset || "unknown" });
  if (pathname === "/api/report") return sendJson(res, 200, report);
  if (pathname === "/api/summary") return sendJson(res, 200, report.summary);
  if (pathname === "/api/bottlenecks") return sendJson(res, 200, report.bottlenecks);
  if (pathname === "/api/cases") return sendJson(res, 200, report.cases);
  if (pathname === "/api/recommendations") return sendJson(res, 200, report.recommendations || []);
  if (pathname === "/api/live") return sendJson(res, 200, buildLiveSnapshot(report));
  if (pathname === "/api/simulate") return sendJson(res, 200, runSimulation(report, urlObj.searchParams));
  if (pathname === "/api/copilot") return sendJson(res, 200, { answer: answerCopilot(report, urlObj.searchParams.get("q") || "") });
  if (pathname === "/api/geo") return sendJson(res, 200, buildGeoData(report));
  if (pathname === "/api/forecast") return sendJson(res, 200, buildForecast(report));
  if (pathname === "/api/story") return sendJson(res, 200, buildStory(report));
  if (pathname === "/api/interventions") return sendJson(res, 200, readInterventions().map(withInterventionMetrics));

  const interventions = readInterventions().map(withInterventionMetrics);
  if (pathname === "/api/export/brief") return sendText(res, 200, buildExecutiveBrief(report, interventions));
  if (pathname === "/api/export/actions.csv") return sendText(res, 200, buildActionsCsv(report, interventions), "text/csv; charset=utf-8");
  if (pathname === "/api/export/brief-html") return sendText(res, 200, buildBriefHtml(report, interventions), "text/html; charset=utf-8");
  return sendJson(res, 404, { error: "Unknown API route" });
}

function handlePostInterventions(req, res, report) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    try {
      const payload = JSON.parse(body || "{}");
      const items = readInterventions();
      const now = new Date().toISOString();
      const baselineLeakEur = Number(payload.baselineLeakEur || (report.summary && report.summary.estimatedLeakEur) || 0);
      const measurementStart = payload.measurementStart || now.slice(0, 10);
      const measurementEnd = payload.measurementEnd || new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const item = {
        id: payload.id || `exp-${Date.now()}`,
        owner: payload.owner || "Unassigned",
        action: payload.action || "Intervention",
        expectedUpliftEur: Number(payload.expectedUpliftEur || 0),
        actualUpliftEur: Number(payload.actualUpliftEur || 0),
        baselineLeakEur,
        actualLeakAfterEur: payload.actualLeakAfterEur != null ? Number(payload.actualLeakAfterEur) : null,
        measurementStart,
        measurementEnd,
        status: payload.status || "planned",
        createdAt: now
      };
      const idx = items.findIndex((x) => x.id === item.id);
      if (idx >= 0) {
        items[idx] = { ...items[idx], ...item, createdAt: items[idx].createdAt || now };
      } else {
        items.unshift(item);
      }
      writeInterventions(items.slice(0, 120));
      sendJson(res, 201, withInterventionMetrics(item));
    } catch (err) {
      sendJson(res, 400, { error: "Invalid JSON payload" });
    }
  });
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const report = buildReport();

  if (pathname.startsWith("/api/")) {
    if (pathname === "/api/interventions" && req.method === "POST") {
      handlePostInterventions(req, res, report);
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    handleGetApi(pathname, urlObj, report, res);
    return;
  }

  if (pathname === "/") {
    sendFile(res, path.join(PUBLIC_DIR, "index.html"));
    return;
  }

  const requested = path.join(PUBLIC_DIR, pathname.replace(/^\//, ""));
  if (!requested.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  sendFile(res, requested);
});

server.listen(PORT, () => {
  console.log(`Process Leak Detector running on http://localhost:${PORT}`);
});
