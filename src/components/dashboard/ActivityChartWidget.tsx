import { useMemo } from "react";

interface ActivityPoint {
  time: number;
  value: number;
}

interface ActivityChartWidgetProps {
  data: ActivityPoint[];
  title?: string;
  color?: string;
  /** Current render frequency (fps) shown in the footer. */
  hz?: number;
}

export function ActivityChartWidget({ data, title = "Neural Activity", color = "var(--cyan)", hz }: ActivityChartWidgetProps) {
  const points = useMemo(() => {
    if (!data || data.length < 2) return "";
    
    const maxVal = Math.max(...data.map(d => d.value), 10);
    const width = 300;
    const height = 100;
    
    return data.map((d, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - (d.value / maxVal) * height;
      return `${x},${y}`;
    }).join(" ");
  }, [data]);

  return (
    <div className="dashboard-widget chart-widget">
      <header className="widget-header">
        <h3 className="widget-title">{title}</h3>
      </header>
      <div className="widget-body">
        <svg width="100%" height="80" viewBox="0 0 300 100" preserveAspectRatio="none" style={{ filter: 'drop-shadow(0 0 4px rgba(93, 242, 255, 0.2))' }}>
          <defs>
            <linearGradient id="chart-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.4" />
              <stop offset="100%" stopColor={color} stopOpacity="0.0" />
            </linearGradient>
          </defs>
          {points && (
            <>
              <polygon points={`0,100 ${points} 300,100`} fill="url(#chart-gradient)" />
              <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
            </>
          )}
        </svg>
        <div className="chart-footer">
          <small>REAL-TIME FREQUENCY MONITOR</small>
          <span className="current-hz">{hz != null && hz > 0 ? `${Math.round(hz)} Hz` : "— Hz"}</span>
        </div>
      </div>
    </div>
  );
}
