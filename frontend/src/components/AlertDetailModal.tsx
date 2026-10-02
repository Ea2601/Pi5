import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, Loader2 } from 'lucide-react';
import { postApi } from '../hooks/useApi';
import { toast } from '../toast';
import { Badge, Modal } from './ui';
import { tabLabel } from '../nav';
import { type AlertItem, alertTab, fullTime, notifyAlertsChanged, openAlertSubTab, parseAlertTime, relativeTime, severityMeta, sourceLabel } from '../alerts';

// Bildirimin ayrıntısı: zildeki ve Bildirimler sayfasındaki satıra tıklanınca açılır. Tam metin (listede 3 satırla
// kısalır), zaman, kaynak, okundu durumu; "Okundu say" ve ilgili sayfaya git. Pencere body'ye taşınır: zil paneli ve
// sayfa kartları cam efektli (backdrop-filter) — içlerindeki sabit konumlu pencereyi kendilerine göre konumlandırıp keserdi.
// Dış kap sınıfı (notif-detail-host) zil panelinin "dışarı tıklandı" denetiminde pencereyi panelin parçası sayar.
export const DETAIL_HOST_CLASS = 'notif-detail-host';

export function AlertDetailModal({ alert, onClose, onNavigate }: {
  alert: AlertItem; onClose: () => void; onNavigate?: () => void;
}) {
  const [read, setRead] = useState(!!alert.acknowledged);
  const [acking, setAcking] = useState(false);
  const sev = severityMeta(alert.severity);
  const t = alert.created_at ? parseAlertTime(alert.created_at) : null;
  const tab = alertTab(alert.source);

  const ack = async () => {
    setAcking(true);
    try {
      await postApi(`/alerts/acknowledge/${alert.id}`, {});
      setRead(true);
      notifyAlertsChanged(alert.id); // zil sayısı, zil listesi ve Bildirimler sayfası yenilenir
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İşlem başarısız');
    } finally {
      setAcking(false);
    }
  };

  const go = () => {
    if (!tab) return;
    onClose();
    onNavigate?.();
    openAlertSubTab(alert.source);
    window.location.hash = `#${tab}`;
  };

  return createPortal(
    <div className={DETAIL_HOST_CLASS}>
      <Modal open onClose={onClose} title={`${sev.label} — ${sourceLabel(alert.source)}`} width={460}
        actions={
          <>
            {!read && (
              <button className="btn-outline btn-sm" onClick={ack} disabled={acking}>
                {acking ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Okundu say
              </button>
            )}
            {tab ? (
              <button className="btn-primary btn-sm" onClick={go}>
                {tabLabel(tab)} sayfasına git <ChevronRight size={13} />
              </button>
            ) : (
              <button className="btn-primary btn-sm" onClick={onClose}>Kapat</button>
            )}
          </>
        }>
        <div className={`alert-detail alert-detail-${alert.severity}`}>
          <div className="alert-detail-head">
            <sev.Icon size={18} />
            <Badge variant={sev.badge}>{sev.label}</Badge>
            <span>{sourceLabel(alert.source)}</span>
          </div>
          <p className="alert-detail-msg">{alert.message}</p>
          <dl className="alert-detail-meta">
            <div><dt>Zaman</dt><dd>{t ? `${fullTime(t)} (${relativeTime(t)})` : '—'}</dd></div>
            <div><dt>Tür</dt><dd>{alert.type === 'event' ? 'Panelde yapılan işlem / olay' : 'Sistem uyarısı'}</dd></div>
            <div><dt>Durum</dt><dd>{alert.severity === 'info' ? 'Bilgi (okundu sayılır)' : read ? 'Okundu' : 'Okunmadı'}</dd></div>
          </dl>
        </div>
      </Modal>
    </div>,
    document.body,
  );
}
