-- Phase 1 foundation migration for PostgreSQL mode

CREATE TABLE IF NOT EXISTS interventions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interventions_tenant_created
  ON interventions (tenant_id, created_at DESC);
