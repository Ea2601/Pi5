import type { ReactNode } from 'react';
import { Layers, Router, Globe, Wifi, Repeat2, Cable, Share2, Check, X, CircleHelp, Cpu, Info, RefreshCw } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';

// Cihaz Rolleri (R0): Pi'nin takılı donanımına göre hangi ağ rollerini üstlenebileceği. Salt okunur — rol değiştirme
// ilgili fazlarda (R1 erişim noktası, R2 mesh, R3 WAN router, R4 repeater) eklenecek. Veri /api/system/hardware.

type RoleId = 'lan-router' | 'wan-router' | 'ap' | 'repeater' | 'mesh-wired' | 'mesh-wireless';
type RoleStatus = 'active' | 'available' | 'hw-ready' | 'needs-hw' | 'unknown';
type Check = { ok: boolean | null; label: string; detail?: string };
type RoleEval = { id: RoleId; status: RoleStatus; phase: string | null; checks: Check[]; need: string[]; notes: string[] };
type EthPort = { name: string; driver: string; bus: 'usb' | 'onboard'; usbSpeedMbps: number | null; speedMbps: number | null; carrier: boolean | null; mac: string; uplink: boolean };
type Radio = {
  phy: string; ifaces: string[]; driver: string; bus: 'usb' | 'onboard'; usbSpeedMbps: number | null; modes: string[]; bands: string[];
  ap: boolean; sta: boolean; mesh: boolean; apSta: boolean; apMesh: boolean; fourAddr: boolean | null;
};
type HardwareResp = {
  supported: boolean; board?: string; kernel?: string; iwMissing?: boolean; eth?: EthPort[]; radios?: Radio[];
  tools?: Record<string, boolean>; modules?: Record<string, boolean>; roles?: RoleEval[];
  net?: { uplinkIface: string | null; apStage: string; apIface: string | null };
};

const ROLE_META: Record<RoleId, { name: string; icon: ReactNode; desc: string }> = {
  'lan-router': { name: 'LAN router', icon: <Router size={18} />, desc: 'Mevcut modemin arkasında ev ağını yönetir: adres dağıtımı (DHCP), DNS, reklam engelleme, yönlendirme.' },
  'wan-router': { name: 'WAN router', icon: <Globe size={18} />, desc: 'İnternetin ilk cihazı: operatör bağlantısını (DHCP / PPPoE / VLAN) Pi karşılar, çift NAT biter.' },
  ap: { name: 'Erişim noktası', icon: <Wifi size={18} />, desc: "Ev Wi-Fi'ını Pi yayınlar; kablosuz cihazlar doğrudan Klyrix ağına bağlanır." },
  repeater: { name: 'Repeater', icon: <Repeat2 size={18} />, desc: "Mevcut Wi-Fi'ı alıp yeniden yayınlar; kapsama alanını genişletir." },
  'mesh-wired': { name: 'Kablolu mesh uydusu', icon: <Cable size={18} />, desc: 'İkinci Klyrix cihazı kabloyla ağa bağlanır, aynı ağ adı ve şifreyle yayın yapar.' },
  'mesh-wireless': { name: 'Kablosuz mesh', icon: <Share2 size={18} />, desc: 'Uydular birbirine 802.11s ile kablosuz bağlanır; kablo çekmeden kapsama.' },
};
const STATUS: Record<RoleStatus, { label: (phase: string | null) => string; variant: 'success' | 'info' | 'neutral' | 'warning' }> = {
  active: { label: () => 'Kullanımda', variant: 'success' },
  available: { label: () => 'Hazır · kapalı', variant: 'info' },
  'hw-ready': { label: p => (p ? `Donanım uygun · ${p}'de gelecek` : 'Donanım uygun'), variant: 'neutral' },
  'needs-hw': { label: () => 'Donanım gerekli', variant: 'warning' },
  unknown: { label: () => 'Belirlenemedi', variant: 'neutral' },
};
const MODE_LABEL: Record<string, string> = { AP: 'AP', managed: 'İstemci', 'mesh point': 'Mesh', monitor: 'İzleme', IBSS: 'Ad-hoc' };
const busText = (bus: 'usb' | 'onboard', usb: number | null) =>
  bus === 'onboard' ? 'Dahili' : usb === null ? 'USB' : usb >= 5000 ? `USB 3 (${usb / 1000} Gbps)` : `USB 2 (${usb} Mbps)`;

function CheckIcon({ ok }: { ok: boolean | null }) {
  if (ok === null) return <CircleHelp size={14} className="roles-ck roles-ck-unk" aria-label="bilinmiyor" />;
  return ok ? <Check size={14} className="roles-ck roles-ck-ok" aria-label="uygun" /> : <X size={14} className="roles-ck roles-ck-no" aria-label="eksik" />;
}

export function RolesPanel() {
  const { data, error, loading, refetch } = useApi<HardwareResp | null>('/system/hardware', null);

  return (
    <div className="fade-in page-stack">
      <Panel title="Cihaz Rolleri" icon={<Layers size={20} style={{ marginRight: 8 }} />}
        subtitle="Klyrix Gate'in takılı donanıma göre üstlenebileceği ağ rolleri: hangileri kullanımda, hangileri yapılabilir, hangisi için ne eksik. Bu sayfa yalnız okur; rol değiştirme sonraki fazlarda eklenecek."
        actions={<button className="icon-btn" onClick={refetch} title="Yeniden tara" aria-label="Donanımı yeniden tara"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>}>
        {!data && <div className="roles-note">{error ? `Donanım bilgisi alınamadı (${error})` : 'Donanım taranıyor…'}</div>}
        {data && !data.supported && <div className="roles-note">Donanım taraması yalnız Pi üzerinde çalışır.</div>}
        {data?.iwMissing && (
          <div className="roles-note roles-note-warn">
            <Info size={14} /> Wi-Fi radyolarının yetenekleri okunamadı: <code>iw</code> kurulu değil. Bir sonraki güncellemede kendiliğinden kurulur.
          </div>
        )}
      </Panel>

      {data?.supported && data.roles && (
        <div className="roles-grid">
          {data.roles.map(r => {
            const meta = ROLE_META[r.id];
            const st = STATUS[r.status];
            return (
              <section key={r.id} className={`glass-panel roles-card roles-st-${r.status}`} aria-labelledby={`role-${r.id}`}>
                <div className="roles-card-head">
                  <span className="roles-card-icon">{meta.icon}</span>
                  <h3 id={`role-${r.id}`}>{meta.name}</h3>
                  <Badge variant={st.variant}>{st.label(r.phase)}</Badge>
                </div>
                <p className="roles-desc">{meta.desc}</p>
                <ul className="roles-checks">
                  {r.checks.map((c, i) => (
                    <li key={i}>
                      <CheckIcon ok={c.ok} />
                      <span className="roles-ck-label">{c.label}</span>
                      {c.detail && <span className="roles-ck-detail">{c.detail}</span>}
                    </li>
                  ))}
                </ul>
                {r.need.length > 0 && (
                  <div className="roles-need">
                    <strong>Gerekli</strong>
                    <ul>{r.need.map((n, i) => <li key={i}>{n}</li>)}</ul>
                  </div>
                )}
                {r.notes.map((n, i) => <p key={i} className="roles-hint">{n}</p>)}
              </section>
            );
          })}
        </div>
      )}

      {data?.supported && (
        <Panel title="Donanım" icon={<Cpu size={18} style={{ marginRight: 8 }} />} subtitle={`${data.board || ''}${data.kernel ? ` · çekirdek ${data.kernel}` : ''}`}>
          <h4 className="roles-sub">Ethernet portları</h4>
          {!data.eth?.length && <p className="roles-hint">Ethernet portu bulunamadı.</p>}
          <div className="roles-hw">
            {data.eth?.map(e => (
              <div key={e.name} className="roles-hw-item">
                <div className="roles-hw-title"><code>{e.name}</code>{e.uplink && <Badge variant="info">İnternet çıkışı</Badge>}</div>
                <dl>
                  <dt>Bağlantı</dt><dd>{busText(e.bus, e.usbSpeedMbps)}</dd>
                  <dt>Sürücü</dt><dd>{e.driver || '—'}</dd>
                  <dt>Hız</dt><dd>{e.speedMbps ? (e.speedMbps >= 1000 ? `${e.speedMbps / 1000} Gbps` : `${e.speedMbps} Mbps`) : '—'}</dd>
                  <dt>Kablo</dt><dd>{e.carrier === true ? 'takılı' : e.carrier === false ? 'takılı değil' : '—'}</dd>
                </dl>
              </div>
            ))}
          </div>
          <h4 className="roles-sub">Wi-Fi radyoları</h4>
          {!data.radios?.length && <p className="roles-hint">Wi-Fi radyosu bulunamadı.</p>}
          <div className="roles-hw">
            {data.radios?.map(r => (
              <div key={r.phy} className="roles-hw-item">
                <div className="roles-hw-title"><code>{r.ifaces.join(', ') || r.phy}</code><span className="roles-muted">{r.phy}</span></div>
                <dl>
                  <dt>Bağlantı</dt><dd>{busText(r.bus, r.usbSpeedMbps)}</dd>
                  <dt>Sürücü</dt><dd>{r.driver || '—'}</dd>
                  <dt>Bantlar</dt><dd>{r.bands.length ? r.bands.map(b => `${b} GHz`).join(' · ') : '—'}</dd>
                  <dt>Modlar</dt>
                  <dd className="roles-modes">
                    {['AP', 'managed', 'mesh point', 'monitor'].map(m => (
                      <span key={m} className={`roles-mode${r.modes.includes(m) ? ' is-on' : ''}`}>{r.modes.includes(m) ? '✓' : '✗'} {MODE_LABEL[m]}</span>
                    ))}
                  </dd>
                  <dt>Aynı anda</dt>
                  <dd>{[r.apSta ? 'AP + istemci ✓' : 'AP + istemci ✗', r.apMesh ? 'AP + mesh ✓' : 'AP + mesh ✗'].join(' · ')}</dd>
                  <dt>4 adres</dt><dd>{r.fourAddr === null ? 'bilinmiyor' : r.fourAddr ? 'destekler' : 'desteklemez'}</dd>
                </dl>
              </div>
            ))}
          </div>
          <h4 className="roles-sub">Yazılım</h4>
          <div className="roles-modes">
            {Object.entries({ ...(data.tools || {}), ...(data.modules || {}) }).map(([k, v]) => (
              <span key={k} className={`roles-mode${v ? ' is-on' : ''}`}>{v ? '✓' : '✗'} {k}</span>
            ))}
          </div>
          <p className="roles-hint">Eksik araçlar ilgili rolün fazında kurulur. Roller birleştirilebilir (ör. WAN router + erişim noktası + mesh yöneticisi).</p>
        </Panel>
      )}
    </div>
  );
}
