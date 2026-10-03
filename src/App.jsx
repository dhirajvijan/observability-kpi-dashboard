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

// ---------------------------------------------------------------------------
// "Ask the agent" panel
// The Azure Copilot Observability Agent is used on demand only: nothing runs
// in the background. The Console gives a free first-level triage from data it
// already has, prepares narrow questions from the live numbers, and opens the
// Application Insights Failures page, where the agent chat is started by hand.
// ---------------------------------------------------------------------------
const APP_INSIGHTS_RESOURCE_ID =
  '/subscriptions/6b8cf597-b179-46e4-af0d-d3a7676f940f/resourceGroups/dvv-observability-poc/providers/microsoft.insights/components/Obs-poc-FuncApp';

const WINDOW_TEXT = { '1h': 'the last hour', '6h': 'the last 6 hours', '24h': 'the last 24 hours' };
const WINDOW_MS = { '1h': 3600000, '6h': 21600000, '24h': 86400000 };

// Same address format the portal's own "Copy link" button produces for the
// Failures page, with the time range set to the window selected in the Console.
function failuresPageUrl(windowSize) {
  const now = new Date();
  const end = new Date(now);
  end.setSeconds(0, 0);
  const inputs = {
    filters: [],
    timeContext: {
      durationMs: WINDOW_MS[windowSize] || WINDOW_MS['1h'],
      createdTime: now.toISOString(),
      endTime: end.toISOString(),
    },
    selectedOperation: null,
    experience: 1,
    roleSelectors: [],
    clientTypeMode: 'Server',
  };
  return (
    'https://portal.azure.com/#blade/AppInsightsExtension/BladeRedirect/BladeName/failures/ResourceId/' +
    encodeURIComponent(encodeURIComponent(APP_INSIGHTS_RESOURCE_ID)) +
    '/BladeInputs/' +
    encodeURIComponent(JSON.stringify(inputs))
  );
}

function clock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Free triage: plain statements worked out from the numbers already on screen.
function buildTriage(data) {
  const t = data.totals || {};
  const failures = t.failures || 0;
  const requests = t.requests || 0;
  const by4xx = t.by4xx || 0;
  const by5xx = t.by5xx || 0;
  const lines = [];

  if (requests === 0) return ['No messages were processed in this window.'];
  if (failures === 0) return [`All ${requests} delivery attempts succeeded in this window. Nothing to investigate.`];

  lines.push(`${failures} of ${requests} delivery attempts failed (${data.failureRatePct}%).`);

  if (by4xx > 0 && by5xx > 0) {
    lines.push(`${by4xx} were 4XX (payload rejected) and ${by5xx} were 5XX (downstream still failing after retries).`);
  } else if (by4xx > 0) {
    lines.push(`All ${by4xx} classified failures were 4XX: the payload was rejected, so retrying the same message will not help.`);
  } else if (by5xx > 0) {
    lines.push(`All ${by5xx} classified failures were 5XX: the downstream API kept failing after retries, so these may succeed if replayed later.`);
  }
  const other = failures - by4xx - by5xx;
  if (other > 0) lines.push(`${other} had another cause, for example a network error.`);

  const failing = (data.trend || []).filter((p) => (p.by4xx || 0) + (p.by5xx || 0) + 0 > 0 || (p.failures || 0) > 0);
  if (failing.length === 1) {
    lines.push(`Failures appear in the interval starting ${clock(failing[0].time)}.`);
  } else if (failing.length > 1) {
    lines.push(`Failures appear between ${clock(failing[0].time)} and ${clock(failing[failing.length - 1].time)}.`);
  }

  const dlq = data.serviceBus && data.serviceBus.dlqDepth;
  if (dlq > 0) lines.push(`${Math.round(dlq)} message${Math.round(dlq) === 1 ? ' is' : 's are'} parked in the dead-letter queue.`);

  lines.push('A failed message is retried up to 3 times, so one bad message can count as 3 failures.');
  return lines;
}

// Narrow, ready-made questions for the agent, built from the live numbers.
function buildQuestions(data, windowSize) {
  const when = WINDOW_TEXT[windowSize] || 'the last hour';
  const t = (data && data.totals) || {};
  const sameMessage = ' Treat failures that share a correlationId as one message retried, not as separate failures.';
  const questions = [];

  if ((t.by5xx || 0) > 0) {
    questions.push({
      label: 'Why the 5XX errors?',
      text: `In ${when}, why did ServiceBusTopicTrigger1 fail with errorCode IDIT_5XX_EXHAUSTED in the EntitySyncFunction_FAILED log messages? When did it start and stop?` + sameMessage,
    });
  }
  if ((t.by4xx || 0) > 0) {
    questions.push({
      label: 'Which messages were rejected?',
      text: `In ${when}, which messages failed with errorCode IDIT_4XX or SCHEMA_INVALID in the EntitySyncFunction_FAILED log messages? List their correlationIds and what the log says was wrong.` + sameMessage,
    });
  }
  if (data && data.p95ResponseTimeMs >= 5000) {
    questions.push({
      label: 'Why is it slow?',
      text: `In ${when}, why did the duration of ServiceBusTopicTrigger1 rise? Compare the durationMs of EntitySyncFunction_COMPLETED and EntitySyncFunction_FAILED log messages, grouped by errorCode.`,
    });
  }
  questions.push({
    label: 'Health summary',
    text: `Summarize the health of ServiceBusTopicTrigger1 over ${when}: how many executions succeeded and failed, the failures grouped by errorCode from the EntitySyncFunction_FAILED log messages, and the typical duration.` + sameMessage,
  });
  questions.push({
    label: 'Did something change?',
    text: 'What changed on the Obs-poc-FuncApp Function App in the last 24 hours (app settings, function code, restarts), and did failures in ServiceBusTopicTrigger1 start after any of those changes?',
  });
  return questions;
}

export function AgentPanel({ data, windowSize }) {
  const [copied, setCopied] = useState(null);

  if (!data) return null;

  const triage = buildTriage(data);
  const questions = buildQuestions(data, windowSize);

  const copy = async (text, index) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // Older browsers or blocked clipboard: fall back to a hidden text area.
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }
    setCopied(index);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="agent-panel">
      <div className="agent-col">
        <h3>What the Console already knows</h3>
        <p className="chart-sub">Free, from the numbers on this page</p>
        <ul className="agent-triage">
          {triage.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </div>

      <div className="agent-col">
        <h3>Questions for the Observability Agent</h3>
        <p className="chart-sub">Runs only when you ask. Each question is billed.</p>
        <ul className="agent-questions">
          {questions.map((q, i) => (
            <li key={q.label}>
              <div className="agent-question-text">
                <span className="agent-question-label">{q.label}</span>
                {q.text}
              </div>
              <button className="agent-copy" onClick={() => copy(q.text, i)}>
                {copied === i ? 'Copied' : 'Copy'}
              </button>
            </li>
          ))}
        </ul>
        <a className="agent-open" href={failuresPageUrl(windowSize)} target="_blank" rel="noopener noreferrer">
          Open the agent in Azure
        </a>
        <p className="agent-hint">
          Copy a question, open the Failures page, then choose Observability Agent and "Chat with the agent" and
          paste it. Chat is the cheaper option; a deep investigation costs more.
        </p>
      </div>
    </div>
  );
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

      <p className="section-label">Ask the agent</p>
      <AgentPanel data={data} windowSize={windowSize} />

      <p className="retired-note">
        The original demo proxy pipeline (direct HTTP → Logic App, no Service Bus) has been retired —
        it didn't reflect the real D365 → IDIT integration pattern. This Console now reports only the
        Service Bus-based pipeline shown above.
      </p>
    </div>
  );
}
