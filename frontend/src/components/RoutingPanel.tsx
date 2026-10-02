import {
  Route, Globe, Tv, Gamepad2, MessageCircle, Apple,
  Plus, Trash2, Check, X, Search, Link, Shield, Info,
  Lightbulb, ChevronDown, ChevronRight, RotateCcw, Loader2, AlertTriangle
} from 'lucide-react';
import { useApi, getApi, putApi, postApi, deleteApi } from '../hooks/useApi';
import { useState, useRef, useCallback, useEffect } from 'react';
import { Panel, Badge, Select } from './ui';
import { AppLogo } from './AppLogos';
import { CAT_ICON } from './contentCategories';
import { toast } from '../toast';
import type { TrafficRule } from '../types';
import './RoutingPanel.css';

type RoutingTab = 'apps' | 'domains';

const categoryMeta: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  voip: { label: 'VoIP & Mesajlaşma', icon: <MessageCircle size={16} />, color: 'badge-success' },
  streaming: { label: 'Streaming & Medya', icon: <Tv size={16} />, color: 'badge-info' },
  social: { label: 'Sosyal Medya', icon: <Globe size={16} />, color: 'badge-warning' },
  gaming: { label: 'Oyun', icon: <Gamepad2 size={16} />, color: 'badge-error' },
  web: { label: 'Web & Geliştirme', icon: <Globe size={16} />, color: 'badge-neutral' },
  apple: { label: 'Apple Servisleri', icon: <Apple size={16} />, color: 'badge-neutral' },
  restricted: { label: 'Yetişkin & Kumar', icon: <CAT_ICON.adult size={16} />, color: 'badge-error' },
};

// Hazır listeli satır (backend categoryLists.ts): domains = "@list:adult" — siteler tek tek yazılmaz. VPS çıkışında liste
// adları Pi-hole'dan panelin çözücüsüne gider (listDns.ts), yalnız DPI'da liste Zapret'e eklenir.
type ListId = 'adult' | 'gambling';
interface ListInfo { id: ListId; label: string; source: string; count: number; collapsed: number; updatedAt: string | null; error: string | null }
interface ListDnsStats { queries: number; added: number; failed: number; listening: boolean; lastError: string }
const LIST_ENTRY = /^@list:(adult|gambling)$/;
const ruleList = (r: TrafficRule): ListId | null => {
  const m = LIST_ENTRY.exec(String(r.domains || '').trim());
  return m ? (m[1] as ListId) : null;
};
const fmtN = (n: number) => n.toLocaleString('tr-TR');

interface VpsServer { id: number; ip: string; location: string }

// Zapret'in kısa durumu (GET /routing/rules ve /routing/domains yanıtında). DPI'ı açık kural Zapret çalışmıyorsa hiçbir
// trafiğe dokunmaz — kartta nedeniyle söylenir: çıkışı ISP olan kuralda hemen, VPS + "operatörden devam" kuralında tünel
// düşünce (tünel çalışırken DPI kullanılmaz: trafik wg'den şifreli çıkar). VPS + "engelle"de DPI hiç kullanılmaz.
interface ZapretBrief { installed: boolean; issue: string | null; active: boolean }
const dpiInactiveReason = (z: ZapretBrief | undefined): string | null => {
  if (!z || z.active) return null;
  if (!z.installed) return 'Zapret bu cihazda kurulu değil';
  return z.issue || 'Zapret kapalı — Zapret DPI sayfasından açın';
};
function DpiInactive({ why, vps }: { why: string; vps: boolean }) {
  return (
    <div className="rt-warnline" role="note">
      <AlertTriangle size={13} /><span>{vps ? 'Tünel düşerse DPI uygulanmaz' : 'DPI uygulanmıyor'}: {why}</span>
    </div>
  );
}

// VPS çıkışlı kuralda tünel kapanınca / VPS yanıt vermeyince ne olacağı (backend routeMarks.ts, kural başına).
const FALLBACK_TITLE = "VPS tüneli kapanırsa ya da VPS yanıt vermezse — engelle: bu trafik operatörden (ISP) çıkmaz, site açılmaz; operatörden devam: trafik ISP üzerinden sürer (gerçek konumunuz görünür), kuralda DPI açıksa DPI atlatmayla";
function FallbackSelect({ value, dpi, onChange }: { value: string | undefined; dpi: boolean; onChange: (v: 'block' | 'isp') => void }) {
  return (
    <Select className="config-select config-select-sm" value={value === 'isp' ? 'isp' : 'block'}
      onChange={e => onChange(e.target.value === 'isp' ? 'isp' : 'block')} title={FALLBACK_TITLE} aria-label="Tünel düşerse">
      <option value="block">Tünel düşerse: engelle</option>
      <option value="isp">{dpi ? 'Tünel düşerse: operatörden + DPI' : 'Tünel düşerse: operatörden devam'}</option>
    </Select>
  );
}

// İki görünümün ortak denetimleri. Telefonda sütun başlığı gösterilmez: DPI düğmesi kendini anlatır, anahtar adıyla okunur.
function DpiButton({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`rt-dpi-btn ${on ? 'is-on' : ''}`} onClick={onClick} aria-pressed={on} title="DPI bypass (Zapret)">
      <Shield size={12} />DPI {on ? 'ON' : 'OFF'}
    </button>
  );
}
function StateToggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={`${label} kuralı`} title={on ? 'Kural açık' : 'Kural kapalı'}
      className={`toggle-btn toggle-sm ${on ? 'toggle-on' : 'toggle-off'}`} onClick={onClick}>
      <div className="toggle-knob" />
    </button>
  );
}

// Uygulama kuralının listesinde alan adları ile IP aralığı girdileri (backend ipRanges.ts) birlikte durur:
// "@asn:<n>[!443]" bir ağın (AS) IP aralıkları, "a.b.c.d[/nn]" sabit aralık. Aralıklar etiket olarak gösterilir.
const ASN_ENTRY = /^@asn:(\d{1,10})(!443)?$/i;
const CIDR_ENTRY = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;
// Telegram beş AS kullanır (hepsi Telegram Messenger Inc; resmî core.telegram.org/resources/cidr.txt listesinin tümünü kapsar).
const ASN_NAMES: Record<string, string> = {
  '32934': 'Meta',
  '62041': 'Telegram', '59930': 'Telegram', '62014': 'Telegram', '211157': 'Telegram', '44907': 'Telegram',
  '32590': 'Valve', '30103': 'Zoom', '714': 'Apple',
};
function splitRuleEntries(list: string): { domains: string[]; ranges: string[] } {
  const entries = list.split(',').map(s => s.trim()).filter(Boolean);
  return {
    domains: entries.filter(e => !ASN_ENTRY.test(e) && !CIDR_ENTRY.test(e) && !LIST_ENTRY.test(e)),
    ranges: entries.filter(e => ASN_ENTRY.test(e) || CIDR_ENTRY.test(e)),
  };
}
function describeRangeEntry(e: string): string {
  const m = ASN_ENTRY.exec(e);
  if (!m) return `IP aralığı ${e}`;
  const who = ASN_NAMES[m[1]] ? `${ASN_NAMES[m[1]]} IP aralıkları` : `AS${m[1]} IP aralıkları`;
  return m[2] ? `${who} — yalnız arama trafiği (443 hariç)` : `${who} — tüm trafik`;
}
// Aynı etiketi veren girdiler tek etikette toplanır (ör. Telegram'ın beş AS'si → "… · 5 ağ").
function groupRangeEntries(ranges: string[]): { label: string; entries: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const r of ranges) {
    const label = describeRangeEntry(r);
    groups.set(label, [...(groups.get(label) || []), r]);
  }
  return [...groups].map(([label, entries]) => ({ label: entries.length > 1 ? `${label} · ${entries.length} ağ` : label, entries }));
}

// ─── Bekleyen değişiklikler: tıklanan denetim yanıtı beklemeden yeni değerini gösterir ───
// Pi'de bir kural değişikliğinin uygulanması birkaç saniye sürer ve istekler sunucuda sıraya girer; eskiden düğme o süre
// boyunca eski hâlinde kalıyor, arka arkaya basılan diğer düğmeler de değişmiyor, sayfa donmuş gibi görünüyordu.
// Yanıt ve yeniden yükleme bitince sunucudaki değer geçerli olur; istek başarısızsa denetim eski değerine döner.
function usePendingEdits() {
  const [pending, setPending] = useState<Record<string, unknown>>({});
  const seq = useRef(0);
  const latest = useRef<Record<string, number>>({});
  const value = <T,>(id: number, field: string, server: T): T => {
    const k = `${id}:${field}`;
    return k in pending ? (pending[k] as T) : server;
  };
  const busy = (id: number) => Object.keys(pending).some(k => k.startsWith(`${id}:`));
  const run = async (id: number, field: string, next: unknown, send: () => Promise<void>) => {
    const k = `${id}:${field}`;
    const n = ++seq.current;
    latest.current[k] = n;
    setPending(p => ({ ...p, [k]: next }));
    try {
      await send();
    } finally {
      // Aynı denetime yeniden basıldıysa onun değeri kalır (son tıklama geçerli)
      if (latest.current[k] === n) setPending(p => { const rest = { ...p }; delete rest[k]; return rest; });
    }
  };
  return { value, busy, run };
}
const Saving = () => <Loader2 size={12} className="spin rt-saving" aria-label="Kaydediliyor" />;

// ─── Kural uygulama durumu: değişiklikten sonra "uygulanıyor… / hazır" ───
// Sunucu kuralı yazıp yanıt döner; DNS yenilemesi arka planda (2-15 sn + yeniden başlatma) sürer.
interface RoutingApplyStatus {
  phase: 'idle' | 'queued' | 'waiting' | 'restarting' | 'warming' | 'failed';
  apply_seq: number; restart_needed_seq: number; restart_done_seq: number; restart_at: number; now: number; error: string;
  prewarm: { kind: 'add' | 'restart'; names: number; ips: number; error: string } | null;
}
const APPLY_WATCH_MS = 180000;
// apply_seq > 0: sunucu süreci en az bir uygulama yaptı — panel arada yeniden başladıysa açılış uygulaması bitmeden
// (durum sıfırdan başlar) 'Hazır' denmez.
const isApplied = (s: RoutingApplyStatus) =>
  s.phase === 'idle' && s.apply_seq > 0 && s.restart_done_seq >= s.restart_needed_seq;

function useRoutingApplyWatch() {
  const [status, setStatus] = useState<RoutingApplyStatus | null>(null);
  const [polling, setPolling] = useState(false);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef(0);
  // Her watch() yeni bir döngü: önceki döngünün geç gelen cevabı yok sayılır; aynı anda tek istek.
  const cycle = useRef(0);
  const inFlight = useRef(false);

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setPolling(false);
  }, []);
  const poll = useCallback(async (id: number) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const expired = Date.now() - startedAt.current > APPLY_WATCH_MS;
    try {
      const s = await getApi<RoutingApplyStatus>('/routing/status');
      if (id !== cycle.current) return;
      setStatus(s);
      if (isApplied(s) || s.phase === 'failed' || expired) stop();
    } catch {
      if (id === cycle.current && expired) stop();
    } finally {
      inFlight.current = false;
    }
  }, [stop]);
  const watch = useCallback(() => {
    const id = ++cycle.current;
    startedAt.current = Date.now();
    setStatus(null);
    setVisible(true);
    setPolling(true);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => { void poll(id); }, 1000);
    void poll(id);
  }, [poll]);
  const dismiss = useCallback(() => { cycle.current++; stop(); setVisible(false); }, [stop]);
  useEffect(() => stop, [stop]);
  return { status, polling, visible, watch, dismiss };
}

function ApplyBanner({ w }: { w: ReturnType<typeof useRoutingApplyWatch> }) {
  if (!w.visible) return null;
  const s = w.status;
  const warmed = s?.prewarm?.kind === 'add' && s.prewarm.ips > 0 && !s.prewarm.error
    ? `${s.prewarm.ips} adres tünel listesine eklendi. ` : '';
  let tone: 'info' | 'ok' | 'err' = 'info';
  let text = 'Kural uygulanıyor…';
  if (s?.phase === 'failed') {
    tone = 'err'; text = s.error || 'Kural uygulanamadı';
  } else if (s && isApplied(s)) {
    tone = 'ok'; text = 'Hazır. Siteyi telefonda kapatıp yeniden açın; hâlâ eski yoldan açılırsa uçak modunu 5 sn açıp kapatın.';
  } else if (s?.phase === 'waiting') {
    text = `${warmed}DNS ${Math.max(0, Math.ceil((s.restart_at - s.now) / 1000))} sn içinde yenilenecek…`;
  } else if (s?.phase === 'queued') {
    text = `${warmed}Önceki DNS yenilemesi bitince uygulanacak…`;
  } else if (s?.phase === 'restarting') {
    text = 'DNS yeniden başlatılıyor (birkaç saniye yanıt gelmeyebilir)…';
  } else if (s?.phase === 'warming') {
    text = 'DNS açıldı, tünel listesi dolduruluyor…';
  }
  if (tone === 'info' && !w.polling) { tone = 'err'; text = 'Durum 3 dakikada netleşmedi; sayfayı yenileyip kuralı kontrol edin.'; }
  return (
    <div className={`routing-apply routing-apply-${tone}`} role="status">
      <Info size={14} />
      <span>{text}</span>
      <button onClick={w.dismiss} aria-label="Kapat"><X size={13} /></button>
    </div>
  );
}

export function RoutingPanel() {
  const [activeTab, setActiveTab] = useState<RoutingTab>('apps');
  const apply = useRoutingApplyWatch();

  return (
    <div className="fade-in">
      <Panel title="Trafik Yönlendirme" icon={<Route size={20} style={{ marginRight: 8 }} />}
        subtitle="Tüm trafik yönlendirme kuralları — uygulamalar ve özel domain'ler">
        <div className="service-tabs rt-tabs">
          <button className={`service-tab ${activeTab === 'apps' ? 'service-tab-active' : ''}`}
            onClick={() => setActiveTab('apps')}>
            <Gamepad2 size={14} /><span>Uygulamalar</span>
          </button>
          <button className={`service-tab ${activeTab === 'domains' ? 'service-tab-active' : ''}`}
            onClick={() => setActiveTab('domains')}>
            <Link size={14} /><span>Özel Domain'ler</span>
          </button>
        </div>
        <ApplyBanner w={apply} />
      </Panel>

      {activeTab === 'apps' && <AppRoutingView onApplied={apply.watch} />}
      {activeTab === 'domains' && <DomainRoutingView onApplied={apply.watch} />}
    </div>
  );
}

// ─── App Routing — inline controls per row ───
function AppRoutingView({ onApplied }: { onApplied: () => void }) {
  const { data: rulesData, refetch } = useApi<{ rules: TrafficRule[]; lists?: ListInfo[]; listDns?: ListDnsStats; zapret?: ZapretBrief }>('/routing/rules', { rules: [] });
  const dpiWhy = dpiInactiveReason(rulesData.zapret);
  const { data: vpsData } = useApi<{ servers: VpsServer[] }>('/vps/list', { servers: [] });
  const [filterCat, setFilterCat] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const vpsList = vpsData.servers;
  const rules = rulesData.rules;
  const categories = [...new Set(rules.map(r => r.category))];
  const filtered = filterCat === 'all' ? rules : rules.filter(r => r.category === filterCat);

  const grouped: Record<string, TrafficRule[]> = {};
  filtered.forEach(r => {
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push(r);
  });

  const edits = usePendingEdits();
  const handleChange = (id: number, field: string, value: any) => edits.run(id, field, value, async () => {
    try {
      await putApi(`/routing/rules/${id}`, { [field]: value });
      onApplied();
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Kural güncellenemedi');
    }
  });

  const activeCount = rules.filter(r => r.enabled && r.exit_node !== 'isp').length;

  return (
    <div style={{ marginTop: 14 }}>
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3>Uygulama Bazlı Yönlendirme</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <Badge variant="info">{rules.length} uygulama</Badge>
            <Badge variant="success">{activeCount} aktif VPS</Badge>
          </div>
        </div>

        <div className="rt-chips" role="group" aria-label="Kategori">
          <button type="button" className={`rt-chip ${filterCat === 'all' ? 'is-on' : ''}`} aria-pressed={filterCat === 'all'} onClick={() => setFilterCat('all')}>
            Tümü <span className="rt-chip-n">{rules.length}</span>
          </button>
          {categories.map(cat => {
            const meta = categoryMeta[cat] || { label: cat, icon: null, color: 'badge-neutral' };
            const count = rules.filter(r => r.category === cat).length;
            return (
              <button type="button" key={cat} className={`rt-chip ${filterCat === cat ? 'is-on' : ''}`} aria-pressed={filterCat === cat} onClick={() => setFilterCat(cat)}>
                {meta.icon}{meta.label} <span className="rt-chip-n">{count}</span>
              </button>
            );
          })}
        </div>

        {/* Sütun başlıkları yalnız geniş ekranda (telefonda her kural kendi kartında) */}
        {filtered.length > 0 && (
          <div className="rt-head rt-cols-app" aria-hidden="true">
            <span />
            <span>Uygulama</span>
            <span>Çıkış Noktası</span>
            <span className="rt-c">DPI Bypass</span>
            <span className="rt-c">Durum</span>
          </div>
        )}

        {Object.entries(grouped).map(([category, catRules]) => {
          const meta = categoryMeta[category] || { label: category, icon: null, color: 'badge-neutral' };
          return (
            <section key={category} className="rt-group">
              <div className="rt-group-head">
                {meta.icon}
                <span>{meta.label}</span>
                <Badge variant={meta.color.replace('badge-', '') as any}>{catRules.length}</Badge>
              </div>

              <div className="rt-list">
                {catRules.map(rule => {
                  const exitNode = edits.value(rule.id, 'exit_node', rule.exit_node || 'isp');
                  const dpi = edits.value(rule.id, 'dpi_bypass', rule.dpi_bypass || 0);
                  const enabled = edits.value(rule.id, 'enabled', rule.enabled);
                  const fallback = edits.value(rule.id, 'vps_fallback', rule.vps_fallback);
                  const saving = edits.busy(rule.id);
                  const isActive = enabled && exitNode !== 'isp';
                  const isExpanded = expandedId === rule.id;
                  const list = ruleList(rule);
                  const ListIcon = list ? CAT_ICON[list] : null;
                  const info = list ? rulesData.lists?.find(l => l.id === list) : undefined;

                  return (
                    <div key={rule.id} className={`rt-item ${!enabled ? 'is-off' : ''} ${isActive ? 'is-vps' : ''}`} aria-busy={saving || undefined}>
                      <div className={`rt-row rt-app ${exitNode !== 'isp' ? 'has-fb' : ''}`}>
                        <div className="rt-icon">
                          <div className="app-icon-sm">
                            {ListIcon ? <ListIcon size={16} strokeWidth={2} /> : <AppLogo name={rule.app_name} />}
                          </div>
                        </div>

                        <div className="rt-name">
                          <strong>{rule.app_name}</strong>
                          {list && <span className="rt-tag" title={info ? `${info.source} · ${fmtN(info.count)} alan adı` : 'Hazır liste'}>hazır liste{info?.count ? ` · ${fmtN(info.count)}` : ''}</span>}
                          <button type="button" className="rt-more" onClick={() => setExpandedId(isExpanded ? null : rule.id)}
                            title={list ? 'Listeyi göster' : "Domain'leri göster"} aria-expanded={isExpanded}>
                            <Info size={13} />
                          </button>
                          {saving && <Saving />}
                        </div>

                        <div className="rt-exit">
                          <Select
                            className="config-select config-select-sm"
                            value={exitNode}
                            onChange={e => handleChange(rule.id, 'exit_node', e.target.value)}
                            aria-label="Çıkış noktası"
                          >
                            <option value="isp">ISP (Direkt)</option>
                            {vpsList.map(v => (
                              <option key={v.id} value={String(v.id)}>VPS {v.location} ({v.ip})</option>
                            ))}
                          </Select>
                        </div>
                        {exitNode !== 'isp' && (
                          <div className="rt-fb">
                            <FallbackSelect value={fallback} dpi={!!dpi} onChange={v => handleChange(rule.id, 'vps_fallback', v)} />
                          </div>
                        )}

                        <div className="rt-dpi">
                          <DpiButton on={!!dpi} onClick={() => handleChange(rule.id, 'dpi_bypass', dpi ? 0 : 1)} />
                        </div>

                        <div className="rt-state">
                          <StateToggle on={!!enabled} label={rule.app_name} onClick={() => handleChange(rule.id, 'enabled', enabled ? 0 : 1)} />
                        </div>
                      </div>
                      {enabled && dpi && (exitNode === 'isp' || fallback === 'isp') && dpiWhy
                        ? <DpiInactive why={dpiWhy} vps={exitNode !== 'isp'} /> : null}

                      {isExpanded && list && (
                        <div className="rt-detail">
                          <span className="rt-detail-label">Hazır liste</span>
                          <span>
                            {info?.count
                              ? `${info.source} — ${fmtN(info.count)} alan adı, alt alan adlarıyla (tekrarlar ayıklanınca ${fmtN(info.collapsed)})`
                              : 'Liste yükleniyor…'}
                            {info?.updatedAt ? ` · güncellendi ${new Date(info.updatedAt).toLocaleDateString('tr-TR')}` : ''}
                            {' · siteleri tek tek yazmak gerekmez, liste günde bir yenilenir'}
                          </span>
                          <span>
                            {exitNode !== 'isp'
                              ? `VPS çıkışı: Pi-hole bu listedeki adları paneldeki çözücüye iletir, adresler yanıt dönmeden tünel yoluna eklenir${rulesData.listDns?.listening ? ` · son açılıştan beri ${fmtN(rulesData.listDns.queries)} sorgu, ${fmtN(rulesData.listDns.added)} adres` : ''}`
                              : dpi ? `DPI: Pi-hole bu listedeki adları paneldeki çözücüye iletir, adresler DPI işaretiyle modemden çıkar (Zapret)${rulesData.listDns?.listening ? ` · son açılıştan beri ${fmtN(rulesData.listDns.queries)} sorgu, ${fmtN(rulesData.listDns.added)} adres` : ''}`
                              : 'Çıkış noktası ya da DPI seçilince uygulanır'}
                          </span>
                          {info?.error && <span className="rt-warn">{info.error}</span>}
                          {(exitNode !== 'isp' || !!dpi) && rulesData.listDns?.lastError && <span className="rt-warn">{rulesData.listDns.lastError}</span>}
                        </div>
                      )}
                      {isExpanded && !list && rule.domains && (() => {
                        const { domains: names, ranges } = splitRuleEntries(rule.domains);
                        return (
                          <div className="rt-detail">
                            <span className="rt-detail-label">Domain'ler</span>
                            {names.length > 0 && (
                              <div className="rt-chipset">
                                {names.map((n, i) => <span key={i} className="rt-domain-chip">{n}</span>)}
                              </div>
                            )}
                            {ranges.length > 0 && (
                              <div className="rt-chipset">
                                {groupRangeEntries(ranges).map(g => (
                                  <span key={g.label} className="rt-range" title={g.entries.join(', ')}>{g.label}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ─── Domain Routing — custom URL rules with inline controls ───
interface DomainRule {
  id: number;
  domain: string;
  exit_node: string;
  dpi_bypass: number;
  route_type: string;
  description: string;
  enabled: number;
  redirect_url?: string;
  vps_fallback?: 'block' | 'isp';
  created_at: string;
}

// ─── Routing önerileri: yönlendirilen siteyle birlikte açılan alan adları (GET /routing/suggestions) ───
interface SuggestionItem { key: string; domain: string; samples: string[]; visits: number; clients: number; last_seen: string }
interface RuleSuggestions { rule_id: number; domain: string; visits: number; hidden_background: number; more: number; suggestions: SuggestionItem[] }
interface SuggestionsResponse { available: boolean; reason: string | null; window: { hours: number }; truncated: boolean; rules: RuleSuggestions[] }
interface DismissedItem { id: number; domain: string; rule_domain: string; created_at: string }

const EMPTY_SUGGESTIONS: SuggestionsResponse = { available: false, reason: null, window: { hours: 24 }, truncated: false, rules: [] };
const SUGGEST_UNAVAILABLE: Record<string, string> = {
  privacy: 'Öneriler kapalı: Pi-hole gizlilik düzeyi 0 değil, alan adı kayıtları tutulmuyor.',
  db: 'Öneriler şu an alınamıyor: Pi-hole sorgu kaydı okunamadı.',
  timeout: 'Öneriler şu an alınamıyor: Pi-hole sorgu kaydı zaman aşımına uğradı.',
};

// Açılınca mount edilir; her yoksay/geri al sonrası üst bileşen `key` değiştirip yeniden yükletir.
function DismissedList({ onChange }: { onChange: () => void }) {
  const { data, loading, error, refetch } = useApi<{ dismissed: DismissedItem[] }>('/routing/suggestions/dismissed', { dismissed: [] });
  const [undoing, setUndoing] = useState<number | null>(null);
  const undo = async (item: DismissedItem) => {
    setUndoing(item.id);
    try {
      await deleteApi(`/routing/suggestions/dismissed/${item.id}`);
      toast.success(`${item.domain} yeniden önerilebilir`);
      await refetch();
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Geri alınamadı');
    }
    setUndoing(null);
  };
  if (loading) return <div className="routing-suggest-note">Yükleniyor…</div>;
  if (error) return <div className="routing-suggest-note">Yoksayılan öneriler alınamadı: {error}</div>;
  if (data.dismissed.length === 0) return <div className="routing-suggest-note">Yoksayılan öneri yok</div>;
  return (
    <div className="routing-suggest">
      {data.dismissed.map(item => (
        <div key={item.id} className="routing-suggest-item">
          <div className="routing-suggest-main">
            <span className="routing-suggest-domain">{item.domain}</span>
            {item.rule_domain && <span className="routing-suggest-samples">{item.rule_domain} için yoksayıldı</span>}
          </div>
          <div className="routing-suggest-actions">
            <button className="btn-outline btn-sm" disabled={undoing !== null} onClick={() => undo(item)}>
              <RotateCcw size={12} /> {undoing === item.id ? 'Geri alınıyor…' : 'Geri al'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function DomainRoutingView({ onApplied }: { onApplied: () => void }) {
  const { data, refetch } = useApi<{ domains: DomainRule[]; zapret?: ZapretBrief }>('/routing/domains', { domains: [] });
  const dpiWhy = dpiInactiveReason(data.zapret);
  const [adding, setAdding] = useState(false);
  const { data: vpsData } = useApi<{ servers: VpsServer[] }>('/vps/list', { servers: [] });
  const [showAdd, setShowAdd] = useState(false);
  const [newDomain, setNewDomain] = useState('');
  const [newExitNode, setNewExitNode] = useState('isp');
  const [newDpi, setNewDpi] = useState(0);
  const [newDesc, setNewDesc] = useState('');
  const [newRedirectUrl, setNewRedirectUrl] = useState('');
  const [filter, setFilter] = useState('');
  // Öneriler: sunucu 60 sn önbellekler; FTL diske dakikada bir yazar → 2 dk'da bir yoklamak yeter.
  const { data: sug, refetch: refetchSug } = useApi<SuggestionsResponse>('/routing/suggestions', EMPTY_SUGGESTIONS, 120000);
  const [openSug, setOpenSug] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [dismissedNonce, setDismissedNonce] = useState(0);

  const vpsList = vpsData.servers;
  const domains = data.domains;
  const filtered = filter ? domains.filter(d => d.domain.includes(filter.toLowerCase())) : domains;
  const sugByRule = new Map(sug.rules.map(r => [r.rule_id, r]));

  const exitLabel = (rule: DomainRule) => {
    const vps = vpsList.find(v => String(v.id) === rule.exit_node);
    const base = rule.exit_node && rule.exit_node !== 'isp' ? `VPS ${vps?.location || rule.exit_node}` : 'ISP';
    return rule.dpi_bypass ? `${base} + DPI` : base;
  };

  const toggleSug = (id: number) => setOpenSug(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Tekli "Ekle" ve "Tümünü ekle" aynı uç noktadan: çıkış sunucuda ana kuraldan kopyalanır, tek DNS yenilemesi.
  const acceptSuggestions = async (rule: DomainRule, list: SuggestionItem[]) => {
    if (list.length > 1 && !confirm(`Şu alan adları ${rule.domain} ile aynı çıkışa (${exitLabel(rule)}) eklensin mi?\n\n${list.map(s => s.domain).join('\n')}`)) return;
    setBusy(list.length > 1 ? `all:${rule.id}` : list[0].domain);
    try {
      const r = await postApi('/routing/suggestions/accept', { rule_id: rule.id, domains: list.map(s => s.domain) });
      const added = Array.isArray(r.added) ? r.added.length : 0;
      const skipped = Array.isArray(r.skipped) ? r.skipped.length : 0;
      if (added) {
        toast.success(`${added} alan adı eklendi (${exitLabel(rule)})${skipped ? ` · ${skipped} tanesi zaten ekliydi` : ''}`);
        onApplied();
      } else {
        toast.info('Seçilen alan adları zaten ekliydi');
      }
      await refetch();
      await refetchSug();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Eklenemedi');
    }
    setBusy(null);
  };

  // Yoksay kayıtlı alan adı bazında ve globaldir: aynı sitenin başka alt adresleri de bir daha önerilmez.
  const dismissSuggestion = async (rule: DomainRule, s: SuggestionItem) => {
    setBusy(`x:${s.key}`);
    try {
      await postApi('/routing/suggestions/dismiss', { domain: s.key, rule_domain: rule.domain });
      toast.info(`${s.key} artık önerilmeyecek`);
      setDismissedNonce(n => n + 1);
      await refetchSug();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Yoksayılamadı');
    }
    setBusy(null);
  };

  const handleAdd = async () => {
    const domain = newDomain.trim();
    if (!domain || adding) return;
    setAdding(true);
    try {
      const result = await postApi('/routing/domains', {
        domain,
        exit_node: newRedirectUrl ? 'isp' : newExitNode,
        dpi_bypass: newRedirectUrl ? 0 : newDpi,
        description: newDesc.trim(),
        redirect_url: newRedirectUrl.trim(),
      });
      if (result.error) { toast.error(result.error); return; }
      toast.success(`${domain} eklendi`);
      onApplied();
      setNewDomain(''); setNewDesc(''); setNewExitNode('isp'); setNewDpi(0); setNewRedirectUrl(''); setShowAdd(false);
      await refetch();
      await refetchSug(); // kapsam ve başlangıç kuralları değişti
    } catch (e: any) {
      toast.error(e.message || 'Eklenemedi');
    } finally {
      setAdding(false);
    }
  };

  const edits = usePendingEdits();
  const handleChange = (id: number, field: string, value: any) => edits.run(id, field, value, async () => {
    try {
      await putApi(`/routing/domains/${id}`, { [field]: value });
      onApplied();
      await refetch();
      await refetchSug(); // kural artık başlangıç kuralı olmayabilir (kapalı / ISP)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Kural güncellenemedi');
    }
  });

  const handleDelete = async (id: number, domain: string) => {
    if (!confirm(`${domain} kuralı silinsin mi?`)) return;
    await edits.run(id, 'delete', true, async () => {
      try {
        await deleteApi(`/routing/domains/${id}`);
        toast.success(`${domain} silindi`);
        onApplied();
        await refetch();
        await refetchSug();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Silinemedi');
      }
    });
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3><Link size={18} style={{ marginRight: 8 }} />Özel Domain Yönlendirme</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <Badge variant="info"><span>{domains.length} <span lang="en">domain</span></span></Badge>
            <button className="btn-primary btn-sm" onClick={() => setShowAdd(!showAdd)}>
              <Plus size={14} /> Domain Ekle
            </button>
          </div>
        </div>
        <p className="subtitle">
          Belirli domain'leri farklı VPS'ler üzerinden yönlendirin. Wildcard desteklenir: <code style={{ fontSize: 11, background: 'var(--surface-code)', padding: '1px 4px', borderRadius: 8 }}>*.example.com</code> veya kelime (alan-adı son eki): <code style={{ fontSize: 11, background: 'var(--surface-code)', padding: '1px 4px', borderRadius: 8 }}>youtube</code> (youtube.com ve tüm alt alan adları — DNS son-ek eşleşmesi)
        </p>
        {!sug.available && sug.reason && SUGGEST_UNAVAILABLE[sug.reason] && (
          <p className="routing-suggest-note">{SUGGEST_UNAVAILABLE[sug.reason]}</p>
        )}
        {sug.truncated && <p className="routing-suggest-note">Çok fazla kayıt var; öneriler için yalnız en yeni kayıtlar incelendi.</p>}

        {showAdd && (
          <div className="cron-add-form">
            <div className="cron-add-grid">
              <div className="form-group">
                <label><Globe size={14} /> Domain / Kelime</label>
                <input className="config-input" type="text" placeholder="example.com veya *.video.com veya streaming"
                  value={newDomain} onChange={e => setNewDomain(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAdd()} />
              </div>
              <div className="form-group">
                <label><Route size={14} /> Çıkış Noktası</label>
                <Select className="config-select" value={newExitNode} onChange={e => setNewExitNode(e.target.value)}>
                  <option value="isp">ISP (Direkt)</option>
                  {vpsList.map(v => (
                    <option key={v.id} value={String(v.id)}>VPS {v.location} ({v.ip})</option>
                  ))}
                </Select>
              </div>
              <div className="form-group">
                <label><Shield size={14} /> DPI Bypass</label>
                <button
                  className={`btn-sm ${newDpi ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setNewDpi(newDpi ? 0 : 1)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <Shield size={12} /> DPI {newDpi ? 'ON' : 'OFF'}
                </button>
              </div>
              <div className="form-group">
                <label>Açıklama</label>
                <input className="config-input" type="text" placeholder="Neden bu rota?"
                  value={newDesc} onChange={e => setNewDesc(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAdd()} />
              </div>
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label><Route size={14} /> Yönlendirme URL'si (opsiyonel)</label>
                <input className="config-input" type="text" placeholder="https://example.com/blocked — boş bırakılırsa VPS/ISP routing uygulanır"
                  value={newRedirectUrl} onChange={e => setNewRedirectUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAdd()} />
                {newRedirectUrl && <span style={{ fontSize: 11, color: 'var(--accent-color)', marginTop: 4, display: 'block' }}>Bu domain'e erişildiğinde kullanıcı otomatik olarak bu URL'ye yönlendirilecek</span>}
              </div>
            </div>
            <div className="cron-add-actions" style={{ marginTop: 10 }}>
              <button className="btn-primary btn-sm" onClick={handleAdd} disabled={!newDomain.trim() || adding}>
                <Check size={13} /> {adding ? 'Ekleniyor…' : 'Ekle'}
              </button>
              <button className="btn-outline btn-sm" onClick={() => setShowAdd(false)}>
                <X size={13} /> İptal
              </button>
            </div>
          </div>
        )}

        {domains.length > 5 && (
          <div className="list-filter" style={{ marginTop: 12 }}>
            <Search size={13} />
            <input className="config-input" type="text" placeholder="Domain ara..."
              value={filter} onChange={e => setFilter(e.target.value)} />
          </div>
        )}

        {/* Sütun başlıkları yalnız geniş ekranda */}
        {filtered.length > 0 && (
          <div className="rt-head rt-cols-dom" aria-hidden="true">
            <span className="rt-c">Durum</span>
            <span>Domain</span>
            <span>Çıkış Noktası</span>
            <span className="rt-c">DPI</span>
            <span />
          </div>
        )}

        <div className="rt-list rt-list-dom">
          {filtered.length === 0 && (
            <div className="empty-state" style={{ padding: 30 }}>
              <Link size={32} />
              <p>{domains.length === 0 ? 'Henüz özel domain eklenmedi' : 'Aramayla eşleşen domain bulunamadı'}</p>
            </div>
          )}
          {filtered.map(d => {
            const exitNode = edits.value(d.id, 'exit_node', d.exit_node || 'isp');
            const dpi = edits.value(d.id, 'dpi_bypass', d.dpi_bypass || 0);
            const enabled = edits.value(d.id, 'enabled', d.enabled);
            const fallback = edits.value(d.id, 'vps_fallback', d.vps_fallback);
            const saving = edits.busy(d.id);
            // Yalnız öneri üretebilen kural (etkin, redirect değil, VPS ya da DPI) — sunucu yanıtı 2 dk'ya kadar eski olabilir.
            const rs = enabled && !d.redirect_url && (exitNode !== 'isp' || dpi) ? sugByRule.get(d.id) : undefined;
            const sugOpen = openSug.has(d.id);
            const hasFb = exitNode !== 'isp' && !d.redirect_url;

            return (
              <div key={d.id} className={`rt-item ${!enabled ? 'is-off' : ''} ${enabled && exitNode !== 'isp' ? 'is-vps' : ''} ${edits.value(d.id, 'delete', false) ? 'is-deleting' : ''}`} aria-busy={saving || undefined}>
              <div className={`rt-row rt-dom ${hasFb ? 'has-fb' : ''}`}>
                <div className="rt-state">
                  <StateToggle on={!!enabled} label={d.domain} onClick={() => handleChange(d.id, 'enabled', enabled ? 0 : 1)} />
                </div>

                <div className="rt-name">
                  <span className="rt-domain">{d.domain}</span>
                  {saving && <Saving />}
                  {!d.domain.includes('.') && <span className="rt-tag rt-tag-warn">kelime</span>}
                  {d.domain.startsWith('*.') && <span className="rt-tag rt-tag-info" lang="en">wildcard</span>}
                  {d.redirect_url && <span className="rt-tag rt-tag-warn" lang="en">redirect</span>}
                  {d.redirect_url ? (
                    <span className="rt-sub rt-sub-link">→ {d.redirect_url}</span>
                  ) : d.description ? (
                    <span className="rt-sub">{d.description}</span>
                  ) : null}
                </div>

                <div className="rt-exit">
                  <Select
                    className="config-select config-select-sm"
                    value={exitNode}
                    onChange={e => handleChange(d.id, 'exit_node', e.target.value)}
                    aria-label="Çıkış noktası"
                  >
                    <option value="isp">ISP (Direkt)</option>
                    {vpsList.map(v => (
                      <option key={v.id} value={String(v.id)}>VPS {v.location} ({v.ip})</option>
                    ))}
                  </Select>
                </div>
                {hasFb && (
                  <div className="rt-fb">
                    <FallbackSelect value={fallback} dpi={!!dpi} onChange={v => handleChange(d.id, 'vps_fallback', v)} />
                  </div>
                )}

                <div className="rt-dpi">
                  <DpiButton on={!!dpi} onClick={() => handleChange(d.id, 'dpi_bypass', dpi ? 0 : 1)} />
                </div>

                <div className="rt-del">
                  <button className="icon-btn icon-btn-sm cron-delete" onClick={() => handleDelete(d.id, d.domain)} title="Sil" aria-label={`${d.domain} kuralını sil`}
                    disabled={edits.value(d.id, 'delete', false)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              {enabled && dpi && (exitNode === 'isp' || fallback === 'isp') && !d.redirect_url && dpiWhy
                ? <DpiInactive why={dpiWhy} vps={exitNode !== 'isp'} /> : null}

              {rs && rs.suggestions.length > 0 && (
                <div className="routing-suggest">
                  <div className="routing-suggest-head">
                    <button className="routing-suggest-toggle" onClick={() => toggleSug(d.id)} aria-expanded={sugOpen}>
                      {sugOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <Lightbulb size={12} />
                      <span>Önerilen alan adları ({rs.suggestions.length + rs.more})</span>
                    </button>
                    <span className="routing-suggest-meta">
                      bu siteyle birlikte açılan adresler · son {sug.window.hours} saat · {rs.visits} ziyaret
                    </span>
                    {sugOpen && rs.suggestions.length > 1 && (
                      <button className="btn-outline btn-sm" disabled={busy !== null} onClick={() => acceptSuggestions(d, rs.suggestions)}>
                        <Plus size={12} /> {busy === `all:${d.id}` ? 'Ekleniyor…' : rs.more > 0 ? `Listelenenleri ekle (${rs.suggestions.length})` : 'Tümünü ekle'}
                      </button>
                    )}
                  </div>
                  {sugOpen && (
                    <>
                      {rs.suggestions.map(s => (
                        <div key={s.key} className="routing-suggest-item">
                          <div className="routing-suggest-main">
                            <span className="routing-suggest-domain">{s.domain}</span>
                            {(s.samples.length > 1 || s.samples[0] !== s.domain) && (
                              <span className="routing-suggest-samples">örn. {s.samples.join(', ')}</span>
                            )}
                          </div>
                          <div className="routing-suggest-actions">
                            <Badge variant="neutral">{s.visits} ziyaret</Badge>
                            {s.clients > 1 && <Badge variant="neutral">{s.clients} cihaz</Badge>}
                            <span className="routing-suggest-meta">
                              son: {new Date(s.last_seen).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
                            </span>
                            <button className="btn-primary btn-sm" disabled={busy !== null} onClick={() => acceptSuggestions(d, [s])}>
                              <Plus size={12} /> {busy === s.domain ? 'Ekleniyor…' : 'Ekle'}
                            </button>
                            <button className="btn-outline btn-sm" disabled={busy !== null} onClick={() => dismissSuggestion(d, s)}>
                              <X size={12} /> Yoksay
                            </button>
                          </div>
                        </div>
                      ))}
                      <div className="routing-suggest-note">
                        Eklenen adres bu kuralla aynı çıkışı kullanır: {exitLabel(d)}.
                        {rs.hidden_background > 0 && ` ${rs.hidden_background} arka plan adresi gizlendi.`}
                        {rs.more > 0 && ` +${rs.more} öneri daha.`}
                        {' '}Pi-hole kayıtları yaklaşık 1 dk gecikmeyle işlenir; yeni bir ziyaretin önerileri 2–3 dk içinde görünür.
                        Yeni eklenen adresin ilk isteği normal hattan gidebilir; sayfayı yenileyin.
                      </div>
                    </>
                  )}
                </div>
              )}
              </div>
            );
          })}
        </div>

        {domains.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <button className="routing-suggest-toggle" onClick={() => setShowDismissed(v => !v)} aria-expanded={showDismissed}>
              {showDismissed ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span>Yoksayılan öneriler</span>
            </button>
            {showDismissed && <DismissedList key={dismissedNonce} onChange={refetchSug} />}
          </div>
        )}

        {domains.length > 0 && (
          <div className="list-summary">
            <span>{domains.filter(d => d.enabled).length} aktif</span>
            <span>{domains.filter(d => !d.enabled).length} devre dışı</span>
            <span>{domains.length} toplam</span>
          </div>
        )}
      </div>
    </div>
  );
}
