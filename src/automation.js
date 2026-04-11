function buildDigest(report, interventions, tenantId) {
  const summary = report.summary || {};
  const expected = interventions.reduce((acc, i) => acc + Number(i.expectedUpliftEur || 0), 0);
  const actual = interventions.reduce((acc, i) => acc + Number(i.actualUpliftEur || 0), 0);
  return [
    `Tenant: ${tenantId}`,
    `Generated: ${new Date().toISOString()}`,
    `Leakage estimate: ${Math.round(summary.estimatedLeakEur || 0).toLocaleString("en-US")} EUR`,
    `Top driver: ${summary.topLeakArea || "n/a"}`,
    `Risk entities: ${((summary.riskStores || 0) + (summary.criticalStores || 0)).toLocaleString("en-US")}`,
    `Interventions: ${interventions.length}`,
    `Expected uplift total: ${Math.round(expected).toLocaleString("en-US")} EUR`,
    `Actual uplift total: ${Math.round(actual).toLocaleString("en-US")} EUR`
  ].join("\n");
}

async function sendTaskToProvider(provider, payload) {
  const providerKey = String(provider || "").toLowerCase();
  const envKey =
    providerKey === "jira"
      ? "JIRA_WEBHOOK_URL"
      : providerKey === "asana"
        ? "ASANA_WEBHOOK_URL"
        : providerKey === "clickup"
          ? "CLICKUP_WEBHOOK_URL"
          : "";
  const target = envKey ? process.env[envKey] : "";
  if (!target) {
    return { delivered: false, reason: "Webhook URL not configured" };
  }

  const res = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return { delivered: res.ok, statusCode: res.status };
}

module.exports = {
  buildDigest,
  sendTaskToProvider
};
