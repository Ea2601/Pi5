import { Bell, User, ShieldCheck, ShieldAlert, Download, Loader2, Clock } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { HealthStatus } from '../types';
import { useApi, postApi } from '../hooks/useApi';
import { Modal, Badge } from './ui';

interface UpdateInfo {
  available: boolean;
  commits: { hash: string; message: string; time: string }[];
  currentVersion: string;
  commitCount: number;
}

export function Topbar() {
  const { data } = useApi<HealthStatus>('/system/health', {
    isFailOpen: false, lastCheckTime: '', lastCheckResult: 'pending',
    checksTotal: 0, checksFailed: 0, uptimePercent: 100,
  }, 10000);

  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [clock, setClock] = useState('');

  // Live clock
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const time = now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      const date = now.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
      const offset = -now.getTimezoneOffset() / 60;
      const gmt = `GMT${offset >= 0 ? '+' : ''}${offset}`;
      setClock(`${time} | ${date} | ${gmt}`);
    };
    tick();
    const interval = setInterval(tick, 10000);
    return () => clearInterval(interval);
  }, []);

  // Check for updates every hour (and on mount)
  useEffect(() => {
    const check = () => {
      fetch('/api/system/update-check')
        .then(r => r.json())
        .then(setUpdateInfo)
        .catch(() => {});
    };
    check();
    const interval = setInterval(check, 3600000); // 1 hour
    return () => clearInterval(interval);
  }, []);

  const handleUpdate = async () => {
    setUpdating(true);
    setUpdateResult(null);
    try {
      const result = await postApi('/system/update', {});
      if (result.success) {
        setUpdateResult('Güncelleme tamamlandı! 8sn sonra sayfa yenilenecek...');
        setTimeout(() => window.location.reload(), 8000);
      } else {
        const failed = result.steps?.filter((s: any) => !s.success).map((s: any) => s.step).join(', ');
        setUpdateResult(`Başarısız: ${failed}`);
      }
    } catch (e: any) {
      setUpdateResult(e.message || 'Güncelleme başarısız');
    }
    setUpdating(false);
  };

  // Unread alerts count
  const { data: alertData } = useApi<{ count: number }>('/alerts/unread-count', { count: 0 }, 30000);

  const connected = data.lastCheckResult !== 'failed';
  const hasUpdate = updateInfo?.available ?? false;
  const totalBadge = (hasUpdate ? updateInfo!.commitCount : 0) + alertData.count;

  return (
    <>
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
          {clock && (
            <span className="topbar-clock">
              <Clock size={13} /> {clock}
            </span>
          )}
          <button
            className="icon-btn"
            title="Bildirimler"
            onClick={() => hasUpdate && setShowUpdateModal(true)}
            style={{ position: 'relative' }}
          >
            <Bell size={18} />
            {totalBadge > 0 && (
              <span className="notification-badge">{totalBadge}</span>
            )}
          </button>
          <div className="user-profile">
            <User size={14} />
            <span>Admin</span>
          </div>
        </div>
      </header>

      <Modal
        open={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        title="Sistem Güncellemesi Mevcut"
        actions={
          <>
            <button className="btn-outline btn-sm" onClick={() => setShowUpdateModal(false)} disabled={updating}>
              İptal
            </button>
            <button className="btn-primary btn-sm" onClick={handleUpdate} disabled={updating}>
              {updating ? <><Loader2 size={13} className="spin" /> Güncelleniyor...</> : <><Download size={13} /> Güncelle</>}
            </button>
          </>
        }
      >
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Badge variant="info">{updateInfo?.currentVersion}</Badge>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>→</span>
            <Badge variant="success">{updateInfo?.commitCount} yeni commit</Badge>
          </div>
        </div>

        <div style={{ fontSize: 13 }}>
          <h4 style={{ marginBottom: 8, fontSize: 13 }}>Değişiklikler:</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {updateInfo?.commits.map(c => (
              <div key={c.hash} style={{
                display: 'flex', gap: 8, alignItems: 'flex-start',
                padding: '6px 10px', borderRadius: 6,
                background: 'rgba(255,255,255,0.03)', border: '1px solid var(--panel-border)',
              }}>
                <code style={{ color: 'var(--accent-color)', fontSize: 11, flexShrink: 0, fontFamily: 'var(--font-mono)' }}>
                  {c.hash}
                </code>
                <span style={{ flex: 1, fontSize: 12 }}>{c.message}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0 }}>{c.time}</span>
              </div>
            ))}
          </div>
        </div>

        {updateResult && (
          <div style={{
            marginTop: 12, padding: '8px 12px', borderRadius: 6, fontSize: 12,
            background: updateResult.includes('tamamlandı') ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
            color: updateResult.includes('tamamlandı') ? '#10b981' : '#ef4444',
          }}>
            {updateResult}
          </div>
        )}
      </Modal>
    </>
  );
}
