function eur(value) {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0
  }).format(value || 0);
}

function number(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function renderDatasetTag(report) {
  const tag = document.getElementById("dataset-tag");
  const dataset = report.dataset || "unknown";
  tag.textContent = `Dataset: ${dataset}`;
}

function renderTrustPills(report) {
  const dataset = report.dataset || "dataset";
  const trustDataset = document.getElementById("trust-dataset");
  const trustStores = document.getElementById("trust-stores");
  const trustPeriod = document.getElementById("trust-period");
  const summary = report.summary || {};

  if (trustDataset) {
    trustDataset.textContent = `Using ${dataset.replace("-", " ")} data`;
  }
  if (trustStores && summary.totalStores) {
    trustStores.textContent = `${number(summary.totalStores)} stores analyzed`;
  }
  if (trustPeriod && summary.periodStart && summary.periodEnd) {
    trustPeriod.textContent = `${summary.periodStart} to ${summary.periodEnd}`;
  }
}

function renderInsights(report) {
  const summary = report.summary || {};
  const riskEl = document.getElementById("insight-risk");
  const driverEl = document.getElementById("insight-driver");
  const focusEl = document.getElementById("insight-focus");

  if (riskEl) {
    riskEl.textContent = summary.estimatedLeakEur
      ? `${eur(summary.estimatedLeakEur)} in leakage`
      : "Leakage estimate pending";
  }
  if (driverEl) {
    driverEl.textContent = summary.topLeakArea ? summary.topLeakArea : "Top driver pending";
  }
  if (focusEl) {
    const focusCount = (summary.riskStores || 0) + (summary.criticalStores || 0);
    focusEl.textContent = focusCount ? `${number(focusCount)} stores in focus` : "Focus list pending";
  }
}

function renderOverviewGraph(summary) {
  const container = document.getElementById("overview-graph");
  if (!container) return;

  const leaks = summary.leakByType || {};
  const entries = Object.entries(leaks);
  if (!entries.length) {
    container.textContent = "No leakage data available.";
    return;
  }

  const max = Math.max(...entries.map(([, v]) => v), 1);
  container.innerHTML = entries
    .map(([label, value]) => {
      const width = Math.round((value / max) * 100);
      return `
        <div class="mini-graph-bar">
          <span>${label}</span>
          <div class="mini-graph-track">
            <div class="mini-graph-fill" style="width:${width}%"></div>
          </div>
          <span class="mini-graph-value">${eur(value)}</span>
        </div>
      `;
    })
    .join("");
}

function renderLive(snapshot) {
  const money = document.getElementById("live-money");
  const rate = document.getElementById("live-rate");
  const alerts = document.getElementById("live-alerts");
  const feed = document.getElementById("alert-feed");
  if (money) money.textContent = eur(snapshot.moneyLeakingNow || 0);
  if (rate) rate.textContent = eur(snapshot.leakRatePerMin || 0);
  if (alerts) alerts.textContent = number(snapshot.activeAlerts || 0);
  if (feed) {
    feed.innerHTML = (snapshot.alerts || [])
      .map(
        (a) => `<div class="alert-item ${a.severity || "low"}"><strong>${a.severity || "low"}</strong> · ${a.title}</div>`
      )
      .join("");
  }
}

function renderSimulation(data) {
  const out = document.getElementById("sim-output");
  if (!out) return;
  out.innerHTML =
    `<strong>Projected leak:</strong> ${eur(data.projectedLeakEur)} · ` +
    `<strong>Recovered:</strong> ${eur(data.recoveredEur)} · ` +
    `<strong>ROI score:</strong> ${data.roiScore}%`;
}

function updateSliderValues() {
  const ids = ["promo", "closure", "conversion"];
  ids.forEach((id) => {
    const input = document.getElementById(`sim-${id}`);
    const label = document.getElementById(`sim-${id}-value`);
    if (input && label) label.textContent = `${input.value}%`;
  });
}

async function refreshSimulation() {
  const promo = document.getElementById("sim-promo");
  const closure = document.getElementById("sim-closure");
  const conversion = document.getElementById("sim-conversion");
  if (!promo || !closure || !conversion) return;
  updateSliderValues();
  const qs = `promo=${promo.value}&closure=${closure.value}&conversion=${conversion.value}`;
  const res = await fetch(`/api/simulate?${qs}`);
  const data = await res.json();
  renderSimulation(data);
}

function colorForLeak(value, max) {
  const ratio = max > 0 ? value / max : 0;
  const green = Math.round(220 - ratio * 140);
  const red = Math.round(80 + ratio * 160);
  return `rgb(${red}, ${green}, 180)`;
}

function renderGeoGrid(points) {
  const grid = document.getElementById("geo-grid");
  if (!grid) return;
  const max = Math.max(...points.map((p) => p.leakEur || 0), 1);
  grid.innerHTML = points
    .slice(0, 100)
    .map((p) => {
      const color = colorForLeak(p.leakEur || 0, max);
      const title = `${p.id}: ${eur(p.leakEur || 0)}`;
      return `<div class="geo-cell" title="${title}" style="background:${color}"></div>`;
    })
    .join("");
}

function renderForecast(points) {
  const list = document.getElementById("forecast-list");
  if (!list) return;
  const max = Math.max(...points.map((p) => p.projectedLeakEur || 0), 1);
  list.innerHTML = points
    .map((p) => {
      const width = Math.max(6, Math.round((p.projectedLeakEur / max) * 100));
      return `
        <div class="forecast-item">
          <span>Day ${p.day}</span>
          <div class="forecast-band" style="width:${width}%"></div>
          <span>${eur(p.projectedLeakEur)}</span>
        </div>
      `;
    })
    .join("");
}

function renderStory(story) {
  const list = document.getElementById("story-list");
  if (!list) return;
  list.innerHTML = (story.bullets || []).map((b) => `<li>${b}</li>`).join("");
}

function renderRoleSummary(role, summary) {
  const el = document.getElementById("role-summary");
  if (!el) return;
  if (role === "ceo") {
    el.innerHTML = `CEO view: leakage exposure is <strong>${eur(summary.estimatedLeakEur || 0)}</strong>; prioritize top driver and weekly ROI tracking.`;
    return;
  }
  if (role === "ops") {
    el.innerHTML = `Ops view: focus on <strong>${number((summary.riskStores || 0) + (summary.criticalStores || 0))}</strong> high-risk entities and top 3 bottlenecks first.`;
    return;
  }
  el.innerHTML = "Store manager view: focus on daily execution, promo quality, and prevent avoidable closure days.";
}

async function askCopilot() {
  const input = document.getElementById("copilot-q");
  const out = document.getElementById("copilot-answer");
  if (!input || !out) return;
  const q = encodeURIComponent(input.value || "");
  const res = await fetch(`/api/copilot?q=${q}`);
  const data = await res.json();
  out.textContent = data.answer || "No answer available.";
}

function renderInterventions(items) {
  const list = document.getElementById("intervention-list");
  if (!list) return;
  if (!items.length) {
    list.textContent = "No interventions yet. Add your first action above.";
    return;
  }
  list.innerHTML = items
    .slice(0, 8)
    .map(
      (i) =>
        `<div class="intervention-item"><strong>${i.action}</strong> · owner: ${i.owner} · expected: ${eur(i.expectedUpliftEur || 0)} · actual: ${eur(i.actualUpliftEur || 0)} · progress: ${i.progressPct || 0}% · window: ${i.windowDays || 0}d · status: ${i.status}</div>`
    )
    .join("");
}

function renderImpactRanking(items) {
  const list = document.getElementById("impact-list");
  if (!list) return;
  if (!items || !items.length) {
    list.textContent = "No impact ranking available.";
    return;
  }
  list.innerHTML = items
    .slice(0, 8)
    .map(
      (i) =>
        `<div class="intervention-item"><strong>${i.id}</strong> · impact ${i.impactScore}/100 · leak ${eur(i.leakEur)} · ${i.primaryDriver}</div>`
    )
    .join("");
}

function renderClusters(items) {
  const list = document.getElementById("cluster-list");
  if (!list) return;
  if (!items || !items.length) {
    list.textContent = "No clusters available.";
    return;
  }
  list.innerHTML = items
    .slice(0, 8)
    .map(
      (c) =>
        `<div class="intervention-item"><strong>${c.rootCause}</strong> · type ${c.storeType} · ${c.count} entities · ${eur(c.totalLeakEur)}</div>`
    )
    .join("");
}

let scenarioSelection = [];

function toggleScenarioSelection(id) {
  if (scenarioSelection.includes(id)) {
    scenarioSelection = scenarioSelection.filter((x) => x !== id);
  } else {
    scenarioSelection = [...scenarioSelection, id].slice(-2);
  }
}

async function compareScenariosIfReady() {
  const out = document.getElementById("scenario-compare");
  if (!out) return;
  if (scenarioSelection.length < 2) {
    out.textContent = "Select two scenarios to compare.";
    return;
  }
  const [base, candidate] = scenarioSelection;
  const res = await fetch(`/api/scenarios/compare?base=${encodeURIComponent(base)}&candidate=${encodeURIComponent(candidate)}`);
  if (!res.ok) {
    out.textContent = "Unable to compare selected scenarios.";
    return;
  }
  const data = await res.json();
  out.innerHTML =
    `<strong>Leak delta:</strong> ${eur(data.baselineLeakDeltaEur)} · ` +
    `<strong>Recovered delta:</strong> ${eur(data.recoveredDeltaEur)} · ` +
    `<strong>ROI delta:</strong> ${data.roiDelta}%`;
}

function renderScenarios(items) {
  const list = document.getElementById("scenario-list");
  if (!list) return;
  if (!items || !items.length) {
    list.textContent = "No saved scenarios yet.";
    return;
  }
  list.innerHTML = items
    .slice(0, 10)
    .map((s) => {
      const selected = scenarioSelection.includes(s.id) ? "selected" : "";
      return `<div class="intervention-item ${selected}">
        <strong>${s.name}</strong> · recovered ${eur(s.result && s.result.recoveredEur)} · ROI ${s.result && s.result.roiScore}%
        <button class="btn btn-ghost" data-scenario-select="${s.id}" type="button">Select</button>
      </div>`;
    })
    .join("");

  list.querySelectorAll("[data-scenario-select]").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggleScenarioSelection(btn.dataset.scenarioSelect);
      renderScenarios(items);
      compareScenariosIfReady().catch(() => {});
    });
  });
}

function renderApprovals(items) {
  const list = document.getElementById("approval-list");
  if (!list) return;
  if (!items || !items.length) {
    list.textContent = "No approval requests yet.";
    return;
  }
  list.innerHTML = items
    .slice(0, 8)
    .map(
      (a) =>
        `<div class="intervention-item">
          <strong>${a.interventionId || "n/a"}</strong> · ${a.stage} · ${a.status}
          <button class="btn btn-ghost" data-approve-id="${a.id}" type="button">Approve</button>
          <button class="btn btn-ghost" data-reject-id="${a.id}" type="button">Reject</button>
        </div>`
    )
    .join("");

  list.querySelectorAll("[data-approve-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      approvalAction(btn.dataset.approveId, "approve").catch(() => {});
    });
  });
  list.querySelectorAll("[data-reject-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      approvalAction(btn.dataset.rejectId, "reject").catch(() => {});
    });
  });
}

function renderAudit(items) {
  const list = document.getElementById("audit-list");
  if (!list) return;
  if (!items || !items.length) {
    list.textContent = "No audit events yet.";
    return;
  }
  list.innerHTML = items
    .slice(0, 10)
    .map(
      (e) => `<div class="intervention-item"><strong>${e.action}</strong> · ${e.actor} · ${new Date(e.createdAt).toLocaleString()}</div>`
    )
    .join("");
}

function renderDecisionStudio(data) {
  const out = document.getElementById("studio-output");
  if (!out) return;
  out.innerHTML = `<strong>Diagnosis:</strong> ${data.diagnosis}<br><strong>Recommendation:</strong> ${data.recommendation}<br><strong>Hint:</strong> ${data.scenarioHint}`;
}

function renderMobileCommand(report, live) {
  const risk = document.getElementById("mobile-risk");
  const driver = document.getElementById("mobile-driver");
  const alerts = document.getElementById("mobile-alerts");
  const summary = report.summary || {};
  if (risk) risk.textContent = `Risk: ${number((summary.riskStores || 0) + (summary.criticalStores || 0))}`;
  if (driver) driver.textContent = `Driver: ${summary.topLeakArea || "n/a"}`;
  if (alerts) alerts.textContent = `Alerts: ${number(live.activeAlerts || 0)}`;
}

async function refreshInterventions() {
  const res = await fetch("/api/interventions");
  const items = await res.json();
  renderInterventions(items);
}

async function refreshImpactAndClusters() {
  const [impactRes, clustersRes] = await Promise.all([
    fetch("/api/impact-ranking"),
    fetch("/api/root-cause-clusters")
  ]);
  const [impact, clusters] = await Promise.all([impactRes.json(), clustersRes.json()]);
  renderImpactRanking(impact);
  renderClusters(clusters);
}

async function refreshScenarios() {
  const res = await fetch("/api/scenarios");
  const scenarios = await res.json();
  renderScenarios(scenarios);
}

async function saveScenario() {
  const name = document.getElementById("scn-name");
  const promo = document.getElementById("scn-promo");
  const closure = document.getElementById("scn-closure");
  const conversion = document.getElementById("scn-conversion");
  if (!name || !promo || !closure || !conversion) return;
  await fetch("/api/scenarios", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: name.value || undefined,
      promo: Number(promo.value || 0),
      closure: Number(closure.value || 0),
      conversion: Number(conversion.value || 0)
    })
  });
  name.value = "";
  promo.value = "";
  closure.value = "";
  conversion.value = "";
  await refreshScenarios();
}

async function runDecisionStudio() {
  const q = document.getElementById("studio-q");
  const text = q ? q.value : "";
  const res = await fetch(`/api/decision-studio?q=${encodeURIComponent(text || "")}`);
  const data = await res.json();
  renderDecisionStudio(data);
}

async function refreshApprovals() {
  const res = await fetch("/api/approvals");
  const items = await res.json();
  renderApprovals(items);
}

async function requestApproval() {
  const intervention = document.getElementById("apr-intervention");
  const notes = document.getElementById("apr-notes");
  if (!intervention || !notes) return;
  await fetch("/api/approvals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      interventionId: intervention.value || "",
      notes: notes.value || ""
    })
  });
  intervention.value = "";
  notes.value = "";
  await refreshApprovals();
}

async function approvalAction(id, action) {
  await fetch("/api/approvals/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, action })
  });
  await refreshApprovals();
}

async function refreshAudit() {
  const res = await fetch("/api/audit");
  const items = await res.json();
  renderAudit(items);
}

async function addIntervention() {
  const owner = document.getElementById("int-owner");
  const action = document.getElementById("int-action");
  const expected = document.getElementById("int-expected");
  const baseline = document.getElementById("int-baseline");
  const after = document.getElementById("int-after");
  const start = document.getElementById("int-start");
  const end = document.getElementById("int-end");
  if (!owner || !action || !expected || !baseline || !after || !start || !end) return;
  await fetch("/api/interventions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner: owner.value || "Unassigned",
      action: action.value || "Intervention",
      expectedUpliftEur: Number(expected.value || 0),
      baselineLeakEur: Number(baseline.value || 0),
      actualLeakAfterEur: after.value ? Number(after.value) : null,
      measurementStart: start.value || undefined,
      measurementEnd: end.value || undefined,
      status: "planned"
    })
  });
  owner.value = "";
  action.value = "";
  expected.value = "";
  baseline.value = "";
  after.value = "";
  await refreshInterventions();
}

async function downloadFile(url, filename) {
  const response = await fetch(url);
  const blob = await response.blob();
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}

function renderPipelineStatus(status) {
  const el = document.getElementById("pipeline-status");
  if (!el) return;
  if (!status.enabled) {
    el.textContent = "Pipeline status: disabled (train.csv not detected).";
    return;
  }
  const state = status.isBuilding ? "building..." : "idle";
  const last = status.lastSuccessAt ? `last success ${status.lastSuccessAt}` : "no successful build yet";
  const err = status.lastError ? ` | error: ${status.lastError}` : "";
  el.textContent = `Pipeline status: ${state} | ${last}${err}`;
}

async function refreshPipelineStatus() {
  const res = await fetch("/api/pipeline-status");
  const data = await res.json();
  renderPipelineStatus(data);
  return data;
}

function setDataControlStatus(message, isError = false) {
  const el = document.getElementById("data-control-status");
  if (!el) return;
  el.textContent = message;
  el.style.borderColor = isError ? "rgba(248, 113, 113, 0.45)" : "rgba(255, 255, 255, 0.12)";
}

function renderDataControl(meta) {
  const mode = document.getElementById("data-mode");
  const generated = document.getElementById("data-generated");
  const tenant = document.getElementById("data-tenant");
  if (mode) mode.textContent = `Mode: ${meta.storageMode || "unknown"}`;
  if (generated) {
    generated.textContent = meta.generatedAt
      ? `Generated: ${new Date(meta.generatedAt).toLocaleString()}`
      : "Generated: n/a";
  }
  if (tenant) tenant.textContent = `Tenant: ${meta.tenantId || "default"}`;
}

async function refreshDataControl() {
  const res = await fetch("/api/data/control");
  if (!res.ok) throw new Error("Unable to fetch data control metadata.");
  const meta = await res.json();
  renderDataControl(meta);
  return meta;
}

async function importReportFromFile() {
  const input = document.getElementById("report-file");
  if (!input || !input.files || !input.files[0]) {
    setDataControlStatus("Select a report JSON file first.", true);
    return;
  }

  const file = input.files[0];
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    setDataControlStatus("Invalid JSON file. Please upload a valid report JSON.", true);
    return;
  }

  setDataControlStatus("Importing report...");
  const res = await fetch("/api/data/import-report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ report: parsed })
  });
  const result = await res.json();
  if (!res.ok) {
    setDataControlStatus(result.error || "Failed to import report.", true);
    return;
  }

  setDataControlStatus(
    `Imported ${result.dataset || "report"} with ${number(result.cases || 0)} entities. Dashboard is now live on this dataset.`
  );
  input.value = "";
  await Promise.all([loadDashboardData(), refreshDataControl()]);
}

let latestPipelineSuccess = null;

function connectRealtimeStream() {
  if (!window.EventSource) return null;
  const stream = new EventSource("/api/stream");
  stream.addEventListener("snapshot", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.live) renderLive(data.live);
      if (data.pipeline) renderPipelineStatus(data.pipeline);
      if (data.live && window.__latestReportForMobile) {
        renderMobileCommand(window.__latestReportForMobile, data.live);
      }
    } catch (err) {
      // noop
    }
  });
  stream.addEventListener("pipeline", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.status) renderPipelineStatus(data.status);
      if (data.status && data.status.lastSuccessAt && data.status.lastSuccessAt !== latestPipelineSuccess) {
        latestPipelineSuccess = data.status.lastSuccessAt;
        loadDashboardData().catch(() => {});
        refreshDataControl().catch(() => {});
      }
    } catch (err) {
      // noop
    }
  });
  stream.addEventListener("report", () => {
    loadDashboardData().catch(() => {});
    refreshDataControl().catch(() => {});
  });
  stream.addEventListener("intervention", () => {
    refreshInterventions().catch(() => {});
    refreshImpactAndClusters().catch(() => {});
    refreshAudit().catch(() => {});
  });
  stream.addEventListener("scenario", () => {
    refreshScenarios().catch(() => {});
  });
  stream.addEventListener("approval", () => {
    refreshApprovals().catch(() => {});
    refreshAudit().catch(() => {});
  });
  stream.onerror = () => {
    // let browser auto-reconnect
  };
  return stream;
}

async function loadDashboardData() {
  const res = await fetch("/api/report");
  const report = await res.json();
  window.__latestReportForMobile = report;

  renderDatasetTag(report);
  renderTrustPills(report);
  renderInsights(report);
  renderKpis(report);
  renderOverviewGraph(report.summary || {});
  renderLeakBreakdown(report.summary || {});
  renderBottlenecks(report.bottlenecks || []);
  renderRecommendations(report.recommendations || []);
  renderCaseTable(report.cases || []);

  const live = await fetch("/api/live").then((r) => r.json());
  renderLive(live);

  const geo = await fetch("/api/geo").then((r) => r.json());
  renderGeoGrid(geo);

  const forecast = await fetch("/api/forecast").then((r) => r.json());
  renderForecast(forecast);

  const story = await fetch("/api/story").then((r) => r.json());
  renderStory(story);

  renderRoleSummary("ceo", report.summary || {});
  await refreshSimulation();
  await refreshInterventions();
  await refreshImpactAndClusters();
  await refreshScenarios();
  await refreshApprovals();
  await refreshAudit();
  renderMobileCommand(report, live);
}

function fallbackKpis(summary) {
  return [
    ["Total cases", number(summary.totalCases)],
    ["Open cases", number(summary.openCases)],
    ["Conversion", `${summary.conversionRate || 0}%`],
    ["Avg cycle (closed)", `${summary.averageCycleHoursClosed || 0} h`],
    ["Estimated leak", eur(summary.estimatedLeakEur)],
    ["Top leak area", summary.topLeakArea || "n/a"]
  ];
}

function renderKpis(report) {
  const summary = report.summary || {};
  const cards = Array.isArray(report.summaryCards) && report.summaryCards.length
    ? report.summaryCards.map((c) => [c.label, c.value])
    : fallbackKpis(summary);

  const container = document.getElementById("kpi-grid");
  container.innerHTML = cards
    .map(
      ([label, value]) => `
      <article class="kpi">
        <div class="kpi-label">${label}</div>
        <div class="kpi-value">${value}</div>
      </article>
    `
    )
    .join("");
}

function renderLeakBreakdown(summary) {
  const leaks = summary.leakByType || {};
  const entries = Object.entries(leaks);
  if (!entries.length) {
    document.getElementById("leak-breakdown").textContent = "No leak breakdown available.";
    return;
  }

  const max = Math.max(...entries.map(([, v]) => v), 1);

  const html = entries
    .map(([label, value]) => {
      const width = Math.round((value / max) * 100);
      return `
        <div class="bar-item">
          <div><strong>${label}</strong> · ${eur(value)}</div>
          <div class="bar-line"><div class="bar-fill" style="width:${width}%"></div></div>
        </div>
      `;
    })
    .join("");

  document.getElementById("leak-breakdown").innerHTML = `<div class="bar-list">${html}</div>`;
}

function renderBottlenecks(bottlenecks) {
  if (!bottlenecks || !bottlenecks.length) {
    document.getElementById("bottlenecks").textContent = "No leakage drivers found.";
    return;
  }

  const values = bottlenecks.map((b) => b.leakEur || b.leakPressure || b.avgOverflowHours || 0);
  const max = Math.max(...values, 1);

  const html = bottlenecks
    .map((b) => {
      const label = b.driver || b.transition || "Unnamed driver";
      const value = b.leakEur || b.leakPressure || b.avgOverflowHours || 0;
      const suffix = b.leakEur || b.leakPressure ? eur(value) : `${value} h`;
      const width = Math.round((value / max) * 100);

      return `
      <div class="bar-item">
        <div><strong>${label}</strong> · ${suffix}</div>
        <div class="bar-line"><div class="bar-fill" style="width:${width}%"></div></div>
      </div>
    `;
    })
    .join("");

  document.getElementById("bottlenecks").innerHTML = `<div class="bar-list">${html}</div>`;
}

function renderRecommendations(recommendations) {
  const list = document.getElementById("recommendation-list");
  if (!list) return;
  if (!recommendations || !recommendations.length) {
    list.innerHTML = "<li>No recommendations yet.</li>";
    return;
  }

  const html = recommendations
    .map(
      (r) => `
      <li>
        <strong>${r.title}</strong>
        <span class="reco-impact">${r.impact || "Medium"}</span>
        <div>${r.rationale}</div>
      </li>
    `
    )
    .join("");

  list.innerHTML = html;
}

function statusChip(status) {
  const normalized = ["open", "won", "lost"].includes(status) ? status : "open";
  const cls = `status status-${normalized}`;
  return `<span class="${cls}">${normalized}</span>`;
}

function renderCaseTable(cases) {
  const top = (cases || []).slice(0, 12);
  const rows = top
    .map((c) => {
      const entity = c.entityId || c.caseId || "n/a";
      const segment = c.segment || c.processArea || "n/a";
      const status = c.status || "open";
      const driver = c.primaryDriver || c.currentStep || "n/a";
      const score = c.leakScore != null ? `${c.leakScore}%` : "n/a";
      const value = c.valueEur != null ? eur(c.valueEur) : "n/a";

      return `
      <tr>
        <td>${entity}</td>
        <td>${segment}</td>
        <td>${statusChip(status)}</td>
        <td>${driver}</td>
        <td>${score}</td>
        <td>${eur(c.leakEur)}</td>
        <td>${value}</td>
      </tr>
    `;
    })
    .join("");

  document.getElementById("case-table").innerHTML = rows;
}

async function run() {
  await loadDashboardData();

  document.body.classList.add("ready");

  const summaryBtn = document.querySelector('[data-action="jump-summary"]');
  const recosBtn = document.querySelector('[data-action="jump-recos"]');
  if (summaryBtn) {
    summaryBtn.addEventListener("click", () => {
      const target = document.getElementById("summary");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  if (recosBtn) {
    recosBtn.addEventListener("click", () => {
      const target = document.getElementById("recommendations");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  const sliders = ["sim-promo", "sim-closure", "sim-conversion"];
  sliders.forEach((id) => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener("input", () => {
        refreshSimulation().catch(() => {});
      });
    }
  });

  const askBtn = document.getElementById("copilot-ask");
  if (askBtn) {
    askBtn.addEventListener("click", () => {
      askCopilot().catch(() => {});
    });
  }

  const copilotInput = document.getElementById("copilot-q");
  if (copilotInput) {
    copilotInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        askCopilot().catch(() => {});
      }
    });
  }

  const intAdd = document.getElementById("int-add");
  if (intAdd) {
    intAdd.addEventListener("click", () => {
      addIntervention().catch(() => {});
    });
  }

  const roleButtons = document.querySelectorAll(".role-btn");
  roleButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      roleButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      fetch("/api/report")
        .then((r) => r.json())
        .then((report) => renderRoleSummary(btn.dataset.role, report.summary || {}))
        .catch(() => {});
    });
  });

  setInterval(async () => {
    try {
      const data = await fetch("/api/live").then((r) => r.json());
      renderLive(data);
    } catch (err) {
      // noop for dashboard continuity
    }
  }, 8000);

  const exportBrief = document.getElementById("export-brief");
  if (exportBrief) {
    exportBrief.addEventListener("click", () => {
      downloadFile("/api/export/brief", "executive-brief.txt").catch(() => {});
    });
  }

  const exportActions = document.getElementById("export-actions");
  if (exportActions) {
    exportActions.addEventListener("click", () => {
      downloadFile("/api/export/actions.csv", "action-plan.csv").catch(() => {});
    });
  }

  const exportPdf = document.getElementById("export-pdf");
  if (exportPdf) {
    exportPdf.addEventListener("click", () => {
      window.open("/api/export/brief-html", "_blank", "noopener,noreferrer");
    });
  }

  const rebuildBtn = document.getElementById("pipeline-rebuild");
  if (rebuildBtn) {
    rebuildBtn.addEventListener("click", async () => {
      rebuildBtn.disabled = true;
      try {
        await fetch("/api/rebuild", { method: "POST" });
        await refreshPipelineStatus();
      } catch (err) {
        // noop
      } finally {
        setTimeout(() => {
          rebuildBtn.disabled = false;
        }, 1200);
      }
    });
  }

  const firstPipeline = await refreshPipelineStatus();
  latestPipelineSuccess = firstPipeline.lastSuccessAt || null;
  await refreshDataControl().catch(() => {});

  const reportImportBtn = document.getElementById("report-import");
  if (reportImportBtn) {
    reportImportBtn.addEventListener("click", () => {
      importReportFromFile().catch(() => {
        setDataControlStatus("Report import failed due to a network or validation error.", true);
      });
    });
  }

  const reportDownloadBtn = document.getElementById("report-download");
  if (reportDownloadBtn) {
    reportDownloadBtn.addEventListener("click", () => {
      downloadFile("/api/report", "current-report.json").catch(() => {});
    });
  }

  const reportTemplateBtn = document.getElementById("report-template");
  if (reportTemplateBtn) {
    reportTemplateBtn.addEventListener("click", () => {
      downloadFile("/api/data/template", "report-template.json").catch(() => {});
    });
  }

  const studioRun = document.getElementById("studio-run");
  if (studioRun) {
    studioRun.addEventListener("click", () => {
      runDecisionStudio().catch(() => {});
    });
  }

  const studioInput = document.getElementById("studio-q");
  if (studioInput) {
    studioInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runDecisionStudio().catch(() => {});
      }
    });
  }

  const saveScenarioBtn = document.getElementById("scn-save");
  if (saveScenarioBtn) {
    saveScenarioBtn.addEventListener("click", () => {
      saveScenario().catch(() => {});
    });
  }

  const approvalRequestBtn = document.getElementById("apr-request");
  if (approvalRequestBtn) {
    approvalRequestBtn.addEventListener("click", () => {
      requestApproval().catch(() => {});
    });
  }

  const mobileRefresh = document.getElementById("mobile-refresh");
  if (mobileRefresh) {
    mobileRefresh.addEventListener("click", () => {
      loadDashboardData().catch(() => {});
    });
  }

  setInterval(() => {
    refreshPipelineStatus()
      .then((status) => {
        if (status.lastSuccessAt && status.lastSuccessAt !== latestPipelineSuccess) {
          latestPipelineSuccess = status.lastSuccessAt;
          loadDashboardData().catch(() => {});
        }
      })
      .catch(() => {});
  }, 10000);

  connectRealtimeStream();
}

run().catch((err) => {
  document.body.innerHTML = `<pre>Failed to load report:\n${err.message}</pre>`;
});


