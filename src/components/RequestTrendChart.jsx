import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function RequestTrendChart({ data }) {
  if (!data || data.length === 0) {
    return <div className="empty-state">No request data in this window yet</div>;
  }

  const chartData = data.map((d) => ({
    time: formatTime(d.time),
    success: Math.max((d.total || 0) - (d.failures || 0), 0),
    failures: d.failures || 0,
  }));

  return (
    <>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
          <defs>
            <linearGradient id="successFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#5EEAD4" stopOpacity={0.5} />
              <stop offset="100%" stopColor="#5EEAD4" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="failFill" x1="0" y1="0" x2="0" y2="1">
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
          <Area type="monotone" dataKey="success" stackId="1" stroke="#5EEAD4" fill="url(#successFill)" strokeWidth={1.5} />
          <Area type="monotone" dataKey="failures" stackId="1" stroke="#E5484D" fill="url(#failFill)" strokeWidth={1.5} />
        </AreaChart>
      </ResponsiveContainer>
      <div className="legend-row">
        <span><span className="legend-swatch" style={{ background: '#5EEAD4' }} />Successful</span>
        <span><span className="legend-swatch" style={{ background: '#E5484D' }} />Failed</span>
      </div>
    </>
  );
}
