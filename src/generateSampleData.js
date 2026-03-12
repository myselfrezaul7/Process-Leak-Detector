const fs = require("fs");
const path = require("path");

function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(20260308);
const processAreas = ["sales", "procurement", "customer-success"];
const teamsByArea = {
  sales: ["BDR", "AE", "Legal"],
  procurement: ["Requester", "Buyer", "Approver"],
  "customer-success": ["CSM", "Support", "Finance"]
};

const transitionTemplates = [
  "lead_created",
  "qualified",
  "proposal_sent",
  "negotiation",
  "won"
];

function randInt(min, max) {
  return Math.floor(random() * (max - min + 1)) + min;
}

function chance(p) {
  return random() < p;
}

function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}

function toIso(baseHourOffset) {
  const now = new Date();
  const d = new Date(now.getTime() - baseHourOffset * 60 * 60 * 1000);
  return d.toISOString();
}

function createCase(caseNum) {
  const area = pick(processAreas);
  const teams = teamsByArea[area];
  const caseId = `C-${String(caseNum).padStart(4, "0")}`;
  const caseValue = randInt(5000, 65000);

  const steps = [...transitionTemplates];
  if (chance(0.2)) {
    steps[4] = "lost";
  }
  if (chance(0.35)) {
    steps.splice(3, 0, "proposal_sent");
  }

  const events = [];
  let elapsed = randInt(80, 600);
  let owner = pick(teams);

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const gap = i === 0 ? 0 : randInt(4, 96) + (chance(0.2) ? randInt(40, 140) : 0);
    elapsed -= gap;

    if (i > 0 && chance(0.45)) {
      owner = pick(teams);
    }

    events.push({
      caseId,
      processArea: area,
      eventType: step,
      timestamp: toIso(Math.max(1, elapsed)),
      ownerTeam: owner,
      valueEur: caseValue
    });
  }

  if (chance(0.2)) {
    const last = events[events.length - 1];
    events.pop();
    events.push({
      ...last,
      eventType: "negotiation"
    });
  }

  return events;
}

const allEvents = [];
for (let i = 1; i <= 42; i += 1) {
  allEvents.push(...createCase(i));
}

allEvents.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

const outPath = path.join(__dirname, "..", "data", "events.json");
fs.writeFileSync(outPath, JSON.stringify(allEvents, null, 2));
console.log(`Generated ${allEvents.length} events into ${outPath}`);

