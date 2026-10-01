// Kiosk panoları (büyük pano: ölçülmüş hız testleri; anlık kullanım İnternet panosunda). Her pano kendi verisini ortak yoklamadan alır (data.ts usePoll: aynı uç tek istek). Aralıklar ucun
// maliyetine göre: ucuzlar 5-15 sn, pahalılar (Unbound 17 süreç, Fail2Ban istemcisi, donanım) dakikalarca.
import { useEffect, useState } from 'react';
import {
  Gauge, Cpu, ShieldCheck, Globe, Waypoints, MonitorSmartphone, Shield, ArrowDown, ArrowUp,
  ShieldBan, Zap, ShieldAlert, Flame, Server, Home,
} from 'lucide-react';
import { AreaChart, Ring } from './charts';
import {
  usePoll, useNow, bitRateText, num, ago, duration, parseTime,
  type TopologyLive, type TopoExit, type SystemStats, type ServiceRow, type AlertRow,
} from './data';
import { sourceLabel, severityMeta } from '../alerts';
import { TOPO, SERVICES, ALERTS, UNREAD, HEALTH, WG, HW } from './status';

function Tile({ icon, title, aside, className = '', children }: {
  icon: React.ReactNode; title: string; aside?: React.ReactNode; className?: string; children: React.ReactNode;
}) {
  return (
    <section className={`k-tile ${className}`}>
      <div className="k-tile-head">
        <span className="k-tile-title">{icon}{title}</span>
        {aside != null && <span className="k-tile-aside">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

// ── İnternet hızı: ölçülmüş hız testleri (son test + son 7 günün grafiği + özet). Anlık kullanım İnternet panosunda. ──
interface Speed { download_mbps: number; upload_mbps: number; ping_ms: number; jitter_ms: number | null; packet_loss?: number | null; isp?: string; server?: string; timestamp: string }
export function SpeedTile() {
  const week = usePoll<{ tests: Speed[] }>('/speedtest/history?period=7d', 60000);
  // Son 7 günde 2'den az test varsa (ör. aralık uzun) grafik için 30 güne bakılır
  const month = usePoll<{ tests: Speed[] }>(week && (week.tests || []).length < 2 ? '/speedtest/history?period=30d' : null, 300000);
  const settings = usePoll<{ settings?: Record<string, string> }>('/settings', 60000);
  const useMonth = !!week && (week.tests || []).length < 2 && (month?.tests || []).length >= 2;
  const tests = ((useMonth ? month?.tests : week?.tests) || []).slice().reverse(); // eskiden yeniye
  const last = tests.at(-1);
  const everyMin = Number(settings?.settings?.speedtest_interval_min ?? 360);
  const auto = !Number.isFinite(everyMin) || everyMin <= 0 ? 'otomatik test kapalı'
    : everyMin % 60 === 0 ? `otomatik: ${everyMin / 60} saatte bir` : `otomatik: ${everyMin} dk'da bir`;
  const downs = tests.map(t => t.download_mbps);
  const ups = tests.map(t => t.upload_mbps);
  const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  const pings = tests.map(t => t.ping_ms).filter(v => Number.isFinite(v));
  const span = useMonth ? 'son 30 gün' : 'son 7 gün';
  return (
    <Tile icon={<Gauge />} title="İnternet hızı" className="k-traffic"
      aside={<span className="k-legend">
        <span><i style={{ background: 'var(--k-down)' }} />İndirme</span><span><i style={{ background: 'var(--k-up)' }} />Yükleme</span>
      </span>}>
      {!week ? <div className="k-empty">Hız testleri okunuyor…</div> : !last ? (
        <div className="k-empty">
          Henüz hız testi yok. {everyMin > 0 ? `İlk otomatik ölçüm ${auto.replace('otomatik: ', '')} yapılır` : 'Otomatik test kapalı'};
          panelde <strong>Hız Testi</strong> sayfasından hemen başlatılabilir.
        </div>
      ) : (
        <>
          <div className="k-traffic-now">
            <div><span className="k-label"><ArrowDown size={12} /> İndirme</span><span className="k-big k-down">{num(last.download_mbps, 1)}<span className="k-unit">Mbps</span></span></div>
            <div><span className="k-label"><ArrowUp size={12} /> Yükleme</span><span className="k-big k-up">{num(last.upload_mbps, 1)}<span className="k-unit">Mbps</span></span></div>
            <div><span className="k-label">Gecikme</span><span className="k-mid">{num(last.ping_ms)}<span className="k-unit">ms</span></span></div>
            {last.jitter_ms != null && last.jitter_ms > 0 && (
              <div className="k-hide-sm"><span className="k-label">Dalgalanma</span><span className="k-mid">{num(last.jitter_ms, 1)}<span className="k-unit">ms</span></span></div>
            )}
          </div>
          <div className="k-speed-meta">
            son ölçüm {ago(parseTime(last.timestamp))}{last.isp ? ` · ${last.isp}` : ''}{last.server ? <span className="k-hide-sm"> · {last.server}</span> : null}
          </div>
          <div className="k-traffic-chart">
            {tests.length >= 2
              ? <AreaChart series={[{ values: downs, color: 'var(--k-down)' }, { values: ups, color: 'var(--k-up)' }]} />
              : <div className="k-empty">Grafik için en az iki ölçüm gerekiyor</div>}
          </div>
          <div className="k-ifaces k-hide-xs">
            <div className="k-iface"><div className="k-iface-name">Ortalama ({span})</div>
              <div className="k-iface-rate"><span className="k-down">↓ {num(avg(downs), 1)}</span><span className="k-up">↑ {num(avg(ups), 1)}</span><span className="k-muted">Mbps</span></div></div>
            <div className="k-iface"><div className="k-iface-name">En düşük / en yüksek indirme</div>
              <div className="k-iface-rate"><span>{num(Math.min(...downs), 1)} / {num(Math.max(...downs), 1)}</span><span className="k-muted">Mbps</span></div></div>
            <div className="k-iface"><div className="k-iface-name">Ortalama gecikme</div>
              <div className="k-iface-rate"><span>{num(avg(pings))}</span><span className="k-muted">ms</span></div></div>
            <div className="k-iface"><div className="k-iface-name">{tests.length} ölçüm</div>
              <div className="k-iface-rate"><span className="k-muted">{auto}</span></div></div>
          </div>
        </>
      )}
    </Tile>
  );
}

const exitDot = (e: TopoExit) => (!e.up ? 'k-dot-bad' : e.handshakeAgeS != null && e.handshakeAgeS > 180 ? 'k-dot-warn' : 'k-dot-ok');

// ── Sistem: işlemci, sıcaklık, bellek, disk ──
export function SystemTile() {
  const st = usePoll<SystemStats>('/system/stats', 5000);
  const tempPct = st ? ((st.cpuTemp - 30) / (85 - 30)) * 100 : null;
  const memPct = st && st.memoryTotal ? (st.memoryUsed / st.memoryTotal) * 100 : null;
  const diskPct = st && st.diskTotal ? (st.diskUsed / st.diskTotal) * 100 : null;
  const tone = (v: number | null, warn: number, bad: number, base: string) =>
    v == null ? base : v >= bad ? 'var(--danger-color)' : v >= warn ? 'var(--warning-color)' : base;
  const gauges = [
    { label: 'İşlemci', val: st ? `%${num(st.cpuUsage)}` : '—', pct: st?.cpuUsage ?? null, color: tone(st?.cpuUsage ?? null, 70, 90, '#3b82f6'),
      sub: st?.loadAvg?.length ? `yük ${st.loadAvg[0].toFixed(2)}` : '' },
    { label: 'Sıcaklık', val: st ? `${num(st.cpuTemp)}°` : '—', pct: tempPct, color: tone(st?.cpuTemp ?? null, 70, 80, 'var(--orange-color)'),
      sub: st?.fanSpeed ? `fan ${num(st.fanSpeed)} rpm` : 'pasif soğutma' },
    { label: 'Bellek', val: memPct == null ? '—' : `%${num(memPct)}`, pct: memPct, color: tone(memPct, 80, 92, 'var(--purple-color)'),
      sub: st ? `${num(st.memoryUsed / 1024, 1)} / ${num(st.memoryTotal / 1024, 1)} GB` : '' },
    { label: 'Disk', val: diskPct == null ? '—' : `%${num(diskPct)}`, pct: diskPct, color: tone(diskPct, 80, 92, 'var(--cyan-color)'),
      sub: st ? `${num(st.diskUsed)} / ${num(st.diskTotal)} GB` : '' },
  ];
  return (
    <Tile icon={<Cpu />} title="Sistem" aside={st ? <>açık: <b>{duration(st.uptime)}</b></> : null}>
      <div className="k-rings">
        {gauges.map(g => (
          <div key={g.label} className="k-gauge">
            <Ring value={g.pct} color={g.color}>
              <span className="k-gauge-val">{g.val}</span>
            </Ring>
            <span className="k-label">{g.label}</span>
            <span className="k-gauge-sub k-hide-sm">{g.sub}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}

// ── DNS kalkanı: Pi-hole engelleme + Unbound özyinelemeli çözücü ──
interface Pihole { dnsQueriesToday: number; adsBlockedToday: number; adsPercentageToday: number; uniqueClients: number; domainsBlocked: number; topBlockedDomains?: { domain: string; count: number }[]; _status?: string }
interface Unbound { installed?: boolean; running?: boolean; stats?: { hitRate: number | null; recursionAvgMs: number | null; secure: number | null } | null; security?: { label: string; status: boolean }[] }
export function DnsTile() {
  const ph = usePoll<Pihole>('/pihole/stats', 30000);
  const ub = usePoll<Unbound>('/unbound/status', 180000); // pahalı: 17 checkconf süreci
  const pct = ph && !ph._status ? ph.adsPercentageToday : null;
  const dnssec = ub?.security?.[0]?.status;
  const top = ph?.topBlockedDomains?.[0];
  return (
    <Tile icon={<ShieldCheck />} title="DNS kalkanı" aside={ph && !ph._status ? `${num(ph.domainsBlocked)} alan adı listede` : null}>
      <div className="k-dns">
        <Ring value={pct} color="var(--danger-color)" stroke={10}>
          <span className="k-mid">{pct == null ? '—' : `%${num(pct, 1)}`}</span>
          <span className="k-label">engellendi</span>
        </Ring>
        <div className="k-dns-stats">
          <div className="k-stat"><span className="k-label">Sorgu (bugün)</span><span className="k-mid">{num(ph?.dnsQueriesToday)}</span></div>
          <div className="k-stat"><span className="k-label">Engellenen</span><span className="k-mid k-bad">{num(ph?.adsBlockedToday)}</span></div>
          <div className="k-stat k-hide-sm"><span className="k-label">Önbellek isabeti</span><span className="k-mid">{ub?.stats?.hitRate == null ? '—' : `%${num(ub.stats.hitRate, 1)}`}</span></div>
          <div className="k-stat k-hide-sm"><span className="k-label">Ort. çözümleme</span><span className="k-mid">{ub?.stats?.recursionAvgMs == null ? '—' : <>{num(ub.stats.recursionAvgMs)}<span className="k-unit">ms</span></>}</span></div>
        </div>
      </div>
      <div className="k-foot">
        <span className={`k-chip ${dnssec ? 'k-chip-ok' : dnssec === false ? 'k-chip-warn' : ''}`}>
          DNSSEC {dnssec ? 'açık' : dnssec === false ? 'kapalı' : '—'}
        </span>
        <span>istemci <b>{num(ph?.uniqueClients)}</b></span>
        {top && <span className="k-hide-sm">en çok engellenen <b>{top.domain}</b></span>}
      </div>
    </Tile>
  );
}

// ── İnternet: dış IP, hat (ana / yedek), DDNS, anlık kullanım ──
interface Hardware { board?: string; net?: { uplinkIface?: string; bakActive?: boolean; bakDev?: string; bakStage?: string } }
interface WgServer { enabled?: boolean; running?: boolean; endpoint?: { host: string; source: string }; peers?: { id: number; name: string; handshake: number }[] }
export function InternetTile() {
  const ip = usePoll<{ ip: string }>('/ddns/current-ip', 600000); // her çağrı internete sorar: 10 dk
  const hw = usePoll<Hardware>(HW, 120000); // ~1 sn süren birkaç süreç: 2 dk
  const wg = usePoll<WgServer>(WG, 15000);
  const topo = usePoll<TopologyLive>(TOPO, 5000);
  const health = usePoll<{ uptimePercent?: number }>(HEALTH, 10000);
  const acct = !!topo && topo.accounting !== false;
  const rate = (k: 'downBps' | 'upBps') => (topo?.exits || []).reduce((a, e) => a + (e[k] || 0) * 8, 0);
  const backup = !!hw?.net?.bakActive;
  const ddns = wg?.endpoint?.source === 'ddns' ? wg.endpoint.host : '';
  return (
    <Tile icon={<Globe />} title="İnternet">
      <div className="k-stat">
        <span className="k-label">Dış IP</span>
        <span className="k-mid k-mono">{ip?.ip || '—'}</span>
      </div>
      <div className="k-svcs">
        {hw?.net && (backup
          ? <span className="k-chip k-chip-warn">Yedek hat · {hw.net.bakDev || '—'}</span>
          : <span className="k-chip k-chip-ok">Ana hat{hw.net.uplinkIface ? ` · ${hw.net.uplinkIface}` : ''}</span>)}
        {hw?.net?.bakStage === 'on' && !backup && <span className="k-chip">yedek hat hazır</span>}
      </div>
      <dl className="k-kv k-hide-sm">
        {ddns && <><dt>DDNS</dt><dd className="k-mono">{ddns}</dd></>}
        <dt>DNS denetimi</dt><dd>%{num(health?.uptimePercent, 1)} başarılı</dd>
      </dl>
      <div className="k-stat" style={{ marginTop: 'auto' }}>
        <span className="k-label">Anlık kullanım (tüm ev)</span>
        {acct ? (
          <span className="k-iface-rate" style={{ fontSize: '0.95rem' }}>
            <span className="k-down">↓ {bitRateText(rate('downBps'))}</span>
            <span className="k-up">↑ {bitRateText(rate('upBps'))}</span>
          </span>
        ) : <span className="k-muted">—</span>}
      </div>
    </Tile>
  );
}

// ── Tüneller: VPS bağlantıları + Ev VPN'i istemcileri ──
interface Vps { id: number; ip: string; location: string; status: string }
export function TunnelsTile() {
  const vps = usePoll<{ servers: Vps[] }>('/vps/list', 30000);
  const topo = usePoll<TopologyLive>(TOPO, 5000);
  const wg = usePoll<WgServer>(WG, 15000);
  const exits = new Map((topo?.exits || []).filter(e => e.kind === 'vps').map(e => [e.vpsId, e]));
  const servers = vps?.servers || [];
  const peers = wg?.peers || [];
  const now = useNow(15000) / 1000;
  const online = peers.filter(p => p.handshake && now - p.handshake < 180);
  return (
    <Tile icon={<Waypoints />} title="Tüneller">
      <div className="k-list">
        {servers.length === 0 && <span className="k-muted" style={{ fontSize: '0.85rem' }}>VPS tüneli yok</span>}
        {servers.slice(0, 4).map(s => {
          const e = exits.get(s.id);
          const dot = e ? exitDot(e) : s.status === 'connected' ? 'k-dot-ok' : '';
          return (
            <div key={s.id} className="k-row">
              <span className={`k-dot ${dot}`} />
              <span className="k-row-main">{s.location || 'VPS'} <span className="k-muted k-mono">{s.ip}</span></span>
              <span className="k-row-meta">
                {e?.up ? `↓ ${bitRateText((e.downBps || 0) * 8)}${e.devices ? ` · ${e.devices} cihaz` : ''}` : 'bağlı değil'}
              </span>
            </div>
          );
        })}
      </div>
      <div className="k-stat" style={{ marginTop: 'auto' }}>
        <span className="k-label">Ev VPN'i</span>
        {wg?.enabled
          ? <span className="k-mid">{online.length}<span className="k-unit">/ {peers.length} bağlı</span></span>
          : <span className="k-muted" style={{ fontSize: '0.85rem' }}>kapalı</span>}
      </div>
      {wg?.enabled && peers.length > 0 && (
        <div className="k-list k-hide-sm">
          {peers.slice().sort((a, b) => b.handshake - a.handshake).slice(0, 4).map(p => {
            const live = !!p.handshake && now - p.handshake < 180;
            return (
              <div key={p.id} className="k-row">
                <span className={`k-dot ${live ? 'k-dot-ok' : ''}`} />
                <span className="k-row-main">{p.name}</span>
                <span className="k-row-meta">{live ? 'bağlı' : p.handshake ? ago(new Date(p.handshake * 1000)) : 'hiç bağlanmadı'}</span>
              </div>
            );
          })}
        </div>
      )}
    </Tile>
  );
}

// ── Cihazlar: çevrimiçi sayısı ve en çok trafik yapanlar ──
export function DevicesTile() {
  const topo = usePoll<TopologyLive>(TOPO, 5000);
  const all = topo?.devices || [];
  const on = all.filter(d => d.online);
  const blocked = all.filter(d => d.blocked).length;
  const busy = on.slice().sort((a, b) => (b.downBps + b.upBps) - (a.downBps + a.upBps)).slice(0, 5);
  return (
    <Tile icon={<MonitorSmartphone />} title="Cihazlar" aside={blocked ? <span className="k-bad">{blocked} engelli</span> : null}>
      <div className="k-stat">
        <span className="k-big">{topo ? on.length : '—'}<span className="k-unit">/ {all.length} çevrimiçi</span></span>
      </div>
      <div className="k-list k-hide-sm" style={{ marginTop: 'auto' }}>
        {busy.map(d => {
          const rate = (d.downBps + d.upBps) * 8;
          return (
            <div key={d.mac} className="k-row">
              <span className={`k-dot ${d.blocked ? 'k-dot-bad' : 'k-dot-ok'}`} />
              <span className="k-row-main">{d.hostname || d.ip || d.mac}</span>
              <span className="k-row-meta">{rate > 0 ? `↓ ${bitRateText(d.downBps * 8)}` : d.ip}</span>
            </div>
          );
        })}
      </div>
    </Tile>
  );
}

// ── Güvenlik uygulamaları: her biri durumu ve kısa ayrıntısıyla (panelin menüsündeki simgelerle) ──
interface F2b { jails?: { name: string; currentlyBanned: number; totalBanned: number }[] }
interface Zapret { installed?: boolean; service?: boolean; nfqws?: boolean; processes?: number; dpiRules?: number }
type AppTone = 'ok' | 'warn' | 'bad' | 'off';
const APP_STATUS: Record<ServiceRow['status'] | 'off', [string, AppTone]> = {
  running: ['Çalışıyor', 'ok'], error: ['Hatalı', 'bad'], restarting: ['Geçişte', 'warn'], stopped: ['Durmuş', 'warn'],
  not_installed: ['Kurulu değil', 'off'], off: ['Kapalı', 'off'],
};
export function SecurityTile() {
  const svc = usePoll<{ services: ServiceRow[] }>(SERVICES, 15000);
  const unread = usePoll<{ count: number }>(UNREAD, 15000);
  const f2b = usePoll<F2b>('/fail2ban/status', 60000); // fail2ban-client her hapishane için ayrı çalışır
  const zp = usePoll<Zapret>('/zapret/status', 30000);
  const ph = usePoll<Pihole>('/pihole/stats', 30000);
  const ub = usePoll<Unbound>('/unbound/status', 180000);
  const vps = usePoll<{ servers: { id: number }[] }>('/vps/list', 30000);
  const topo = usePoll<TopologyLive>(TOPO, 5000);
  const wg = usePoll<WgServer>(WG, 15000);
  const now = useNow(15000) / 1000;
  const find = (name: string) => (svc?.services || []).find(s => s.name === name);
  // Durmuş ama açılışta başlamayan servis bilerek kapatılmıştır: "Kapalı"
  const state = (s?: ServiceRow): ServiceRow['status'] | 'off' | null =>
    !s ? null : s.status === 'stopped' && !s.boot_enabled ? 'off' : s.status;
  const banned = (f2b?.jails || []).reduce((a, j) => a + (j.currentlyBanned || 0), 0);
  const vpsUp = (topo?.exits || []).filter(e => e.kind === 'vps' && e.up).length;
  const peers = wg?.peers || [];
  const peersOn = peers.filter(p => p.handshake && now - p.handshake < 180).length;
  const apps: { key: string; icon: React.ReactNode; name: string; role: string; st: ServiceRow['status'] | 'off' | null; detail: string }[] = [
    { key: 'pihole', icon: <ShieldBan />, name: 'Pi-hole', role: 'reklam ve izleyici engelleme', st: state(find('pihole')),
      detail: ph && !ph._status ? `%${num(ph.adsPercentageToday, 1)} engellendi` : '' },
    { key: 'unbound', icon: <Globe />, name: 'Unbound', role: 'özel DNS çözücü', st: state(find('unbound')),
      detail: ub?.stats?.hitRate != null ? `%${num(ub.stats.hitRate)} önbellek isabeti` : '' },
    { key: 'zapret', icon: <Zap />, name: 'Zapret', role: 'DPI atlatma', st: state(find('zapret')),
      detail: zp?.installed && zp.dpiRules ? `${num(zp.dpiRules)} DPI kuralı` : '' },
    { key: 'fail2ban', icon: <ShieldAlert />, name: 'Fail2Ban', role: 'saldırı engelleme', st: state(find('fail2ban')),
      detail: f2b ? (banned ? `${num(banned)} yasaklı IP` : 'yasaklı IP yok') : '' },
    { key: 'nftables', icon: <Flame />, name: 'Güvenlik duvarı', role: 'nftables', st: state(find('nftables')), detail: '' },
    { key: 'wireguard', icon: <Server />, name: 'VPS tünelleri', role: 'WireGuard', st: state(find('wireguard')),
      detail: vps?.servers?.length ? `${vpsUp}/${vps.servers.length} bağlı` : 'tünel yok' },
    { key: 'homevpn', icon: <Home />, name: "Ev VPN'i", role: 'uzaktan erişim', st: !wg ? null : !wg.enabled ? 'off' : wg.running ? 'running' : 'error',
      detail: wg?.enabled ? `${peersOn}/${peers.length} istemci bağlı` : '' },
  ];
  const shown = apps.filter(a => a.st !== 'not_installed' || a.key === 'pihole');
  return (
    <Tile icon={<Shield />} title="Güvenlik"
      aside={unread ? (unread.count ? <span className="k-warn">{unread.count} okunmamış uyarı</span> : <span className="k-ok">uyarı yok</span>) : null}>
      <div className="k-apps">
        {shown.map(a => {
          const [label, tone] = a.st ? APP_STATUS[a.st] : ['—', 'off' as AppTone];
          return (
            <div key={a.key} className={`k-app-row k-app-${tone}`}>
              <span className="k-app-icon">{a.icon}</span>
              <span className="k-app-name">{a.name}<span className="k-app-role k-hide-sm"> · {a.role}</span></span>
              {a.detail && <span className="k-app-detail k-hide-xs">{a.detail}</span>}
              <span className="k-app-status">{label}</span>
            </div>
          );
        })}
      </div>
    </Tile>
  );
}

// ── Alt şerit: son olaylar, 7 sn'de bir sıradaki (okunmamış uyarılar önce) ──
export function AlertTicker() {
  const d = usePoll<{ alerts: AlertRow[] }>(ALERTS, 15000);
  const list = (d?.alerts || []).slice().sort((a, b) => rank(b) - rank(a) || b.id - a.id).slice(0, 6);
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI(n => n + 1), 7000);
    return () => clearInterval(t);
  }, []);
  if (!list.length) {
    return <div className="k-ticker"><span className="k-chip k-chip-ok">Olay yok</span><span className="k-ticker-msg k-muted">Son bildirim bulunmuyor</span></div>;
  }
  const a = list[i % list.length];
  const sev = severityMeta(a.severity);
  const tone = a.severity === 'critical' ? 'k-chip-bad' : a.severity === 'warning' ? 'k-chip-warn' : '';
  return (
    <div className="k-ticker">
      <span className={`k-chip ${tone}`}><sev.Icon size={12} /> {sourceLabel(a.source)}</span>
      <span key={a.id} className="k-ticker-msg">{a.message}</span>
      <span className="k-ticker-time">{ago(parseTime(a.created_at))} · {(i % list.length) + 1}/{list.length}</span>
    </div>
  );
}
const rank = (a: AlertRow) => (!a.acknowledged ? (a.severity === 'critical' ? 2 : a.severity === 'warning' ? 1 : 0) : 0);
