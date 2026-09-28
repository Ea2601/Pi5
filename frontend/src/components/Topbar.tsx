import { Bell, User, ShieldCheck, ShieldAlert, Download, Loader2, Clock, Sun, Moon, Menu, LogOut } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { HealthStatus } from '../types';
import { useApi } from '../hooks/useApi';
import { Modal, Badge } from './ui';
import { setTheme, getCurrentTheme, type Theme } from '../theme';
import { toast } from '../toast';
import { startSystemUpdate } from '../systemUpdate';

// Son bildirilen güncellemenin (en yeni commit) kısaltması — aynı güncelleme için bildirim bir kez çıksın
const UPDATE_SEEN_KEY = 'updateNotifiedHash';

interface UpdateInfo {
  available: boolean;
  commits: { hash: string; message: string; time: string }[];
  currentVersion: string;
  commitCount: number;
}

interface TopbarProps {
  onShowAlerts?: () => void;
  // Telefon/tablet: menü çekmecesini açan düğme + o anki sayfanın adı (≥1024px'te gizlenir)
  onMenu?: () => void;
  menuOpen?: boolean;
  title?: string;
  // Giriş ekranı modunda: oturumu kapatır (verilmezse kullanıcı alanı yalnız ad gösterir)
  onLogout?: () => void;
  userName?: string;
}

export function Topbar({ onShowAlerts, onMenu, menuOpen = false, title = '', onLogout, userName }: TopbarProps) {
  const { data } = useApi<HealthStatus>('/system/health', {
    isFailOpen: false, lastCheckTime: '', lastCheckResult: 'pending',
    checksTotal: 0, checksFailed: 0, uptimePercent: 100,
  }, 10000);

  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updatePhase, setUpdatePhase] = useState('');
  const [clock, setClock] = useState('');
  const [theme, setThemeState] = useState<Theme>(getCurrentTheme());

  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);      // DOM + localStorage + backend senkron
    setThemeState(next); // ikon güncellensin
  };

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

  // Güncelleme denetimi: açılışta, dakikada bir ve sekmeye dönülünce (eskiden saatte bir — yeni güncelleme ancak sayfa
  // yenilenince görünüyordu). Backend GitHub'a en çok 60 sn'de bir sorar. Yeni bir güncelleme ilk görüldüğünde bir kez
  // bildirim çıkar (son bildirilen commit tarayıcıda hatırlanır).
  useEffect(() => {
    const check = () => {
      fetch('/api/system/update-check')
        .then(r => (r.ok ? r.json() : null))
        // Yalnız beklenen biçimdeki yanıt kaydedilir: JSON hata gövdesi (ör. hız sınırının 429'u) güncelleme penceresinin
        // `commits.map`'ini — pencere kapalıyken de hesaplanır — ve onunla bütün paneli çökertmesin.
        .then(d => {
          if (!d || !Array.isArray(d.commits)) return;
          setUpdateInfo(d);
          const top = d.available && d.commits[0]?.hash;
          let seen: string | null = null;
          try { seen = localStorage.getItem(UPDATE_SEEN_KEY); } catch { /* depolama yok */ }
          if (top && top !== seen) {
            toast.info(`Yeni güncelleme hazır: ${d.commitCount} değişiklik — üst çubuktaki zile dokunun`, { duration: 8000 });
            try { localStorage.setItem(UPDATE_SEEN_KEY, top); } catch { /* depolama yok */ }
          }
        })
        .catch(() => {});
    };
    check();
    const interval = setInterval(check, 60000);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  const handleUpdate = async () => {
    setUpdating(true);
    try {
      await startSystemUpdate(setUpdatePhase);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Güncelleme başarısız');
    }
    setUpdating(false);
    setUpdatePhase('');
  };

  // Unread alerts count
  const { data: alertData } = useApi<{ count: number }>('/alerts/unread-count', { count: 0 }, 30000);

  const connected = data.lastCheckResult !== 'failed';
  const hasUpdate = updateInfo?.available ?? false;
  const totalBadge = (hasUpdate ? updateInfo!.commitCount : 0) + alertData.count;

  return (
    <>
      <header className="glass-panel topbar">
        <div className="topbar-start">
          <button
            className="icon-btn topbar-menu"
            onClick={onMenu}
            aria-label="Menüyü aç"
            title="Menü"
            aria-expanded={menuOpen}
            aria-controls="app-nav"
          >
            <Menu size={20} />
          </button>
          <div className="topbar-heading">
            {title && <span className="topbar-page">{title}</span>}
            <div className="status-indicator">
              <span className={`dot ${connected ? 'pulse' : 'dot-error'}`} />
              {data.isFailOpen ? (
                <span className="fail-open-warn">
                  <ShieldAlert size={14} />
                  <span className="status-long">FAIL-OPEN Aktif — Trafik dogrudan ISP'ye yonlendirildi</span>
                  <span className="status-short">FAIL-OPEN — trafik doğrudan ISP'de</span>
                </span>
              ) : (
                <span className="status-ok">
                  <ShieldCheck size={14} />
                  <span className="status-long">Sistem Aktif — Uptime: {data.uptimePercent}%</span>
                  <span className="status-short">Sistem aktif · %{data.uptimePercent}</span>
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="topbar-actions">
          {clock && (
            <span className="topbar-clock">
              <Clock size={13} /> {clock}
            </span>
          )}
          <button
            className="icon-btn"
            title={theme === 'dark' ? 'Açık moda geç' : 'Koyu moda geç'}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button
            className="icon-btn"
            title="Bildirimler"
            onClick={() => { if (hasUpdate) setShowUpdateModal(true); else onShowAlerts?.(); }}
            style={{ position: 'relative' }}
          >
            <Bell size={18} />
            {totalBadge > 0 && (
              <span className="notification-badge">{totalBadge}</span>
            )}
          </button>
          {onLogout ? (
            <button className="user-profile user-logout" onClick={onLogout} title="Çıkış yap">
              <User size={14} />
              <span>{userName || 'admin'}</span>
              <LogOut size={14} />
            </button>
          ) : (
            <div className="user-profile">
              <User size={14} />
              <span>Admin</span>
            </div>
          )}
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
              {updating ? <><Loader2 size={13} className="spin" /> {updatePhase || 'Güncelleniyor...'}</> : <><Download size={13} /> Güncelle</>}
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
                padding: '6px 10px', borderRadius: 8,
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
      </Modal>
    </>
  );
}
