import { Flame, Trash2, Shield, ArrowRight, Settings, Activity, Waypoints, Plus, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, Select, Badge } from './ui';
import { ServiceSettings } from './ui/ServiceSettings';
import { toast } from '../toast';

// Kurallar ve önizleme GET /firewall/rules'tan: önizleme, yüklenecek yapılandırmayla aynı üreticiden (backend
// services.ts buildNftables) gelir — eskiden sabit bir listeydi (port 3000, eth0 → wlan0).
interface FwRuleRow { id: number; type: string; target: string; port: string; proto: string; action: string; enabled: number; ignored?: boolean }
interface NftLine { rule: string; label: string; kind: 'system' | 'custom' | 'service' }
interface FwPreview {
  input: NftLine[]; forward: NftLine[]; nat: NftLine[]; mode: string; lanIfs: string[]; wanIfs: string[];
  deployed: boolean; loaded: boolean; pending: boolean; error?: string;
}
interface FirewallData { rules: FwRuleRow[]; preview: FwPreview | null }

type FwTab = 'overview' | 'settings';

const actionClass = (a: string) =>
  a === 'accept' ? 'fw-action-accept' : a === 'drop' || a === 'reject' ? 'fw-action-deny' : 'fw-action-other';
const ACTION_LABEL: Record<string, string> = { accept: 'İzin ver', drop: 'Düşür', reject: 'Reddet' };
const TYPE_LABEL: Record<string, string> = { tcp: 'TCP port', udp: 'UDP port', ip: 'Kaynak IP' };
const PROTO_LABEL: Record<string, string> = { tcp: 'TCP', udp: 'UDP', both: 'TCP/UDP' };
const MODE_LABEL: Record<string, string> = {
  oneArm: 'tek bacak (modem ile aynı ağ)', wan: 'internet kartı', sameNet: 'Wi-Fi köprüsü (aynı ağ)', twoCard: 'iki kart',
};
const ruleTarget = (r: FwRuleRow) =>
  r.type === 'ip' ? `${r.target}${r.port ? ` → ${PROTO_LABEL[r.proto] || 'TCP'} ${r.port}` : ' (tüm erişim)'}` : r.target;
const IPV4_CIDR = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(\/([12]?\d|3[0-2]))?$/;

export function FirewallPanel() {
  const [activeTab, setActiveTab] = useState<FwTab>('overview');
  const { data, refetch } = useApi<FirewallData>('/firewall/rules', { rules: [], preview: null });
  const [deploying, setDeploying] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [fwType, setFwType] = useState('tcp');
  const [fwTarget, setFwTarget] = useState('');
  const [fwPort, setFwPort] = useState('');
  const [fwProto, setFwProto] = useState('tcp');
  const [fwAction, setFwAction] = useState('drop');
  const [busy, setBusy] = useState(false);

  const handleDeploy = async () => {
    setDeploying(true);
    try { await postApi('/services/setup', { action: 'firewall' }); toast.success('Güvenlik duvarı kuralları uygulandı.'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Uygulanamadı'); }
    await refetch();
    setDeploying(false);
  };

  // Sunucu kuralı doğrular, uygulanınca bu cihazın panele erişimini kesecekse reddeder ve (güvenlik duvarı kuruluysa)
  // hemen uygular; uygulanamazsa kural eklenmez.
  const report = (r: { applied?: boolean; warning?: string }, done: string) => {
    if (r.warning) toast.info(r.warning);
    if (r.applied) toast.success(`${done} ve uygulandı.`);
    else toast.info(`${done}. Güvenlik duvarı henüz kurulu değil: "Deploy Et" ile kurulur.`);
  };

  const handleAdd = async () => {
    const target = fwTarget.trim();
    const port = fwPort.trim();
    if (!target) { toast.error('Hedef (port ya da IP) gerekli.'); return; }
    if (fwType === 'tcp' || fwType === 'udp') {
      const n = Number(target);
      if (!/^\d+$/.test(target) || n < 1 || n > 65535) { toast.error('Port 1-65535 arası bir sayı olmalı.'); return; }
    } else {
      if (!IPV4_CIDR.test(target)) { toast.error('Geçerli bir IPv4 ya da IPv4/önek girin (ör. 192.168.1.50 veya 192.168.1.0/24).'); return; }
      if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) { toast.error('Port 1-65535 arası bir sayı olmalı.'); return; }
    }
    setBusy(true);
    try {
      const r = await postApi('/firewall/rules', { type: fwType, target, port: fwType === 'ip' ? port : '', proto: fwType === 'ip' && port ? fwProto : '', action: fwAction });
      setFwTarget(''); setFwPort(''); setShowForm(false);
      report(r, 'Kural eklendi');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Kural eklenemedi.'); }
    await refetch();
    setBusy(false);
  };

  const handleToggle = async (rule: FwRuleRow) => {
    setBusy(true);
    try { report(await putApi(`/firewall/rules/${rule.id}`, { enabled: rule.enabled ? 0 : 1 }), rule.enabled ? 'Kural kapatıldı' : 'Kural açıldı'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Değiştirilemedi.'); }
    await refetch();
    setBusy(false);
  };

  const handleDelete = async (rule: FwRuleRow) => {
    setBusy(true);
    try { report(await deleteApi(`/firewall/rules/${rule.id}`), 'Kural silindi'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Silinemedi.'); }
    await refetch();
    setBusy(false);
  };

  const preview = data.preview;
  const tabs: { id: FwTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Kurallar', icon: <Activity size={14} /> },
    { id: 'settings', label: 'Ayarlar', icon: <Settings size={14} /> },
  ];

  const section = (title: React.ReactNode, lines: NftLine[], policy?: string) => (
    <div className="fw-section">
      <h4 className="fw-section-title">{title}{policy && <span className="fw-policy">politika: {policy}</span>}</h4>
      <div className="fw-table fw-cols-rule" role="table">
        <div className="fw-row fw-head" role="row"><span>Kural (sırayla)</span><span>Açıklama</span></div>
        {lines.map((l, i) => (
          <div key={i} className={`fw-row ${l.kind === 'custom' ? 'fw-row-custom' : ''}`} role="row">
            <span className={/ (drop|reject)$/.test(l.rule) ? 'fw-action-deny' : undefined}>{l.rule}</span>
            <span className="fw-label">{l.label}</span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="fade-in">
      <Panel title="nftables Güvenlik Duvarı" icon={<Flame size={20} style={{ marginRight: 8 }} />}
        subtitle="Pi'ye gelen bağlantılar, ev ağından iletim ve adres çevirisi"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-outline btn-sm" onClick={() => setShowForm(v => !v)}><Plus size={13} /> Kural Ekle</button>
            <button className="btn-primary btn-sm" onClick={handleDeploy} disabled={deploying || busy}>{deploying ? 'Uygulanıyor...' : 'Deploy Et'}</button>
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
          {preview && !preview.error && (
            <div className={`fw-state ${!preview.deployed || preview.pending ? 'fw-state-warn' : 'fw-state-ok'}`}>
              {!preview.deployed ? <><Info size={14} /> Güvenlik duvarı kurulu değil. "Deploy Et" ile kurulur: aşağıdaki kurallar yüklenir, izin verilmeyen gelen bağlantılar düşürülür.</>
                : !preview.loaded ? <><AlertTriangle size={14} /> Kurallar kayıtlı ama şu an yüklü değil — "Deploy Et" ile yeniden yükleyin.</>
                : preview.pending ? <><AlertTriangle size={14} /> Uygulanmamış değişiklik var (ör. ağ düzeni değişti) — "Deploy Et" ile uygulayın.</>
                : <><CheckCircle2 size={14} /> Kurallar yüklü ve güncel · {MODE_LABEL[preview.mode] || preview.mode} · ev ağı: {preview.lanIfs.join(', ')}</>}
            </div>
          )}
          {showForm && (
            <div className="glass-panel widget-large" style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Tür</label>
                  <Select className="config-select" value={fwType} onChange={e => setFwType(e.target.value)} style={{ width: 130 }}>
                    <option value="tcp">TCP port</option>
                    <option value="udp">UDP port</option>
                    <option value="ip">Kaynak IP</option>
                  </Select>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fwType === 'ip' ? 'Cihaz / ağ' : "Pi'nin portu"}</label>
                  <input className="config-input" value={fwTarget} onChange={e => setFwTarget(e.target.value)}
                    placeholder={fwType === 'ip' ? '192.168.1.50 veya 192.168.1.0/24' : 'ör. 8080'} style={{ width: 200 }} />
                </div>
                {fwType === 'ip' && (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Port (isteğe bağlı)</label>
                      <input className="config-input" value={fwPort} onChange={e => setFwPort(e.target.value)} placeholder="boş = tüm erişim" style={{ width: 130 }} />
                    </div>
                    {fwPort.trim() && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Protokol</label>
                        <Select className="config-select" value={fwProto} onChange={e => setFwProto(e.target.value)} style={{ width: 110 }}>
                          <option value="tcp">TCP</option>
                          <option value="udp">UDP</option>
                          <option value="both">TCP/UDP</option>
                        </Select>
                      </div>
                    )}
                  </>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Eylem</label>
                  <Select className="config-select" value={fwAction} onChange={e => setFwAction(e.target.value)} style={{ width: 130 }}>
                    <option value="drop">Düşür</option>
                    <option value="reject">Reddet</option>
                    <option value="accept">İzin ver</option>
                  </Select>
                </div>
                <button className="btn-primary btn-sm" onClick={handleAdd} disabled={busy}>{busy ? 'Ekleniyor...' : 'Ekle'}</button>
              </div>
              <div className="fw-hint">
                {fwType === 'ip'
                  ? (fwPort.trim()
                    ? `Bu cihaz Pi'nin yalnız ${fwPort.trim()} portuna ulaşamaz / ulaşır; DNS ve öbür hizmetler sürer (ör. misafir cihaz panel 80 / SSH 22'ye giremez).`
                    : "Port boşken cihazın Pi'ye TÜM erişimi etkilenir — DNS dahil: cihaz Pi-hole kullanıyorsa interneti de gider.")
                  : "Pi'nin bu portu herkes için. Özel kurallar sabit izinlerden (SSH, DNS, panel) önce değerlendirilir. Evdeki cihazların internetini kesmek için Cihaz Yönetimi → engelle."}
                {' '}Panele eriştiğiniz cihazı dışarıda bırakan kural kabul edilmez.
              </div>
            </div>
          )}

          {data.rules.length > 0 && (
            <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
              <h4 className="widget-title">Özel Kurallar <span className="fw-sub">sırayla, sabit izinlerden önce</span></h4>
              <div className="fw-table fw-cols-custom2" role="table">
                <div className="fw-row fw-head" role="row"><span>Tür</span><span>Hedef</span><span>Eylem</span><span>Durum</span><span aria-hidden="true" /></div>
                {data.rules.map(rule => (
                  <div key={rule.id} className={`fw-row ${rule.enabled ? '' : 'fw-row-off'}`} role="row">
                    <span className="fw-proto">{TYPE_LABEL[rule.type] || rule.type}</span>
                    <span className="fw-iface">
                      {ruleTarget(rule)}
                      {rule.ignored && <span style={{ marginLeft: 6 }} title="Panele herkesin erişimini keseceği için uygulanmıyor"><Badge variant="warning">uygulanmıyor</Badge></span>}
                    </span>
                    <span className={actionClass(rule.action)}>{ACTION_LABEL[rule.action] || rule.action}</span>
                    <button className={`toggle-btn toggle-sm ${rule.enabled ? 'toggle-on' : 'toggle-off'}`} disabled={busy}
                      onClick={() => handleToggle(rule)} aria-label={rule.enabled ? 'Kuralı kapat' : 'Kuralı aç'} title={rule.enabled ? 'Kapat' : 'Aç'}>
                      <div className="toggle-knob" />
                    </button>
                    <button className="icon-btn icon-btn-sm" onClick={() => handleDelete(rule)} disabled={busy} title="Kuralı sil" aria-label="Kuralı sil">
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
            {!preview ? (
              <div className="fw-hint">Önizleme yalnız Pi üzerinde üretilir.</div>
            ) : preview.error ? (
              <div className="fw-hint">Önizleme üretilemedi: {preview.error}</div>
            ) : (
              <>
                {section(<><Shield size={14} /> Pi'ye gelen (input)</>, preview.input, 'drop')}
                {section(<><ArrowRight size={14} /> İletilen (forward)</>, preview.forward, 'drop')}
                {section(<><Flame size={14} /> Adres çevirisi (NAT)</>, preview.nat)}
              </>
            )}
          </div>
        </>
      )}

      {activeTab === 'settings' && (
        <div style={{ marginTop: 14 }}>
          <ServiceSettings service="nftables" categoryLabels={{ forwarding: 'Arayüzler (iki kartlı eski düzen)' }}
            categoryIcons={{ forwarding: <Waypoints size={15} /> }} restartLabel="Kuralları yeniden uygula" />
        </div>
      )}
    </div>
  );
}
