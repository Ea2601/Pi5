import { Flame, Trash2, Shield, ArrowRight, Settings, Activity, Waypoints, Plus } from 'lucide-react';
import { useApi, postApi, deleteApi } from '../hooks/useApi';
import { useState } from 'react';
import { Panel, Alert } from './ui';
import { ServiceSettings } from './ui/ServiceSettings';
import type { FirewallRule } from '../types';

interface FirewallData {
  rules: { id: number; type: string; target: string; action: string; enabled: number }[];
  nftablesPreview: { inputRules: FirewallRule[]; forwardRules: FirewallRule[]; natRules: FirewallRule[] };
}

type FwTab = 'overview' | 'settings';

export function FirewallPanel() {
  const [activeTab, setActiveTab] = useState<FwTab>('overview');
  const { data, refetch } = useApi<FirewallData>('/firewall/rules', { rules: [], nftablesPreview: { inputRules: [], forwardRules: [], natRules: [] } });
  const [deploying, setDeploying] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [fwType, setFwType] = useState('tcp');
  const [fwTarget, setFwTarget] = useState('');
  const [fwAction, setFwAction] = useState('accept');
  const [adding, setAdding] = useState(false);

  const handleDeploy = async () => {
    setDeploying(true); setResult(null);
    try { await postApi('/services/setup', { action: 'firewall' }); setResult({ type: 'success', msg: 'nftables kuralları uygulandı.' }); }
    catch (e: any) { setResult({ type: 'error', msg: e.message }); }
    setDeploying(false);
  };

  const handleAdd = async () => {
    const target = fwTarget.trim();
    if (!target) { setResult({ type: 'error', msg: 'Hedef (port ya da IP) gerekli.' }); return; }
    if (fwType === 'tcp' || fwType === 'udp') {
      const n = Number(target);
      if (!/^\d+$/.test(target) || n < 1 || n > 65535) { setResult({ type: 'error', msg: 'Port 1-65535 arası bir sayı olmalı.' }); return; }
    } else if (fwType === 'ip') {
      if (!/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(target)) { setResult({ type: 'error', msg: 'Geçerli bir IPv4 ya da IPv4/CIDR girin (ör. 192.168.1.50 veya 10.0.0.0/24).' }); return; }
    }
    setAdding(true); setResult(null);
    try {
      await postApi('/firewall/rules', { type: fwType, target, action: fwAction });
      setFwTarget(''); setShowForm(false);
      await refetch();
      // Kaydedilen kuralı nftables'a uygula (Pi dışında/başarısızsa kural yine kayıtlı kalır)
      try { await postApi('/services/setup', { action: 'firewall' }); setResult({ type: 'success', msg: 'Kural eklendi ve uygulandı.' }); }
      catch { setResult({ type: 'success', msg: 'Kural kaydedildi. "Deploy Et" ile uygulayabilirsiniz.' }); }
    } catch (e: any) { setResult({ type: 'error', msg: e.message || 'Kural eklenemedi.' }); }
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
                <select className="config-select" value={fwType} onChange={e => setFwType(e.target.value)} style={{ width: 130 }}>
                  <option value="tcp">TCP Port</option>
                  <option value="udp">UDP Port</option>
                  <option value="ip">Kaynak IP</option>
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Hedef</label>
                <input className="config-input" value={fwTarget} onChange={e => setFwTarget(e.target.value)}
                  placeholder={fwType === 'ip' ? '192.168.1.50 veya 10.0.0.0/24' : 'ör. 8080'} style={{ width: 200 }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>Eylem</label>
                <select className="config-select" value={fwAction} onChange={e => setFwAction(e.target.value)} style={{ width: 130 }}>
                  <option value="accept">İzin Ver</option>
                  <option value="drop">Düşür</option>
                  <option value="reject">Reddet</option>
                </select>
              </div>
              <button className="btn-primary btn-sm" onClick={handleAdd} disabled={adding}>{adding ? 'Ekleniyor...' : 'Ekle'}</button>
            </div>
          )}
          <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
            {result && <Alert type={result.type} message={result.msg} />}
            <div className="fw-section">
              <h4 className="fw-section-title"><Shield size={14} /> Input Chain <span className="fw-policy">policy: drop</span></h4>
              <div className="fw-rules">
                {preview.inputRules.map((rule, i) => (
                  <div key={i} className="fw-rule"><span className="fw-port">{rule.port}</span><span className="fw-proto">{rule.protocol}</span><ArrowRight size={12} /><span className="fw-action-accept">{rule.action}</span><span className="fw-label">{rule.label}</span></div>
                ))}
              </div>
            </div>
            <div className="fw-section">
              <h4 className="fw-section-title"><ArrowRight size={14} /> Forward Chain <span className="fw-policy">policy: drop</span></h4>
              <div className="fw-rules">
                {preview.forwardRules.map((rule, i) => (
                  <div key={i} className="fw-rule"><span className="fw-iface">{rule.from}</span><ArrowRight size={12} /><span className="fw-iface">{rule.to}</span><span className="fw-action-accept">{rule.action}</span><span className="fw-label">{rule.label}</span></div>
                ))}
              </div>
            </div>
            <div className="fw-section">
              <h4 className="fw-section-title"><Flame size={14} /> NAT</h4>
              <div className="fw-rules">
                {preview.natRules.map((rule, i) => (
                  <div key={i} className="fw-rule"><span className="fw-iface">{rule.interface}</span><ArrowRight size={12} /><span className="fw-action-accept">{rule.action}</span><span className="fw-label">{rule.label}</span></div>
                ))}
              </div>
            </div>
          </div>
          {data.rules.length > 0 && (
            <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
              <h4 className="widget-title">Özel Kurallar</h4>
              <div className="fw-custom-rules">
                {data.rules.map(rule => (
                  <div key={rule.id} className="fw-rule"><span className="fw-proto">{rule.type}</span><span className="fw-iface">{rule.target}</span><span className="fw-action-accept">{rule.action}</span>
                    <button className="icon-btn icon-btn-sm" onClick={() => handleDelete(rule.id)}><Trash2 size={12} /></button></div>
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
