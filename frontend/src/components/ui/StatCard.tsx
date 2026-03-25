import type { ReactNode } from 'react';

interface StatCardProps {
  icon: ReactNode;
  label: string;
  value: string | number;
  color: 'blue' | 'green' | 'emerald' | 'purple' | 'orange' | 'cyan';
  valueClass?: string;
}

export function StatCard({ icon, label, value, color, valueClass = '' }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className={`stat-icon stat-icon-${color}`}>{icon}</div>
      <div className="stat-info">
        <span className="stat-label">{label}</span>
        <span className={`stat-value ${valueClass}`}>{value}</span>
      </div>
    </div>
  );
}
