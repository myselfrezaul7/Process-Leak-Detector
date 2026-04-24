const http = require("http");
const fs = require("fs");
const path = require("path");
const { readEvents, aggregate } = require("./src/analytics");
const { createRecommendations } = require("./src/recommendations");
const { buildRossmannReport } = require("./src/buildRossmannReport");
const { Storage } = require("./src/storage");
const { resolveTenantId, normalizeTenantId } = require("./src/tenant");
const { TTLCache } = require("./src/cache");
const { log } = require("./src/logger");
const {
  detectAnomalies,
  explainEntity,
  alertsFromAnomalies,
  buildImpactRanking,
  clusterRootCauses
} = require("./src/intelligence");
const { buildDigest, sendTaskToProvider } = require("./src/automation");
const { ensureDefaultUsers, issueToken, verifyToken, authenticate, parseAuthHeader, hasRole } = require("./src/auth");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const SEED_DATA_DIR = path.join(__dirname, "data");
const TMP_DATA_DIR = path.join("/tmp", "pld-data");

function canWriteToDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
    return true;
  } catch (err) {
    return false;
  }
}

const DATA_DIR = process.env.DATA_DIR
  ? process.env.DATA_DIR
  : canWriteToDir(SEED_DATA_DIR)
    ? SEED_DATA_DIR
    : TMP_DATA_DIR;
const IS_SERVERLESS = DATA_DIR !== SEED_DATA_DIR || Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "pld-dev-token-change-this";
const AUTH_REQUIRED = String(process.env.AUTH_REQUIRED || "false").toLowerCase() === "true";
const REPORT_CACHE_TTL_MS = Number(process.env.REPORT_CACHE_TTL_MS || 8000);
const DIGEST_INTERVAL_MS = Number(process.env.DIGEST_INTERVAL_MS || 15 * 60 * 1000);

function resolveTrainCsvPath() {
  const candidates = [
    process.env.ROSSMANN_TRAIN_PATH,
    path.join(DATA_DIR, "train.csv"),
    path.join(SEED_DATA_DIR, "train.csv"),
    "C:\\Users\\mysel\\OneDrive\\Desktop\\Azure\\rossmann-store-sales\\train.csv"
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function resolveStoreCsvPath() {
  const candidates = [
    process.env.ROSSMANN_STORE_PATH,
    path.join(DATA_DIR, "store.csv"),
    path.join(SEED_DATA_DIR, "store.csv"),
    "C:\\Users\\mysel\\OneDrive\\Desktop\\Azure\\rossmann-store-sales\\store.csv"
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const appState = {
  startedAt: Date.now(),
  storage: new Storage(DATA_DIR),
  cache: new TTLCache(REPORT_CACHE_TTL_MS),
  sseClients: new Map(),
  pipeline: {
    enabled: false,
    sourceTrainPath: resolveTrainCsvPath(),
    sourceStorePath: resolveStoreCsvPath(),
    isBuilding: false,
    queued: false,
    lastBuildAt: null,
    lastSuccessAt: null,
    lastDurationMs: 0,
    lastError: null,
    lastReason: "startup",
    watchers: []
  }
};

function sendJson(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, code, payload, contentType = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": contentType });
  res.end(payload);
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
  res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
  fs.createReadStream(filepath).pipe(res);
}

function escapeCsv(value) {
  const s = String(value == null ? "" : value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error("Invalid JSON payload"));
      }
    });
    req.on("error", reject);
  });
}

function userFromRequest(req) {
  const token = parseAuthHeader(req.headers);
  const claims = token ? verifyToken(token, TOKEN_SECRET) : null;
  return claims || null;
}

function checkRole(user, roles) {
  if (!AUTH_REQUIRED) return true;
  if (!user) return false;
  return hasRole(user, roles);
}

function cacheKey(prefix, tenantId) {
  return `${prefix}:${normalizeTenantId(tenantId)}`;
}

function invalidateTenantCache(tenantId) {
  const keys = [
    "report",
    "summary",
    "live",
    "bottlenecks",
    "cases",
    "recommendations",
    "anomalies",
    "alerts",
    "impact",
    "clusters",
    "scenarios",
    "approvals",
    "audit"
  ];
  keys.forEach((k) => appState.cache.del(cacheKey(k, tenantId)));
}

function sseSet(tenantId) {
  const id = normalizeTenantId(tenantId);
  if (!appState.sseClients.has(id)) {
    appState.sseClients.set(id, new Set());
  }
  return appState.sseClients.get(id);
}

function pushSse(tenantId, eventName, payload) {
  const clients = sseSet(tenantId);
  const msg = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  clients.forEach((res) => {
    try {
      res.write(msg);
    } catch (err) {
      // ignore stale clients
    }
  });
}

async function appendAudit(tenantId, actor, action, detail = {}) {
  await appState.storage.appendAudit(tenantId, {
    id: `audit-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    actor: actor || "system",
    action,
    detail,
    createdAt: new Date().toISOString()
  });
}

function buildEventReportFromLegacyEvents() {
  const events = appState.storage.readLegacyEvents();
  const report = aggregate(
    events
      .map((e) => ({ ...e, ts: new Date(e.timestamp).getTime() }))
      .sort((a, b) => a.ts - b.ts)
  );
  return {
    ...report,
    dataset: "process-events",
    recommendations: createRecommendations(report)
  };
}

async function getReport(tenantId) {
  const key = cacheKey("report", tenantId);
  const hit = appState.cache.get(key);
  if (hit) return hit;

  let report = await appState.storage.readReport(tenantId);
  if (!report) {
    report = buildEventReportFromLegacyEvents();
  }
  appState.cache.set(key, report);
  return report;
}

function withInterventionMetrics(item, report) {
  const baseline = Number(item.baselineLeakEur || (report.summary && report.summary.estimatedLeakEur) || 0);
  const after = item.actualLeakAfterEur != null ? Number(item.actualLeakAfterEur) : null;
  const expected = Number(item.expectedUpliftEur || 0);
  const computedActual = after != null ? Math.max(0, baseline - after) : Number(item.actualUpliftEur || 0);
  const windowDays =
    item.measurementStart && item.measurementEnd
      ? Math.max(1, Math.round((new Date(item.measurementEnd) - new Date(item.measurementStart)) / (1000 * 60 * 60 * 24)))
      : 14;
  const counterfactualLeakEur = Math.round(baseline * (1 + Math.min(0.15, (windowDays / 30) * 0.03)));
  const effectVsCounterfactual = Math.max(0, counterfactualLeakEur - (after != null ? after : baseline - computedActual));
  const confidencePct = Math.max(
    45,
    Math.min(
      98,
      Math.round(60 + Math.min(25, (windowDays / 14) * 8) + Math.min(13, (effectVsCounterfactual / Math.max(1, baseline)) * 100))
    )
  );
  const progressPct = expected > 0 ? Math.round((computedActual / expected) * 100) : 0;
  return {
    ...item,
    baselineLeakEur: Math.round(baseline),
    counterfactualLeakEur,
    actualUpliftEur: Math.round(computedActual),
    effectVsCounterfactualEur: Math.round(effectVsCounterfactual),
    confidencePct,
    progressPct,
    windowDays
  };
}

function buildLiveSnapshot(report) {
  const summary = report.summary || {};
  const anomalies = detectAnomalies(report);
  const leakRatePerMin = (summary.estimatedLeakEur || 0) / Math.max(1, 30 * 24 * 60);
  const alerts = anomalies.slice(0, 3).map((a, i) => ({
    id: `live-${i + 1}`,
    title: `${a.id} abnormal leak spike`,
    severity: a.severity
  }));
  return {
    timestamp: new Date().toISOString(),
    leakRatePerMin,
    activeAlerts: alerts.length,
    moneyLeakingNow: leakRatePerMin * ((new Date().getSeconds() + 1) / 60),
    alerts
  };
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

function buildStory(report, interventions) {
  const summary = report.summary || {};
  const top = (report.bottlenecks || [])[0];
  const topLeak = summary.topLeakArea || (top && (top.driver || top.transition)) || "unknown";
  const expected = interventions.reduce((acc, i) => acc + Number(i.expectedUpliftEur || 0), 0);
  const actual = interventions.reduce((acc, i) => acc + Number(i.actualUpliftEur || 0), 0);
  return {
    title: "Executive transformation story",
    bullets: [
      `Current leakage exposure is ${Math.round(summary.estimatedLeakEur || 0).toLocaleString("en-US")} EUR.`,
      `Primary pressure point: ${topLeak}.`,
      `Intervention progress: expected ${Math.round(expected).toLocaleString("en-US")} EUR vs actual ${Math.round(actual).toLocaleString("en-US")} EUR.`,
      "Recommended path: fix top anomaly clusters, assign owners, and close weekly ROI reviews."
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

function runSimulationFromInputs(report, inputs) {
  const qp = new URLSearchParams();
  qp.set("promo", String(inputs.promo || 0));
  qp.set("closure", String(inputs.closure || 0));
  qp.set("conversion", String(inputs.conversion || 0));
  return runSimulation(report, qp);
}

function scenarioComparison(base, candidate) {
  return {
    baseId: base.id,
    candidateId: candidate.id,
    baselineLeakDeltaEur: (candidate.result && candidate.result.projectedLeakEur) - (base.result && base.result.projectedLeakEur),
    recoveredDeltaEur: (candidate.result && candidate.result.recoveredEur) - (base.result && base.result.recoveredEur),
    roiDelta: (candidate.result && candidate.result.roiScore) - (base.result && base.result.roiScore)
  };
}

function buildDecisionStudio(report, scenarios, interventions, question) {
  const ranking = buildImpactRanking(report, interventions || []);
  const top = ranking[0];
  const latestScenario = scenarios && scenarios.length ? scenarios[0] : null;
  const diagnosis = top
    ? `Highest impact entity is ${top.id} with score ${top.impactScore} driven by ${top.primaryDriver}.`
    : "No high-impact entity detected.";
  const recommendation = latestScenario
    ? `Use scenario "${latestScenario.name}" and execute focused action on ${top ? top.id : "top entity"}.`
    : `Create a scenario and prioritize action on ${top ? top.id : "top impact entities"}.`;
  return {
    question: question || "",
    diagnosis,
    recommendation,
    suggestedTask: {
      provider: "jira",
      title: `Intervention for ${top ? top.id : "high impact entity"}`,
      description: recommendation
    },
    scenarioHint: latestScenario
      ? `Latest scenario "${latestScenario.name}" estimates recovery ${latestScenario.result.recoveredEur} EUR.`
      : "No saved scenario yet."
  };
}

function answerCopilot(report, question) {
  const q = String(question || "").toLowerCase();
  const summary = report.summary || {};
  const anomalies = detectAnomalies(report);
  const topRisk = (report.cases || [])[0];
  if (!q.trim()) return "Ask about anomalies, drivers, interventions, or forecast.";
  if (q.includes("anomal")) {
    return anomalies.length
      ? `Top anomaly is ${anomalies[0].id} with z-score ${anomalies[0].zScore}.`
      : "No active anomalies above threshold right now.";
  }
  if (q.includes("driver") || q.includes("why")) {
    return `Primary leakage driver is ${summary.topLeakArea || "unknown"}, causing the largest estimated impact.`;
  }
  if (q.includes("store") || q.includes("entity")) {
    return `Highest-risk entity currently: ${topRisk ? topRisk.entityId || topRisk.caseId : "n/a"}.`;
  }
  if (q.includes("forecast")) {
    return "30-day risk radar indicates upward leakage unless top interventions are executed now.";
  }
  return "Use role-based view, anomaly feed, and intervention confidence to prioritize actions each week.";
}

function buildActionsCsv(report, interventions) {
  const rows = [["type", "title_or_action", "owner", "status_or_impact", "expected_uplift_eur", "actual_uplift_eur", "confidence_pct"]];
  (report.recommendations || []).forEach((r) => {
    rows.push(["recommendation", r.title || "", "", r.impact || "", "", "", ""]);
  });
  interventions.forEach((i) => {
    rows.push([
      "intervention",
      i.action || "",
      i.owner || "",
      i.status || "",
      Number(i.expectedUpliftEur || 0),
      Number(i.actualUpliftEur || 0),
      Number(i.confidencePct || 0)
    ]);
  });
  return rows.map((r) => r.map(escapeCsv).join(",")).join("\n");
}

function buildBriefText(report, interventions, tenantId) {
  const summary = report.summary || {};
  const story = buildStory(report, interventions);
  return [
    "Process Leak Detector - Executive Brief",
    `Tenant: ${tenantId}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    `Dataset: ${report.dataset || "unknown"}`,
    `Leakage estimate: ${Math.round(summary.estimatedLeakEur || 0).toLocaleString("en-US")} EUR`,
    `Top driver: ${summary.topLeakArea || "n/a"}`,
    "",
    ...story.bullets.map((b) => `- ${b}`)
  ].join("\n");
}

function buildBriefHtml(text) {
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Executive Brief</title><style>
  body{font-family:Arial,sans-serif;padding:28px;line-height:1.5;color:#111}
  h1{font-size:22px}
  pre{white-space:pre-wrap;font-family:inherit}
  .hint{margin-top:20px;font-size:12px;color:#555}
  </style></head><body><h1>Executive Brief</h1><pre>${safe}</pre><p class="hint">Use browser print to export as PDF.</p></body></html>`;
}

async function seedRuntimeDataIfNeeded() {
  if (!IS_SERVERLESS) return;
  const sourceReport = path.join(SEED_DATA_DIR, "rossmann_report.json");
  const targetTenantDir = path.join(DATA_DIR, "tenants", "default");
  const targetReport = path.join(targetTenantDir, "report.json");
  const targetInterventions = path.join(targetTenantDir, "interventions.json");
  const sourceInterventions = path.join(SEED_DATA_DIR, "interventions.json");

  try {
    if (!fs.existsSync(targetReport) && fs.existsSync(sourceReport)) {
      fs.mkdirSync(targetTenantDir, { recursive: true });
      fs.copyFileSync(sourceReport, targetReport);
    }
    if (!fs.existsSync(targetInterventions)) {
      fs.mkdirSync(targetTenantDir, { recursive: true });
      if (fs.existsSync(sourceInterventions)) {
        fs.copyFileSync(sourceInterventions, targetInterventions);
      } else {
        fs.writeFileSync(targetInterventions, "[]", "utf8");
      }
    }
  } catch (err) {
    log("warn", "serverless_seed_failed", { error: err.message });
  }
}

function getPipelineStatus(tenantId) {
  return {
    tenantId,
    enabled: appState.pipeline.enabled,
    sourceTrainPath: appState.pipeline.sourceTrainPath,
    sourceStorePath: appState.pipeline.sourceStorePath,
    isBuilding: appState.pipeline.isBuilding,
    queued: appState.pipeline.queued,
    lastBuildAt: appState.pipeline.lastBuildAt,
    lastSuccessAt: appState.pipeline.lastSuccessAt,
    lastDurationMs: appState.pipeline.lastDurationMs,
    lastError: appState.pipeline.lastError,
    lastReason: appState.pipeline.lastReason
  };
}

function normalizeImportedReport(payload) {
  const report =
    payload && typeof payload === "object" && payload.report && typeof payload.report === "object"
      ? payload.report
      : payload;
  if (!report || typeof report !== "object") return null;
  if (!report.summary || typeof report.summary !== "object") return null;
  if (!Array.isArray(report.cases)) return null;

  return {
    generatedAt: report.generatedAt || new Date().toISOString(),
    dataset: report.dataset || "custom-import",
    summary: report.summary,
    summaryCards: Array.isArray(report.summaryCards) ? report.summaryCards : [],
    bottlenecks: Array.isArray(report.bottlenecks) ? report.bottlenecks : [],
    recommendations: Array.isArray(report.recommendations) ? report.recommendations : [],
    cases: report.cases
  };
}

function buildDataControlStatus(tenantId, report) {
  const mode = IS_SERVERLESS ? "serverless-ephemeral" : "filesystem-persistent";
  return {
    tenantId,
    dataset: report.dataset || "unknown",
    generatedAt: report.generatedAt || null,
    storageMode: mode,
    dataDir: DATA_DIR,
    serverless: IS_SERVERLESS,
    pipeline: getPipelineStatus(tenantId),
    hints: [
      "Use POST /api/data/import-report to replace the live report with custom JSON.",
      "Use POST /api/rebuild to rebuild from train.csv/store.csv paths when pipeline is enabled."
    ]
  };
}

async function refreshAlertsForTenant(tenantId, report) {
  const anomalies = detectAnomalies(report);
  const derived = alertsFromAnomalies(anomalies);
  await appState.storage.writeAlerts(tenantId, derived);
  appState.cache.del(cacheKey("alerts", tenantId));
  appState.cache.del(cacheKey("anomalies", tenantId));
}

async function triggerRossmannBuild(tenantId, reason = "manual") {
  const t = normalizeTenantId(tenantId);
  if (!appState.pipeline.sourceTrainPath) {
    appState.pipeline.lastError = "Train CSV not found.";
    return;
  }
  if (appState.pipeline.isBuilding) {
    appState.pipeline.queued = true;
    appState.pipeline.lastReason = `${reason} (queued)`;
    return;
  }

  appState.pipeline.isBuilding = true;
  appState.pipeline.lastError = null;
  appState.pipeline.lastReason = reason;
  appState.pipeline.lastBuildAt = new Date().toISOString();
  const started = Date.now();

  try {
    const report = await buildRossmannReport(appState.pipeline.sourceTrainPath, appState.pipeline.sourceStorePath);
    await appState.storage.writeReport(t, report);
    await refreshAlertsForTenant(t, report);
    await appendAudit(t, "system", "pipeline.rebuild.success", { reason });
    invalidateTenantCache(t);
    appState.pipeline.lastSuccessAt = new Date().toISOString();
    pushSse(t, "pipeline", { status: getPipelineStatus(t) });
  } catch (err) {
    appState.pipeline.lastError = err && err.message ? err.message : "Build failed";
    await appendAudit(t, "system", "pipeline.rebuild.error", { reason, error: appState.pipeline.lastError });
    pushSse(t, "pipeline", { status: getPipelineStatus(t) });
  } finally {
    appState.pipeline.lastDurationMs = Date.now() - started;
    appState.pipeline.isBuilding = false;
    if (appState.pipeline.queued) {
      appState.pipeline.queued = false;
      triggerRossmannBuild(t, "queued-rebuild").catch(() => {});
    }
  }
}

function registerFileWatcher(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const watcher = (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      triggerRossmannBuild("default", `source-updated:${path.basename(filePath)}`).catch(() => {});
    }
  };
  fs.watchFile(filePath, { interval: 2500 }, watcher);
  appState.pipeline.watchers.push({ filePath, watcher });
}

function initAutoPipeline() {
  if (IS_SERVERLESS) {
    appState.pipeline.enabled = false;
    return;
  }
  if (!appState.pipeline.sourceTrainPath) {
    appState.pipeline.enabled = false;
    return;
  }
  appState.pipeline.enabled = true;
  registerFileWatcher(appState.pipeline.sourceTrainPath);
  registerFileWatcher(appState.pipeline.sourceStorePath);
  triggerRossmannBuild("default", "startup-sync").catch(() => {});
}

async function runDigestAutomation() {
  try {
    const tenantId = "default";
    const report = await getReport(tenantId);
    const interventionsRaw = await appState.storage.readInterventions(tenantId);
    const interventions = interventionsRaw.map((i) => withInterventionMetrics(i, report));
    const digest = buildDigest(report, interventions, tenantId);
    await appState.storage.writeDigest(tenantId, digest);
  } catch (err) {
    log("warn", "Digest automation failed", { error: err.message });
  }
}

function startDigestScheduler() {
  if (IS_SERVERLESS) return;
  runDigestAutomation().catch(() => {});
  setInterval(() => {
    runDigestAutomation().catch(() => {});
  }, DIGEST_INTERVAL_MS);
}

function startRealtimeBroadcast() {
  if (IS_SERVERLESS) return;
  setInterval(async () => {
    const tenantsDir = path.join(DATA_DIR, "tenants");
    const tenantIds = fs.existsSync(tenantsDir)
      ? fs.readdirSync(tenantsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      : ["default"];

    for (const tenantId of tenantIds) {
      const clients = sseSet(tenantId);
      if (!clients.size) continue;
      try {
        const report = await getReport(tenantId);
        const payload = {
          live: buildLiveSnapshot(report),
          pipeline: getPipelineStatus(tenantId),
          anomalyCount: detectAnomalies(report).length
        };
        pushSse(tenantId, "snapshot", payload);
      } catch (err) {
        // keep loop resilient
      }
    }
  }, 7000);
}

async function routeApi(req, res, urlObj, tenantId, user) {
  const pathname = urlObj.pathname;
  const report = await getReport(tenantId);

  if (pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "process-leak-detector",
      dataset: report.dataset || "unknown",
      uptimeSec: Math.round((Date.now() - appState.startedAt) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      authRequired: AUTH_REQUIRED,
      tenant: tenantId
    });
    return;
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    const body = await readBodyJson(req);
    const principal = await authenticate(appState.storage, tenantId, body.email, body.password);
    if (!principal) {
      await appendAudit(tenantId, body.email || "unknown", "auth.login.failed", {});
      sendJson(res, 401, { error: "Invalid credentials" });
      return;
    }
    const token = issueToken(principal, TOKEN_SECRET);
    await appendAudit(tenantId, principal.email, "auth.login.success", { role: principal.role });
    sendJson(res, 200, { token, user: { email: principal.email, role: principal.role, name: principal.name } });
    return;
  }

  if (pathname === "/api/auth/me") {
    if (!user) {
      sendJson(res, 200, { user: null, authRequired: AUTH_REQUIRED });
      return;
    }
    sendJson(res, 200, { user });
    return;
  }

  if (pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ tenantId, ts: new Date().toISOString() })}\n\n`);
    const clients = sseSet(tenantId);
    clients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
      } catch (err) {
        // ignore
      }
    }, 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
    return;
  }

  if (pathname === "/api/report") return sendJson(res, 200, report);
  if (pathname === "/api/summary") return sendJson(res, 200, report.summary);
  if (pathname === "/api/bottlenecks") return sendJson(res, 200, report.bottlenecks);
  if (pathname === "/api/cases") return sendJson(res, 200, report.cases);
  if (pathname === "/api/recommendations") return sendJson(res, 200, report.recommendations || []);
  if (pathname === "/api/live") return sendJson(res, 200, buildLiveSnapshot(report));
  if (pathname === "/api/simulate") return sendJson(res, 200, runSimulation(report, urlObj.searchParams));
  if (pathname === "/api/copilot") return sendJson(res, 200, { answer: answerCopilot(report, urlObj.searchParams.get("q") || "") });

  if (pathname === "/api/anomalies") {
    const key = cacheKey("anomalies", tenantId);
    const cached = appState.cache.get(key);
    if (cached) return sendJson(res, 200, cached);
    const anomalies = detectAnomalies(report);
    appState.cache.set(key, anomalies, 7000);
    return sendJson(res, 200, anomalies);
  }

  if (pathname === "/api/impact-ranking") {
    const key = cacheKey("impact", tenantId);
    const cached = appState.cache.get(key);
    if (cached) return sendJson(res, 200, cached);
    const interventions = (await appState.storage.readInterventions(tenantId)).map((i) => withInterventionMetrics(i, report));
    const ranking = buildImpactRanking(report, interventions);
    appState.cache.set(key, ranking, 7000);
    return sendJson(res, 200, ranking);
  }

  if (pathname === "/api/root-cause-clusters") {
    const key = cacheKey("clusters", tenantId);
    const cached = appState.cache.get(key);
    if (cached) return sendJson(res, 200, cached);
    const clusters = clusterRootCauses(report);
    appState.cache.set(key, clusters, 7000);
    return sendJson(res, 200, clusters);
  }

  if (pathname === "/api/explain") {
    const entityId = urlObj.searchParams.get("entityId") || "";
    const explanation = explainEntity(report, entityId);
    if (!explanation) {
      sendJson(res, 404, { error: "Entity not found" });
      return;
    }
    sendJson(res, 200, explanation);
    return;
  }

  if (pathname === "/api/alerts") {
    const key = cacheKey("alerts", tenantId);
    const cached = appState.cache.get(key);
    if (cached) return sendJson(res, 200, cached);
    const alerts = await appState.storage.readAlerts(tenantId);
    appState.cache.set(key, alerts, 8000);
    return sendJson(res, 200, alerts);
  }

  if (pathname === "/api/alerts/refresh" && req.method === "POST") {
    if (!checkRole(user, ["ceo", "ops"])) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    await refreshAlertsForTenant(tenantId, report);
    const alerts = await appState.storage.readAlerts(tenantId);
    sendJson(res, 200, alerts);
    return;
  }

  if (pathname === "/api/geo") {
    const cases = (report.cases || []).slice(0, 160);
    const data = cases.map((c, idx) => ({
      id: c.entityId || c.caseId || `entity-${idx + 1}`,
      leakEur: c.leakEur || 0,
      risk: c.status || "open",
      lat: Number((47.35 + ((idx * 17) % 100) * 0.06).toFixed(3)),
      lon: Number((6.9 + ((idx * 29) % 100) * 0.08).toFixed(3))
    }));
    sendJson(res, 200, data);
    return;
  }

  if (pathname === "/api/forecast") return sendJson(res, 200, buildForecast(report));

  if (pathname === "/api/interventions") {
    if (req.method === "POST") {
      if (!checkRole(user, ["ceo", "ops"])) {
        sendJson(res, 403, { error: "Forbidden" });
        return;
      }
      const body = await readBodyJson(req);
      const existing = await appState.storage.readInterventions(tenantId);
      const now = new Date().toISOString();
      const item = {
        id: body.id || `exp-${Date.now()}`,
        owner: body.owner || "Unassigned",
        action: body.action || "Intervention",
        expectedUpliftEur: Number(body.expectedUpliftEur || 0),
        actualUpliftEur: Number(body.actualUpliftEur || 0),
        baselineLeakEur: Number(body.baselineLeakEur || (report.summary && report.summary.estimatedLeakEur) || 0),
        actualLeakAfterEur: body.actualLeakAfterEur != null ? Number(body.actualLeakAfterEur) : null,
        measurementStart: body.measurementStart || now.slice(0, 10),
        measurementEnd: body.measurementEnd || new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString().slice(0, 10),
        status: body.status || "planned",
        createdAt: now
      };
      const idx = existing.findIndex((x) => x.id === item.id);
      if (idx >= 0) existing[idx] = { ...existing[idx], ...item, createdAt: existing[idx].createdAt || now };
      else existing.unshift(item);
      await appState.storage.writeInterventions(tenantId, existing.slice(0, 150));
      await appendAudit(tenantId, user ? user.email : "system", "intervention.upsert", { id: item.id, action: item.action });
      pushSse(tenantId, "intervention", { id: item.id, status: item.status });
      sendJson(res, 201, withInterventionMetrics(item, report));
      return;
    }
    const items = await appState.storage.readInterventions(tenantId);
    sendJson(res, 200, items.map((i) => withInterventionMetrics(i, report)));
    return;
  }

  if (pathname === "/api/scenarios") {
    if (req.method === "POST") {
      if (!checkRole(user, ["ceo", "ops"])) {
        sendJson(res, 403, { error: "Forbidden" });
        return;
      }
      const body = await readBodyJson(req);
      const scenarios = await appState.storage.readScenarios(tenantId);
      const scenario = {
        id: body.id || `scn-${Date.now()}`,
        name: body.name || `Scenario ${scenarios.length + 1}`,
        notes: body.notes || "",
        inputs: {
          promo: Number(body.promo || 0),
          closure: Number(body.closure || 0),
          conversion: Number(body.conversion || 0)
        },
        result: runSimulationFromInputs(report, body),
        createdAt: new Date().toISOString(),
        createdBy: user ? user.email : "system"
      };
      scenarios.unshift(scenario);
      await appState.storage.writeScenarios(tenantId, scenarios.slice(0, 120));
      await appendAudit(tenantId, user ? user.email : "system", "scenario.create", { id: scenario.id, name: scenario.name });
      pushSse(tenantId, "scenario", { id: scenario.id, name: scenario.name });
      sendJson(res, 201, scenario);
      return;
    }
    const scenarios = await appState.storage.readScenarios(tenantId);
    sendJson(res, 200, scenarios);
    return;
  }

  if (pathname === "/api/scenarios/compare") {
    const scenarios = await appState.storage.readScenarios(tenantId);
    const baseId = urlObj.searchParams.get("base");
    const candidateId = urlObj.searchParams.get("candidate");
    const base = scenarios.find((s) => s.id === baseId);
    const candidate = scenarios.find((s) => s.id === candidateId);
    if (!base || !candidate) {
      sendJson(res, 404, { error: "Both scenarios are required" });
      return;
    }
    sendJson(res, 200, scenarioComparison(base, candidate));
    return;
  }

  if (pathname === "/api/decision-studio") {
    const scenarios = await appState.storage.readScenarios(tenantId);
    const interventions = (await appState.storage.readInterventions(tenantId)).map((i) => withInterventionMetrics(i, report));
    const decision = buildDecisionStudio(report, scenarios, interventions, urlObj.searchParams.get("q") || "");
    sendJson(res, 200, decision);
    return;
  }

  if (pathname === "/api/story") {
    const interventions = (await appState.storage.readInterventions(tenantId)).map((i) => withInterventionMetrics(i, report));
    sendJson(res, 200, buildStory(report, interventions));
    return;
  }

  if (pathname === "/api/export/brief") {
    const interventions = (await appState.storage.readInterventions(tenantId)).map((i) => withInterventionMetrics(i, report));
    sendText(res, 200, buildBriefText(report, interventions, tenantId));
    return;
  }

  if (pathname === "/api/export/actions.csv") {
    const interventions = (await appState.storage.readInterventions(tenantId)).map((i) => withInterventionMetrics(i, report));
    sendText(res, 200, buildActionsCsv(report, interventions), "text/csv; charset=utf-8");
    return;
  }

  if (pathname === "/api/export/brief-html") {
    const interventions = (await appState.storage.readInterventions(tenantId)).map((i) => withInterventionMetrics(i, report));
    const brief = buildBriefText(report, interventions, tenantId);
    sendText(res, 200, buildBriefHtml(brief), "text/html; charset=utf-8");
    return;
  }

  if (pathname === "/api/pipeline-status") {
    sendJson(res, 200, getPipelineStatus(tenantId));
    return;
  }

  if (pathname === "/api/data/control") {
    sendJson(res, 200, buildDataControlStatus(tenantId, report));
    return;
  }

  if (pathname === "/api/data/template") {
    sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      dataset: "custom-import",
      summary: {
        totalStores: 0,
        estimatedLeakEur: 0,
        topLeakArea: "n/a"
      },
      summaryCards: [
        { label: "Dataset", value: "custom-import" },
        { label: "Stores", value: "0" },
        { label: "Leak estimate", value: "0 EUR" }
      ],
      bottlenecks: [],
      recommendations: [],
      cases: []
    });
    return;
  }

  if (pathname === "/api/data/import-report" && req.method === "POST") {
    if (!checkRole(user, ["ceo", "ops"])) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    const body = await readBodyJson(req);
    const normalized = normalizeImportedReport(body);
    if (!normalized) {
      sendJson(res, 400, { error: "Invalid report format. Required fields: summary (object), cases (array)." });
      return;
    }

    await appState.storage.writeReport(tenantId, normalized);
    await refreshAlertsForTenant(tenantId, normalized);
    await appendAudit(tenantId, user ? user.email : "system", "report.import", {
      dataset: normalized.dataset,
      cases: normalized.cases.length
    });
    invalidateTenantCache(tenantId);

    pushSse(tenantId, "report", {
      dataset: normalized.dataset,
      generatedAt: normalized.generatedAt
    });
    pushSse(tenantId, "snapshot", {
      live: buildLiveSnapshot(normalized),
      pipeline: getPipelineStatus(tenantId),
      anomalyCount: detectAnomalies(normalized).length
    });

    sendJson(res, 201, {
      ok: true,
      dataset: normalized.dataset,
      generatedAt: normalized.generatedAt,
      cases: normalized.cases.length
    });
    return;
  }

  if (pathname === "/api/rebuild" && req.method === "POST") {
    if (!checkRole(user, ["ceo", "ops"])) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    triggerRossmannBuild(tenantId, "manual-api-trigger").catch(() => {});
    sendJson(res, 202, { accepted: true, status: getPipelineStatus(tenantId) });
    return;
  }

  if (pathname === "/api/integrations/task" && req.method === "POST") {
    if (!checkRole(user, ["ceo", "ops"])) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    const body = await readBodyJson(req);
    const task = {
      id: `task-${Date.now()}`,
      provider: body.provider || "jira",
      title: body.title || "Leak intervention",
      description: body.description || "",
      owner: body.owner || "Unassigned",
      status: "open",
      createdAt: new Date().toISOString()
    };
    const deliver = await sendTaskToProvider(task.provider, task);
    const existing = await appState.storage.readTasks(tenantId);
    existing.unshift({ ...task, delivery: deliver });
    await appState.storage.writeTasks(tenantId, existing.slice(0, 200));
    await appendAudit(tenantId, user ? user.email : "system", "task.create", { id: task.id, provider: task.provider });
    pushSse(tenantId, "task", { id: task.id, title: task.title, delivered: deliver.delivered });
    sendJson(res, 201, { task, delivery: deliver });
    return;
  }

  if (pathname === "/api/tasks") {
    const tasks = await appState.storage.readTasks(tenantId);
    sendJson(res, 200, tasks);
    return;
  }

  if (pathname === "/api/approvals") {
    if (req.method === "POST") {
      if (!checkRole(user, ["ceo", "ops"])) {
        sendJson(res, 403, { error: "Forbidden" });
        return;
      }
      const body = await readBodyJson(req);
      const approvals = await appState.storage.readApprovals(tenantId);
      const item = {
        id: body.id || `apr-${Date.now()}`,
        interventionId: body.interventionId || "",
        stage: body.stage || "ops-review",
        status: body.status || "pending",
        requestedBy: user ? user.email : "system",
        assignedToRole: body.assignedToRole || "ceo",
        notes: body.notes || "",
        createdAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null
      };
      approvals.unshift(item);
      await appState.storage.writeApprovals(tenantId, approvals.slice(0, 200));
      await appendAudit(tenantId, user ? user.email : "system", "approval.request", { id: item.id, interventionId: item.interventionId });
      pushSse(tenantId, "approval", { id: item.id, status: item.status });
      sendJson(res, 201, item);
      return;
    }
    const approvals = await appState.storage.readApprovals(tenantId);
    sendJson(res, 200, approvals);
    return;
  }

  if (pathname === "/api/approvals/action" && req.method === "POST") {
    if (!checkRole(user, ["ceo", "ops"])) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    const body = await readBodyJson(req);
    const approvals = await appState.storage.readApprovals(tenantId);
    const idx = approvals.findIndex((a) => a.id === body.id);
    if (idx < 0) {
      sendJson(res, 404, { error: "Approval not found" });
      return;
    }
    const nextStatus = body.action === "approve" ? "approved" : body.action === "reject" ? "rejected" : "pending";
    approvals[idx] = {
      ...approvals[idx],
      status: nextStatus,
      decidedAt: new Date().toISOString(),
      decidedBy: user ? user.email : "system",
      notes: body.notes || approvals[idx].notes || ""
    };
    await appState.storage.writeApprovals(tenantId, approvals);
    await appendAudit(tenantId, user ? user.email : "system", "approval.action", { id: body.id, action: body.action });
    pushSse(tenantId, "approval", { id: body.id, status: nextStatus });
    sendJson(res, 200, approvals[idx]);
    return;
  }

  if (pathname === "/api/digest/latest") {
    const digest = await appState.storage.readDigest(tenantId);
    sendText(res, 200, digest || "No digest generated yet.");
    return;
  }

  if (pathname === "/api/audit") {
    if (!checkRole(user, ["ceo", "ops"])) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    const audit = await appState.storage.readAudit(tenantId);
    sendJson(res, 200, audit);
    return;
  }

  if (pathname === "/api/tenants") {
    const tenantsDir = path.join(DATA_DIR, "tenants");
    const tenants = fs.existsSync(tenantsDir)
      ? fs.readdirSync(tenantsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      : ["default"];
    sendJson(res, 200, tenants);
    return;
  }

  sendJson(res, 404, { error: "Unknown API route" });
}

async function requestHandler(req, res) {
  const started = Date.now();
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const tenantId = resolveTenantId(urlObj, req.headers);
  const user = userFromRequest(req);

  try {
    if (pathname.startsWith("/api/")) {
      await routeApi(req, res, urlObj, tenantId, user);
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
  } catch (err) {
    sendJson(res, 500, { error: err.message || "Internal server error" });
  } finally {
    log("info", "http_request", {
      method: req.method,
      path: pathname,
      tenantId,
      role: user ? user.role : "guest",
      durationMs: Date.now() - started
    });
  }
}

async function bootstrap() {
  await seedRuntimeDataIfNeeded();
  await appState.storage.init();
  await ensureDefaultUsers(appState.storage, "default");
  initAutoPipeline();
  startDigestScheduler();
  startRealtimeBroadcast();
}

let bootstrapPromise = null;

async function ensureReady() {
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrap();
  }
  await bootstrapPromise;
}

if (require.main === module) {
  ensureReady()
    .then(() => {
      const server = http.createServer(requestHandler);
      server.listen(PORT, () => {
        log("info", "server_started", { port: PORT, authRequired: AUTH_REQUIRED });
      });
    })
    .catch((err) => {
      log("error", "bootstrap_failed", { error: err.message });
      process.exit(1);
    });
}

const vercelHandler = async (req, res) => {
  await ensureReady();
  return requestHandler(req, res);
};

module.exports = vercelHandler;
module.exports.ensureReady = ensureReady;
