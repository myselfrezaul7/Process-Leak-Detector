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
        `<div class="intervention-item"><strong>${i.action}</strong> · owner: ${i.owner} · expected: ${eur(i.expectedUpliftEur || 0)} · status: ${i.status}</div>`
    )
    .join("");
}

async function refreshInterventions() {
  const res = await fetch("/api/interventions");
  const items = await res.json();
  renderInterventions(items);
}

async function addIntervention() {
  const owner = document.getElementById("int-owner");
  const action = document.getElementById("int-action");
  const expected = document.getElementById("int-expected");
  if (!owner || !action || !expected) return;
  await fetch("/api/interventions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner: owner.value || "Unassigned",
      action: action.value || "Intervention",
      expectedUpliftEur: Number(expected.value || 0),
      status: "planned"
    })
  });
  owner.value = "";
  action.value = "";
  expected.value = "";
  await refreshInterventions();
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
  const res = await fetch("/api/report");
  const report = await res.json();

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
      renderRoleSummary(btn.dataset.role, report.summary || {});
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
}

run().catch((err) => {
  document.body.innerHTML = `<pre>Failed to load report:\n${err.message}</pre>`;
});


