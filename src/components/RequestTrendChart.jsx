import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function RequestTrendChart({ data }) {
  if (!data || data.length === 0) {
    return <div className="empty-state">No request data in this window yet</div>;
  }

  // Falls back to the old binary failures count if a given point predates
  // the 4xx/5xx split (e.g. cached data from before this was added) --
  // in that case the whole bucket is shown as "5xx" so nothing silently
  // disappears from the chart.
  const chartData = data.map((d) => {
    const total = d.total || 0;
    const by4xx = d.by4xx !== undefined ? d.by4xx : 0;
    const by5xx = d.by5xx !== undefined ? d.by5xx : (d.failures || 0);
    const success = Math.max(total - by4xx - by5xx, 0);
    return { time: formatTime(d.time), success, by4xx, by5xx };
  });

  return (
    <>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
          <defs>
            <linearGradient id="successFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#5EEAD4" stopOpacity={0.5} />
              <stop offset="100%" stopColor="#5EEAD4" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="fill4xx" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#F5A623" stopOpacity={0.6} />
              <stop offset="100%" stopColor="#F5A623" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="fill5xx" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#E5484D" stopOpacity={0.6} />
              <stop offset="100%" stopColor="#E5484D" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#2B3947" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="time" stroke="#8B98A5" fontSize={11} fontFamily="IBM Plex Mono" tickLine={false} axisLine={{ stroke: '#2B3947' }} />
          <YAxis stroke="#8B98A5" fontSize={11} fontFamily="IBM Plex Mono" tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip
            contentStyle={{ background: '#212D3A', border: '1px solid #2B3947', borderRadius: 8, fontFamily: 'IBM Plex Mono', fontSize: 12 }}
            labelStyle={{ color: '#8B98A5' }}
          />
          <Area type="monotone" dataKey="success" stackId="1" stroke="#5EEAD4" fill="url(#successFill)" strokeWidth={1.5} name="Successful" />
          <Area type="monotone" dataKey="by4xx" stackId="1" stroke="#F5A623" fill="url(#fill4xx)" strokeWidth={1.5} name="4XX" />
          <Area type="monotone" dataKey="by5xx" stackId="1" stroke="#E5484D" fill="url(#fill5xx)" strokeWidth={1.5} name="5XX" />
        </AreaChart>
      </ResponsiveContainer>
      <div className="legend-row">
        <span><span className="legend-swatch" style={{ background: '#5EEAD4' }} />Successful</span>
        <span><span className="legend-swatch" style={{ background: '#F5A623' }} />4XX</span>
        <span><span className="legend-swatch" style={{ background: '#E5484D' }} />5XX</span>
      </div>
    </>
  );
}
