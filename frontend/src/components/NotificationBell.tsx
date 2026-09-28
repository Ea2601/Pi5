import { Bell, CheckCheck, Check, Download, ChevronRight, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useApi, postApi } from '../hooks/useApi';
import { toast } from '../toast';
import { type AlertsPage, parseAlertTime, relativeTime, severityMeta, sourceLabel, notifyAlertsChanged, onAlertsChanged } from '../alerts';

// Üst çubuktaki zil: tıklanınca son bildirimler zilin altında açılır (telefonda ekran genişliğinde). Güncelleme varsa en
// üstte o durur (güncelleme penceresini açar). Açıkken 10 sn'de bir yenilenir; okundu bilgisi Bildirimler sayfasıyla
// anında paylaşılır (alerts.ts). Panel body'ye taşınır: üst çubuğun cam efekti (backdrop-filter) sabit konumlu çocukları
// kendine göre konumlandırıp keserdi.
const PANEL_ID = 'notif-panel';
const LIMIT = 15;

interface Props {
  updateCount: number; // 0 = güncelleme yok
  onOpenUpdate: () => void;
  onShowAll?: () => void;
}

export function NotificationBell({ updateCount, onOpenUpdate, onShowAll }: Props) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const { data: unread, refetch: refetchUnread } = useApi<{ count: number }>('/alerts/unread-count', { count: 0 }, 30000);
  useEffect(() => onAlertsChanged(() => { void refetchUnread(); }), [refetchUnread]);
  const close = useCallback((focusBell = false) => {
    setOpen(false);
    if (focusBell) btnRef.current?.focus();
  }, []);

  const total = unread.count + updateCount;
  return (
    <>
      <button
        ref={btnRef}
        className="icon-btn"
        title="Bildirimler"
        aria-label={total ? `Bildirimler — ${total} yeni` : 'Bildirimler'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? PANEL_ID : undefined}
        onClick={() => setOpen(o => !o)}
        style={{ position: 'relative' }}
      >
        <Bell size={18} />
        {total > 0 && <span className="notification-badge">{total > 99 ? '99+' : total}</span>}
      </button>
      {open && createPortal(
        <NotificationPanel anchor={btnRef} unreadCount={unread.count} updateCount={updateCount} onClose={close}
          onOpenUpdate={onOpenUpdate} onShowAll={onShowAll} />,
        document.body,
      )}
    </>
  );
}

function NotificationPanel({ anchor, unreadCount, updateCount, onClose, onOpenUpdate, onShowAll }: {
  anchor: RefObject<HTMLButtonElement | null>; unreadCount: number; updateCount: number;
  onClose: (focusBell?: boolean) => void; onOpenUpdate: () => void; onShowAll?: () => void;
}) {
  const { data, loading, refetch } = useApi<AlertsPage>(`/alerts?limit=${LIMIT}`, { alerts: [] }, 10000);
  const panelRef = useRef<HTMLDivElement>(null);
  const [acking, setAcking] = useState<number | 'all' | null>(null);
  useEffect(() => onAlertsChanged(() => { void refetch(); }), [refetch]);

  // Konum: zilin altı, sağ kenarına hizalı; dar ekranda iki yanda 8 px boşlukla tam genişlik (stil doğrudan yazılır).
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      const el = panelRef.current;
      if (!r || !el) return;
      const narrow = window.innerWidth < 640;
      el.style.top = `${Math.round(r.bottom + 8)}px`;
      el.style.left = narrow ? '8px' : 'auto';
      el.style.right = narrow ? '8px' : `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
      el.style.maxHeight = `${Math.max(240, Math.round(window.innerHeight - r.bottom - 24))}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  // Dışarı tıklama ya da Esc kapatır (Esc'te odak zile döner); açılınca odak panele.
  useEffect(() => {
    panelRef.current?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(true); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [anchor, onClose]);

  const ack = async (id: number | 'all') => {
    setAcking(id);
    try {
      await postApi(id === 'all' ? '/alerts/acknowledge-all' : `/alerts/acknowledge/${id}`, {});
      notifyAlertsChanged(id); // zil sayısı, bu liste ve açıksa Bildirimler sayfası yenilenir
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İşlem başarısız');
    } finally {
      setAcking(null);
    }
  };

  return (
    <div id={PANEL_ID} ref={panelRef} className="glass-panel notif-panel" role="dialog" aria-label="Bildirimler" tabIndex={-1}>
      <div className="notif-head">
        <div className="notif-title">
          <strong>Bildirimler</strong>
          <span className="notif-count">{unreadCount ? `${unreadCount} okunmamış` : 'Hepsi okundu'}</span>
        </div>
        <button className="btn-outline btn-sm" onClick={() => ack('all')} disabled={!unreadCount || acking === 'all'}>
          {acking === 'all' ? <Loader2 size={13} className="spin" /> : <CheckCheck size={13} />} Tümünü okundu say
        </button>
      </div>

      <div className="notif-list">
        {updateCount > 0 && (
          <button className="notif-item notif-update" onClick={() => { onClose(); onOpenUpdate(); }}>
            <Download size={15} className="notif-icon" />
            <span className="notif-body">
              <span className="notif-msg">Yeni güncelleme hazır</span>
              <span className="notif-meta">{updateCount} değişiklik — ayrıntılar ve Güncelle</span>
            </span>
            <ChevronRight size={15} className="notif-icon" />
          </button>
        )}
        {loading && data.alerts.length === 0 && (
          <div className="notif-empty"><Loader2 size={16} className="spin" /></div>
        )}
        {!loading && data.alerts.length === 0 && updateCount === 0 && (
          <div className="notif-empty">Henüz bildirim yok.</div>
        )}
        {data.alerts.map(a => {
          const sev = severityMeta(a.severity);
          const read = !!a.acknowledged;
          return (
            <div key={a.id} className={`notif-item notif-${a.severity} ${read ? 'notif-read' : ''}`}>
              <sev.Icon size={15} className="notif-icon" aria-label={sev.label} />
              <span className="notif-body">
                <span className="notif-msg">{a.message}</span>
                <span className="notif-meta">{sourceLabel(a.source)} · {a.created_at ? relativeTime(parseAlertTime(a.created_at)) : '—'}</span>
              </span>
              {!read && (
                <button className="icon-btn icon-btn-sm notif-ack" onClick={() => ack(a.id)} disabled={acking === a.id}
                  title="Okundu say" aria-label="Okundu say">
                  {acking === a.id ? <Loader2 size={13} className="spin" /> : <Check size={14} />}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button className="notif-foot" onClick={() => { onClose(); onShowAll?.(); }}>
        Tümünü gör <ChevronRight size={14} />
      </button>
    </div>
  );
}
