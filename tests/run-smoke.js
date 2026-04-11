const assert = require("node:assert/strict");
const { normalizeTenantId } = require("../src/tenant");
const { detectAnomalies, explainEntity } = require("../src/intelligence");

function run(name, fn) {
  try {
    fn();
    process.stdout.write(`PASS: ${name}\n`);
  } catch (err) {
    process.stderr.write(`FAIL: ${name}\n${err.stack}\n`);
    process.exitCode = 1;
  }
}

run("normalizeTenantId keeps safe chars only", () => {
  assert.equal(normalizeTenantId("Acme-West#1"), "acme-west1");
  assert.equal(normalizeTenantId(""), "default");
});

run("detectAnomalies finds high z-score outlier", () => {
  const base = Array.from({ length: 20 }, (_, i) => ({
    entityId: `N-${i + 1}`,
    leakEur: 900 + i * 8,
    primaryDriver: "conversion"
  }));
  const report = { cases: [...base, { entityId: "D", leakEur: 40000, primaryDriver: "closures" }] };
  const anomalies = detectAnomalies(report);
  assert.ok(anomalies.length >= 1);
  assert.equal(anomalies[0].id, "D");
});

run("explainEntity returns contribution breakdown", () => {
  const report = {
    cases: [
      {
        entityId: "Store 1",
        conversionLeakEur: 100,
        promoLeakEur: 40,
        closureLeakEur: 60,
        volatilityLeakEur: 20,
        primaryDriver: "Conversion gap",
        segment: "mid-volume",
        storeType: "a",
        assortment: "a"
      }
    ]
  };
  const explanation = explainEntity(report, "Store 1");
  assert.ok(explanation);
  assert.equal(explanation.id, "Store 1");
  assert.equal(explanation.contributions.length, 4);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
