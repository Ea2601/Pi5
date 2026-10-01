import { Zap, Globe, Shield, List, Plus, Trash2, Search, RefreshCw, AlertTriangle, FileText } from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { useEffect, useState } from 'react';
import { Panel, Badge } from './ui';
import type { ServiceStatus, ZapretDomain } from '../types';
import { toast } from '../toast';

type ZapretTab = 'overview' | 'strategy' | 'hostlist' | 'exclude';

// Backend zapret.ts: listeler ve NFQWS_ENABLE / MODE_FILTER / IFACE_WAN Zapret'e gerçekten yazılır.
interface ZapretApply {
  ok: boolean; installed: boolean; hostlist: number; exclude: number; fromRouting: number; vpsDpiRules: number;
  methodEnabled: boolean; restarted: boolean; warnings: string[]; error?: string; at: number;
}
interface ZapretStatus {
  installed: boolean; lastApply: ZapretApply | null;
  // Klasör var ama nfqws / servis birimi yok (yarım kurulum): nedeni ve ne yapılacağı (Ayarlar → Güncelle kurar)
  installIssue?: string | null;
  service?: boolean; processes?: number; nfqws?: boolean; tpws?: boolean; modeFilter?: string; iface?: string;
  strategy?: string; unlistedLines?: number; userEntries?: number; excludeEntries?: number; fromRouting?: string[];
  // Routing'in hazır listeli DPI satırları (Yetişkin / Kumar): listeye girer, tek tek gösterilmez — yalnız sayı.
  fromLists?: { id: string; label: string; count: number }[];
  zapretOwnList?: boolean; blockcheck?: { running: boolean; log: string };
}

// Uygulama sonucunu bildir: kayıt her durumda saklanır; Zapret'e yazılamadıysa neden, liste boşsa uyarı gösterilir.
function reportApply(z: ZapretApply | undefined, okMsg: string) {
  if (!z || !z.installed) { toast.success(okMsg); return; }
  if (!z.ok) { toast.error(`Kaydedildi ama Zapret'e uygulanamadı: ${z.error || 'bilinmeyen hata'}`); return; }
  toast.success(`${okMsg}${z.restarted ? ' — Zapret yeniden başlatıldı' : ' ve Zapret\'e uygulandı'}`);
  if (!z.methodEnabled) toast.info('DPI listesi boş: Zapret hiçbir trafiğe dokunmuyor. Bypass listesine site ekleyin.');
}

export function ZapretPanel() {
  const [activeTab, setActiveTab] = useState<ZapretTab>('overview');
  const { data: svcData, refetch } = useApi<{ services: ServiceStatus[] }>('/services', { services: [] });
  const zapretSvc = svcData.services.find(s => s.name === 'zapret');
  const isEnabled = zapretSvc?.enabled === 1;
  const { data: st, refetch: refetchStatus } = useApi<ZapretStatus | null>('/zapret/status', null);
  const [toggling, setToggling] = useState(false);

  const handleToggle = async () => {
    setToggling(true);
    try {
      const r = await postApi('/services/toggle', { name: 'zapret', enabled: !isEnabled });
      if (r.zapret && !r.zapret.methodEnabled) toast.info('Zapret açık ama DPI listesi boş: hiçbir trafiğe dokunmuyor.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Zapret açılıp kapatılamadı');
    } finally {
      setToggling(false);
      await Promise.all([refetch(), refetchStatus()]);
    }
  };

  const tabs: { id: ZapretTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Genel Bakış', icon: <Zap size={14} /> },
    { id: 'strategy', label: 'Strateji', icon: <FileText size={14} /> },
    { id: 'hostlist', label: 'Bypass Listesi', icon: <List size={14} /> },
    { id: 'exclude', label: 'Hariç Tutulanlar', icon: <Shield size={14} /> },
  ];

  return (
    <div className="fade-in">
      <Panel title="Zapret DPI Bypass Motoru" icon={<Zap size={20} style={{ marginRight: 8 }} />}
        subtitle="Yalnız listedeki sitelere, modem çıkışında nfqws paket manipülasyonu"
        badge={<Badge variant={isEnabled ? 'success' : 'neutral'}>{isEnabled ? 'Aktif' : 'Pasif'}</Badge>}
        actions={
          <button className={`toggle-btn ${isEnabled ? 'toggle-on' : 'toggle-off'}`} onClick={handleToggle} disabled={toggling}
            title={isEnabled ? 'Durdur' : 'Başlat'}>
            <div className="toggle-knob" />
          </button>
        }>
        <div className="service-tabs">
          {tabs.map(tab => (
            <button key={tab.id}
              className={`service-tab ${activeTab === tab.id ? 'service-tab-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}>
              {tab.icon}<span>{tab.label}</span>
            </button>
          ))}
        </div>
      </Panel>

      {activeTab === 'overview' && (
        <>
          <div style={{ marginTop: 14 }}><ZapretStatusCard st={st} onApplied={refetchStatus} /></div>
          <div style={{ marginTop: 14 }}><BlockcheckCard st={st} refetch={refetchStatus} /></div>
        </>
      )}

      {activeTab === 'strategy' && (
        <div style={{ marginTop: 14 }}><StrategyCard st={st} /></div>
      )}

      {(activeTab === 'hostlist' || activeTab === 'exclude') && (
        <div style={{ marginTop: 14 }}>
          <ZapretDomainManager listType={activeTab} fromRouting={activeTab === 'hostlist' ? st?.fromRouting || [] : []}
            onChanged={refetchStatus} />
        </div>
      )}
    </div>
  );
}

function ZapretStatusCard({ st, onApplied }: { st: ZapretStatus | null; onApplied: () => Promise<void> }) {
  const [applying, setApplying] = useState(false);
  const handleApply = async () => {
    setApplying(true);
    try { reportApply((await postApi('/zapret/apply', {})).zapret, 'Listeler yazıldı'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Uygulanamadı'); }
    finally { setApplying(false); await onApplied(); }
  };

  if (!st) return <Panel title="Durum"><div className="empty-state" style={{ padding: 20 }}>Yükleniyor…</div></Panel>;
  if (!st.installed) {
    return (
      <Panel title="Durum">
        <div className="routing-apply routing-apply-err" style={{ marginTop: 0 }}>
          <AlertTriangle size={14} /><span>Zapret bu cihazda kurulu değil (/opt/zapret/config yok).</span>
        </div>
      </Panel>
    );
  }
  const la = st.lastApply;
  const facts: [string, React.ReactNode][] = [
    ['Servis', st.service ? <Badge variant="success">Çalışıyor</Badge> : <Badge variant="neutral">Durmuş</Badge>],
    ['nfqws', st.nfqws
      ? (st.processes ? `Açık · ${st.processes} süreç` : 'Açık · süreç yok')
      : 'Kapalı'],
    ['Kapsam', st.modeFilter === 'hostlist' ? 'Yalnız listedeki siteler' : `MODE_FILTER=${st.modeFilter || '—'}`],
    ['Çıkış arayüzü', st.iface || '—'],
    ['Bypass listesi', `${st.userEntries ?? 0} alan adı${st.fromRouting?.length ? ` (${st.fromRouting.length} Routing'den)` : ''}`
      + (st.fromLists?.length ? ` · hazır liste: ${st.fromLists.map(l => `${l.label} ${l.count.toLocaleString('tr-TR')}`).join(', ')}` : '')],
    ['Hariç', `${st.excludeEntries ?? 0} alan adı`],
  ];
  // Eksik kurulum ayrı (kırmızı) bantta; son uygulamanın uyarılarında da geçtiği için orada tekrarlanmaz.
  const warnings = (la?.warnings || []).filter(w => w !== st.installIssue);
  if (la && la.vpsDpiRules > 0) {
    warnings.push(`${la.vpsDpiRules} Routing kuralında çıkış VPS + DPI: tünel trafiği modemden şifreli çıkar, orada DPI atlatma etkisizdir`);
  }

  return (
    <Panel title="Durum" subtitle="Zapret'in Pi üzerindeki gerçek durumu"
      actions={
        <button className="btn-outline btn-sm" onClick={handleApply} disabled={applying} title="Listeleri ve ayarları Zapret'e yeniden yaz">
          <RefreshCw size={13} className={applying ? 'spin' : ''} /> Zapret'e uygula
        </button>
      }>
      {st.installIssue && (
        <div className="routing-apply routing-apply-err" style={{ marginTop: 0, marginBottom: 12 }}>
          <AlertTriangle size={14} /><span>{st.installIssue}. Kurulum tamamlanana dek DPI hiçbir trafiğe uygulanmaz.</span>
        </div>
      )}
      <div className="zapret-facts">
        {facts.map(([k, v]) => (
          <div key={k} className="zapret-fact"><span>{k}</span><strong>{v}</strong></div>
        ))}
      </div>
      {la?.error && (
        <div className="routing-apply routing-apply-err"><AlertTriangle size={14} /><span>Son uygulama başarısız: {la.error}</span></div>
      )}
      {warnings.map(w => (
        <div key={w} className="routing-apply"><AlertTriangle size={14} /><span>{w}</span></div>
      ))}
      <p className="subtitle" style={{ marginTop: 12 }}>
        Zapret yalnız Bypass Listesi'ndeki sitelere (alt alan adları dahil) ve modem tarafı çıkıştaki trafiğe uygulanır.
        Routing'de çıkışı ISP olup DPI seçili kuralların siteleri listeye kendiliğinden eklenir. Liste boşken yöntem kapalı tutulur;
        Zapret'te boş liste "tüm trafik" demektir.
      </p>
    </Panel>
  );
}

function BlockcheckCard({ st, refetch }: { st: ZapretStatus | null; refetch: () => Promise<void> }) {
  const [domain, setDomain] = useState('discord.com');
  const [starting, setStarting] = useState(false);
  const running = !!st?.blockcheck?.running;
  // Test sürerken günlük 3 sn'de bir yenilenir.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => { void refetch(); }, 3000);
    return () => clearInterval(id);
  }, [running, refetch]);

  const handleStart = async () => {
    setStarting(true);
    try {
      await postApi('/zapret/blockcheck', { domain: domain.trim() });
      toast.info('Blockcheck başladı; birkaç dakika sürer.');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Blockcheck başlatılamadı'); }
    finally { setStarting(false); await refetch(); }
  };

  const log = st?.blockcheck?.log || '';
  return (
    <Panel title="Blockcheck" subtitle="Bu hatta hangi DPI atlatma stratejisinin çalıştığını test eder"
      badge={running ? <Badge variant="warning">Çalışıyor</Badge> : undefined}>
      <div className="form-group">
        <label><Globe size={14} /><span>Test alan adı</span></label>
        <input type="text" value={domain} onChange={e => setDomain(e.target.value)} placeholder="discord.com" disabled={running || starting} />
      </div>
      <button className="btn-primary btn-full" onClick={handleStart} disabled={running || starting || !domain.trim() || st?.installed === false}>
        {running ? 'Blockcheck çalışıyor…' : 'Blockcheck başlat'}
      </button>
      <p className="subtitle" style={{ marginTop: 10 }}>
        Hızlı tarama, IPv4, HTTP ve HTTPS (TLS 1.2). Zapret çalışıyorsa test süresince durdurulur, bitince eski durumuna döner.
        Sonuçtaki önerilen strateji Strateji sekmesinde anlatıldığı gibi uygulanır.
      </p>
      {log && <pre className="doc-code zapret-log">{log}</pre>}
    </Panel>
  );
}

function StrategyCard({ st }: { st: ZapretStatus | null }) {
  if (st && !st.installed) {
    return <Panel title="Strateji"><div className="empty-state" style={{ padding: 20 }}>Zapret bu cihazda kurulu değil.</div></Panel>;
  }
  return (
    <Panel title="nfqws Stratejisi" subtitle="/opt/zapret/config → NFQWS_OPT (salt okunur)">
      {!!st?.unlistedLines && (
        <div className="routing-apply routing-apply-err" style={{ marginTop: 0, marginBottom: 10 }}>
          <AlertTriangle size={14} />
          <span>{st.unlistedLines} strateji satırında &lt;HOSTLIST&gt; yok: o satır listeden bağımsız, tüm trafiğe uygulanır.</span>
        </div>
      )}
      <pre className="doc-code zapret-log">{st?.strategy || '—'}</pre>
      <p className="subtitle" style={{ marginTop: 12 }}>
        Panel yalnız NFQWS_ENABLE, TPWS_ENABLE, MODE_FILTER ve IFACE_WAN değerlerini yönetir; strateji satırlarına dokunmaz.
        Blockcheck'in önerdiği stratejiyi uygulamak için SSH'ta <code>sudo nano /opt/zapret/config</code> ile NFQWS_OPT'u değiştirip
        <code> sudo systemctl restart zapret</code> çalıştırın; her satırda &lt;HOSTLIST&gt; kalmalı. Özgün dosya ilk uygulamada
        config.pi5-orig olarak saklandı.
      </p>
      <p className="subtitle" style={{ marginTop: 8 }}>
        Yöntem yalnız nfqws: paketleri modem çıkışında işler ve VPS tüneline giden trafiğe dokunmaz. tpws web trafiğini Pi'deki
        bir vekile yönlendirir; bağlantı Pi'den yeniden açıldığı için VPS yönlendirmesi kaybolurdu, bu yüzden kapalı tutulur.
      </p>
    </Panel>
  );
}

function ZapretDomainManager({ listType, fromRouting, onChanged }: {
  listType: 'hostlist' | 'exclude'; fromRouting: string[]; onChanged: () => Promise<void>;
}) {
  const { data, refetch } = useApi<{ domains: ZapretDomain[] }>('/zapret/domains', { domains: [] });
  const items = data.domains.filter(d => d.list_type === listType);
  const [newDomain, setNewDomain] = useState('');
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');

  const filteredItems = filter ? items.filter(d => d.domain.includes(filter)) : items;

  const run = async (fn: () => Promise<{ zapret?: ZapretApply }>, okMsg: string) => {
    try {
      reportApply((await fn()).zapret, okMsg);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İşlem başarısız');
      return false;
    } finally {
      await Promise.all([refetch(), onChanged()]);
    }
  };

  const handleAdd = async () => {
    if (!newDomain.trim()) return;
    setAdding(true);
    if (await run(() => postApi('/zapret/domains', { list_type: listType, domain: newDomain.trim() }), 'Eklendi')) setNewDomain('');
    setAdding(false);
  };

  const handleToggle = (id: number, enabled: number) =>
    run(() => putApi(`/zapret/domains/${id}`, { enabled: !enabled }), enabled ? 'Devre dışı bırakıldı' : 'Etkinleştirildi');

  const handleDelete = (id: number) => run(() => deleteApi(`/zapret/domains/${id}`), 'Silindi');

  const title = listType === 'hostlist' ? 'Bypass Listesi' : 'Hariç Tutulanlar';
  const subtitle = listType === 'hostlist'
    ? 'DPI atlatma uygulanacak siteler; alt alan adları dahil (discord.com → cdn.discord.com)'
    : 'Bypass listesinde olsa bile DPI atlatma uygulanmayacak siteler';

  return (
    <Panel title={title} subtitle={subtitle} icon={<List size={18} style={{ marginRight: 8 }} />}>
      <div className="list-add-form">
        <div className="list-add-row">
          <input className="config-input list-input-main" type="text" placeholder="discord.com ya da *.discord.com"
            value={newDomain} onChange={e => setNewDomain(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()} />
          <button className="btn-primary btn-sm" onClick={handleAdd} disabled={adding || !newDomain.trim()}>
            <Plus size={14} /> Ekle
          </button>
        </div>
        {items.length > 5 && (
          <div className="list-filter">
            <Search size={13} />
            <input className="config-input" type="text" placeholder="Alan adı ara..."
              value={filter} onChange={e => setFilter(e.target.value)} />
          </div>
        )}
      </div>

      <div className="list-items">
        {filteredItems.length === 0 && <div className="empty-state" style={{ padding: '20px' }}>Kayıt bulunamadı.</div>}
        {filteredItems.map(item => (
          <div key={item.id} className={`list-item ${!item.enabled ? 'list-item-disabled' : ''}`}>
            <button
              className={`toggle-btn toggle-sm ${item.enabled ? 'toggle-on' : 'toggle-off'}`}
              onClick={() => handleToggle(item.id, item.enabled)}
              title={item.enabled ? 'Devre dışı bırak (Zapret listesinden çıkarılır)' : 'Etkinleştir'}
            >
              <div className="toggle-knob" />
            </button>
            <div className="list-item-content">
              <span className="list-item-value">{item.domain}</span>
            </div>
            <button className="icon-btn icon-btn-sm list-delete" onClick={() => handleDelete(item.id)} title="Sil">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="list-summary">
        <span>{items.filter(i => i.enabled).length} aktif</span>
        <span>{items.filter(i => !i.enabled).length} devre dışı</span>
        <span>{items.length} toplam</span>
      </div>

      {fromRouting.length > 0 && (
        <div className="pihole-external">
          <span className="list-item-comment">Routing'deki DPI kurallarından (çıkış ISP) — Routing sayfasından yönetilir:</span>
          <div className="list-items">
            {fromRouting.map(d => (
              <div key={d} className="list-item list-item-disabled"><span className="list-item-value">{d}</span></div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
