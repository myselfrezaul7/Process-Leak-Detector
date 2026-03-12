const fs = require("fs");
const path = require("path");
const readline = require("readline");

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  out.push(current);
  return out;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function money(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function welfordUpdate(state, value) {
  state.count += 1;
  const delta = value - state.mean;
  state.mean += delta / state.count;
  const delta2 = value - state.mean;
  state.m2 += delta * delta2;
}

function welfordStdDev(state) {
  if (state.count < 2) return 0;
  return Math.sqrt(state.m2 / (state.count - 1));
}

function initStore(id) {
  return {
    id,
    rows: 0,
    openDays: 0,
    closedDays: 0,
    totalSales: 0,
    totalCustomers: 0,
    promoDays: 0,
    promoSales: 0,
    promoCustomers: 0,
    noPromoDays: 0,
    noPromoSales: 0,
    noPromoCustomers: 0,
    closedByWeekday: Array(8).fill(0),
    weekdaySales: Array(8).fill(0),
    weekdayOpenDays: Array(8).fill(0),
    avoidableClosedDays: 0,
    salesWelford: { count: 0, mean: 0, m2: 0 }
  };
}

function pickStatus(leakPct) {
  if (leakPct >= 0.18) return "lost";
  if (leakPct >= 0.1) return "open";
  return "won";
}

function formatPercent(value) {
  return Math.round(value * 10000) / 100;
}

function findCsvPath() {
  const cliPath = process.argv[2];
  const candidates = [
    cliPath,
    process.env.ROSSMANN_TRAIN_PATH,
    path.join(__dirname, "..", "data", "train.csv"),
    "C:\\Users\\mysel\\OneDrive\\Desktop\\Azure\\rossmann-store-sales\\train.csv"
  ].filter(Boolean);

  return candidates.find((p) => fs.existsSync(p));
}

async function buildRossmannReport(csvPath) {
  const stores = new Map();

  const global = {
    rows: 0,
    openDays: 0,
    totalSalesOpen: 0,
    totalCustomersOpen: 0,
    promoSales: 0,
    promoCustomers: 0,
    noPromoSales: 0,
    noPromoCustomers: 0,
    weekdaySales: Array(8).fill(0),
    weekdayOpenDays: Array(8).fill(0),
    salesWelford: { count: 0, mean: 0, m2: 0 },
    minDate: null,
    maxDate: null
  };

  const stream = fs.createReadStream(csvPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let isHeader = true;

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (isHeader) {
      isHeader = false;
      continue;
    }

    const cols = parseCsvLine(line);
    if (cols.length < 9) continue;

    const storeId = String(cols[0]);
    const dayOfWeek = Math.max(1, Math.min(7, parseInt(cols[1], 10) || 1));
    const date = cols[2];
    const sales = toNumber(cols[3]);
    const customers = toNumber(cols[4]);
    const open = toNumber(cols[5]);
    const promo = toNumber(cols[6]);
    const stateHoliday = String(cols[7] || "0");

    if (!stores.has(storeId)) {
      stores.set(storeId, initStore(storeId));
    }

    const store = stores.get(storeId);
    store.rows += 1;
    global.rows += 1;

    if (!global.minDate || date < global.minDate) global.minDate = date;
    if (!global.maxDate || date > global.maxDate) global.maxDate = date;

    if (open === 1) {
      store.openDays += 1;
      store.totalSales += sales;
      store.totalCustomers += customers;
      store.weekdaySales[dayOfWeek] += sales;
      store.weekdayOpenDays[dayOfWeek] += 1;
      welfordUpdate(store.salesWelford, sales);

      global.openDays += 1;
      global.totalSalesOpen += sales;
      global.totalCustomersOpen += customers;
      global.weekdaySales[dayOfWeek] += sales;
      global.weekdayOpenDays[dayOfWeek] += 1;
      welfordUpdate(global.salesWelford, sales);

      if (promo === 1) {
        store.promoDays += 1;
        store.promoSales += sales;
        store.promoCustomers += customers;
        global.promoSales += sales;
        global.promoCustomers += customers;
      } else {
        store.noPromoDays += 1;
        store.noPromoSales += sales;
        store.noPromoCustomers += customers;
        global.noPromoSales += sales;
        global.noPromoCustomers += customers;
      }
    } else {
      store.closedDays += 1;
      store.closedByWeekday[dayOfWeek] += 1;
      if (dayOfWeek !== 7 && stateHoliday === "0") {
        store.avoidableClosedDays += 1;
      }
    }
  }

  const globalSalesPerCustomer = global.totalSalesOpen / Math.max(1, global.totalCustomersOpen);
  const globalAvgOpenSales = global.totalSalesOpen / Math.max(1, global.openDays);
  const globalPromoSpc = global.promoSales / Math.max(1, global.promoCustomers);
  const globalNoPromoSpc = global.noPromoSales / Math.max(1, global.noPromoCustomers);
  const expectedPromoUplift = globalNoPromoSpc > 0
    ? Math.max(0, globalPromoSpc / globalNoPromoSpc - 1)
    : 0;
  const globalStd = welfordStdDev(global.salesWelford);
  const globalCv = global.salesWelford.mean > 0 ? globalStd / global.salesWelford.mean : 0;
  const weekdayAvgSales = global.weekdaySales.map((sum, d) => sum / Math.max(1, global.weekdayOpenDays[d]));

  let totalConversionLeak = 0;
  let totalPromoLeak = 0;
  let totalClosureLeak = 0;
  let totalVolatilityLeak = 0;

  const weekdayClosureLeak = Array(8).fill(0);
  const cases = [];

  for (const store of stores.values()) {
    const storeAvgOpenSales = store.totalSales / Math.max(1, store.openDays);
    const storeSpc = store.totalSales / Math.max(1, store.totalCustomers);

    const conversionLeak = Math.max(0, globalSalesPerCustomer - storeSpc)
      * store.totalCustomers
      * 0.55;

    let promoLeak = 0;
    if (store.promoCustomers > 0 && store.noPromoCustomers > 0) {
      const storeNoPromoSpc = store.noPromoSales / Math.max(1, store.noPromoCustomers);
      const expectedPromoSales = storeNoPromoSpc * (1 + expectedPromoUplift) * store.promoCustomers;
      promoLeak = Math.max(0, expectedPromoSales - store.promoSales) * 0.6;
    }

    const volumeFactor = clamp(storeAvgOpenSales / Math.max(1, globalAvgOpenSales), 0.5, 2.5);
    let closureLeak = 0;
    for (let d = 1; d <= 6; d += 1) {
      const dayLeak = store.closedByWeekday[d] * weekdayAvgSales[d] * volumeFactor * 0.5;
      closureLeak += dayLeak;
      weekdayClosureLeak[d] += dayLeak;
    }

    const storeStd = welfordStdDev(store.salesWelford);
    const storeCv = store.salesWelford.mean > 0 ? storeStd / store.salesWelford.mean : 0;
    const volatilityLeak = Math.max(0, storeCv - globalCv)
      * storeAvgOpenSales
      * store.openDays
      * 0.3;

    const totalLeak = conversionLeak + promoLeak + closureLeak + volatilityLeak;
    const leakPct = totalLeak / Math.max(1, store.totalSales);

    totalConversionLeak += conversionLeak;
    totalPromoLeak += promoLeak;
    totalClosureLeak += closureLeak;
    totalVolatilityLeak += volatilityLeak;

    const segment = storeAvgOpenSales >= globalAvgOpenSales * 1.4
      ? "high-volume"
      : storeAvgOpenSales >= globalAvgOpenSales * 0.8
        ? "mid-volume"
        : "low-volume";

    const driverPairs = [
      ["Conversion gap", conversionLeak],
      ["Promo underperformance", promoLeak],
      ["Avoidable closures", closureLeak],
      ["Demand volatility", volatilityLeak]
    ];

    driverPairs.sort((a, b) => b[1] - a[1]);
    const primaryDriver = driverPairs[0][0];

    cases.push({
      caseId: `Store-${store.id}`,
      entityId: `Store ${store.id}`,
      processArea: segment,
      segment,
      status: pickStatus(leakPct),
      currentStep: primaryDriver,
      primaryDriver,
      reworkCount: Math.round(leakPct * 100),
      handoffCount: store.avoidableClosedDays,
      leakScore: formatPercent(leakPct),
      leakEur: money(totalLeak),
      conversionLeakEur: money(conversionLeak),
      promoLeakEur: money(promoLeak),
      closureLeakEur: money(closureLeak),
      volatilityLeakEur: money(volatilityLeak),
      avgDailySalesEur: money(storeAvgOpenSales),
      valueEur: money(store.totalSales),
      openDays: store.openDays,
      totalCustomers: store.totalCustomers
    });
  }

  cases.sort((a, b) => b.leakEur - a.leakEur);

  const totalLeak = totalConversionLeak + totalPromoLeak + totalClosureLeak + totalVolatilityLeak;
  const criticalStores = cases.filter((c) => c.status === "lost").length;
  const riskStores = cases.filter((c) => c.status === "open").length;
  const healthyStores = cases.filter((c) => c.status === "won").length;

  const leakDrivers = [
    ["Conversion gap", totalConversionLeak],
    ["Promo underperformance", totalPromoLeak],
    ["Avoidable closures", totalClosureLeak],
    ["Demand volatility", totalVolatilityLeak]
  ]
    .sort((a, b) => b[1] - a[1])
    .map(([driver, leakEur]) => ({
      driver,
      leakEur: money(leakEur),
      sharePct: totalLeak > 0 ? money((leakEur / totalLeak) * 100) : 0
    }));

  const weekdayNames = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const closureDrivers = weekdayClosureLeak
    .map((v, d) => ({ d, v }))
    .filter((x) => x.d >= 1 && x.d <= 6)
    .sort((a, b) => b.v - a.v)
    .slice(0, 2)
    .map((x) => ({
      driver: `Closure pressure on ${weekdayNames[x.d]}`,
      leakEur: money(x.v),
      sharePct: totalLeak > 0 ? money((x.v / totalLeak) * 100) : 0
    }));

  const bottlenecks = [...leakDrivers, ...closureDrivers].slice(0, 8);

  const recommendations = [];
  if (leakDrivers[0] && leakDrivers[0].driver === "Conversion gap") {
    recommendations.push({
      title: "Improve conversion quality in low-SPC stores",
      rationale: "Sales per customer is the largest leakage source. Focus on assortment, pricing, and in-store conversion coaching.",
      impact: "High"
    });
  }

  if (totalPromoLeak > totalLeak * 0.2) {
    recommendations.push({
      title: "Recalibrate promo execution",
      rationale: "Promo uplift is below expected in many stores. Tune promo mechanics by store segment and weekday.",
      impact: "High"
    });
  }

  if (totalClosureLeak > totalLeak * 0.15) {
    recommendations.push({
      title: "Reduce avoidable non-holiday closures",
      rationale: "Avoidable closures create direct missed-sales leakage on high-demand weekdays.",
      impact: "Medium"
    });
  }

  if (riskStores + criticalStores > cases.length * 0.35) {
    recommendations.push({
      title: "Create a weekly at-risk store review",
      rationale: "A large share of stores have high leak score. Weekly intervention loops can recover revenue quickly.",
      impact: "Medium"
    });
  }

  recommendations.push({
    title: "Deploy store cluster playbooks",
    rationale: "Split stores into high/mid/low-volume clusters and apply distinct actions to avoid one-size-fits-all decisions.",
    impact: "Medium"
  });

  const avgDailySalesPerStore = cases.length
    ? cases.reduce((acc, c) => acc + c.avgDailySalesEur, 0) / cases.length
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    dataset: "rossmann-train",
    summary: {
      totalStores: cases.length,
      rowsProcessed: global.rows,
      periodStart: global.minDate,
      periodEnd: global.maxDate,
      estimatedLeakEur: money(totalLeak),
      leakByType: {
        conversion: money(totalConversionLeak),
        promo: money(totalPromoLeak),
        closures: money(totalClosureLeak),
        volatility: money(totalVolatilityLeak)
      },
      criticalStores,
      riskStores,
      healthyStores,
      avgDailySalesPerStore: money(avgDailySalesPerStore),
      globalSalesPerCustomer: money(globalSalesPerCustomer),
      expectedPromoUpliftPct: money(expectedPromoUplift * 100),
      topLeakArea: leakDrivers[0] ? leakDrivers[0].driver : "n/a"
    },
    summaryCards: [
      { label: "Dataset", value: "Rossmann train.csv" },
      { label: "Stores", value: String(cases.length) },
      { label: "Rows", value: String(global.rows) },
      { label: "Leak estimate", value: `${Math.round(totalLeak).toLocaleString("en-US")} EUR` },
      { label: "Risk stores", value: String(riskStores + criticalStores) },
      { label: "Period", value: `${global.minDate} to ${global.maxDate}` }
    ],
    bottlenecks,
    recommendations: recommendations.slice(0, 5),
    cases
  };
}

async function main() {
  const csvPath = findCsvPath();
  if (!csvPath) {
    console.error("Could not find train.csv. Provide a path: node src/buildRossmannReport.js <path>");
    process.exit(1);
  }

  const report = await buildRossmannReport(csvPath);
  const outPath = path.join(__dirname, "..", "data", "rossmann_report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  console.log(`Rossmann report written to ${outPath}`);
  console.log(`Stores: ${report.summary.totalStores}, Leak estimate: EUR ${report.summary.estimatedLeakEur}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

