import { Bell, User, ShieldCheck, ShieldAlert, RefreshCw, Check, X, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { HealthStatus } from '../types';
import { useApi, postApi } from '../hooks/useApi';

export function Topbar() {
  const { data } = useApi<HealthStatus>('/system/health', {
    isFailOpen: false, lastCheckTime: '', lastCheckResult: 'pending',
    checksTotal: 0, checksFailed: 0, uptimePercent: 100,
  }, 10000);

  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleUpdate = async () => {
    if (!confirm('Sistem guncellenecek ve backend yeniden baslatilacak. Devam edilsin mi?')) return;
    setUpdating(true);
    setUpdateResult(null);
    try {
      const result = await postApi('/system/update', {});
      if (result.success) {
        setUpdateResult({ success: true, message: 'Guncelleme tamamlandi! Sayfa yenilenecek...' });
        setTimeout(() => window.location.reload(), 3000);
      } else {
        const failed = result.steps?.filter((s: any) => !s.success).map((s: any) => s.step).join(', ');
        setUpdateResult({ success: false, message: `Basarisiz adimlar: ${failed}` });
      }
    } catch (e: any) {
      setUpdateResult({ success: false, message: e.message || 'Guncelleme basarisiz' });
    }
    setUpdating(false);
  };

  const connected = data.lastCheckResult !== 'failed';

  return (
    <header className="glass-panel topbar">
      <div className="status-indicator">
        <span className={`dot ${connected ? 'pulse' : 'dot-error'}`} />
        {data.isFailOpen ? (
          <span className="fail-open-warn">
            <ShieldAlert size={14} />
            FAIL-OPEN Aktif — Trafik dogrudan ISP'ye yonlendirildi
          </span>
        ) : (
          <span>
            <ShieldCheck size={14} style={{ marginRight: 4 }} />
            Sistem Aktif — Uptime: {data.uptimePercent}%
          </span>
        )}
      </div>
      <div className="topbar-actions">
        {updateResult && (
          <span style={{
            fontSize: 11, display: 'flex', alignItems: 'center', gap: 4,
            color: updateResult.success ? 'var(--success-color)' : 'var(--danger-color)',
          }}>
            {updateResult.success ? <Check size={12} /> : <X size={12} />}
            {updateResult.message}
          </span>
        )}
        <button
          className={updating ? 'btn-outline btn-sm' : 'btn-primary btn-sm'}
          onClick={handleUpdate}
          disabled={updating}
          title="Panel guncelle (git pull + build + restart)"
        >
          {updating ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          <span>{updating ? 'Guncelleniyor...' : 'Guncelle'}</span>
        </button>
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
