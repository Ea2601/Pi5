import type { ReactNode } from 'react';
import { Layers, Router, Globe, Wifi, Repeat2, Cable, Share2, Check, X, CircleHelp, Cpu, Info, TriangleAlert, RefreshCw, Package } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';
import { HomeWifiPanel } from './HomeWifiPanel';
import { MeshPanel } from './MeshPanel';
import { WanPanel } from './WanPanel';
import { FailoverPanel } from './FailoverPanel';

// Cihaz Rolleri: Pi'nin takılı donanımına göre hangi ağ rollerini üstlenebileceği (R0). WAN router (R3) "Yönlendirme"
// grubunun altındaki İnternet bağlantısı panelinden (WanPanel), erişim noktası (R1) "Kablosuz yayın" grubunun altındaki
// Ev Wi-Fi'ı panelinden, mesh (R2) "Mesh" grubunun altındaki Uydular panelinden (MeshPanel) yönetilir; diğerleri salt
// okunur. Roller üç grupta
// (yönlendirme / kablosuz yayın / mesh), her kart aynı iskelette: başlık + durum, açıklama, gereksinim tablosu, tipli
// notlar, altta eksik donanım ve faz. Donanım üç tabloda: kablolu arayüzler, radyo yetenekleri, yazılım bileşenleri.
// Veri /api/system/hardware (backend/src/hardware.ts).

type RoleId = 'lan-router' | 'wan-router' | 'ap' | 'repeater' | 'mesh-wired' | 'mesh-wireless';
type RoleGroup = 'routing' | 'wireless' | 'mesh';
type RoleStatus = 'active' | 'available' | 'hw-ready' | 'needs-hw' | 'unknown';
type Check = { ok: boolean | null; label: string; value: string };
type Note = { kind: 'warn' | 'info'; text: string };
type Need = { item: string; model?: string; chip?: string };
type RoleEval = { id: RoleId; group: RoleGroup; status: RoleStatus; phase: string | null; checks: Check[]; need: Need[]; notes: Note[] };
type EthPort = { name: string; driver: string; bus: 'usb' | 'onboard'; usbSpeedMbps: number | null; speedMbps: number | null; carrier: boolean | null; mac: string; uplink: boolean };
type Radio = {
  phy: string; ifaces: string[]; driver: string; bus: 'usb' | 'onboard'; usbSpeedMbps: number | null; modes: string[]; bands: string[];
  ap: boolean; sta: boolean; mesh: boolean; apSta: boolean; apMesh: boolean; fourAddr: boolean | null;
};
type HardwareResp = {
  supported: boolean; board?: string; kernel?: string; iwMissing?: boolean; eth?: EthPort[]; radios?: Radio[];
  tools?: Record<string, boolean>; modules?: Record<string, boolean>; roles?: RoleEval[];
  net?: { role?: 'main' | 'satellite' };
};

const EN = ({ children }: { children: ReactNode }) => <span lang="en">{children}</span>; // büyük harfte "i" → "İ" olmasın

const GROUPS: { id: RoleGroup; title: string }[] = [
  { id: 'routing', title: 'Yönlendirme' },
  { id: 'wireless', title: 'Kablosuz yayın' },
  { id: 'mesh', title: 'Mesh' },
];
const ROLE_META: Record<RoleId, { name: string; icon: ReactNode; desc: string }> = {
  'lan-router': { name: 'LAN router', icon: <Router size={18} />, desc: 'Mevcut modemin arkasında ev ağını yönetir: adres dağıtımı, DNS, reklam engelleme, yönlendirme.' },
  'wan-router': { name: 'WAN router', icon: <Globe size={18} />, desc: 'İnternetin ilk cihazı: operatör bağlantısını (DHCP / PPPoE / VLAN) Pi karşılar, çift NAT biter.' },
  ap: { name: 'Erişim noktası', icon: <Wifi size={18} />, desc: "Ev Wi-Fi'ını Pi yayınlar; kablosuz cihazlar doğrudan Klyrix ağına bağlanır." },
  repeater: { name: 'Repeater', icon: <Repeat2 size={18} />, desc: "Mevcut Wi-Fi'ı alıp yeniden yayınlar; kapsama alanını genişletir." },
  'mesh-wired': { name: 'Kablolu mesh uydusu', icon: <Cable size={18} />, desc: 'İkinci Klyrix cihazı kabloyla ağa bağlanır, aynı ağ adı ve şifreyle yayın yapar.' },
  'mesh-wireless': { name: 'Kablosuz mesh', icon: <Share2 size={18} />, desc: 'Uydular birbirine 802.11s ile kablosuz bağlanır; kablo çekmeden kapsama.' },
};
// Standart durum adları: özet şeridi ve kartlar aynı sözlüğü kullanır.
const STATUS: Record<RoleStatus, { label: string; variant: 'success' | 'info' | 'neutral' | 'warning' }> = {
  active: { label: 'Kullanımda', variant: 'success' },
  available: { label: 'Kullanıma hazır', variant: 'info' },
  'hw-ready': { label: 'Donanım uygun', variant: 'neutral' },
  'needs-hw': { label: 'Donanım eksik', variant: 'warning' },
  unknown: { label: 'Belirlenemedi', variant: 'neutral' },
};
const STATUS_ORDER: RoleStatus[] = ['active', 'available', 'hw-ready', 'needs-hw', 'unknown'];
// Yazılım bileşenleri: ne işe yaradığı ve hangi rolün gerektirdiği.
const COMPONENTS: { key: string; kind: 'tool' | 'module'; purpose: string; roles: string }[] = [
  { key: 'iw', kind: 'tool', purpose: 'Wi-Fi radyo yeteneklerini okuma', roles: 'Kablosuz roller' },
  { key: 'nmcli', kind: 'tool', purpose: 'Ağ profillerini yönetme (NetworkManager)', roles: 'Tümü' },
  { key: 'wpa_supplicant', kind: 'tool', purpose: 'Wi-Fi yayın, istemci ve mesh', roles: 'Erişim noktası, repeater, mesh' },
  { key: 'hostapd', kind: 'tool', purpose: 'Gelişmiş yayın özellikleri', roles: 'Erişim noktası (isteğe bağlı)' },
  { key: 'batctl', kind: 'tool', purpose: 'Mesh ağ yönetimi (batman-adv)', roles: 'Kablosuz mesh' },
  { key: 'pppd', kind: 'tool', purpose: 'PPPoE bağlantısı', roles: 'WAN router' },
  { key: 'mac80211', kind: 'module', purpose: 'Wi-Fi çekirdek katmanı', roles: 'Kablosuz roller' },
  { key: 'batman_adv', kind: 'module', purpose: 'Mesh yönlendirme', roles: 'Kablosuz mesh' },
  { key: '8021q', kind: 'module', purpose: 'VLAN', roles: 'WAN router' },
  { key: 'pppoe', kind: 'module', purpose: 'PPPoE', roles: 'WAN router' },
];

const busText = (bus: 'usb' | 'onboard', usb: number | null) =>
  bus === 'onboard' ? 'Dahili' : usb === null ? 'USB' : usb >= 5000 ? `USB 3 · ${usb / 1000} Gbps` : `USB 2 · ${usb} Mbps`;
const speedText = (mbps: number | null) => (mbps ? (mbps >= 1000 ? `${mbps / 1000} Gbps` : `${mbps} Mbps`) : '—');

function Mark({ ok, label }: { ok: boolean | null; label?: string }) {
  const aria = label || (ok === null ? 'bilinmiyor' : ok ? 'var' : 'yok');
  if (ok === null) return <CircleHelp size={14} className="rl-mark rl-mark-unk" aria-label={aria} />;
  return ok ? <Check size={14} className="rl-mark rl-mark-ok" aria-label={aria} /> : <X size={14} className="rl-mark rl-mark-no" aria-label={aria} />;
}

function RoleCard({ r }: { r: RoleEval }) {
  const meta = ROLE_META[r.id];
  const st = STATUS[r.status];
  return (
    <article className={`glass-panel rl-card rl-st-${r.status}`} aria-labelledby={`role-${r.id}`}>
      <header className="rl-card-head">
        <span className="rl-icon">{meta.icon}</span>
        <h3 id={`role-${r.id}`}>{meta.name}</h3>
        <Badge variant={st.variant}>{st.label}</Badge>
      </header>
      <p className="rl-desc">{meta.desc}</p>
      <table className="rl-checks">
        <caption className="rl-sr">Gereksinimler</caption>
        <tbody>
          {r.checks.map((c, i) => (
            <tr key={i}>
              <td className="rl-c-mark"><Mark ok={c.ok} /></td>
              <th scope="row">{c.label}</th>
              <td className="rl-c-val">{c.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Boş olsa da çizilir: kartın 5 subgrid satırı sabit kalır. */}
      <ul className="rl-notes">
        {r.notes.map((n, i) => (
          <li key={i} className={`rl-note rl-note-${n.kind}`}>
            {n.kind === 'warn' ? <TriangleAlert size={13} aria-label="uyarı" /> : <Info size={13} aria-label="bilgi" />}
            <span>{n.text}</span>
          </li>
        ))}
      </ul>
      <footer className="rl-foot">
        <div className="rl-need">
          {r.need.length === 0
            ? <span className="rl-muted">Ek donanım gerekmiyor</span>
            : r.need.map((n, i) => (
              <div key={i} className="rl-need-item">
                <span className="rl-need-name">{n.item}</span>
                {n.model && <span className="rl-need-model">Önerilen: <strong>{n.model}</strong>{n.chip ? ` · ${n.chip}` : ''}</span>}
              </div>
            ))}
        </div>
        <span className={`rl-phase${r.phase ? '' : ' is-now'}`}>{r.phase ? `Faz ${r.phase}` : r.status === 'active' ? 'Etkin' : 'Hazır'}</span>
      </footer>
    </article>
  );
}

export function RolesPanel() {
  const { data, error, loading, refetch } = useApi<HardwareResp | null>('/system/hardware', null);
  const roles = data?.roles || [];
  const counts = STATUS_ORDER.map(s => ({ s, n: roles.filter(r => r.status === s).length })).filter(x => x.n > 0);

  return (
    <div className="fade-in page-stack rl-page">
      <Panel title="Cihaz Rolleri" icon={<Layers size={20} style={{ marginRight: 8 }} />}
        subtitle="Klyrix Gate'in takılı donanıma göre üstlenebileceği ağ rolleri. WAN router, erişim noktası ve mesh (uydular) bu sayfadan yönetilir; diğer roller ilgili fazlarda eklenecek."
        actions={<button className="icon-btn" onClick={refetch} title="Yeniden tara" aria-label="Donanımı yeniden tara"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>}>
        {!data && <div className="rl-state">{error ? `Donanım bilgisi alınamadı (${error})` : 'Donanım taranıyor…'}</div>}
        {data && !data.supported && <div className="rl-state">Donanım taraması yalnız Pi üzerinde çalışır.</div>}
        {data?.supported && (
          <div className="rl-summary">
            <dl className="rl-ident">
              <div><dt>Cihaz</dt><dd>{data.board || '—'}</dd></div>
              <div><dt>Çekirdek</dt><dd className="rl-mono">{data.kernel || '—'}</dd></div>
              <div><dt>Arayüzler</dt><dd>{data.eth?.length ?? 0} Ethernet · {data.radios?.length ?? 0} <EN>Wi-Fi</EN> radyosu</dd></div>
            </dl>
            <ul className="rl-counts" aria-label="Rol durumları">
              {counts.map(({ s, n }) => (
                <li key={s} className={`rl-count rl-count-${s}`}><span className="rl-count-n">{n}</span>{STATUS[s].label}</li>
              ))}
            </ul>
          </div>
        )}
        {data?.iwMissing && (
          <div className="rl-banner"><TriangleAlert size={14} /> <span><EN>Wi-Fi</EN> radyolarının yetenekleri okunamadı: <code>iw</code> kurulu değil. Bir sonraki güncellemede kendiliğinden kurulur.</span></div>
        )}
      </Panel>

      {data?.supported && GROUPS.map(g => {
        const items = roles.filter(r => r.group === g.id);
        if (!items.length) return null;
        return (
          <section key={g.id} className="rl-group" aria-labelledby={`rl-g-${g.id}`}>
            <h2 id={`rl-g-${g.id}`} className="rl-group-title">{g.title}</h2>
            <div className="rl-grid">{items.map(r => <RoleCard key={r.id} r={r} />)}</div>
            {/* WAN router (R3): ikinci Ethernet kartı varsa (ya da rol açıksa) ana cihazda. */}
            {g.id === 'routing' && data.net?.role !== 'satellite' && items.some(r => r.id === 'wan-router' && (r.status === 'available' || r.status === 'active')) && (
              <WanPanel ports={data.eth || []} onChange={refetch} />
            )}
            {/* Yedek hat: Pi ağ geçidiyken (LAN router ya da WAN router) ana cihazda; ön koşulları panel kendisi söyler. */}
            {g.id === 'routing' && data.net?.role !== 'satellite' && (
              <FailoverPanel ports={data.eth || []} onChange={refetch} />
            )}
            {/* Uyduda ev Wi-Fi'ı ana cihazdan gelir (net-mode.sh sat); panel yalnız ana cihazda. */}
            {g.id === 'wireless' && data.net?.role !== 'satellite' && items.some(r => r.id === 'ap' && (r.status === 'available' || r.status === 'active')) && (
              <HomeWifiPanel onChange={refetch} />
            )}
            {g.id === 'mesh' && <MeshPanel onChange={refetch} />}
          </section>
        );
      })}

      {data?.supported && (
        <Panel title="Donanım" icon={<Cpu size={18} style={{ marginRight: 8 }} />} subtitle="Takılı arayüzler ve yetenekleri">
          <h4 className="rl-sub">Kablolu arayüzler</h4>
          {!data.eth?.length ? <p className="rl-muted">Ethernet portu bulunamadı.</p> : (
            <table className="rl-table">
              <thead><tr><th>Arayüz</th><th>Bağlantı</th><th>Sürücü</th><th className="rl-num">Hız</th><th>Kablo</th><th>Görev</th></tr></thead>
              <tbody>
                {data.eth.map(e => (
                  <tr key={e.name}>
                    <td data-label="Arayüz" className="rl-mono rl-strong">{e.name}</td>
                    <td data-label="Bağlantı">{busText(e.bus, e.usbSpeedMbps)}</td>
                    <td data-label="Sürücü" className="rl-mono">{e.driver || '—'}</td>
                    <td data-label="Hız" className="rl-num">{speedText(e.speedMbps)}</td>
                    <td data-label="Kablo">{e.carrier === true ? 'Takılı' : e.carrier === false ? 'Takılı değil' : '—'}</td>
                    <td data-label="Görev">{e.uplink ? <Badge variant="info">İnternet çıkışı</Badge> : <span className="rl-muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4 className="rl-sub"><EN>Wi-Fi</EN> radyoları</h4>
          {!data.radios?.length ? <p className="rl-muted"><EN>Wi-Fi</EN> radyosu bulunamadı.</p> : (
            <table className="rl-table rl-caps">
              <thead>
                <tr>
                  <th>Radyo</th><th>Bağlantı</th><th>Sürücü</th><th>Bantlar</th>
                  <th className="rl-c">AP</th><th className="rl-c">İstemci</th><th className="rl-c">Mesh</th>
                  <th className="rl-c">AP + istemci</th><th className="rl-c">AP + mesh</th><th className="rl-c">4 adres</th>
                </tr>
              </thead>
              <tbody>
                {data.radios.map(r => (
                  <tr key={r.phy}>
                    <td data-label="Radyo" className="rl-mono rl-strong"><span>{r.ifaces.join(', ') || r.phy}<span className="rl-muted"> · {r.phy}</span></span></td>
                    <td data-label="Bağlantı">{busText(r.bus, r.usbSpeedMbps)}</td>
                    <td data-label="Sürücü" className="rl-mono">{r.driver || '—'}</td>
                    <td data-label="Bantlar">{r.bands.length ? r.bands.map(b => `${b} GHz`).join(' · ') : '—'}</td>
                    <td data-label="AP" className="rl-c"><Mark ok={data.iwMissing ? null : r.ap} /></td>
                    <td data-label="İstemci" className="rl-c"><Mark ok={data.iwMissing ? null : r.sta} /></td>
                    <td data-label="Mesh" className="rl-c"><Mark ok={data.iwMissing ? null : r.mesh} /></td>
                    <td data-label="AP + istemci" className="rl-c"><Mark ok={data.iwMissing ? null : r.apSta} /></td>
                    <td data-label="AP + mesh" className="rl-c"><Mark ok={data.iwMissing ? null : r.apMesh} /></td>
                    <td data-label="4 adres" className="rl-c"><Mark ok={r.fourAddr} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4 className="rl-sub">Yazılım bileşenleri</h4>
          <table className="rl-table rl-sw">
            <thead><tr><th>Bileşen</th><th>Tür</th><th>Amaç</th><th>Gerektiren rol</th><th className="rl-c">Durum</th></tr></thead>
            <tbody>
              {COMPONENTS.map(c => {
                const have = c.kind === 'tool' ? data.tools?.[c.key] : data.modules?.[c.key];
                return (
                  <tr key={c.key}>
                    <td data-label="Bileşen" className="rl-mono rl-strong"><span><Package size={12} className="rl-pkg" aria-hidden="true" />{c.key}</span></td>
                    <td data-label="Tür">{c.kind === 'tool' ? 'Araç' : 'Çekirdek modülü'}</td>
                    <td data-label="Amaç">{c.purpose}</td>
                    <td data-label="Gerektiren rol">{c.roles}</td>
                    <td data-label="Durum" className="rl-c">
                      <span className={`rl-have${have ? ' is-on' : ''}`}><Mark ok={!!have} label={have ? 'kurulu' : 'yok'} />{have ? 'Kurulu' : 'Yok'}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="rl-foot-note">
            <Mark ok={true} /> var · <Mark ok={false} /> yok · <Mark ok={null} /> bilinmiyor. Eksik yazılım bileşenleri ilgili rolün fazında kurulur.
            Roller birleştirilebilir (ör. WAN router + erişim noktası + mesh yöneticisi).
          </p>
        </Panel>
      )}
    </div>
  );
}
