// Kiosk panoları. Her pano kendi verisini ortak yoklamadan alır (data.ts usePoll: aynı uç tek istek). Aralıklar ucun
// maliyetine göre: ucuzlar 5-15 sn, pahalılar (Unbound 17 süreç, Fail2Ban istemcisi, donanım) dakikalarca.
import { useEffect, useState } from 'react';
import {
  Activity, Cpu, ShieldCheck, Globe, Waypoints, MonitorSmartphone, Shield, ArrowDown, ArrowUp,
} from 'lucide-react';
import { AreaChart, Ring } from './charts';
import {
  usePoll, feedHistory, useNow, bitRate, bitRateText, num, ago, duration, parseTime,
  type TopologyLive, type TopoExit, type SystemStats, type MetricPoint, type ServiceRow, type AlertRow,
} from './data';
import { sourceLabel, severityMeta } from '../alerts';
import { TOPO, SERVICES, ALERTS, UNREAD, HEALTH, WG, HW, SERVICE_LABEL } from './status';

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

// ── Ağ trafiği: internete giden/gelen trafik (çıkış bazında: ISS, DPI, VPS tünelleri) ──
export function TrafficTile() {
  const topo = usePoll<TopologyLive>(TOPO, 5000);
  const acct = topo?.accounting !== false;
  // Sayaç (nft accounting) yoksa yedek: tüm arayüzlerin toplamı (yaklaşık, çift sayabilir)
  const mh = usePoll<{ history: MetricPoint[] }>(acct ? null : '/system/metrics/history?minutes=10', 10000);
  let down: number[];
  let up: number[];
  if (acct) {
    const hist = feedHistory<TopologyLive>(TOPO).filter(t => t.accounting !== false);
    const sum = (t: TopologyLive, k: 'downBps' | 'upBps') => (t.exits || []).reduce((a, e) => a + (e[k] || 0) * 8, 0);
    down = hist.map(t => sum(t, 'downBps'));
    up = hist.map(t => sum(t, 'upBps'));
  } else {
    const h = mh?.history || [];
    down = h.map(p => p.networkIn * 1e6);
    up = h.map(p => p.networkOut * 1e6);
  }
  const [dNow, dUnit] = bitRate(down.at(-1) ?? 0);
  const [uNow, uUnit] = bitRate(up.at(-1) ?? 0);
  const peak = Math.max(0, ...down, ...up);
  const minutes = Math.max(1, Math.round((down.length * 5) / 60));
  const exits = (topo?.exits || []).slice().sort((a, b) => order(a) - order(b));
  return (
    <Tile icon={<Activity />} title="Ağ trafiği" className="k-traffic"
      aside={<span className="k-legend"><span><i style={{ background: 'var(--k-down)' }} />İndirme</span><span><i style={{ background: 'var(--k-up)' }} />Yükleme</span></span>}>
      <div className="k-traffic-now">
        <div><span className="k-label"><ArrowDown size={12} /> İndirme</span><span className="k-big k-down">{dNow}<span className="k-unit">{dUnit}</span></span></div>
        <div><span className="k-label"><ArrowUp size={12} /> Yükleme</span><span className="k-big k-up">{uNow}<span className="k-unit">{uUnit}</span></span></div>
        <div className="k-hide-sm"><span className="k-label">Tepe (son {minutes} dk)</span><span className="k-mid">{bitRateText(peak)}</span></div>
        {!acct && <span className="k-chip k-chip-warn">yaklaşık: tüm arayüzler</span>}
      </div>
      <div className="k-traffic-chart">
        {down.length >= 2
          ? <AreaChart series={[{ values: down, color: 'var(--k-down)' }, { values: up, color: 'var(--k-up)' }]} />
          : <div className="k-empty">Grafik birkaç saniye içinde oluşacak…</div>}
      </div>
      {exits.length > 0 && (
        <div className="k-ifaces k-hide-xs">
          {exits.slice(0, 4).map(e => (
            <div key={e.id} className="k-iface">
              <div className="k-iface-name">
                {e.kind === 'vps' && <span className={`k-dot ${exitDot(e)}`} style={{ display: 'inline-block', marginRight: 6 }} />}
                {e.label}{e.devices ? ` · ${e.devices} cihaz` : ''}
              </div>
              <div className="k-iface-rate">
                <span className="k-down">↓ {bitRateText((e.downBps || 0) * 8)}</span>
                <span className="k-up">↑ {bitRateText((e.upBps || 0) * 8)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Tile>
  );
}
const order = (e: TopoExit) => (e.kind === 'local' ? 0 : e.kind === 'dpi' ? 1 : 2);
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

// ── İnternet: dış IP, hat (ana / yedek), DDNS, son hız testi ──
interface Hardware { board?: string; net?: { uplinkIface?: string; bakActive?: boolean; bakDev?: string; bakStage?: string } }
interface WgServer { enabled?: boolean; running?: boolean; endpoint?: { host: string; source: string }; peers?: { id: number; name: string; handshake: number }[] }
interface Speed { download_mbps: number; upload_mbps: number; ping_ms: number; timestamp: string }
export function InternetTile() {
  const ip = usePoll<{ ip: string }>('/ddns/current-ip', 600000); // her çağrı internete sorar: 10 dk
  const hw = usePoll<Hardware>(HW, 120000); // ~1 sn süren birkaç süreç: 2 dk
  const wg = usePoll<WgServer>(WG, 15000);
  const sp = usePoll<{ tests: Speed[] }>('/speedtest/history?period=30d', 60000);
  const health = usePoll<{ uptimePercent?: number }>(HEALTH, 10000);
  const t = sp?.tests?.[0];
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
        <span className="k-label">Son hız testi{t ? ` · ${ago(parseTime(t.timestamp))}` : ''}</span>
        {t ? (
          <span className="k-iface-rate" style={{ fontSize: '0.95rem' }}>
            <span className="k-down">↓ {num(t.download_mbps, 1)}</span>
            <span className="k-up">↑ {num(t.upload_mbps, 1)}</span>
            <span className="k-muted">Mbps · {num(t.ping_ms)} ms</span>
          </span>
        ) : <span className="k-muted">henüz yok</span>}
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

// ── Güvenlik ve servisler ──
interface F2b { jails?: { name: string; currentlyBanned: number; totalBanned: number }[] }
interface Zapret { installed?: boolean; service?: boolean; nfqws?: boolean; processes?: number; userEntries?: number }
export function SecurityTile() {
  const f2b = usePoll<F2b>('/fail2ban/status', 60000); // fail2ban-client her hapishane için ayrı çalışır
  const svc = usePoll<{ services: ServiceRow[] }>(SERVICES, 15000);
  const unread = usePoll<{ count: number }>(UNREAD, 15000);
  const zp = usePoll<Zapret>('/zapret/status', 30000);
  const jails = f2b?.jails || [];
  const banned = jails.reduce((a, j) => a + (j.currentlyBanned || 0), 0);
  const total = jails.reduce((a, j) => a + (j.totalBanned || 0), 0);
  const dpi = !!(zp?.service && zp.nfqws && (zp.processes || 0) > 0);
  const services = (svc?.services || []).filter(s => s.status !== 'not_installed');
  const cls = (s: ServiceRow) => (s.status === 'running' ? 'k-chip-ok' : s.status === 'error' ? 'k-chip-bad'
    : s.status === 'stopped' && !s.boot_enabled ? '' : 'k-chip-warn');
  return (
    <Tile icon={<Shield />} title="Güvenlik">
      <div className="k-dns-stats">
        <div className="k-stat">
          <span className="k-label">Yasaklı IP</span>
          <span className={`k-mid ${banned ? 'k-bad' : ''}`}>{f2b ? num(banned) : '—'}</span>
          <span className="k-row-meta">toplam {num(total)}</span>
        </div>
        <div className="k-stat">
          <span className="k-label">Uyarı</span>
          <span className={`k-mid ${unread?.count ? 'k-warn' : 'k-ok'}`}>{unread ? num(unread.count) : '—'}</span>
          <span className="k-row-meta">{unread?.count ? 'okunmamış' : 'temiz'}</span>
        </div>
      </div>
      {zp?.installed && (
        <div className="k-row k-hide-sm" style={{ fontSize: '0.8rem' }}>
          <span className={`k-dot ${dpi ? 'k-dot-ok' : ''}`} />
          <span className="k-row-main">DPI atlatma {dpi ? 'açık' : 'kapalı'}</span>
          {dpi && <span className="k-row-meta">{num(zp.userEntries)} alan adı</span>}
        </div>
      )}
      <div className="k-svcs" style={{ marginTop: 'auto' }}>
        {services.map(s => (
          <span key={s.name} className={`k-chip ${cls(s)}`}>{SERVICE_LABEL[s.name] || s.name}</span>
        ))}
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
