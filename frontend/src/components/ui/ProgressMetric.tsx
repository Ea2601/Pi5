import type { ReactNode } from 'react';

interface ProgressMetricProps {
  icon: ReactNode;
  label: string;
  value: string;
  percent: number;
  variant?: 'temp' | 'cpu' | 'mem' | 'disk';
  valueClass?: string;
}

export function ProgressMetric({ icon, label, value, percent, variant = 'cpu', valueClass = '' }: ProgressMetricProps) {
  return (
    <div className="hw-stat">
      <div className="hw-stat-header">
        {icon}
        <span>{label}</span>
        <span className={`hw-val ${valueClass}`}>{value}</span>
      </div>
      <div className="progress-bar">
        <div className={`progress-fill progress-${variant}`} style={{ width: `${Math.min(percent, 100)}%` }} />
      </div>
    </div>
  );
}
