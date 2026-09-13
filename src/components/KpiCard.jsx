export default function KpiCard({ label, value, unit, tone = 'neutral', footnote }) {
  return (
    <div className="kpi-card">
      <p className="kpi-label">{label}</p>
      <p className={`kpi-value ${tone}`}>
        {value}
        {unit ? <span style={{ fontSize: '17px', marginLeft: '4px', color: 'var(--text-muted)' }}>{unit}</span> : null}
      </p>
      {footnote ? <p className="kpi-footnote">{footnote}</p> : null}
    </div>
  );
}
