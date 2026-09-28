import { ShieldBan, Search, BarChart3, Globe, Users, ArrowRight, Settings, List, Plus, Trash2, Check, X, Server, Lock, Gauge, Radio, RefreshCw, AlertTriangle } from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, StatCard, Badge } from './ui';
import { ServiceSettings } from './ui/ServiceSettings';
import type { PiholeStats, ServiceStatus, PiholeListItem } from '../types';
import { toast } from '../toast';

type PiholeTab = 'overview' | 'settings' | 'blocklists' | 'whitelist' | 'blacklist' | 'localdns';

export function PiholePanel() {
  const [activeTab, setActiveTab] = useState<PiholeTab>('overview');
  const { data: stats } = useApi<PiholeStats>('/pihole/stats', {
    domainsBlocked: 0, dnsQueriesToday: 0, adsBlockedToday: 0,
    adsPercentageToday: 0, uniqueClients: 0, queriesForwarded: 0,
    queriesCached: 0, topBlockedDomains: [], queryTypes: {},
  }, 10000);
  const { data: svcData, refetch: refetchSvc } = useApi<{ services: ServiceStatus[] }>('/services', { services: [] });
  const piholeSvc = svcData.services.find(s => s.name === 'pihole');
  const isEnabled = piholeSvc?.enabled === 1;
  const [toggling, setToggling] = useState(false);

  // Anahtar kalıcıdır (açılışta da geçerli): Pi-hole kapanırsa Pi'yi DNS olarak kullanan cihazların interneti kesilir.
  const handleToggle = async () => {
    if (isEnabled && !confirm('Pi-hole durdurulursa Pi\'yi DNS olarak kullanan tüm cihazların interneti kesilir ve Pi yeniden başlasa da kapalı kalır. Devam edilsin mi?')) return;
    setToggling(true);
    try {
      const result = await postApi('/services/toggle', { name: 'pihole', enabled: !isEnabled });
      if (!result.success) {
        toast.error(result.error || 'Servis değiştirilemedi');
      } else {
        toast.success(isEnabled ? 'Pi-hole durduruldu' : 'Pi-hole başlatıldı');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İstek başarısız');
    }
    await refetchSvc();
    setToggling(false);
  };

  const tabs: { id: PiholeTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Genel Bakış', icon: <BarChart3 size={14} /> },
    { id: 'settings', label: 'Ayarlar', icon: <Settings size={14} /> },
    { id: 'blocklists', label: 'Bloklisteleri', icon: <ShieldBan size={14} /> },
    { id: 'whitelist', label: 'Beyaz Liste', icon: <Check size={14} /> },
    { id: 'blacklist', label: 'Kara Liste', icon: <X size={14} /> },
    { id: 'localdns', label: 'Yerel DNS', icon: <Globe size={14} /> },
  ];

  const categoryLabels: Record<string, string> = {
    dns: 'DNS Ayarları',
    blocking: 'Engelleme',
    dhcp: 'DHCP Sunucu',
    privacy: 'Gizlilik & Kayıtlar',
    ratelimit: 'Hız Limitleme',
  };

  const categoryIcons: Record<string, React.ReactNode> = {
    dns: <Server size={15} />,
    blocking: <ShieldBan size={15} />,
    dhcp: <Radio size={15} />,
    privacy: <Lock size={15} />,
    ratelimit: <Gauge size={15} />,
  };

  return (
    <div className="fade-in">
      <Panel title="Pi-hole DNS Reklam Engelleme" icon={<ShieldBan size={20} style={{ marginRight: 8 }} />}
        subtitle="Headless Pi-hole + Unbound DNS — Reklam & tracker bloklama"
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Badge variant={isEnabled ? 'success' : 'neutral'}>{isEnabled ? 'Aktif' : 'Pasif'}</Badge>
            <button
              className={`toggle-btn ${isEnabled ? 'toggle-on' : 'toggle-off'}`}
              onClick={handleToggle} disabled={toggling}
              title={isEnabled ? 'Devre dışı bırak' : 'Etkinleştir'}
            >
              <div className="toggle-knob" />
            </button>
          </div>
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
          <div className="stats-grid stats-grid-4" style={{ marginTop: 14 }}>
            <StatCard icon={<Globe size={20} />} label="Bloklistesi" value={stats.domainsBlocked.toLocaleString('tr-TR')} color="blue" />
            <StatCard icon={<Search size={20} />} label="DNS Sorguları" value={stats.dnsQueriesToday.toLocaleString('tr-TR')} color="green" />
            <StatCard icon={<ShieldBan size={20} />} label="Engellenen" value={stats.adsBlockedToday.toLocaleString('tr-TR')} color="orange" />
            <StatCard icon={<Users size={20} />} label="İstemciler" value={stats.uniqueClients} color="purple" />
          </div>
          <div className="panel-row" style={{ marginTop: 14 }}>
            <Panel title="En Çok Engellenen Domainler" size="medium">
              <div className="blocked-list">
                {stats.topBlockedDomains.map((item, i) => (
                  <div key={item.domain} className="blocked-item">
                    <span className="blocked-rank">#{i + 1}</span>
                    <span className="blocked-domain">{item.domain}</span>
                    <span className="blocked-count">{item.count.toLocaleString('tr-TR')}</span>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="Sorgu Dağılımı" icon={<BarChart3 size={16} style={{ marginRight: 6 }} />} size="medium">
              <div className="query-types">
                {Object.entries(stats.queryTypes).map(([type, pct]) => (
                  <div key={type} className="query-type-row">
                    <span className="qt-label">{type}</span>
                    <div className="progress-bar"><div className="progress-fill progress-cpu" style={{ width: `${pct}%` }} /></div>
                    <span className="qt-val">{pct}%</span>
                  </div>
                ))}
              </div>
              <div className="pihole-flow">
                <span>Forwarded: <strong>{stats.queriesForwarded.toLocaleString('tr-TR')}</strong></span>
                <ArrowRight size={14} />
                <span>Cached: <strong>{stats.queriesCached.toLocaleString('tr-TR')}</strong></span>
              </div>
            </Panel>
          </div>
        </>
      )}

      {activeTab === 'settings' && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* DHCP ayarları kendi sayfasında (menü → DHCP Ayarları, adres #dhcp) */}
          <ServiceSettings service="pihole" categoryLabels={categoryLabels} categoryIcons={categoryIcons} excludeCategories={['dhcp']} />
        </div>
      )}

      {(activeTab === 'blocklists' || activeTab === 'whitelist' || activeTab === 'blacklist' || activeTab === 'localdns') && (
        <div style={{ marginTop: 14 }}>
          <PiholeListManager listType={activeTab === 'blocklists' ? 'adlist' : activeTab} />
        </div>
      )}
    </div>
  );
}

// Paneldeki kayıtlar Pi-hole'a gerçekten uygulanır (backend piholeLists.ts): her değişiklikten sonra eşitlenir.
// Panelin eklediği kayıtlar Pi-hole'da "klyrix" açıklamasıyla işaretlidir; Pi-hole'a kendi arayüzünden eklenmiş
// kayıtlar aşağıda salt okunur gösterilir ve eşitleme onlara dokunmaz.
interface ListSync { ok: boolean; added: number; removed: number; gravity: boolean; errors: string[]; at: number }
interface ExternalEntries { whitelist: string[]; blacklist: string[]; adlist: string[]; localdns: string[] }

function PiholeListManager({ listType }: { listType: string }) {
  const { data, refetch } = useApi<{ lists: PiholeListItem[]; sync?: ListSync | null; external?: ExternalEntries | null }>(
    '/pihole/lists?external=1', { lists: [] });
  const items = data.lists.filter(l => l.list_type === listType);
  // undefined = henüz yanıt yok, null = Pi-hole okunamadı
  const external = data.external === undefined ? undefined : data.external === null ? null
    : data.external[listType as keyof ExternalEntries] || [];
  const [newValue, setNewValue] = useState('');
  const [newComment, setNewComment] = useState('');
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const labels: Record<string, { title: string; placeholder: string; commentPh: string; hint: string }> = {
    adlist: { title: 'Bloklisteleri', placeholder: 'https://example.com/hosts.txt', commentPh: 'Liste açıklaması',
      hint: 'Eklenen liste Pi-hole\'a yazılır ve liste indirme (gravity) arka planda başlar; birkaç dakika sürebilir.' },
    whitelist: { title: 'Beyaz Liste (İzin Verilen)', placeholder: 'example.com ya da *.example.com', commentPh: 'Neden izin verildi?',
      hint: '"*.site.com" alt alan adlarını da kapsar. Pi-hole\'a hemen uygulanır.' },
    blacklist: { title: 'Kara Liste (Engellenen)', placeholder: 'tracking.example.com ya da *.example.com', commentPh: 'Neden engellendi?',
      hint: '"*.site.com" alt alan adlarını da kapsar. Pi-hole\'a hemen uygulanır.' },
    localdns: { title: 'Yerel DNS Kayıtları', placeholder: '192.168.0.50 nas.lan', commentPh: 'Açıklama',
      hint: 'Biçim: "IP ad". Ağdaki cihazlar bu adı Pi-hole üzerinden bu IP\'ye çözer.' },
  };
  const l = labels[listType] || labels.adlist;

  // Sunucu yanıtındaki eşitleme sonucunu bildir: kayıt her durumda saklanır, Pi-hole'a uygulanamadıysa neden yazılır.
  const report = (sync: ListSync | undefined, okMsg: string) => {
    if (!sync) { toast.success(okMsg); return; }
    if (!sync.ok) toast.error(`Kaydedildi ama Pi-hole'a uygulanamadı: ${sync.errors.join('; ') || 'bilinmeyen hata'}`);
    else toast.success(sync.gravity ? `${okMsg} — liste indiriliyor (birkaç dakika)` : `${okMsg} ve Pi-hole'a uygulandı`);
  };
  const run = async (fn: () => Promise<{ sync?: ListSync }>, okMsg: string) => {
    try {
      report((await fn()).sync, okMsg);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İşlem başarısız');
      return false;
    } finally {
      await refetch();
    }
  };

  const handleAdd = async () => {
    if (!newValue.trim()) return;
    setAdding(true);
    if (await run(() => postApi('/pihole/lists', { list_type: listType, value: newValue.trim(), comment: newComment.trim() }), 'Eklendi')) {
      setNewValue('');
      setNewComment('');
    }
    setAdding(false);
  };

  const handleToggle = (id: number, currentEnabled: number) =>
    run(() => putApi(`/pihole/lists/${id}`, { enabled: currentEnabled ? 0 : 1 }), currentEnabled ? 'Devre dışı bırakıldı' : 'Etkinleştirildi');

  const handleDelete = (id: number) => run(() => deleteApi(`/pihole/lists/${id}`), 'Silindi');

  const handleSync = async () => {
    setSyncing(true);
    await run(() => postApi('/pihole/lists/sync', {}), 'Eşitlendi');
    setSyncing(false);
  };

  const sync = data.sync;
  return (
    <Panel title={l.title} icon={<List size={18} style={{ marginRight: 8 }} />}
      actions={
        <button className="btn-outline btn-sm" onClick={handleSync} disabled={syncing} title="Paneldeki kayıtları Pi-hole'a yeniden uygula">
          <RefreshCw size={13} className={syncing ? 'spin' : ''} /> Pi-hole'a uygula
        </button>
      }>
      <p className="subtitle" style={{ marginBottom: 10 }}>{l.hint}</p>
      {sync && !sync.ok && (
        <div className="routing-apply routing-apply-err" style={{ marginTop: 0, marginBottom: 10 }}>
          <AlertTriangle size={14} />
          <span>Son eşitleme başarısız: {sync.errors.join('; ')}</span>
        </div>
      )}
      <div className="list-add-form">
        <div className="list-add-row">
          <input className="config-input list-input-main" type="text" placeholder={l.placeholder}
            value={newValue} onChange={e => setNewValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()} />
          <input className="config-input list-input-comment" type="text" placeholder={l.commentPh}
            value={newComment} onChange={e => setNewComment(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()} />
          <button className="btn-primary btn-sm" onClick={handleAdd} disabled={adding || !newValue.trim()}>
            <Plus size={14} /> Ekle
          </button>
        </div>
      </div>

      <div className="list-items">
        {items.length === 0 && <div className="empty-state" style={{ padding: '20px' }}>Bu listede panelden eklenmiş kayıt yok.</div>}
        {items.map(item => (
          <div key={item.id} className={`list-item ${!item.enabled ? 'list-item-disabled' : ''}`}>
            <button
              className={`toggle-btn toggle-sm ${item.enabled ? 'toggle-on' : 'toggle-off'}`}
              onClick={() => handleToggle(item.id, item.enabled)}
              title={item.enabled ? 'Devre dışı bırak (Pi-hole\'dan kaldırılır)' : 'Etkinleştir'}
            >
              <div className="toggle-knob" />
            </button>
            <div className="list-item-content">
              <span className="list-item-value">{item.value}</span>
              {item.comment && <span className="list-item-comment">{item.comment}</span>}
            </div>
            <button className="icon-btn icon-btn-sm list-delete" onClick={() => handleDelete(item.id)} title="Sil">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      {external && external.length > 0 && (
        <div className="pihole-external">
          <span className="list-item-comment">Pi-hole'da ayrıca ekli (Pi-hole'un kendi arayüzünden; panel dokunmaz):</span>
          <div className="list-items">
            {external.map(v => (
              <div key={v} className="list-item list-item-disabled"><span className="list-item-value">{v}</span></div>
            ))}
          </div>
        </div>
      )}
      {external === null && (
        <span className="list-item-comment" style={{ display: 'block', marginTop: 10 }}>
          Pi-hole'daki mevcut kayıtlar okunamadı (Pi-hole çalışmıyor olabilir).
        </span>
      )}
    </Panel>
  );
}

