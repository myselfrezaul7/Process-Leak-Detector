function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values, m) {
  if (values.length < 2) return 0;
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function detectAnomalies(report) {
  const cases = report.cases || [];
  const leakValues = cases.map((c) => Number(c.leakEur || 0));
  const leakMean = mean(leakValues);
  const leakStd = std(leakValues, leakMean);
  if (!cases.length || leakStd === 0) return [];

  return cases
    .map((c) => {
      const leak = Number(c.leakEur || 0);
      const z = (leak - leakMean) / leakStd;
      return {
        id: c.entityId || c.caseId,
        leakEur: leak,
        zScore: Number(z.toFixed(2)),
        severity: z >= 2.5 ? "high" : z >= 1.8 ? "medium" : "low",
        primaryDriver: c.primaryDriver || c.currentStep || "unknown",
        storeType: c.storeType || "unknown"
      };
    })
    .filter((x) => x.zScore >= 1.8)
    .sort((a, b) => b.zScore - a.zScore)
    .slice(0, 40);
}

function explainEntity(report, entityId) {
  const item = (report.cases || []).find(
    (c) => String(c.entityId || c.caseId).toLowerCase() === String(entityId || "").toLowerCase()
  );
  if (!item) {
    return null;
  }
  const components = [
    ["conversion", Number(item.conversionLeakEur || 0)],
    ["promo", Number(item.promoLeakEur || 0)],
    ["closures", Number(item.closureLeakEur || 0)],
    ["volatility", Number(item.volatilityLeakEur || 0)]
  ];
  const total = components.reduce((acc, [, v]) => acc + v, 0) || 1;
  return {
    id: item.entityId || item.caseId,
    summary: `Primary driver: ${item.primaryDriver || item.currentStep || "unknown"}`,
    contributions: components.map(([name, value]) => ({
      name,
      leakEur: Math.round(value),
      sharePct: Math.round((value / total) * 100)
    })),
    metadata: {
      segment: item.segment || item.processArea || "unknown",
      storeType: item.storeType || "unknown",
      assortment: item.assortment || "unknown"
    }
  };
}

function alertsFromAnomalies(anomalies) {
  return anomalies.slice(0, 12).map((a, i) => ({
    id: `an-${i + 1}-${Date.now()}`,
    type: "anomaly",
    severity: a.severity,
    title: `${a.id} anomaly (${a.zScore})`,
    detail: `Leak ${Math.round(a.leakEur).toLocaleString("en-US")} EUR, driver ${a.primaryDriver}`,
    createdAt: new Date().toISOString()
  }));
}

function computeImpactScore(item) {
  const leak = Number(item.leakEur || 0);
  const leakScore = Math.min(55, Math.round(leak / 15000));
  const riskScore = item.status === "lost" ? 22 : item.status === "open" ? 14 : 6;
  const confidence = Number(item.confidencePct || 70);
  const confidenceScore = Math.round((confidence / 100) * 15);
  const readiness = item.status === "planned" ? 8 : item.status === "approved" ? 12 : 6;
  const total = Math.max(0, Math.min(100, leakScore + riskScore + confidenceScore + readiness));
  return total;
}

function buildImpactRanking(report, interventions) {
  const interventionByEntity = new Map();
  (interventions || []).forEach((i) => {
    if (i.entityId) interventionByEntity.set(String(i.entityId).toLowerCase(), i);
  });

  return (report.cases || [])
    .map((c) => {
      const key = String(c.entityId || c.caseId || "").toLowerCase();
      const linked = interventionByEntity.get(key);
      const impactScore = computeImpactScore({
        ...c,
        confidencePct: linked ? linked.confidencePct : 70,
        status: linked ? linked.status : c.status
      });
      return {
        id: c.entityId || c.caseId,
        leakEur: Number(c.leakEur || 0),
        primaryDriver: c.primaryDriver || c.currentStep || "unknown",
        segment: c.segment || c.processArea || "unknown",
        impactScore
      };
    })
    .sort((a, b) => b.impactScore - a.impactScore)
    .slice(0, 80);
}

function clusterRootCauses(report) {
  const items = report.cases || [];
  const map = new Map();
  items.forEach((c) => {
    const key = `${c.primaryDriver || c.currentStep || "unknown"}|${c.storeType || "unknown"}`;
    if (!map.has(key)) {
      map.set(key, {
        id: `cluster-${map.size + 1}`,
        rootCause: c.primaryDriver || c.currentStep || "unknown",
        storeType: c.storeType || "unknown",
        count: 0,
        totalLeakEur: 0
      });
    }
    const row = map.get(key);
    row.count += 1;
    row.totalLeakEur += Number(c.leakEur || 0);
  });

  return Array.from(map.values())
    .map((r) => ({
      ...r,
      avgLeakEur: Math.round(r.totalLeakEur / Math.max(1, r.count)),
      totalLeakEur: Math.round(r.totalLeakEur)
    }))
    .sort((a, b) => b.totalLeakEur - a.totalLeakEur)
    .slice(0, 20);
}

module.exports = {
  detectAnomalies,
  explainEntity,
  alertsFromAnomalies,
  computeImpactScore,
  buildImpactRanking,
  clusterRootCauses
};
