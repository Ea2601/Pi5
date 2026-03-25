import { Bell, User, ShieldCheck, ShieldAlert } from 'lucide-react';
import type { HealthStatus } from '../types';
import { useApi } from '../hooks/useApi';

export function Topbar() {
  const { data } = useApi<HealthStatus>('/system/health', {
    isFailOpen: false, lastCheckTime: '', lastCheckResult: 'pending',
    checksTotal: 0, checksFailed: 0, uptimePercent: 100,
  }, 10000);

  const connected = data.lastCheckResult !== 'failed';

  return (
    <header className="glass-panel topbar">
      <div className="status-indicator">
        <span className={`dot ${connected ? 'pulse' : 'dot-error'}`} />
        {data.isFailOpen ? (
          <span className="fail-open-warn">
            <ShieldAlert size={14} />
            FAIL-OPEN Aktif — Trafik doğrudan ISP'ye yönlendirildi
          </span>
        ) : (
          <span>
            <ShieldCheck size={14} style={{ marginRight: 4 }} />
            Sistem Aktif — Uptime: {data.uptimePercent}%
          </span>
        )}
      </div>
      <div className="topbar-actions">
        <button className="icon-btn" title="Bildirimler">
          <Bell size={18} />
        </button>
        <div className="user-profile">
          <User size={14} />
          <span>Admin</span>
        </div>
      </div>
    </header>
  );
}
