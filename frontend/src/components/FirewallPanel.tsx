import { Flame, Trash2, Shield, ArrowRight, Settings, Activity, Waypoints, Plus } from 'lucide-react';
import { useApi, postApi, deleteApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, Select } from './ui';
import { ServiceSettings } from './ui/ServiceSettings';
import type { FirewallRule } from '../types';
import { toast } from '../toast';

interface FirewallData {
  rules: { id: number; type: string; target: string; action: string; enabled: number }[];
  nftablesPreview: { inputRules: FirewallRule[]; forwardRules: FirewallRule[]; natRules: FirewallRule[] };
}

type FwTab = 'overview' | 'settings';

// Eylem rengi gerçek eyleme göre: izin yeşil, düşür/reddet kırmızı, diğerleri (masquerade vb.) nötr.
const actionClass = (a: string) =>
  a === 'accept' ? 'fw-action-accept' : a === 'drop' || a === 'reject' ? 'fw-action-deny' : 'fw-action-other';
const ACTION_LABEL: Record<string, string> = { accept: 'İzin ver', drop: 'Düşür', reject: 'Reddet', masquerade: 'Masquerade' };
const TYPE_LABEL: Record<string, string> = { tcp: 'TCP', udp: 'UDP', ip: 'Kaynak IP' };

export function FirewallPanel() {
  const [activeTab, setActiveTab] = useState<FwTab>('overview');
  const { data, refetch } = useApi<FirewallData>('/firewall/rules', { rules: [], nftablesPreview: { inputRules: [], forwardRules: [], natRules: [] } });
  const [deploying, setDeploying] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [fwType, setFwType] = useState('tcp');
  const [fwTarget, setFwTarget] = useState('');
  const [fwAction, setFwAction] = useState('accept');
  const [adding, setAdding] = useState(false);

  const handleDeploy = async () => {
    setDeploying(true);
    try { await postApi('/services/setup', { action: 'firewall' }); toast.success('nftables kuralları uygulandı.'); }
    catch (e: any) { toast.error(e.message); }
    setDeploying(false);
  };

  const handleAdd = async () => {
    const target = fwTarget.trim();
    if (!target) { toast.error('Hedef (port ya da IP) gerekli.'); return; }
    if (fwType === 'tcp' || fwType === 'udp') {
      const n = Number(target);
      if (!/^\d+$/.test(target) || n < 1 || n > 65535) { toast.error('Port 1-65535 arası bir sayı olmalı.'); return; }
    } else if (fwType === 'ip') {
      if (!/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(target)) { toast.error('Geçerli bir IPv4 ya da IPv4/CIDR girin (ör. 192.168.1.50 veya 10.0.0.0/24).'); return; }
    }
    setAdding(true);
    try {
      await postApi('/firewall/rules', { type: fwType, target, action: fwAction });
      setFwTarget(''); setShowForm(false);
      await refetch();
      // Kaydedilen kuralı nftables'a uygula (Pi dışında/başarısızsa kural yine kayıtlı kalır)
      try { await postApi('/services/setup', { action: 'firewall' }); toast.success('Kural eklendi ve uygulandı.'); }
      catch { toast.success('Kural kaydedildi. "Deploy Et" ile uygulayabilirsiniz.'); }
    } catch (e: any) { toast.error(e.message || 'Kural eklenemedi.'); }
    setAdding(false);
  };

  const handleDelete = async (id: number) => {
    try { await deleteApi(`/firewall/rules/${id}`); await refetch(); try { await postApi('/services/setup', { action: 'firewall' }); } catch { /* */ } } catch { /* */ }
  };
  const preview = data.nftablesPreview;

  const tabs: { id: FwTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Kurallar', icon: <Activity size={14} /> },
    { id: 'settings', label: 'Ayarlar', icon: <Settings size={14} /> },
  ];

  const categoryLabels: Record<string, string> = {
    policy: 'Zincir Politikaları',
    nat: 'NAT Ayarları',
    forwarding: 'Yönlendirme',
  };

  const categoryIcons: Record<string, React.ReactNode> = {
    policy: <Shield size={15} />,
    nat: <Flame size={15} />,
    forwarding: <Waypoints size={15} />,
  };

  return (
    <div className="fade-in">
      <Panel title="nftables Güvenlik Duvarı" icon={<Flame size={20} style={{ marginRight: 8 }} />}
        subtitle="Paket filtreleme, port yönetimi ve NAT kuralları"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-outline btn-sm" onClick={() => setShowForm(v => !v)}><Plus size={13} /> Kural Ekle</button>
            <button className="btn-primary btn-sm" onClick={handleDeploy} disabled={deploying}>{deploying ? 'Uygulanıyor...' : 'Deploy Et'}</button>
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
          {showForm && (
            <div className="glass-panel widget-large" style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Tür</label>
                <Select className="config-select" value={fwType} onChange={e => setFwType(e.target.value)} style={{ width: 130 }}>
                  <option value="tcp">TCP Port</option>
                  <option value="udp">UDP Port</option>
                  <option value="ip">Kaynak IP</option>
                </Select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Hedef</label>
                <input className="config-input" value={fwTarget} onChange={e => setFwTarget(e.target.value)}
                  placeholder={fwType === 'ip' ? '192.168.1.50 veya 10.0.0.0/24' : 'ör. 8080'} style={{ width: 200 }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Eylem</label>
                <Select className="config-select" value={fwAction} onChange={e => setFwAction(e.target.value)} style={{ width: 130 }}>
                  <option value="accept">İzin Ver</option>
                  <option value="drop">Düşür</option>
                  <option value="reject">Reddet</option>
                </Select>
              </div>
              <button className="btn-primary btn-sm" onClick={handleAdd} disabled={adding}>{adding ? 'Ekleniyor...' : 'Ekle'}</button>
            </div>
          )}
          {/* Her liste başlık satırlı bir ızgara: aynı türden değerler aynı sütunda alt alta hizalanır */}
          <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
            <div className="fw-section">
              <h4 className="fw-section-title"><Shield size={14} /> Input Chain <span className="fw-policy">policy: drop</span></h4>
              <div className="fw-table fw-cols-input" role="table">
                <div className="fw-row fw-head" role="row"><span>Port</span><span>Protokol</span><span>Eylem</span><span>Açıklama</span></div>
                {preview.inputRules.map((rule, i) => (
                  <div key={i} className="fw-row" role="row">
                    <span className="fw-port">{rule.port}</span>
                    <span className="fw-proto">{rule.protocol}</span>
                    <span className={actionClass(rule.action)}>{rule.action}</span>
                    <span className="fw-label">{rule.label}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="fw-section">
              <h4 className="fw-section-title"><ArrowRight size={14} /> Forward Chain <span className="fw-policy">policy: drop</span></h4>
              <div className="fw-table fw-cols-forward" role="table">
                <div className="fw-row fw-head" role="row"><span>Kaynak</span><span aria-hidden="true" /><span>Hedef</span><span>Eylem</span><span>Açıklama</span></div>
                {preview.forwardRules.map((rule, i) => (
                  <div key={i} className="fw-row" role="row">
                    <span className="fw-iface">{rule.from}</span>
                    <ArrowRight size={12} className="fw-arrow" />
                    <span className="fw-iface">{rule.to}</span>
                    <span className={actionClass(rule.action)}>{rule.action}</span>
                    <span className="fw-label">{rule.label}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="fw-section">
              <h4 className="fw-section-title"><Flame size={14} /> NAT</h4>
              <div className="fw-table fw-cols-nat" role="table">
                <div className="fw-row fw-head" role="row"><span>Arayüz</span><span>Eylem</span><span>Açıklama</span></div>
                {preview.natRules.map((rule, i) => (
                  <div key={i} className="fw-row" role="row">
                    <span className="fw-iface">{rule.interface}</span>
                    <span className={actionClass(rule.action)}>{rule.action}</span>
                    <span className="fw-label">{rule.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          {data.rules.length > 0 && (
            <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
              <h4 className="widget-title">Özel Kurallar</h4>
              <div className="fw-table fw-cols-custom" role="table">
                <div className="fw-row fw-head" role="row"><span>Tür</span><span>Hedef</span><span>Eylem</span><span aria-hidden="true" /></div>
                {data.rules.map(rule => (
                  <div key={rule.id} className="fw-row" role="row">
                    <span className="fw-proto">{TYPE_LABEL[rule.type] || rule.type}</span>
                    <span className="fw-iface">{rule.target}</span>
                    <span className={actionClass(rule.action)}>{ACTION_LABEL[rule.action] || rule.action}</span>
                    <button className="icon-btn icon-btn-sm" onClick={() => handleDelete(rule.id)} title="Kuralı sil" aria-label="Kuralı sil">
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === 'settings' && (
        <div style={{ marginTop: 14 }}>
          <ServiceSettings service="nftables" categoryLabels={categoryLabels} categoryIcons={categoryIcons} />
        </div>
      )}
    </div>
  );
}
