function createRecommendations(report) {
  const { summary, bottlenecks, cases } = report;
  const recommendations = [];

  if (summary.leakByType.delay > summary.estimatedLeakEur * 0.45) {
    recommendations.push({
      title: "Set transition SLAs and auto-escalations",
      rationale:
        "Delay leak is the largest share, so strict SLA timers between process steps will reduce wait-time leakage fastest.",
      impact: "High"
    });
  }

  const highReworkCases = cases.filter((c) => c.reworkCount >= 1).length;
  if (highReworkCases >= Math.ceil(cases.length * 0.25)) {
    recommendations.push({
      title: "Introduce first-time-right quality gates",
      rationale:
        "A high number of cases repeat steps. Add validation checklists before handoff to prevent loops and rework cost.",
      impact: "Medium"
    });
  }

  const highHandoffCases = cases.filter((c) => c.handoffCount >= 2).length;
  if (highHandoffCases >= Math.ceil(cases.length * 0.2)) {
    recommendations.push({
      title: "Reduce cross-team handoffs for high-value cases",
      rationale:
        "Frequent owner switches correlate with delay and handoff leak. Assign case ownership to one accountable pod.",
      impact: "High"
    });
  }

  if (bottlenecks.length > 0) {
    const top = bottlenecks[0];
    recommendations.push({
      title: `Fix bottleneck: ${top.transition}`,
      rationale:
        `This transition has the highest overflow (${top.avgOverflowHours}h average). Investigate approval loops and staffing in this step.`,
      impact: "High"
    });
  }

  const staleOpenCases = cases.filter((c) => c.status === "open" && c.ageHours > 200).length;
  if (staleOpenCases > 0) {
    recommendations.push({
      title: "Launch weekly stale-case review",
      rationale:
        `There are ${staleOpenCases} long-running open cases. Weekly triage can recover blocked revenue and reduce stall leakage.`,
      impact: "Medium"
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      title: "Baseline is stable, tighten KPIs",
      rationale:
        "No major leak pattern crossed thresholds; next step is refining thresholds by process area and value segment.",
      impact: "Low"
    });
  }

  return recommendations.slice(0, 5);
}

module.exports = {
  createRecommendations
};
