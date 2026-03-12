const fs = require("fs");
const path = require("path");

const config = {
  targetGapHours: {
    "lead_created->qualified": 24,
    "qualified->proposal_sent": 48,
    "proposal_sent->negotiation": 72,
    "negotiation->won": 96,
    "negotiation->lost": 96,
    "proposal_sent->proposal_sent": 24
  },
  defaultGapHours: 36,
  delayCostPerHour: 45,
  handoffThresholdHours: 12,
  handoffCostPerHour: 60,
  reworkCostPerEvent: 320,
  stallThresholdHours: 72,
  stallCostPerDay: 480
};

function readEvents() {
  const file = path.join(__dirname, "..", "data", "events.json");
  if (!fs.existsSync(file)) {
    return [];
  }

  const raw = fs.readFileSync(file, "utf8");
  const data = JSON.parse(raw);
  return data
    .map((e) => ({ ...e, ts: new Date(e.timestamp).getTime() }))
    .sort((a, b) => a.ts - b.ts);
}

function hoursBetween(fromTs, toTs) {
  return Math.max(0, (toTs - fromTs) / (1000 * 60 * 60));
}

function money(n) {
  return Math.round(n * 100) / 100;
}

function valueMultiplier(valueEur) {
  if (valueEur >= 40000) return 1.8;
  if (valueEur >= 20000) return 1.4;
  return 1.0;
}

function classifyStatus(lastEventType) {
  if (lastEventType === "won") return "won";
  if (lastEventType === "lost") return "lost";
  return "open";
}

function aggregate(events) {
  const cases = new Map();

  for (const event of events) {
    if (!cases.has(event.caseId)) {
      cases.set(event.caseId, {
        caseId: event.caseId,
        processArea: event.processArea,
        valueEur: event.valueEur,
        events: []
      });
    }
    cases.get(event.caseId).events.push(event);
  }

  const nowTs = Date.now();
  const caseMetrics = [];
  const transitionStats = new Map();
  const areaLeakTotals = new Map();

  let totalDelayLeak = 0;
  let totalReworkLeak = 0;
  let totalHandoffLeak = 0;
  let totalStallLeak = 0;
  let totalCycleHoursClosed = 0;
  let closedCases = 0;
  let wonCases = 0;

  for (const data of cases.values()) {
    data.events.sort((a, b) => a.ts - b.ts);

    const firstEvent = data.events[0];
    const lastEvent = data.events[data.events.length - 1];
    const status = classifyStatus(lastEvent.eventType);
    const cycleHours = hoursBetween(firstEvent.ts, lastEvent.ts);
    const ageHours = hoursBetween(firstEvent.ts, nowTs);

    if (status !== "open") {
      totalCycleHoursClosed += cycleHours;
      closedCases += 1;
      if (status === "won") wonCases += 1;
    }

    const seenEvents = new Map();
    let reworkCount = 0;
    let handoffCount = 0;
    let delayLeak = 0;
    let handoffLeak = 0;

    for (let i = 0; i < data.events.length; i += 1) {
      const current = data.events[i];

      seenEvents.set(current.eventType, (seenEvents.get(current.eventType) || 0) + 1);
      if (seenEvents.get(current.eventType) > 1) {
        reworkCount += 1;
      }

      if (i === 0) continue;

      const previous = data.events[i - 1];
      const transition = `${previous.eventType}->${current.eventType}`;
      const gapHours = hoursBetween(previous.ts, current.ts);
      const target = config.targetGapHours[transition] || config.defaultGapHours;
      const overflow = Math.max(0, gapHours - target);
      const weightedDelay = overflow * config.delayCostPerHour * valueMultiplier(data.valueEur);
      delayLeak += weightedDelay;

      if (!transitionStats.has(transition)) {
        transitionStats.set(transition, {
          transition,
          count: 0,
          totalGapHours: 0,
          totalOverflowHours: 0,
          target
        });
      }

      const stat = transitionStats.get(transition);
      stat.count += 1;
      stat.totalGapHours += gapHours;
      stat.totalOverflowHours += overflow;

      if (previous.ownerTeam !== current.ownerTeam) {
        handoffCount += 1;
        const handoffOverflow = Math.max(0, gapHours - config.handoffThresholdHours);
        handoffLeak += handoffOverflow * config.handoffCostPerHour;
      }
    }

    const reworkLeak = reworkCount * config.reworkCostPerEvent;
    const stalledHours = status === "open" ? hoursBetween(lastEvent.ts, nowTs) : 0;
    const stalledDays = Math.max(0, (stalledHours - config.stallThresholdHours) / 24);
    const stallLeak = stalledDays * config.stallCostPerDay;
    const totalLeak = delayLeak + handoffLeak + reworkLeak + stallLeak;

    totalDelayLeak += delayLeak;
    totalReworkLeak += reworkLeak;
    totalHandoffLeak += handoffLeak;
    totalStallLeak += stallLeak;

    const areaTotal = areaLeakTotals.get(data.processArea) || 0;
    areaLeakTotals.set(data.processArea, areaTotal + totalLeak);

    caseMetrics.push({
      caseId: data.caseId,
      processArea: data.processArea,
      status,
      eventCount: data.events.length,
      cycleHours: money(cycleHours),
      ageHours: money(ageHours),
      handoffCount,
      reworkCount,
      leakEur: money(totalLeak),
      delayLeakEur: money(delayLeak),
      handoffLeakEur: money(handoffLeak),
      reworkLeakEur: money(reworkLeak),
      stallLeakEur: money(stallLeak),
      currentStep: lastEvent.eventType,
      lastOwner: lastEvent.ownerTeam,
      valueEur: data.valueEur
    });
  }

  caseMetrics.sort((a, b) => b.leakEur - a.leakEur);

  const bottlenecks = Array.from(transitionStats.values())
    .map((s) => ({
      transition: s.transition,
      count: s.count,
      avgGapHours: money(s.totalGapHours / s.count),
      avgOverflowHours: money(s.totalOverflowHours / s.count),
      targetHours: s.target,
      leakPressure: money(s.totalOverflowHours * config.delayCostPerHour)
    }))
    .sort((a, b) => b.avgOverflowHours - a.avgOverflowHours)
    .slice(0, 8);

  const topArea = Array.from(areaLeakTotals.entries())
    .sort((a, b) => b[1] - a[1])[0];

  const openCases = caseMetrics.filter((c) => c.status === "open").length;
  const totalLeak = totalDelayLeak + totalReworkLeak + totalHandoffLeak + totalStallLeak;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalCases: caseMetrics.length,
      openCases,
      closedCases,
      wonCases,
      conversionRate: closedCases ? money((wonCases / closedCases) * 100) : 0,
      averageCycleHoursClosed: closedCases ? money(totalCycleHoursClosed / closedCases) : 0,
      estimatedLeakEur: money(totalLeak),
      leakByType: {
        delay: money(totalDelayLeak),
        rework: money(totalReworkLeak),
        handoff: money(totalHandoffLeak),
        stalled: money(totalStallLeak)
      },
      topLeakArea: topArea ? topArea[0] : "n/a"
    },
    bottlenecks,
    cases: caseMetrics
  };
}

module.exports = {
  readEvents,
  aggregate
};

