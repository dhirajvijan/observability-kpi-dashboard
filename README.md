# Reliability Console — KPI Dashboard

A React dashboard showing live Success Rate, Failure Rate, Avg Response Time,
Availability, and CPU Utilization for the Observability POC, polling a
Function App endpoint every 20 seconds.

## Before deploying

1. Open `src/App.jsx` and confirm `KPI_ENDPOINT` points at your Function App's
   `/api/kpis` route (already set to the POC's current URL).
2. Make sure the `kpis` Function endpoint is deployed and its
   `APPINSIGHTS_APP_ID` / `APPINSIGHTS_API_KEY` app settings are configured
   (see `kpi-function-index.js` in the same delivery).
3. If your Function App's CORS settings don't already allow this dashboard's
   domain, add it the same way you did for the main demo site.

## Local development

```bash
npm install
npm run dev
```

## Deploying as a Static Web App

1. Push this folder to a new (or existing) GitHub repo.
2. Azure Portal → Create a Static Web App → connect the repo.
3. Build Presets: **React**.
4. App location: `/`
5. Output location: `dist`
6. Api location: leave blank (this app calls the Function App directly).
7. Create — Azure commits a GitHub Actions workflow and deploys automatically.

## Notes

- Colors are functional, not decorative: teal = healthy, amber = elevated
  failures, red = degraded. They only change when the underlying number
  actually crosses a threshold (see `toneForFailureRate` / `toneForAvailability`
  in `App.jsx` if you want to adjust the thresholds).
- The time-window picker (1h / 6h / 24h) re-queries the Function endpoint
  with a different `window` parameter — no separate deployment needed to
  change the range.
