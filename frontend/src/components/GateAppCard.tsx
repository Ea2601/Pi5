import { useEffect, useRef, useState } from 'react';
import { Smartphone, Plus, Trash2, Loader2, AlertTriangle, Copy, Info } from 'lucide-react';
import { useApi, postApi, deleteApi, getApi } from '../hooks/useApi';
import { Badge, Modal } from './ui';
import { toast } from '../toast';
import { relativeTime } from '../alerts';
import { copyText } from '../clipboard';
import { fmtDbTime, parseDbTime } from '../time';

// Klyrix/Gate yönetim uygulaması (backend gateApp.ts): eşleşen telefon Pi'yi panelin kendisiyle yönetir — evde de evin
// dışında da. Bağlantı Ev VPN'i kanalından geçer ama telefonda VPN açılmaz (WireGuard uygulamanın içinde); telefon Pi'de
// yalnız uygulama kapısına ulaşır. Eşleşme paneldeki kodla (QR) ya da panel şifresiyle; kaldırınca bağlantı hemen kesilir.
interface AppDevice {
  id: number; name: string; platform: string; ip: string; created_at: string; last_seen: string; handshake: number; conflict: boolean;
}
interface AppStatus {
  supported: boolean;
  tunnel: { enabled: boolean; running: boolean };
  gate: { listening: boolean; error: string; address: string };
  passwordSet: boolean;
  devices: AppDevice[];
  pairing: { code: string; expires: number } | null;
  lastPair: { id: number; name: string; at: number } | null;
}
interface PairInfo { code: string; expires: number; qr: string; hosts: string[]; at: number }

const ONLINE_S = 180; // uygulama açıkken tünel en geç 2 dk'da bir el sıkışır
const platformName = (p: string) => (p === 'ios' ? 'iPhone / iPad' : p === 'android' ? 'Android' : 'Telefon');
const errText = (e: unknown, d: string) => (e instanceof Error && e.message ? e.message : d);

export function GateAppCard() {
  const { data: st, refetch } = useApi<AppStatus | null>('/app', null, 10000);
  const [busy, setBusy] = useState('');
  const [pair, setPair] = useState<PairInfo | null>(null);

  if (!st?.supported) return null;
  const now = Date.now() / 1000;
  const devices = st.devices;
  const isOn = (d: AppDevice) => !!d.handshake && now - d.handshake < ONLINE_S;
  const online = devices.filter(isOn).length;

  const startPair = async () => {
    setBusy('pair');
    try {
      setPair(await postApi('/app/pair/code', {}) as PairInfo);
    } catch (e) {
      toast.error(errText(e, 'Eşleştirme kodu alınamadı'));
    } finally {
      setBusy('');
    }
  };

  const remove = async (d: AppDevice) => {
    if (!confirm(`${d.name} kaldırılsın mı? Bu telefon Pi'yi artık yönetemez; bağlantısı hemen kesilir. Yeniden eklemek için yeniden eşleştirmek gerekir.`)) return;
    setBusy(`rm${d.id}`);
    try {
      await deleteApi(`/app/devices/${d.id}`);
      toast.success(`${d.name} kaldırıldı`);
    } catch (e) {
      toast.error(errText(e, 'Kaldırılamadı'));
    } finally {
      setBusy('');
      await refetch();
    }
  };

  const seenText = (d: AppDevice) => {
    if (isOn(d)) return 'bağlı';
    if (d.handshake) return `son bağlantı ${relativeTime(new Date(d.handshake * 1000))}`;
    const seen = parseDbTime(d.last_seen);
    return seen ? `son kullanım ${relativeTime(seen)}` : 'henüz bağlanmadı';
  };

  return (
    <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
      <div className="widget-header">
        <h3><Smartphone size={18} style={{ marginRight: 8 }} />Klyrix/Gate uygulaması</h3>
        <Badge variant={online ? 'success' : 'neutral'}>{devices.length ? `${online} bağlı / ${devices.length}` : 'Eşli telefon yok'}</Badge>
      </div>
      <p className="subtitle">
        Pi'yi telefondan panelin kendisiyle yönetin — evde de evin dışında da. Telefon ile Pi arasındaki şifreli, kalıcı bağlantı
        Ev VPN'i kanalından geçer ama telefonda VPN açılmaz: yalnız uygulama kullanır ve Pi'de yalnız yönetime ulaşır. Eşli telefon
        panel şifresi sormaz — kaybolursa buradan kaldırın.
      </p>

      {!st.tunnel.enabled && (
        <div className="routing-apply"><Info size={14} /><span>
          Ev VPN'i kapalı: {devices.length
            ? 'eşli telefonlar şu an bağlanamaz — yukarıdan açın.'
            : 'telefon eşleşirken uygulama onu açmak için onayınızı ister.'}
        </span></div>
      )}
      {st.gate.error && (
        <div className="routing-apply routing-apply-err"><AlertTriangle size={14} /><span>Uygulama kapısı açılamadı: {st.gate.error}</span></div>
      )}

      <div className="pivpn-add">
        <button className="btn-outline btn-sm btn-on" onClick={startPair} disabled={!!busy}>
          {busy === 'pair' ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} Telefon ekle
        </button>
      </div>

      {devices.length === 0 ? (
        <div className="empty-state" style={{ padding: 24 }}>
          Henüz eşli telefon yok. «Telefon ekle» ile QR kodu açın{st.passwordSet ? ' ya da uygulamada panel şifresiyle eşleşin' : ''}.
        </div>
      ) : (
        <div className="pivpn-list">
          {devices.map(d => (
            <div key={d.id} className="list-item pivpn-peer">
              <span className={`svc-dot ${isOn(d) ? 'svc-on' : 'svc-off'}`} />
              <div className="list-item-content">
                <span className="pivpn-peer-name">{d.name}</span>
                <span className="pivpn-peer-meta">
                  {platformName(d.platform)} · {d.ip} · {seenText(d)} · eşleşme {fmtDbTime(d.created_at, { dateStyle: 'medium' })}
                </span>
                {d.conflict && (
                  <span className="pivpn-peer-meta" style={{ color: 'var(--warning-color)' }}>
                    <AlertTriangle size={12} /> Bir Ev VPN'i istemcisiyle aynı adreste (buluttan geri yükleme) — bu telefon bağlanamaz; kaldırıp yeniden eşleştirin.
                  </span>
                )}
              </div>
              <div className="pivpn-peer-actions">
                <button className="btn-outline btn-sm btn-off" onClick={() => remove(d)} disabled={!!busy} aria-label={`${d.name} telefonunu kaldır`}>
                  {busy === `rm${d.id}` ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} Kaldır
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {pair && (
        <PairModal pair={pair}
          onClose={() => { setPair(null); void postApi('/app/pair/cancel', {}).catch(() => {}); void refetch(); }}
          onPaired={name => { setPair(null); toast.success(`${name} eşleşti — Pi'yi artık uygulamadan yönetebilir`); void refetch(); }} />
      )}
    </div>
  );
}

// Eşleştirme penceresi: QR + kod + kalan süre; telefon eşleşince (durumdaki son eşleşme bu koddan sonraysa) kendiliğinden kapanır
function PairModal({ pair, onClose, onPaired }: { pair: PairInfo; onClose: () => void; onPaired: (name: string) => void }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.round((pair.expires - Date.now()) / 1000)));
  const done = useRef(false);
  const paired = useRef(onPaired);
  useEffect(() => { paired.current = onPaired; }, [onPaired]);
  useEffect(() => {
    const t = window.setInterval(() => setLeft(Math.max(0, Math.round((pair.expires - Date.now()) / 1000))), 1000);
    return () => window.clearInterval(t);
  }, [pair.expires]);
  useEffect(() => {
    let alive = true;
    const t = window.setInterval(async () => {
      try {
        const s = await getApi<AppStatus>('/app');
        if (alive && !done.current && s.lastPair && s.lastPair.at > pair.at) {
          done.current = true;
          paired.current(s.lastPair.name);
        }
      } catch { /* sonraki turda */ }
    }, 3000);
    return () => { alive = false; window.clearInterval(t); };
  }, [pair.at]);
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  return (
    <Modal open onClose={onClose} title="Telefon ekle — Klyrix/Gate" width={440} actions={<button className="btn-outline btn-sm" onClick={onClose}>Kapat</button>}>
      {left > 0 ? (
        <div style={{ textAlign: 'center' }}>
          {pair.qr ? <div className="pivpn-qr"><img src={pair.qr} alt="Eşleştirme QR kodu" /></div>
            : <div className="routing-apply"><Info size={14} /><span>QR üretilemedi — kodu uygulamaya elle yazın.</span></div>}
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 26, fontWeight: 700, letterSpacing: 2, margin: '10px 0 2px' }}>{pair.code}</div>
          <div className="pivpn-peer-meta">{mmss} içinde kullanın · tek kullanımlık</div>
          <button className="btn-outline btn-sm" style={{ marginTop: 8 }}
            onClick={() => void copyText(pair.code).then(ok => (ok ? toast.success('Kopyalandı') : toast.error('Kopyalanamadı')))}>
            <Copy size={13} /> Kodu kopyala
          </button>
        </div>
      ) : (
        <div className="routing-apply"><AlertTriangle size={14} /><span>Kodun süresi doldu — kapatıp yeniden «Telefon ekle»ye basın.</span></div>
      )}
      <ol className="pivpn-peer-meta" style={{ textAlign: 'left', marginTop: 14, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6, lineHeight: 1.5 }}>
        <li>Telefonu evin Wi-Fi'ına bağlayın ve <strong>Klyrix/Gate</strong> uygulamasını açın → <strong>Cihaz ekle</strong>.</li>
        <li>Uygulama Pi'yi ağda kendisi bulur: bu QR kodu okutun (ya da kodu yazın).</li>
        <li>Eşleşince telefon Pi'yi evin dışından da yönetir; bağlantı kalıcıdır, buradan kaldırılana dek geçerlidir.</li>
      </ol>
      <div className="routing-apply" style={{ marginTop: 10 }}><Info size={14} /><span>Pi'nin ev ağı adresleri: {pair.hosts.join(', ')}.</span></div>
    </Modal>
  );
}
