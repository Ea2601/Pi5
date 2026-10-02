import { Home, QrCode, Trash2, Plus, Loader2, AlertTriangle, Download, Copy, CheckCircle, ShieldCheck, User, Globe } from 'lucide-react';
import { useState } from 'react';
import { useApi, postApi, putApi, deleteApi, getApi } from '../hooks/useApi';
import { Badge, Modal, Select } from './ui';
import { PiVpnReachability } from './PiVpnReachability';
import { toast } from '../toast';
import { relativeTime } from '../alerts';

// Ev VPN'i (backend wgServer.ts): Pi üzerinde WireGuard sunucusu. Dış VPS'lerin istemcilerinden ayrıdır — bu istemciler
// Pi'ye bağlanır, trafikleri evden (Pi'den) çıkar ve paneldeki yönlendirme kurallarına tabi olur. Yönetici ev ağına ve
// panele erişir; misafir yalnız internete çıkar.
interface Peer {
  id: number; name: string; ip: string; role: 'admin' | 'guest'; created_at: string;
  handshake: number; rx: number; tx: number; endpoint: string;
}
interface WgStatus {
  supported?: boolean; qrencode?: boolean; enabled?: boolean; running?: boolean; port?: number; network?: string;
  serverIp?: string; endpoint?: { host: string; source: 'ddns' | 'ip' | 'none' }; legacyInputDrop?: boolean;
  dnsListening?: string; dnsOk?: boolean; // Pi-hole dns.listeningMode: VPN istemcileri yalnız LOCAL / ALL'da yanıt alır
  peers?: Peer[]; piLanIp?: string;
}
interface PeerConfig { name: string; config: string; qr: string; endpoint: string }

const ONLINE_S = 180; // son el sıkışma 3 dk içindeyse bağlı sayılır (istemci 25 sn'de bir yoklar)
function fmtBytes(n: number) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function PiVpnServer() {
  const { data: st, loading, refetch } = useApi<WgStatus | null>('/wg-server', null, 10000);
  const [toggling, setToggling] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState<'admin' | 'guest'>('guest');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [cfg, setCfg] = useState<PeerConfig | null>(null);

  const now = Date.now() / 1000;
  const peers = st?.peers || [];
  const online = peers.filter(p => p.handshake && now - p.handshake < ONLINE_S).length;
  const ep = st?.endpoint;

  const toggle = async () => {
    const next = !st?.enabled;
    if (!next && !confirm("Ev VPN'i kapatılırsa bağlı bütün istemcilerin bağlantısı kesilir. Devam edilsin mi?")) return;
    setToggling(true);
    try {
      await postApi('/wg-server/enable', { enabled: next });
      toast.success(next ? "Ev VPN'i açıldı" : "Ev VPN'i kapatıldı");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İşlem başarısız');
    } finally {
      setToggling(false);
      await refetch();
    }
  };

  const showConfig = async (id: number) => {
    setBusyId(id);
    try {
      setCfg(await getApi<PeerConfig>(`/wg-server/peers/${id}/config`));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Yapılandırma alınamadı');
    } finally {
      setBusyId(null);
    }
  };

  const add = async () => {
    if (!name.trim()) return;
    setAdding(true);
    try {
      const r = await postApi('/wg-server/peers', { name: name.trim(), role });
      toast.success(`${name.trim()} eklendi — QR açılıyor`);
      setName('');
      await refetch();
      await showConfig(r.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İstemci eklenemedi');
      await refetch();
    } finally {
      setAdding(false);
    }
  };

  const changeRole = async (p: Peer, next: 'admin' | 'guest') => {
    setBusyId(p.id);
    try {
      await putApi(`/wg-server/peers/${p.id}`, { role: next });
      toast.success(`${p.name}: ${next === 'admin' ? 'yönetici' : 'misafir'}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Rol değiştirilemedi');
    } finally {
      setBusyId(null);
      await refetch();
    }
  };

  const remove = async (p: Peer) => {
    if (!confirm(`${p.name} silinsin mi? Bu cihazın VPN bağlantısı hemen kesilir; QR'ı artık çalışmaz.`)) return;
    setBusyId(p.id);
    try {
      await deleteApi(`/wg-server/peers/${p.id}`);
      toast.success(`${p.name} silindi`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Silinemedi');
    } finally {
      setBusyId(null);
      await refetch();
    }
  };

  if (loading && !st) {
    return <div className="glass-panel widget-large" style={{ marginTop: 14, textAlign: 'center', padding: 30 }}><Loader2 size={20} className="spin" /></div>;
  }

  return (
    <>
      <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
        <div className="widget-header">
          <h3><Home size={18} style={{ marginRight: 8 }} />Ev VPN'i (Pi5 sunucusu)</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Badge variant={st?.running ? 'success' : 'neutral'}>{st?.running ? 'Çalışıyor' : 'Kapalı'}</Badge>
            <button className={`toggle-btn ${st?.enabled ? 'toggle-on' : 'toggle-off'}`} onClick={toggle}
              disabled={toggling || st?.supported === false} title={st?.enabled ? 'Kapat' : 'Aç'}>
              <div className="toggle-knob" />
            </button>
          </div>
        </div>
        <p className="subtitle">
          Ev dışındaki telefon ya da bilgisayar QR ile Pi'ye bağlanır; interneti evden (Pi'den) kullanır ve paneldeki yönlendirme
          kuralları ona da uygulanır. Dış VPS istemcilerinden ayrıdır.
        </p>

        {st?.supported === false && (
          <div className="routing-apply routing-apply-err"><AlertTriangle size={14} /><span>WireGuard araçları (wireguard-tools) Pi'de bulunamadı.</span></div>
        )}
        {st?.qrencode === false && (
          <div className="routing-apply"><AlertTriangle size={14} /><span>qrencode kurulu değil: QR üretilemez, yapılandırma dosyası yine indirilebilir.</span></div>
        )}
        {st?.enabled && st.dnsOk === false && (
          <div className="routing-apply routing-apply-err"><AlertTriangle size={14} /><span>
            Pi-hole DNS dinleme modu ({st.dnsListening}) VPN istemcilerini yanıtlamaz: bağlanırlar ama hiçbir site açılmaz. Pi-hole → Ayarlar →
            DNS'te «yerel» (önerilen) ya da «tüm arayüzler» seçin.
          </span></div>
        )}

        <div className="pivpn-facts">
          <div className="pivpn-fact">
            <span><Globe size={13} /> Dışarıdan adres</span>
            <strong>{ep?.host ? `${ep.host}:${st?.port}` : '—'}</strong>
            <em>{ep?.source === 'ddns' ? 'DDNS — ev IP\'si değişse de geçerli' : ep?.source === 'ip' ? 'dış IP — değişirse QR\'lar yenilenmeli (DDNS önerilir)' : 'bulunamadı'}</em>
          </div>
          <div className="pivpn-fact">
            <span><ShieldCheck size={13} /> Pi'nin VPN adresi</span>
            <strong>{st?.serverIp || '—'}</strong>
            <em>panel: http://{st?.serverIp || '10.77.77.1'} (yöneticiler)</em>
          </div>
          <div className="pivpn-fact">
            <span><User size={13} /> İstemciler</span>
            <strong>{online} bağlı / {peers.length}</strong>
            <em>ağ {st?.network || '—'}</em>
          </div>
        </div>

        {/* İlk kurulum rehberi: sabit adımlar yerine test sonucuna göre (tek modem / çift NAT / CGNAT) adım adım */}
        {st?.supported !== false && <PiVpnReachability running={!!st?.running} />}
      </div>

      <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
        <div className="widget-header"><h3>Ev VPN'i istemcileri</h3></div>
        <div className="pivpn-add">
          <input className="config-input" placeholder="Cihaz adı (ör. iPhone-Ali)" value={name} maxLength={40}
            onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} disabled={adding} />
          <Select value={role} onChange={e => setRole(e.target.value as 'admin' | 'guest')} disabled={adding}>
            <option value="guest">Misafir — yalnız internet</option>
            <option value="admin">Yönetici — ev ağı + panel</option>
          </Select>
          <button className="btn-primary btn-sm" onClick={add} disabled={adding || !name.trim()}>
            {adding ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} İstemci ekle
          </button>
        </div>
        {!st?.enabled && peers.length > 0 && (
          <div className="routing-apply"><AlertTriangle size={14} /><span>Ev VPN'i kapalı: istemciler kayıtlı ama bağlanamaz. Yukarıdan açın.</span></div>
        )}

        {peers.length === 0 ? (
          <div className="empty-state" style={{ padding: 24 }}>Henüz istemci yok. Bir cihaz adı yazıp ekleyin; QR hemen açılır.</div>
        ) : (
          <div className="pivpn-list">
            {peers.map(p => {
              const on = !!p.handshake && now - p.handshake < ONLINE_S;
              const busy = busyId === p.id;
              return (
                <div key={p.id} className="list-item pivpn-peer">
                  <span className={`svc-dot ${on ? 'svc-on' : 'svc-off'}`} />
                  <div className="list-item-content">
                    <span className="pivpn-peer-name">
                      {p.name}
                      <Badge variant={p.role === 'admin' ? 'warning' : 'info'}>{p.role === 'admin' ? 'Yönetici' : 'Misafir'}</Badge>
                    </span>
                    <span className="pivpn-peer-meta">
                      {p.ip} · {on ? 'bağlı' : p.handshake ? `son bağlantı ${relativeTime(new Date(p.handshake * 1000))}` : 'hiç bağlanmadı'}
                      {p.handshake ? ` · ↓ ${fmtBytes(p.tx)} ↑ ${fmtBytes(p.rx)}` : ''}
                      {on && p.endpoint ? ` · ${p.endpoint.replace(/:\d+$/, '')}` : ''}
                    </span>
                  </div>
                  <div className="pivpn-peer-actions">
                    <button className="btn-outline btn-sm" onClick={() => showConfig(p.id)} disabled={busy} title="QR ve yapılandırma">
                      {busy ? <Loader2 size={12} className="spin" /> : <QrCode size={12} />} QR
                    </button>
                    <button className="btn-outline btn-sm" onClick={() => changeRole(p, p.role === 'admin' ? 'guest' : 'admin')} disabled={busy}
                      title={p.role === 'admin' ? 'Misafir yap: ev ağına ve panele erişimi kalkar' : 'Yönetici yap: ev ağına ve panele erişir'}>
                      {p.role === 'admin' ? 'Misafir yap' : 'Yönetici yap'}
                    </button>
                    <button className="icon-btn icon-btn-sm" onClick={() => remove(p)} disabled={busy} title="Sil">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {cfg && <ConfigModal cfg={cfg} onClose={() => setCfg(null)} />}
    </>
  );
}

function ConfigModal({ cfg, onClose }: { cfg: PeerConfig; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const file = `ev-vpn-${cfg.name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 20) || 'istemci'}.conf`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([cfg.config], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cfg.config);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { toast.error('Kopyalanamadı'); }
  };
  return (
    <Modal open onClose={onClose} title={`${cfg.name} — Ev VPN'i`} width={400}
      actions={
        <>
          <button className="btn-outline btn-sm" onClick={copy}>{copied ? <CheckCircle size={13} /> : <Copy size={13} />} {copied ? 'Kopyalandı' : 'Kopyala'}</button>
          <button className="btn-primary btn-sm" onClick={download}><Download size={13} /> Dosyayı indir</button>
        </>
      }>
      <div className="pivpn-qr">
        {cfg.qr ? <img src={cfg.qr} alt={`${cfg.name} QR`} /> : <span className="subtitle">QR üretilemedi — dosyayı indirin.</span>}
      </div>
      <p className="subtitle" style={{ marginTop: 10 }}>
        Telefonda WireGuard uygulamasını açıp <strong>+ → QR koddan oluştur</strong> ile tarayın. Bilgisayarda dosyayı indirip
        WireGuard'a <strong>Dosyadan tünel içe aktar</strong> ile ekleyin. Sunucu adresi: <code>{cfg.endpoint}</code>.
        Bu QR, cihazın gizli anahtarını içerir; yalnız o cihazın sahibiyle paylaşın.
      </p>
    </Modal>
  );
}
