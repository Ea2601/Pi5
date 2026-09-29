import { Bell, AlertTriangle, AlertCircle, Info, CheckCircle, Filter, CheckCheck, Loader2, MailOpen } from 'lucide-react';
import { useApi, postApi, getApi } from '../hooks/useApi';
import { useState, useMemo, useEffect } from 'react';
import { Panel, Badge } from './ui';
import { toast } from '../toast';
import { type AlertItem, type AlertsPage, sourceLabel, parseAlertTime, dayLabel, severityMeta, notifyAlertsChanged, onAlertsChanged, markRead } from '../alerts';
import { AlertDetailModal } from './AlertDetailModal';

// Uyarılar + olay geçmişi (backend events.ts): sağlık denetiminin uyarıları (type=health) ve panelde yapılan işlemler
// (type=event: güncelleme, Unbound/Zapret/Pi-hole ayarları, VPS, cihaz engeli, Cron hatası, servis, DHCP / ağ modu).
// Bilgi olayları okunmuş gelir; okunmamış sayısı yalnız uyarı/kritik içindir. Kayıtlar 30 gün tutulur. Son kayıtlar
// üst çubuktaki zilden de görülür (NotificationBell); okundu bilgisi ikisi arasında anında paylaşılır.
type SeverityFilter = 'all' | 'critical' | 'warning' | 'info';

const PAGE = 50;

export function AlertsPanel() {
  const [filter, setFilter] = useState<SeverityFilter>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [rev, setRev] = useState(0); // "Tümünü okundu say" sonrası liste baştan yüklenir
  const [ackingAll, setAckingAll] = useState(false);
  const { data: unread, refetch: refetchUnread } = useApi<{ count: number }>('/alerts/unread-count', { count: 0 }, 15000);
  useEffect(() => onAlertsChanged(() => { void refetchUnread(); }), [refetchUnread]);
  const query = `/alerts?limit=${PAGE}${filter !== 'all' ? `&severity=${filter}` : ''}${unreadOnly ? '&unread=1' : ''}`;

  const handleAckAll = async () => {
    setAckingAll(true);
    try {
      await postApi('/alerts/acknowledge-all', {});
      toast.success('Tüm uyarılar okundu sayıldı');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İşlem başarısız');
    } finally {
      setAckingAll(false);
      setRev(r => r + 1);
      notifyAlertsChanged('all'); // zil de yenilensin
    }
  };

  const tabs: { id: SeverityFilter; label: string; icon: React.ReactNode }[] = [
    { id: 'all', label: 'Tümü', icon: <Filter size={14} /> },
    { id: 'critical', label: 'Kritik', icon: <AlertCircle size={14} /> },
    { id: 'warning', label: 'Uyarı', icon: <AlertTriangle size={14} /> },
    { id: 'info', label: 'Bilgi', icon: <Info size={14} /> },
  ];

  return (
    <div className="fade-in">
      <Panel title="Uyarı Merkezi" icon={<Bell size={20} style={{ marginRight: 8 }} />}
        subtitle="Sistem uyarıları ve panelde yapılan işlemlerin geçmişi — son 30 gün"
        badge={unread.count > 0 ? <Badge variant="error">{unread.count} okunmamış</Badge> : <Badge variant="success">Temiz</Badge>}>
        <div className="service-tabs">
          {tabs.map(tab => (
            <button key={tab.id}
              className={`service-tab ${filter === tab.id ? 'service-tab-active' : ''}`}
              onClick={() => setFilter(tab.id)}>
              {tab.icon}<span>{tab.label}</span>
            </button>
          ))}
        </div>
        <div className="alert-toolbar">
          <button className={`btn-outline btn-sm ${unreadOnly ? 'alert-chip-on' : ''}`} onClick={() => setUnreadOnly(v => !v)}
            aria-pressed={unreadOnly}>
            <MailOpen size={13} /> Yalnız okunmamış
          </button>
          <button className="btn-outline btn-sm" onClick={handleAckAll} disabled={ackingAll || unread.count === 0}>
            {ackingAll ? <Loader2 size={13} className="spin" /> : <CheckCheck size={13} />} Tümünü okundu say
          </button>
        </div>
      </Panel>

      <div style={{ marginTop: 14 }}>
        <AlertList key={`${query}#${rev}`} query={query} unreadOnly={unreadOnly} />
      </div>
    </div>
  );
}

// Süzgeç değişince (key) baştan kurulur: ilk sayfa 10 sn'de bir yenilenir, "Daha fazla göster" daha eskileri ekler.
// Satırın tamamı tıklanır ve ayrıntı penceresini açar (AlertDetailModal); "Okundu" düğmesi ayrı çalışır.
function AlertList({ query, unreadOnly }: { query: string; unreadOnly: boolean }) {
  const { data, refetch } = useApi<AlertsPage>(query, { alerts: [] }, 10000);
  const [older, setOlder] = useState<AlertItem[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [acking, setAcking] = useState<number | null>(null);
  const [detail, setDetail] = useState<AlertItem | null>(null);
  // Zilden (ya da bu sayfadan) okundu yapılınca: ilk sayfa yenilenir, eklenmiş eski kayıtlar yerinde işaretlenir.
  useEffect(() => onAlertsChanged(read => {
    setOlder(prev => markRead(prev, read));
    void refetch();
  }), [refetch]);

  const items = useMemo(() => {
    const seen = new Set<number>();
    return [...data.alerts, ...older].filter(a => (seen.has(a.id) ? false : (seen.add(a.id), true)));
  }, [data.alerts, older]);
  const hasMore = olderHasMore ?? !!data.hasMore;

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const r = await getApi<AlertsPage>(`${query}&before=${last.id}`);
      setOlder(prev => [...prev, ...r.alerts]);
      setOlderHasMore(!!r.hasMore);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Daha eski kayıtlar yüklenemedi');
    } finally {
      setLoadingMore(false);
    }
  };

  const acknowledge = async (id: number) => {
    setAcking(id);
    try {
      await postApi(`/alerts/acknowledge/${id}`, {});
      notifyAlertsChanged(id); // bu liste, sayfanın okunmamış sayısı ve zil yenilenir
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İşlem başarısız');
    } finally {
      setAcking(null);
    }
  };

  // Güne göre gruplama (en yeni önce geldiği için gün değişince başlık)
  const rows: React.ReactNode[] = [];
  let lastDay = '';
  for (const a of items) {
    const t = a.created_at ? parseAlertTime(a.created_at) : null;
    const day = t ? dayLabel(t) : '—';
    if (day !== lastDay) {
      rows.push(<div key={`d-${a.id}`} className="alert-day">{day}</div>);
      lastDay = day;
    }
    const sev = severityMeta(a.severity);
    const read = !!a.acknowledged;
    rows.push(
      <div key={a.id} className={`list-item alert-row alert-${a.severity} ${read ? 'alert-read' : ''}`}>
        {/* Satırın tamamını kaplayan düğme (CSS ::after); "Okundu" düğmesi üstünde kalır. */}
        <button className="alert-open" onClick={() => setDetail(a)} title="Ayrıntıyı aç">
          <span className="alert-icon"><sev.Icon size={16} /></span>
          <span className="list-item-content">
            <span className="alert-message">{a.message}</span>
            <span className="alert-meta">
              <Badge variant={sev.badge}>{sev.label}</Badge>
              <span>{sourceLabel(a.source)}</span>
              <span>· {t ? t.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
            </span>
          </span>
        </button>
        {read ? (
          a.severity !== 'info' && <span className="alert-meta" title="Okundu"><CheckCircle size={13} /></span>
        ) : (
          <button className="btn-outline btn-sm alert-ack" onClick={() => acknowledge(a.id)} disabled={acking === a.id}>
            {acking === a.id ? <Loader2 size={12} className="spin" /> : <CheckCircle size={12} />} Okundu
          </button>
        )}
      </div>,
    );
  }

  return (
    <Panel title="Geçmiş">
      <div className="alert-list">
        {items.length === 0 && (
          <div className="empty-state" style={{ padding: 20 }}>
            {unreadOnly ? 'Okunmamış uyarı yok.' : 'Bu süzgeçte kayıt yok.'}
          </div>
        )}
        {rows}
      </div>
      {hasMore && (
        <button className="btn-outline btn-sm btn-full" style={{ marginTop: 12 }} onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? <Loader2 size={13} className="spin" /> : null} Daha fazla göster
        </button>
      )}
      {detail && <AlertDetailModal alert={detail} onClose={() => setDetail(null)} />}
    </Panel>
  );
}
