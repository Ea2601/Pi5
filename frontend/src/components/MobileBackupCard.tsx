import { useEffect, useRef, useState } from 'react';
import { Smartphone, Loader2, Plus, Trash2, Power, AlertTriangle, Info, QrCode, Copy } from 'lucide-react';
import { useApi, postApi, getApi } from '../hooks/useApi';
import { Modal, Select } from './ui';
import { toast } from '../toast';
import { copyText } from '../clipboard';

// Mobil yedekleme (backend mobile.ts): Klyrix uygulaması telefonun fotoğraf ve videolarını Pi'nin yedek diskine yükler.
// Cihaz Yedekleme açıkken görünür (aynı hedef diskler ve Yedekler paylaşımı). Telefon panelde üretilen tek kullanımlık kodla
// (QR) eşleşir; kaldırılan telefonun dosyaları diskte kalır.
interface Target { key: string; kind: 'internal' | 'usb'; name: string; mounted: boolean; free: number | null; size: number | null }
interface MobileDevice { id: number; name: string; platform: string; created_at: string; last_seen: string; files: number; bytes: number }
interface MobileStatus {
  supported: boolean; enabled: boolean; listening: boolean; error: string; port: number; target: string;
  targets: Target[]; devices: MobileDevice[]; pairing: { code: string; expires: number } | null; hosts: string[];
}
interface PairInfo { code: string; expires: number; qr: string; hosts: string[] }

function size(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return b > 0 ? `${Math.max(1, Math.round(b / 1e3))} KB` : '0';
}
const seen = (iso: string) => (iso ? new Date(iso).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }) : 'henüz bağlanmadı');
const targetLabel = (t: Target) => (t.kind === 'internal' ? 'Dahili disk' : `USB: ${t.name}`);
const errText = (e: unknown, d: string) => (e instanceof Error && e.message ? e.message : d);

export function MobileBackupCard() {
  const { data, refetch } = useApi<MobileStatus | null>('/mobile', null, 15000);
  const [busy, setBusy] = useState('');
  const [pair, setPair] = useState<PairInfo | null>(null);
  if (!data || !data.supported) return null;

  const post = async (key: string, url: string, body: Record<string, unknown>, okMsg: string) => {
    setBusy(key);
    try {
      await postApi(url, body);
      toast.success(okMsg);
    } catch (e) {
      toast.error(errText(e, 'İşlem başarısız'));
    }
    setBusy('');
    void refetch();
  };
  const startPair = async () => {
    setBusy('pair');
    try {
      setPair(await postApi('/mobile/pair', {}) as PairInfo);
    } catch (e) {
      toast.error(errText(e, 'Eşleştirme kodu alınamadı'));
    }
    setBusy('');
  };
  const remove = (d: MobileDevice) => {
    if (!window.confirm(`${d.name} kaldırılsın mı?\n\nTelefon bir daha yükleyemez (yeniden eşleştirilene kadar). Yedeklenen ${d.files} dosya Pi'de kalır.`)) return;
    void post(`rm${d.id}`, '/mobile/devices/remove', { id: d.id }, `${d.name} kaldırıldı`);
  };
  const mountedTargets = data.targets.filter(t => t.mounted);

  return (
    <section>
      <h4 className="dv-h"><Smartphone size={14} /> Telefon ve tablet — Klyrix uygulaması</h4>
      <div className="dv-card">
        <div className="dv-card-main">
          <span className="dv-meta">
            {data.enabled
              ? `Eşleştirilen telefonlar fotoğraf ve videolarını kendiliğinden buraya yükler (ev ağında ya da Ev VPN'iyle, port ${data.port}). Dosyalar «<telefon>/Kamera/yıl/ay» klasörlerine yazılır ve Yedekler paylaşımından geri alınır.`
              : 'Açınca Klyrix uygulaması (iOS / Android) telefonun fotoğraf ve videolarını Pi\'ye yedekler — Syncthing kurmadan, QR kodla eşleşerek. Pi telefondaki hiçbir şeyi silmez.'}
          </span>
        </div>
        {data.enabled
          ? <button className="btn-outline btn-sm" disabled={!!busy} onClick={() => void post('off', '/mobile/settings', { enabled: false }, 'Mobil yedekleme kapatıldı')}>
              {busy === 'off' ? <Loader2 size={13} className="spin" /> : <Power size={13} />} Kapat
            </button>
          : <button className="btn-primary btn-sm" disabled={!!busy || !mountedTargets.length}
              onClick={() => void post('on', '/mobile/settings', { enabled: true, target: mountedTargets.some(t => t.key === data.target) ? data.target : mountedTargets[0]?.key }, 'Mobil yedekleme açıldı')}>
              {busy === 'on' ? <Loader2 size={13} className="spin" /> : <Power size={13} />} Aç
            </button>}
      </div>
      {!mountedTargets.length && !data.enabled && (
        <div className="dv-note dv-note-warn"><AlertTriangle size={16} /><span>Bağlı yedek diski yok: önce Depolama'dan veri diskini ya da bir USB diski hazırlayın.</span></div>
      )}
      {data.enabled && data.error && (
        <div className="dv-note dv-note-bad"><AlertTriangle size={16} /><span>Mobil yedekleme dinleyicisi açılamadı: {data.error}</span></div>
      )}
      {data.enabled && (
        <>
          <div className="dv-card">
            <div className="dv-card-main">
              <strong>Hedef disk</strong>
              <span className="dv-meta">Telefonlardan gelen dosyalar bu diske yazılır.</span>
            </div>
            <Select className="config-select" value={data.target} disabled={!!busy}
              onChange={e => void post('t', '/mobile/settings', { target: e.target.value }, 'Hedef disk değişti')}>
              {data.targets.map(t => <option key={t.key} value={t.key} disabled={!t.mounted}>{targetLabel(t)}{t.mounted ? '' : ' (bağlı değil)'}</option>)}
            </Select>
          </div>
          {data.devices.map(d => (
            <div key={d.id} className="dv-card">
              <div className="dv-card-main">
                <strong>{d.name}</strong>
                <span className="dv-meta">{d.platform === 'ios' ? 'iPhone / iPad' : d.platform === 'android' ? 'Android' : 'Telefon'} · {d.files} dosya · {size(d.bytes)} · son bağlantı: {seen(d.last_seen)}</span>
              </div>
              <button className="dv-icon-btn" title="Telefonu kaldır" aria-label={`${d.name} telefonunu kaldır`} disabled={!!busy} onClick={() => remove(d)}>
                {busy === `rm${d.id}` ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
              </button>
            </div>
          ))}
          <button className="btn-outline btn-sm" style={{ marginTop: 8 }} disabled={!!busy || !data.listening} onClick={() => void startPair()}>
            {busy === 'pair' ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} Telefon ekle
          </button>
        </>
      )}
      {pair && <PairModal pair={pair} known={data.devices.length} onClose={() => { setPair(null); void postApi('/mobile/pair/cancel', {}).catch(() => {}); void refetch(); }}
        onPaired={name => { setPair(null); toast.success(`${name} eşleştirildi — uygulama yedeklemeye başlıyor`); void refetch(); }} />}
    </section>
  );
}

// Eşleştirme penceresi: QR + kod + kalan süre; telefon eşleşince (cihaz sayısı artınca) kendiliğinden kapanır
function PairModal({ pair, known, onClose, onPaired }: { pair: PairInfo; known: number; onClose: () => void; onPaired: (name: string) => void }) {
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
        const s = await getApi<MobileStatus>('/mobile');
        if (alive && !done.current && s.devices.length > known) {
          done.current = true;
          paired.current(s.devices[s.devices.length - 1].name);
        }
      } catch { /* sonraki turda */ }
    }, 3000);
    return () => { alive = false; window.clearInterval(t); };
  }, [known]);
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  return (
    <Modal open onClose={onClose} title="Telefon ekle" width={440} actions={<button className="btn-outline btn-sm" onClick={onClose}>Kapat</button>}>
      {left > 0 ? (
        <div style={{ textAlign: 'center' }}>
          {pair.qr ? <img src={pair.qr} alt="Eşleştirme QR kodu" width={220} height={220} style={{ imageRendering: 'pixelated', background: '#fff', borderRadius: 8, padding: 6 }} />
            : <div className="dv-note dv-note-info"><QrCode size={16} /><span>QR üretilemedi — kodu elle girin.</span></div>}
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 26, fontWeight: 700, letterSpacing: 2, margin: '10px 0 2px' }}>{pair.code}</div>
          <div className="dv-meta">{mmss} içinde kullanın · tek kullanımlık</div>
          <button className="btn-outline btn-sm" style={{ marginTop: 8 }} onClick={() => void copyText(pair.code).then(ok => (ok ? toast.success('Kopyalandı') : toast.error('Kopyalanamadı')))}>
            <Copy size={13} /> Kodu kopyala
          </button>
        </div>
      ) : (
        <div className="dv-note dv-note-warn"><AlertTriangle size={16} /><span>Kodun süresi doldu — kapatıp yeniden «Telefon ekle»ye basın.</span></div>
      )}
      <ol className="dv-hint" style={{ textAlign: 'left', marginTop: 14, paddingLeft: 18 }}>
        <li>Telefonda <strong>Klyrix</strong> uygulamasını açın → <strong>Pi'ye bağlan</strong>.</li>
        <li>Bu QR kodu okutun (ya da kodu yazın). Telefon Pi ile aynı ev ağında olmalı; evden uzaktaysanız Ev VPN'ini açın.</li>
        <li>Fotoğraflara erişim izni verin: yedekleme hemen başlar, sonra uygulama açıldıkça ve arka planda sürer.</li>
      </ol>
      <div className="dv-note dv-note-info" style={{ marginTop: 10 }}><Info size={16} /><span>
        Pi'nin adresleri: {pair.hosts.join(', ')}. Uygulama henüz mağazada değilse geliştirici sürümüyle kurulur (depodaki mobile/ klasörü).
      </span></div>
    </Modal>
  );
}
