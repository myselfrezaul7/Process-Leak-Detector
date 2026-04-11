const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { tenantDir, normalizeTenantId } = require("./tenant");
const { log } = require("./logger");

async function fileExists(filepath) {
  try {
    await fsp.access(filepath);
    return true;
  } catch (err) {
    return false;
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function buildPaths(baseDataDir, tenantId) {
  const dir = tenantDir(baseDataDir, tenantId);
  return {
    dir,
    report: path.join(dir, "report.json"),
    interventions: path.join(dir, "interventions.json"),
    alerts: path.join(dir, "alerts.json"),
    tasks: path.join(dir, "tasks.json"),
    users: path.join(dir, "users.json"),
    digest: path.join(dir, "digest_latest.txt")
  };
}

async function readJsonFile(filepath, fallback) {
  try {
    const raw = await fsp.readFile(filepath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

async function writeJsonFile(filepath, data) {
  await ensureDir(path.dirname(filepath));
  await fsp.writeFile(filepath, JSON.stringify(data, null, 2), "utf8");
}

class Storage {
  constructor(baseDataDir) {
    this.baseDataDir = baseDataDir;
    this.pgEnabled = false;
    this.pgPool = null;
  }

  async init() {
    await ensureDir(this.baseDataDir);
    await ensureDir(path.join(this.baseDataDir, "tenants"));
    await this.migrateLegacyToDefaultTenant();
    await this.tryInitPostgres();
  }

  async tryInitPostgres() {
    if (!process.env.DATABASE_URL) return;
    try {
      // Optional dependency; app still works in file mode if pg is absent.
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      const { Pool } = require("pg");
      this.pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
      await this.pgPool.query(`
        CREATE TABLE IF NOT EXISTS interventions (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          payload JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      this.pgEnabled = true;
      log("info", "PostgreSQL storage enabled");
    } catch (err) {
      this.pgEnabled = false;
      log("warn", "PostgreSQL unavailable; fallback to file storage", { error: err.message });
    }
  }

  async migrateLegacyToDefaultTenant() {
    const legacyReport = path.join(this.baseDataDir, "rossmann_report.json");
    const legacyInterventions = path.join(this.baseDataDir, "interventions.json");
    const target = buildPaths(this.baseDataDir, "default");
    await ensureDir(target.dir);

    if (await fileExists(legacyReport)) {
      const targetMissing = !(await fileExists(target.report));
      if (targetMissing) {
        await fsp.copyFile(legacyReport, target.report);
      }
    }
    if (await fileExists(legacyInterventions)) {
      const targetMissing = !(await fileExists(target.interventions));
      if (targetMissing) {
        await fsp.copyFile(legacyInterventions, target.interventions);
      }
    }
    if (!(await fileExists(target.interventions))) {
      await writeJsonFile(target.interventions, []);
    }
    if (!(await fileExists(target.alerts))) {
      await writeJsonFile(target.alerts, []);
    }
    if (!(await fileExists(target.tasks))) {
      await writeJsonFile(target.tasks, []);
    }
  }

  tenantPaths(tenantId) {
    return buildPaths(this.baseDataDir, normalizeTenantId(tenantId));
  }

  async readReport(tenantId) {
    const p = this.tenantPaths(tenantId);
    return readJsonFile(p.report, null);
  }

  async writeReport(tenantId, report) {
    const p = this.tenantPaths(tenantId);
    await writeJsonFile(p.report, report);
  }

  async readInterventions(tenantId) {
    const id = normalizeTenantId(tenantId);
    if (this.pgEnabled) {
      const result = await this.pgPool.query(
        "SELECT payload FROM interventions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200",
        [id]
      );
      return result.rows.map((r) => r.payload);
    }
    const p = this.tenantPaths(id);
    return readJsonFile(p.interventions, []);
  }

  async writeInterventions(tenantId, items) {
    const id = normalizeTenantId(tenantId);
    if (this.pgEnabled) {
      await this.pgPool.query("DELETE FROM interventions WHERE tenant_id = $1", [id]);
      for (const item of items) {
        await this.pgPool.query(
          "INSERT INTO interventions (id, tenant_id, payload) VALUES ($1, $2, $3)",
          [String(item.id), id, item]
        );
      }
      return;
    }
    const p = this.tenantPaths(id);
    await writeJsonFile(p.interventions, items);
  }

  async readAlerts(tenantId) {
    const p = this.tenantPaths(tenantId);
    return readJsonFile(p.alerts, []);
  }

  async writeAlerts(tenantId, items) {
    const p = this.tenantPaths(tenantId);
    await writeJsonFile(p.alerts, items);
  }

  async readTasks(tenantId) {
    const p = this.tenantPaths(tenantId);
    return readJsonFile(p.tasks, []);
  }

  async writeTasks(tenantId, items) {
    const p = this.tenantPaths(tenantId);
    await writeJsonFile(p.tasks, items);
  }

  async readUsers(tenantId) {
    const p = this.tenantPaths(tenantId);
    return readJsonFile(p.users, []);
  }

  async writeUsers(tenantId, items) {
    const p = this.tenantPaths(tenantId);
    await writeJsonFile(p.users, items);
  }

  async writeDigest(tenantId, text) {
    const p = this.tenantPaths(tenantId);
    await ensureDir(path.dirname(p.digest));
    await fsp.writeFile(p.digest, text, "utf8");
  }

  async readDigest(tenantId) {
    const p = this.tenantPaths(tenantId);
    try {
      return await fsp.readFile(p.digest, "utf8");
    } catch (err) {
      return "";
    }
  }

  readLegacyEvents() {
    const eventsPath = path.join(this.baseDataDir, "events.json");
    if (!fs.existsSync(eventsPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(eventsPath, "utf8"));
    } catch (err) {
      return [];
    }
  }
}

module.exports = {
  Storage
};
