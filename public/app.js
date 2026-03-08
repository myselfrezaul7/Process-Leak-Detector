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
  if (!recommendations || !recommendations.length) {
    document.getElementById("recommendations").innerHTML = "<li>No recommendations yet.</li>";
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

  document.getElementById("recommendations").innerHTML = html;
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
  const res = await fetch("/api/report");
  const report = await res.json();

  renderDatasetTag(report);
  renderKpis(report);
  renderLeakBreakdown(report.summary || {});
  renderBottlenecks(report.bottlenecks || []);
  renderRecommendations(report.recommendations || []);
  renderCaseTable(report.cases || []);
}

run().catch((err) => {
  document.body.innerHTML = `<pre>Failed to load report:\n${err.message}</pre>`;
});
