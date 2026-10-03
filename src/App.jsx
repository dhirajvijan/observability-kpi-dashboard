import { useEffect, useState, useCallback } from 'react';
import KpiCard from './components/KpiCard.jsx';
import RequestTrendChart from './components/RequestTrendChart.jsx';
import ResponseTimeChart from './components/ResponseTimeChart.jsx';

// Point this at your Function App's kpis endpoint.
const KPI_ENDPOINT = 'https://obs-poc-funcapp-axh3hkgsc5e0dyd0.francecentral-01.azurewebsites.net/api/kpis';
const POLL_INTERVAL_MS = 20000;
const WINDOWS = [
  { label: '1h', value: '1h' },
  { label: '6h', value: '6h' },
  { label: '24h', value: '24h' },
];

function toneForFailureRate(pct) {
  if (pct === null || pct === undefined) return 'neutral';
  if (pct >= 10) return 'bad';
  if (pct >= 3) return 'warn';
  return 'ok';
}

function overallStatus(data) {
  if (!data) return { tone: 'neutral', label: 'Connecting…' };
  const failTone = toneForFailureRate(data.failureRatePct);
  const dlqTone = data.serviceBus && data.serviceBus.dlqDepth > 0 ? 'bad' : 'ok';
  if (failTone === 'bad' || dlqTone === 'bad') return { tone: 'bad', label: 'Degraded' };
  if (failTone === 'warn') return { tone: 'warn', label: 'Elevated failures' };
  return { tone: 'ok', label: 'All systems healthy' };
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [windowSize, setWindowSize] = useState('1h');
  const [lastFetched, setLastFetched] = useState(null);

  const fetchData = useCallback(async (win) => {
    try {
      const res = await fetch(`${KPI_ENDPOINT}?window=${win}&bin=5m`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
      setLastFetched(new Date());
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    fetchData(windowSize);
    const id = setInterval(() => fetchData(windowSize), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [windowSize, fetchData]);

  const status = overallStatus(data);

  return (
    <div className="console">
      <div className="console-header">
        <div>
          <p className="console-title">Reliability Console</p>
          <p className="console-sub">D365 → IDIT pipeline: Service Bus → Function App → Logic App</p>
        </div>
        <div className="console-meta">
          {lastFetched ? `Updated ${lastFetched.toLocaleTimeString()}` : 'Waiting for first fetch…'}
          <br />
          Refreshes every {POLL_INTERVAL_MS / 1000}s
        </div>
      </div>

      {error ? (
        <div className="error-banner">Couldn't reach the KPI endpoint: {error}</div>
      ) : null}

      <div className="status-strip">
        <span className={`status-dot ${status.tone}`} />
        <span className="status-text">
          {status.label}
          {data ? <span className="value">window: {data.window}</span> : null}
        </span>
        <div className="window-picker">
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              className={windowSize === w.value ? 'active' : ''}
              onClick={() => setWindowSize(w.value)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div className="kpi-grid">
        <KpiCard
          label="Success rate"
          value={data ? data.successRatePct : '—'}
          unit={data ? '%' : ''}
          tone={data ? (data.successRatePct >= 97 ? 'ok' : data.successRatePct >= 90 ? 'warn' : 'bad') : 'neutral'}
          footnote={data ? `${data.totals.requests - data.totals.failures} of ${data.totals.requests} messages` : ''}
        />
        <KpiCard
          label="Failure rate"
          value={data ? data.failureRatePct : '—'}
          unit={data ? '%' : ''}
          tone={data ? toneForFailureRate(data.failureRatePct) : 'neutral'}
          footnote={data ? `${data.totals.failures} failed` : ''}
        />
        <KpiCard
          label="4XX errors"
          value={data ? data.totals.by4xx : '—'}
          tone={data && data.totals.by4xx > 0 ? 'warn' : 'ok'}
          footnote="Bad payload, dead-lettered"
        />
        <KpiCard
          label="5XX errors"
          value={data ? data.totals.by5xx : '—'}
          tone={data && data.totals.by5xx > 0 ? 'bad' : 'ok'}
          footnote="Retries exhausted"
        />
        <KpiCard
          label="Avg response time"
          value={data ? data.avgResponseTimeMs : '—'}
          unit={data ? 'ms' : ''}
          tone="neutral"
          footnote={data ? `p95: ${data.p95ResponseTimeMs} ms` : ''}
        />
      </div>

      <div className="chart-grid">
        <div className="chart-panel">
          <h3>Messages over time</h3>
          <p className="chart-sub">Successful vs 4XX vs 5XX, stacked</p>
          <RequestTrendChart data={data ? data.trend : []} />
        </div>
        <div className="chart-panel">
          <h3>Response time</h3>
          <p className="chart-sub">Average per interval</p>
          <ResponseTimeChart data={data ? data.trend : []} />
        </div>
      </div>

      <p className="section-label">Service Bus</p>
      <div className="kpi-grid kpi-grid-narrow">
        <KpiCard
          label="Active messages"
          value={data && data.serviceBus && data.serviceBus.activeMessages !== null ? Math.round(data.serviceBus.activeMessages) : '—'}
          tone="neutral"
          footnote="idit-sync subscription"
        />
        <KpiCard
          label="DLQ depth"
          value={data && data.serviceBus && data.serviceBus.dlqDepth !== null ? Math.round(data.serviceBus.dlqDepth) : '—'}
          tone={data && data.serviceBus && data.serviceBus.dlqDepth > 0 ? 'warn' : 'ok'}
          footnote="Dead-lettered messages, parked for review"
        />
        <KpiCard
          label="CPU utilization"
          value={data && data.cpuUtilizationPct !== null && data.cpuUtilizationPct !== undefined ? data.cpuUtilizationPct : '—'}
          unit={data && data.cpuUtilizationPct !== null && data.cpuUtilizationPct !== undefined ? '%' : ''}
          tone={data && data.cpuUtilizationPct >= 80 ? 'warn' : 'neutral'}
          footnote="Function App process"
        />
      </div>
      {data && data.serviceBus && data.serviceBus.error ? (
        <p className="sb-note">Service Bus metrics unavailable: {data.serviceBus.error}</p>
      ) : null}

      <p className="retired-note">
        The original demo proxy pipeline (direct HTTP → Logic App, no Service Bus) has been retired —
        it didn't reflect the real D365 → IDIT integration pattern. This Console now reports only the
        Service Bus-based pipeline shown above.
      </p>
    </div>
  );
}
