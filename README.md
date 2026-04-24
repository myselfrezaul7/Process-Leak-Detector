# Process Leak Detector (IMIS MVP)

Process Leak Detector identifies where business workflows lose value, then surfaces practical transformation actions.

## Supported datasets

1. Synthetic process event logs (`data/events.json`)
2. Rossmann real sales data (`train.csv`) via prebuilt analytics report (`data/rossmann_report.json`)

If `data/rossmann_report.json` exists, the app will automatically use it.

## Run with Rossmann `train.csv`

```bash
node src/buildRossmannReport.js "C:\Users\mysel\OneDrive\Desktop\Azure\rossmann-store-sales\train.csv" "C:\Users\mysel\OneDrive\Desktop\Azure\rossmann-store-sales\store.csv"
node server.js
```

Open: <http://localhost:3000>

## Run with synthetic process data

```bash
node src/generateSampleData.js
node server.js
```

## API endpoints

- `GET /api/health`
- `POST /api/auth/login` (`email`, `password`)
- `GET /api/auth/me`
- `GET /api/report`
- `GET /api/summary`
- `GET /api/bottlenecks`
- `GET /api/cases`
- `GET /api/recommendations`
- `GET /api/live`
- `GET /api/simulate?promo=10&closure=5&conversion=12`
- `GET /api/copilot?q=why%20is%20leakage%20high`
- `GET /api/geo`
- `GET /api/forecast`
- `GET /api/story`
- `GET /api/interventions`
- `POST /api/interventions`
- `GET /api/export/brief`
- `GET /api/export/actions.csv`
- `GET /api/export/brief-html`
- `GET /api/pipeline-status`
- `POST /api/rebuild`
- `GET /api/anomalies`
- `GET /api/impact-ranking`
- `GET /api/root-cause-clusters`
- `GET /api/scenarios`
- `POST /api/scenarios`
- `GET /api/scenarios/compare?base=<id>&candidate=<id>`
- `GET /api/decision-studio?q=...`
- `GET /api/stream` (SSE realtime feed)
- `GET /api/approvals`
- `POST /api/approvals`
- `POST /api/approvals/action`
- `GET /api/audit`
- `POST /api/alerts/refresh`
- `GET /api/alerts`
- `GET /api/explain?entityId=Store%201`
- `POST /api/integrations/task`
- `GET /api/tasks`
- `GET /api/digest/latest`
- `GET /api/tenants`

Most endpoints support multi-tenant routing via query (`?tenant=default`) or header (`x-tenant-id`).

## Advanced modules in UI

- Live command center with alert feed and leak ticker
- AI copilot for executive Q&A
- What-if simulator with recovery estimate
- Geo-intelligence heat layer
- Risk radar timeline (30-day forward view)
- Intervention tracking loop (baseline/window/actual uplift)
- Auto story generator for board-ready narrative
- Role switch modes (`CEO`, `Ops Lead`, `Store Manager`)
- Export layer (`txt` brief, `csv` action plan, PDF-ready brief page)
- Auto-ingestion pipeline watcher (rebuilds report when source CSV files change)

## Platform upgrades (implemented)

1. Foundation:
- Tenant-aware storage under `data/tenants/<tenant>/...`
- Optional PostgreSQL adapter (fallback to file storage if unavailable)
- TTL caching and structured request logs
- CI workflow + smoke tests

2. Security:
- Token-based auth (`/api/auth/login`)
- API-level RBAC support for sensitive routes (`AUTH_REQUIRED=true`)

3. Intelligence:
- Statistical anomaly detection (`/api/anomalies`)
- Explainability endpoint (`/api/explain`)
- Alert generation (`/api/alerts`)
- Impact scoring + root-cause clustering
- AI Decision Studio orchestration

4. ROI science:
- Counterfactual and confidence scoring for interventions

5. Execution + reporting:
- Integration task handoff endpoint (`/api/integrations/task`)
- Scheduled digest automation (`/api/digest/latest`)
- Existing export layer retained
- Scenario versioning + comparison
- Approval workflow + compliance audit timeline

6. Scale primitives:
- Multi-tenant API context
- Cache invalidation on writes/rebuild
- Health and observability improvements
- Realtime SSE updates and mobile command view

## Dynamic data workflow

1. Drop/replace `train.csv` and `store.csv` in your source path.
2. Watcher auto-detects file changes and rebuilds `data/rossmann_report.json`.
3. Frontend consumes APIs dynamically (`/api/report`, `/api/live`, `/api/pipeline-status`).
4. Optional manual trigger: `POST /api/rebuild`.

## Auth and RBAC quick start

- Default seeded users (tenant `default`):
  - `ceo@pld.local` / `ChangeMe123!`
  - `ops@pld.local` / `ChangeMe123!`
  - `store@pld.local` / `ChangeMe123!`
- Enable strict enforcement by setting environment variable: `AUTH_REQUIRED=true`
- Pass bearer token in header: `Authorization: Bearer <token>`

## Rossmann leak logic (store-level)

- Conversion leak: low sales per customer vs baseline
- Promo leak: underperforming promo uplift
- Closure leak: avoidable non-holiday closures
- Volatility leak: unstable daily sales profile

## Next evolution (thesis/startup path)

1. Add joins with `store.csv` for assortment, competition, and promo intervals.
2. Add per-store action plans with expected savings simulation.
3. Add automatic anomaly alerts for sudden leak spikes.
4. Add user roles: executive summary, operations detail, store manager view.

