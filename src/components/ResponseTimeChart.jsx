import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ResponseTimeChart({ data }) {
  if (!data || data.length === 0) {
    return <div className="empty-state">No timing data in this window yet</div>;
  }

  const chartData = data.map((d) => ({
    time: formatTime(d.time),
    ms: d.avgDurationMs || 0,
  }));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
        <CartesianGrid stroke="#2B3947" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="time" stroke="#8B98A5" fontSize={11} fontFamily="IBM Plex Mono" tickLine={false} axisLine={{ stroke: '#2B3947' }} />
        <YAxis stroke="#8B98A5" fontSize={11} fontFamily="IBM Plex Mono" tickLine={false} axisLine={false} unit="ms" />
        <Tooltip
          contentStyle={{ background: '#212D3A', border: '1px solid #2B3947', borderRadius: 8, fontFamily: 'IBM Plex Mono', fontSize: 12 }}
          labelStyle={{ color: '#8B98A5' }}
        />
        <Line type="monotone" dataKey="ms" stroke="#E8A33D" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
