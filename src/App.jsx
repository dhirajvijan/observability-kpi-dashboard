import { useEffect, useState, useCallback } from 'react';
import KpiCard from './components/KpiCard.jsx';
import RequestTrendChart from './components/RequestTrendChart.jsx';
import ResponseTimeChart from './components/ResponseTimeChart.jsx';

// Browser tab icon: a teal pulse line on the Console's dark background.
// It is set from code so no extra file has to be added to the site.
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="14" fill="#0F1720"/>' +
  '<polyline points="9,36 21,36 28,18 37,47 43,30 55,30" fill="none" stroke="#5EEAD4" ' +
  'stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

function setTabIcon() {
  if (typeof document === 'undefined') return;
  let link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = 'data:image/svg+xml,' + encodeURIComponent(FAVICON_SVG);
}
setTabIcon();

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

// Status of the live traffic in the selected window.
//   red    10% or more of attempts failed
//   amber  3% or more failed, or messages are waiting in the dead-letter queue
//   green  otherwise
// Dead-lettered messages are a backlog to review, not an outage, so they
// never turn the status red on their own.
export function overallStatus(data) {
  if (!data) return { tone: 'neutral', label: 'Connecting…' };
  const failTone = toneForFailureRate(data.failureRatePct);
  const dlq = data.serviceBus && data.serviceBus.dlqDepth > 0 ? Math.round(data.serviceBus.dlqDepth) : 0;
  const dlqText = `${dlq} message${dlq === 1 ? '' : 's'} in dead-letter queue`;
  if (failTone === 'bad') return { tone: 'bad', label: 'Degraded' };
  if (failTone === 'warn') return { tone: 'warn', label: dlq > 0 ? `Elevated failures · ${dlqText}` : 'Elevated failures' };
  if (dlq > 0) return { tone: 'warn', label: dlqText };
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
  const [selected, setSelected] = useState(0);
  const [copied, setCopied] = useState(false);

  if (!data) return null;

  // Small summary: the first three facts only.
  const triage = buildTriage(data).slice(0, 3);
  const questions = buildQuestions(data, windowSize);
  const current = questions[Math.min(selected, questions.length - 1)];

  const copy = async (text) => {
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
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="agent-panel">
      <div className="agent-col">
        <h3>What the Console already knows</h3>
        <ul className="agent-triage">
          {triage.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </div>

      <div className="agent-col">
        <h3>Ask the Observability Agent</h3>
        <p className="chart-sub">Runs only when you ask. Each question is billed.</p>
        <select
          className="agent-select"
          value={Math.min(selected, questions.length - 1)}
          onChange={(e) => { setSelected(Number(e.target.value)); setCopied(false); }}
        >
          {questions.map((q, i) => (
            <option key={q.label} value={i}>{q.label}</option>
          ))}
        </select>
        <p className="agent-question-text">{current.text}</p>
        <div className="agent-actions">
          <button className="agent-copy" onClick={() => copy(current.text)}>
            {copied ? 'Copied' : 'Copy question'}
          </button>
          <a className="agent-open" href={failuresPageUrl(windowSize)} target="_blank" rel="noopener noreferrer">
            Open the agent in Azure
          </a>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Service level objectives
// Figures come from the slo function, which counts per message (not per
// delivery attempt) and leaves rejected payloads out of the success target.
// ---------------------------------------------------------------------------
// The SLO function kept its default name in Azure, so its address ends in HttpTrigger1.
const SLO_ENDPOINT = KPI_ENDPOINT.replace(/\/kpis$/, '/HttpTrigger1');
const SLO_POLL_INTERVAL_MS = 60000;
const SLO_WINDOWS = [
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '28d', value: '28d' },
];

function sloTone(met) {
  if (met === null || met === undefined) return 'neutral';
  return met ? 'ok' : 'bad';
}

function burnLabel(rate) {
  if (rate === null || rate === undefined) return { tone: 'neutral', text: 'No traffic' };
  if (rate >= 14.4) return { tone: 'bad', text: 'Fast burn' };
  if (rate > 1) return { tone: 'warn', text: 'Above pace' };
  return { tone: 'ok', text: 'On pace' };
}

function shortDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function SloSection({ slo, error, sloWindow, onWindowChange, onReport }) {
  const success = slo && slo.slo.success;
  const speed = slo && slo.slo.speed;
  const budget = slo && slo.errorBudget;
  const burn1h = slo && slo.burnRate.last1h;
  const burn6h = slo && slo.burnRate.last6h;
  const burn = burnLabel(burn1h ? burn1h.rate : null);
  const show = (v, suffix) => (v === null || v === undefined ? '—' : `${v}${suffix || ''}`);
  const remaining = budget && budget.remainingPct !== null ? budget.remainingPct : null;

  return (
    <div className="slo-section">
      <div className="slo-header">
        <p className="section-label">Service level objectives</p>
        <button className="report-button" onClick={onReport} disabled={!slo}>
          Generate report
        </button>
        <div className="window-picker">
          {SLO_WINDOWS.map((w) => (
            <button
              key={w.value}
              className={sloWindow === w.value ? 'active' : ''}
              onClick={() => onWindowChange(w.value)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="sb-note">SLO data unavailable: {error}</p> : null}

      <div className="slo-grid">
        <div className="kpi-card">
          <p className="kpi-label">Success SLO</p>
          <p className={`kpi-value ${sloTone(success && success.met)}`}>{show(success && success.actualPct, '%')}</p>
          <p className="kpi-footnote">
            Target {success ? success.targetPct : 99}%
            {success ? ` · ${success.good} of ${success.total} valid messages` : ''}
          </p>
        </div>

        <div className="kpi-card">
          <p className="kpi-label">Speed SLO</p>
          <p className={`kpi-value ${sloTone(speed && speed.met)}`}>{show(speed && speed.actualPct, '%')}</p>
          <p className="kpi-footnote">
            Target {speed ? speed.targetPct : 95}% within {speed ? speed.thresholdMs / 1000 : 5}s
            {speed ? ` · ${speed.good} of ${speed.total} delivered` : ''}
          </p>
        </div>

        <div className="kpi-card">
          <p className="kpi-label">Error budget left</p>
          <p className={`kpi-value ${remaining === null ? 'neutral' : remaining <= 0 ? 'bad' : remaining < 25 ? 'warn' : 'ok'}`}>
            {show(remaining, '%')}
          </p>
          <div className="slo-bar">
            <div className="slo-bar-fill" style={{ width: `${remaining === null ? 0 : Math.min(100, remaining)}%` }} />
          </div>
          <p className="kpi-footnote">
            {budget ? `${budget.failures} failed · ${budget.allowedFailures} allowed` : ''}
          </p>
        </div>

        <div className="kpi-card">
          <p className="kpi-label">Burn rate (last hour)</p>
          <p className={`kpi-value ${burn.tone}`}>{show(burn1h && burn1h.rate, '×')}</p>
          <p className="kpi-footnote">
            {burn.text} · last 6h: {show(burn6h && burn6h.rate, '×')}
          </p>
        </div>
      </div>

      {slo ? (
        <p className="slo-note">
          Counted per message, not per delivery attempt. {slo.messages.rejected} rejected
          payload{slo.messages.rejected === 1 ? '' : 's'} left out of the success target.
          Data from {shortDate(slo.period.dataFrom)} to {shortDate(slo.period.dataTo)}.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cost (FinOps)
// Month-to-date cost of the resource group and suggestions for reducing it,
// from the costs function. Azure cost data lags by up to a day.
// ---------------------------------------------------------------------------
const COST_ENDPOINT = KPI_ENDPOINT.replace(/\/kpis$/, '/costs');
// The costs function keeps its answer for hours and protects Azure's cost
// service from repeated requests, so asking it every 10 minutes is cheap.
const COST_POLL_INTERVAL_MS = 10 * 60 * 1000;

function money(amount, currency) {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR', maximumFractionDigits: 2 }).format(amount);
  } catch (e) {
    return `${amount} ${currency || ''}`.trim();
  }
}

export function CostSection({ costs, error, onReport }) {
  const [selected, setSelected] = useState(0);
  const [service, setService] = useState(0);
  if (!costs && !error) return null;
  const services = costs ? costs.byService : [];
  const top = services.find((svc) => svc.cost > 0);

  return (
    <div className="cost-section">
      <div className="slo-header">
        <p className="section-label">Cost</p>
        <button className="report-button" onClick={onReport} disabled={!costs}>
          Generate report
        </button>
      </div>
      {error ? <p className="sb-note">{costs ? error : `Cost data unavailable. ${error}`}</p> : null}
      {costs ? (
        <>
          <div className="slo-grid">
            <div className="kpi-card">
              <p className="kpi-label">Month to date</p>
              <p className="kpi-value neutral">{money(costs.totalCost, costs.currency)}</p>
              <p className="kpi-footnote">This resource group</p>
            </div>
            <div className="kpi-card">
              <p className="kpi-label">Month-end estimate</p>
              <p className="kpi-value neutral">{money(costs.forecastMonthEnd, costs.currency)}</p>
              <p className="kpi-footnote">At the average daily rate so far</p>
            </div>
            <div className="kpi-card">
              <p className="kpi-label">Cost per 1,000 delivered</p>
              <p className="kpi-value neutral">{money(costs.costPer1000Delivered, costs.currency)}</p>
              <p className="kpi-footnote">{costs.usage.delivered} messages delivered this month</p>
            </div>
            <div className="kpi-card">
              <p className="kpi-label">Largest cost</p>
              <p className="kpi-value warn cost-top">{top ? top.service : '—'}</p>
              <p className="kpi-footnote">{top ? `${top.sharePct}% of spend` : ''}</p>
            </div>
          </div>

          <div className="cost-panels">
            <div className="chart-panel">
              <h3>Cost by service</h3>
              <p className="chart-sub">Month to date</p>
              {services.length === 0 ? (
                <div className="empty-state">No cost recorded yet this month</div>
              ) : (
                <>
                  <select
                    className="agent-select"
                    value={Math.min(service, services.length - 1)}
                    onChange={(e) => setService(Number(e.target.value))}
                  >
                    {services.map((svc, i) => (
                      <option key={svc.service} value={i}>{svc.service}</option>
                    ))}
                  </select>
                  {(() => {
                    const svc = services[Math.min(service, services.length - 1)];
                    return (
                      <div className="cost-service">
                        <p className="cost-service-amount">{money(svc.cost, costs.currency)}</p>
                        <p className="cost-suggestion-text">
                          {svc.sharePct}% of the {money(costs.totalCost, costs.currency)} spent this month
                        </p>
                        <div className="slo-bar">
                          <div className="slo-bar-fill cost-bar-fill" style={{ width: `${Math.min(100, Math.max(1, svc.sharePct))}%` }} />
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>

            <div className="chart-panel">
              <h3>Ways to reduce cost</h3>
              <p className="chart-sub">Worked out from this month's figures. Nothing is changed automatically.</p>
              <select
                className="agent-select"
                value={Math.min(selected, costs.suggestions.length - 1)}
                onChange={(e) => setSelected(Number(e.target.value))}
              >
                {costs.suggestions.map((sug, i) => (
                  <option key={sug.title} value={i}>{sug.title}</option>
                ))}
              </select>
              {(() => {
                const sug = costs.suggestions[Math.min(selected, costs.suggestions.length - 1)];
                return (
                  <div className="cost-suggestion">
                    <p className="cost-suggestion-evidence">{sug.evidence}</p>
                    <p className="cost-suggestion-text">{sug.suggestion}</p>
                  </div>
                );
              })()}
            </div>
          </div>
          <p className="slo-note">{costs.note}</p>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cost report: the FinOps counterpart of the reliability report.
// ---------------------------------------------------------------------------
function reportDay(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function CostReport({ costs, onClose }) {
  const cur = costs.currency;
  const services = costs.byService || [];
  const top = services.find((svc) => svc.cost > 0);
  const usage = costs.usage || {};
  const executions = costs.executions || [];
  const totalRuns = executions.reduce((sum, e) => sum + e.executions, 0);
  const logs = costs.logs || { total: 0, pipeline: 0 };
  const daily = costs.daily || [];
  const today = (costs.generatedAt || '').slice(0, 10);
  const share = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : '—');

  return (
    <div className="report">
      <div className="report-actions">
        <button onClick={() => window.print()}>Print / Save as PDF</button>
        <button onClick={onClose}>Back to Console</button>
      </div>

      <h1>Cost report</h1>
      <p className="report-sub">D365 → IDIT pipeline: Service Bus → Function App → Logic App</p>
      <table className="report-meta">
        <tbody>
          <tr><th>Period</th><td>{costs.period}</td></tr>
          <tr><th>Covers</th><td>{(costs.scope || '').split('/resourceGroups/')[1] ? `Resource group ${(costs.scope || '').split('/resourceGroups/')[1]}` : costs.scope}</td></tr>
          <tr><th>Generated</th><td>{reportDateTime(costs.generatedAt)}</td></tr>
        </tbody>
      </table>

      <h2>Summary</h2>
      <p>
        {money(costs.totalCost, cur)} has been spent so far this month. At the average daily rate, the month is
        estimated to end at {money(costs.forecastMonthEnd, cur)}.
      </p>
      {top ? (
        <p>{top.service} is the largest cost at {money(top.cost, cur)}, which is {top.sharePct}% of the total.</p>
      ) : null}
      {costs.costPer1000Delivered !== null && costs.costPer1000Delivered !== undefined ? (
        <p>
          {usage.delivered} messages were delivered, which works out at {money(costs.costPer1000Delivered, cur)} per
          1,000 delivered messages.
        </p>
      ) : null}

      <h2>Cost by service</h2>
      <table className="report-table">
        <thead>
          <tr><th>Service</th><th>Cost</th><th>Share of total</th></tr>
        </thead>
        <tbody>
          {services.map((svc) => (
            <tr key={svc.service}>
              <td>{svc.service}</td>
              <td>{money(svc.cost, cur)}</td>
              <td>{svc.sharePct}%</td>
            </tr>
          ))}
          <tr>
            <th>Total</th>
            <td><strong>{money(costs.totalCost, cur)}</strong></td>
            <td>100%</td>
          </tr>
        </tbody>
      </table>

      <h2>Cost by day</h2>
      {daily.length === 0 ? (
        <p>No daily figures are available yet.</p>
      ) : (
        <table className="report-table">
          <thead>
            <tr><th>Day</th><th>Cost</th></tr>
          </thead>
          <tbody>
            {daily.map((d) => (
              <tr key={d.date}>
                <td>{reportDay(d.date)}{d.date === today ? ' (so far)' : ''}</td>
                <td>{money(d.cost, cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>What the cost paid for</h2>
      <table className="report-table">
        <tbody>
          <tr><th>Messages processed</th><td>{usage.messages}</td></tr>
          <tr><th>Messages delivered</th><td>{usage.delivered}</td></tr>
          <tr><th>From the traffic generator</th><td>{usage.synthetic} ({share(usage.synthetic, usage.messages)})</td></tr>
          <tr><th>Delivery attempts, including retries</th><td>{usage.attempts}</td></tr>
          <tr><th>Function runs, all functions</th><td>{totalRuns}</td></tr>
          <tr><th>Log lines stored</th><td>{logs.total}</td></tr>
          <tr><th>Log lines that are pipeline events</th><td>{logs.pipeline} ({share(logs.pipeline, logs.total)})</td></tr>
        </tbody>
      </table>

      {executions.length > 0 ? (
        <>
          <h2>Function runs</h2>
          <table className="report-table">
            <thead>
              <tr><th>Function</th><th>Runs</th><th>Share</th></tr>
            </thead>
            <tbody>
              {executions.map((e) => (
                <tr key={e.name}>
                  <td>{e.name}</td>
                  <td>{e.executions}</td>
                  <td>{share(e.executions, totalRuns)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      <h2>Ways to reduce cost</h2>
      <table className="report-table">
        <thead>
          <tr><th>Finding</th><th>Evidence</th><th>What to do</th></tr>
        </thead>
        <tbody>
          {costs.suggestions.map((sug) => (
            <tr key={sug.title}>
              <td>{sug.title}</td>
              <td>{sug.evidence}</td>
              <td>{sug.suggestion}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="report-note">These are suggestions only. Nothing in the pipeline has been changed.</p>

      <h2>How these figures are calculated</h2>
      <ul>
        <li>Costs come from Azure Cost Management for the resource group, month to date, as actual cost.</li>
        <li>Azure cost data lags by up to a day, so the most recent day is incomplete.</li>
        <li>The month-end estimate is the cost of complete days so far, plus the average complete day for each day remaining.</li>
        <li>Cost per 1,000 delivered = total cost ÷ messages delivered × 1,000. Messages are counted once each, by correlation ID.</li>
        <li>Usage figures (messages, function runs, log lines) come from Application Insights for the same month.</li>
        <li>Charges that Azure posts late, or fixed monthly charges not yet shown, are not included until they appear in Cost Management.</li>
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reliability report: a print-ready page built from the same SLO data.
// "Print / Save as PDF" uses the browser's own print dialog.
// ---------------------------------------------------------------------------
const ERROR_CODE_MEANING = {
  IDIT_5XX_EXHAUSTED: 'IDIT kept returning a server error after all retries',
  IDIT_4XX: 'IDIT rejected the payload',
  SCHEMA_INVALID: 'The message failed validation before it was sent',
  IDIT_NETWORK_ERROR: 'IDIT could not be reached',
  UNKNOWN: 'No error code was recorded',
};

function reportDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function intervalLabel(iso, windowKey) {
  const d = new Date(iso);
  const day = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  if (windowKey === '28d') return day;
  return `${day}, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function reportSummary(slo) {
  const { success, speed } = slo.slo;
  const lines = [];
  if (success.met === null) {
    lines.push('No messages were processed in this period, so the objectives could not be measured.');
    return lines;
  }
  if (success.met && speed.met) lines.push('Both objectives were met in this period.');
  else if (!success.met && !speed.met) lines.push('Both objectives were missed in this period.');
  else if (!success.met) lines.push('The success objective was missed in this period. The speed objective was met.');
  else lines.push('The speed objective was missed in this period. The success objective was met.');

  lines.push(
    `${success.good} of ${success.total} valid messages were delivered (${success.actualPct}%, target ${success.targetPct}%), ` +
    `and ${speed.good} of ${speed.total} delivered messages finished within ${speed.thresholdMs / 1000} seconds (${speed.actualPct}%, target ${speed.targetPct}%).`
  );
  const b = slo.errorBudget;
  if (b.remainingPct !== null) {
    lines.push(
      b.remainingPct > 0
        ? `${b.remainingPct}% of the error budget remains: ${b.failures} message${b.failures === 1 ? '' : 's'} failed against an allowance of ${b.allowedFailures}.`
        : `The error budget is used up: ${b.failures} message${b.failures === 1 ? '' : 's'} failed against an allowance of ${b.allowedFailures}.`
    );
  }
  if (slo.messages.rejected > 0) {
    lines.push(`${slo.messages.rejected} message${slo.messages.rejected === 1 ? ' was' : 's were'} rejected as invalid. These are reported separately and do not count against the success objective.`);
  }
  return lines;
}

export function SloReport({ slo, onClose }) {
  const { success, speed } = slo.slo;
  const budget = slo.errorBudget;
  const burn1h = slo.burnRate.last1h;
  const burn6h = slo.burnRate.last6h;
  const status = (met) => (met === null ? 'No data' : met ? 'Met' : 'Missed');
  const statusClass = (met) => (met === null ? '' : met ? 'report-ok' : 'report-bad');
  const rate = (b) => (b.rate === null ? 'no traffic' : `${b.rate}× (${b.failed} failed of ${b.valid} valid)`);
  const dlq = slo.serviceBus && slo.serviceBus.dlqDepth;

  return (
    <div className="report">
      <div className="report-actions">
        <button onClick={() => window.print()}>Print / Save as PDF</button>
        <button onClick={onClose}>Back to Console</button>
      </div>

      <h1>Reliability report</h1>
      <p className="report-sub">D365 → IDIT pipeline: Service Bus → Function App → Logic App</p>
      <table className="report-meta">
        <tbody>
          <tr><th>Period</th><td>{slo.period.label}</td></tr>
          <tr><th>Data covers</th><td>{reportDateTime(slo.period.dataFrom)} to {reportDateTime(slo.period.dataTo)}</td></tr>
          <tr><th>Generated</th><td>{reportDateTime(slo.generatedAt)}</td></tr>
        </tbody>
      </table>

      <h2>Summary</h2>
      {reportSummary(slo).map((line, i) => (
        <p key={i}>{line}</p>
      ))}

      <h2>Service level objectives</h2>
      <table className="report-table">
        <thead>
          <tr><th>Objective</th><th>What is measured</th><th>Target</th><th>Actual</th><th>Counts</th><th>Status</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Success</td>
            <td>{success.description}</td>
            <td>{success.targetPct}%</td>
            <td>{success.actualPct === null ? '—' : `${success.actualPct}%`}</td>
            <td>{success.good} of {success.total}</td>
            <td className={statusClass(success.met)}>{status(success.met)}</td>
          </tr>
          <tr>
            <td>Speed</td>
            <td>{speed.description}</td>
            <td>{speed.targetPct}%</td>
            <td>{speed.actualPct === null ? '—' : `${speed.actualPct}%`}</td>
            <td>{speed.good} of {speed.total}</td>
            <td className={statusClass(speed.met)}>{status(speed.met)}</td>
          </tr>
        </tbody>
      </table>

      <h2>Error budget</h2>
      <table className="report-table">
        <tbody>
          <tr><th>Failures allowed in this period</th><td>{budget.allowedFailures}</td></tr>
          <tr><th>Failures recorded</th><td>{budget.failures}</td></tr>
          <tr><th>Budget used</th><td>{budget.usedPct === null ? '—' : `${budget.usedPct}%`}</td></tr>
          <tr><th>Budget remaining</th><td>{budget.remainingPct === null ? '—' : `${budget.remainingPct}%`}</td></tr>
          <tr><th>Burn rate, last hour</th><td>{rate(burn1h)}</td></tr>
          <tr><th>Burn rate, last 6 hours</th><td>{rate(burn6h)}</td></tr>
        </tbody>
      </table>
      <p className="report-note">
        A burn rate of 1× spends the budget exactly over the 28-day objective period. Above 1× spends it faster;
        14.4× or more in one hour is treated as a fast burn that needs immediate attention.
      </p>

      <h2>Messages</h2>
      <table className="report-table">
        <tbody>
          <tr><th>Messages processed</th><td>{slo.messages.total}</td></tr>
          <tr><th>Delivered</th><td>{slo.messages.delivered}</td></tr>
          <tr><th>Failed (counts against the success objective)</th><td>{slo.messages.failed}</td></tr>
          <tr><th>Rejected as invalid (reported separately)</th><td>{slo.messages.rejected}</td></tr>
          <tr><th>Delivery attempts, including retries</th><td>{slo.messages.attempts}</td></tr>
        </tbody>
      </table>

      <h2>Failures by type</h2>
      {slo.failureBreakdown.length === 0 ? (
        <p>No failed or rejected messages in this period.</p>
      ) : (
        <table className="report-table">
          <thead>
            <tr><th>Outcome</th><th>Error code</th><th>Messages</th><th>Meaning</th></tr>
          </thead>
          <tbody>
            {slo.failureBreakdown.map((f) => (
              <tr key={`${f.outcome}-${f.errorCode}`}>
                <td>{f.outcome === 'failed' ? 'Failed' : 'Rejected'}</td>
                <td>{f.errorCode}</td>
                <td>{f.messages}</td>
                <td>{ERROR_CODE_MEANING[f.errorCode] || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Timeline</h2>
      {slo.timeline.length === 0 ? (
        <p>No messages in this period.</p>
      ) : (
        <table className="report-table">
          <thead>
            <tr><th>Interval starting</th><th>Delivered</th><th>Failed</th><th>Rejected</th><th>Slower than {speed.thresholdMs / 1000}s</th></tr>
          </thead>
          <tbody>
            {slo.timeline.map((t) => (
              <tr key={t.time} className={t.failed > 0 ? 'report-row-bad' : ''}>
                <td>{intervalLabel(t.time, slo.window)}</td>
                <td>{t.delivered}</td>
                <td>{t.failed}</td>
                <td>{t.rejected}</td>
                <td>{t.slow}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Dead-letter queue</h2>
      <p>
        {dlq === null || dlq === undefined
          ? 'The dead-letter count was not available when this report was generated.'
          : `${Math.round(dlq)} message${Math.round(dlq) === 1 ? ' is' : 's are'} parked in the dead-letter queue at the time of this report.`}
      </p>

      <h2>How these figures are calculated</h2>
      <ul>
        <li>Figures come from the structured logs written by the sync function for every delivery attempt.</li>
        <li>Each message is counted once, by its correlation ID, however many times it was retried.</li>
        <li>Delivered: at least one attempt completed. Failed: no attempt completed and the last error was not a rejection. Rejected: no attempt completed and the last error was a rejected or invalid payload.</li>
        <li>Success = delivered ÷ (delivered + failed). Rejected messages are left out because the sender, not the pipeline, has to fix them.</li>
        <li>Speed = delivered messages that finished within {speed.thresholdMs / 1000} seconds ÷ all delivered messages.</li>
        <li>Error budget = the share of valid messages allowed to fail under the success target ({100 - success.targetPct}%).</li>
        <li>The objectives are defined over 28 days. A shorter period shows the same calculation over less data.</li>
      </ul>
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

  const [slo, setSlo] = useState(null);
  const [sloError, setSloError] = useState(null);
  const [sloWindow, setSloWindow] = useState('28d');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${SLO_ENDPOINT}?window=${sloWindow}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) { setSlo(json); setSloError(null); }
      } catch (err) {
        if (!cancelled) setSloError(err.message);
      }
    };
    load();
    const id = setInterval(load, SLO_POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [sloWindow]);

  const [costs, setCosts] = useState(null);
  const [costsError, setCostsError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(COST_ENDPOINT);
        let json = null;
        try { json = await res.json(); } catch (e) { /* no readable body */ }
        if (!res.ok) {
          if (res.status === 503) {
            const wait = json && json.retryInMinutes;
            throw new Error(`Azure's cost service is limiting requests. Trying again ${wait ? `in about ${wait} minutes` : 'shortly'}.`);
          }
          throw new Error((json && (json.details || json.error)) || `HTTP ${res.status}`);
        }
        if (cancelled) return;
        setCosts(json);
        setCostsError(json.stale ? "Showing the last figures received. Azure's cost service is limiting requests at the moment." : null);
      } catch (err) {
        if (!cancelled) setCostsError(err.message);
      }
    };
    load();
    const id = setInterval(load, COST_POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const [report, setReport] = useState(null); // null | 'slo' | 'cost'

  // The report is a light page; the Console is dark. Switch the page
  // background while the report is open.
  useEffect(() => {
    document.body.classList.toggle('report-mode', report !== null);
    return () => document.body.classList.remove('report-mode');
  }, [report]);

  if (report === 'slo' && slo) {
    return <SloReport slo={slo} onClose={() => setReport(null)} />;
  }
  if (report === 'cost' && costs) {
    return <CostReport costs={costs} onClose={() => setReport(null)} />;
  }

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

      <SloSection
        slo={slo}
        error={sloError}
        sloWindow={sloWindow}
        onWindowChange={setSloWindow}
        onReport={() => setReport('slo')}
      />

      <p className="section-label">Live activity</p>
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

      <CostSection costs={costs} error={costsError} onReport={() => setReport('cost')} />

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
