const path = require("path");

function normalizeTenantId(raw) {
  const value = String(raw || "default").trim().toLowerCase();
  const safe = value.replace(/[^a-z0-9_-]/g, "");
  return safe || "default";
}

function resolveTenantId(urlObj, headers) {
  const fromQuery = urlObj && urlObj.searchParams ? urlObj.searchParams.get("tenant") : null;
  const fromHeader = headers ? headers["x-tenant-id"] : null;
  return normalizeTenantId(fromQuery || fromHeader || "default");
}

function tenantDir(baseDataDir, tenantId) {
  return path.join(baseDataDir, "tenants", normalizeTenantId(tenantId));
}

module.exports = {
  normalizeTenantId,
  resolveTenantId,
  tenantDir
};
