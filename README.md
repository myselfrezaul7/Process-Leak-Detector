# Process Leak Detector (IMIS MVP)

Process Leak Detector identifies where business workflows lose value, then surfaces practical transformation actions.

## Supported datasets

1. Synthetic process event logs (`data/events.json`)
2. Rossmann real sales data (`train.csv`) via prebuilt analytics report (`data/rossmann_report.json`)

If `data/rossmann_report.json` exists, the app will automatically use it.

## Run with Rossmann `train.csv`

```bash
node src/buildRossmannReport.js "C:\Users\mysel\OneDrive\Desktop\Azure\rossmann-store-sales\train.csv"
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
- `GET /api/report`
- `GET /api/summary`
- `GET /api/bottlenecks`
- `GET /api/cases`
- `GET /api/recommendations`

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
