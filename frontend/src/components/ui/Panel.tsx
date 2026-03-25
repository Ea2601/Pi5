import type { ReactNode } from 'react';

interface PanelProps {
  title: string;
  icon?: ReactNode;
  subtitle?: string;
  badge?: ReactNode;
  actions?: ReactNode;
  size?: 'large' | 'medium';
  children: ReactNode;
  className?: string;
}

export function Panel({ title, icon, subtitle, badge, actions, size = 'large', children, className = '' }: PanelProps) {
  return (
    <div className={`glass-panel widget-${size} ${className}`}>
      <div className="widget-header">
        <h3>{icon}{title}</h3>
        <div className="widget-header-actions">
          {badge}
          {actions}
        </div>
      </div>
      {subtitle && <p className="subtitle">{subtitle}</p>}
      {children}
    </div>
  );
}
