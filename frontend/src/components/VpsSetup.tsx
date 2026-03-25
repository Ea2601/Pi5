import {
  Server, Lock, Globe, Loader2, CheckCircle, AlertTriangle, Trash2, Plus,
  Wifi, Settings, Activity, Network, Eye, EyeOff, Copy, X, QrCode, Users
} from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useApi, postApi, deleteApi } from '../hooks/useApi';
import { ServiceSettings } from './ui/ServiceSettings';
import type { VpsServer } from '../types';

type SetupState = 'idle' | 'deploying' | 'success' | 'error';
type VpsTab = 'overview' | 'clients' | 'settings';
type StepStatus = 'pending' | 'running' | 'success' | 'error';

interface SetupStep {
  key: string;
  label: string;
  status: StepStatus;
  message: string;
  duration: string;
}

interface WgClient {
  id: number;
  vps_id: number;
  name: string;
  ip: string;
  public_key: string;
  config: string;
  qr_data: string;
  created_at: string;
}

const SETUP_STEPS: { key: string; label: string }[] = [
  { key: 'connection', label: 'Baglanti Kontrolu' },
  { key: 'update', label: 'Sistem Guncellemesi' },
  { key: 'packages', label: 'Paket Kurulumu' },
  { key: 'maintenance', label: 'Gunluk Bakim Ayarlari' },
  { key: 'wireguard', label: 'WireGuard Kurulumu' },
  { key: 'handshake', label: 'Handshake Dogrulama' },
];

function StepIndicator({ step }: { step: SetupStep }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px', borderRadius: 'var(--radius-sm)',
      background: step.status === 'running' ? 'var(--accent-glow)' :
        step.status === 'success' ? 'var(--success-glow)' :
        step.status === 'error' ? 'var(--danger-glow)' : 'rgba(255,255,255,0.01)',
      border: '1px solid',
      borderColor: step.status === 'running' ? 'rgba(59,130,246,0.2)' :
        step.status === 'success' ? 'rgba(34,197,94,0.2)' :
        step.status === 'error' ? 'rgba(239,68,68,0.2)' : 'var(--panel-border)',
      transition: 'all 0.3s ease',
    }}>
      <div style={{ flexShrink: 0 }}>
        {step.status === 'pending' && <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--text-muted)', opacity: 0.3 }} />}
        {step.status === 'running' && <Loader2 size={20} className="spin" style={{ color: 'var(--accent-color)' }} />}
        {step.status === 'success' && <CheckCircle size={20} style={{ color: 'var(--success-color)' }} />}
        {step.status === 'error' && <AlertTriangle size={20} style={{ color: 'var(--danger-color)' }} />}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: step.status === 'pending' ? 'var(--text-muted)' : 'var(--text-primary)' }}>
          {step.label}
        </div>
        {step.message && (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{step.message}</div>
        )}
      </div>
      {step.duration && step.status !== 'pending' && (
        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{step.duration}</span>
      )}
    </div>
  );
}

function ClientCard({ client, onShowConfig, onShowQr }: {
  client: WgClient;
  onShowConfig: () => void;
  onShowQr: () => void;
}) {
  return (
    <div style={{
      padding: 16, borderRadius: 'var(--radius)',
      border: '1px solid var(--panel-border)',
      background: 'rgba(255,255,255,0.02)',
      transition: 'all 0.15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Users size={16} style={{ color: 'var(--accent-color)' }} />
        <span style={{ fontWeight: 600, fontSize: 14, color: '#f8fafc' }}>{client.name}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-muted)' }}>IP</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{client.ip}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-muted)' }}>Public Key</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', fontSize: 10 }}>
            {client.public_key.slice(0, 16)}...
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn-outline btn-sm" style={{ flex: 1 }} onClick={onShowConfig}>
          <Lock size={12} /> Config Goster
        </button>
        <button className="btn-outline btn-sm" style={{ flex: 1 }} onClick={onShowQr}>
          <QrCode size={12} /> QR Goster
        </button>
      </div>
    </div>
  );
}

function ConfigModal({ client, onClose }: { client: WgClient; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(client.config);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* */ }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <div className="glass-panel" style={{ padding: 24, maxWidth: 520, width: '90%' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Lock size={18} /> {client.name} - WireGuard Config
          </h3>
          <button className="icon-btn icon-btn-sm" onClick={onClose}><X size={14} /></button>
        </div>
        <pre style={{
          background: '#060a0f', border: '1px solid var(--panel-border)',
          borderRadius: 'var(--radius-sm)', padding: 16,
          fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)',
          overflowX: 'auto', lineHeight: 1.8, whiteSpace: 'pre-wrap',
        }}>
          {client.config}
        </pre>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn-primary btn-sm" onClick={handleCopy}>
            {copied ? <><CheckCircle size={13} /> Kopyalandi</> : <><Copy size={13} /> Kopyala</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function QrModal({ client, onClose }: { client: WgClient; onClose: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <div className="glass-panel" style={{ padding: 24, maxWidth: 360, width: '90%', textAlign: 'center' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <QrCode size={18} /> {client.name} - QR Kod
          </h3>
          <button className="icon-btn icon-btn-sm" onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{
          background: '#111820', borderRadius: 'var(--radius)',
          padding: 24, border: '1px solid var(--panel-border)',
        }}>
          <img src={client.qr_data} alt={`QR - ${client.name}`} style={{ width: '100%', maxWidth: 200 }} />
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
          Bu QR kodu WireGuard mobil uygulamasinda taratarak baglanabilirsiniz.
        </p>
      </div>
    </div>
  );
}

export function VpsSetup() {
  const [activeTab, setActiveTab] = useState<VpsTab>('overview');
  const { data, refetch } = useApi<{ servers: VpsServer[] }>('/vps/list', { servers: [] });
  const [ip, setIp] = useState('');
  const [username, setUsername] = useState('root');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [location, setLocation] = useState('');
  const [state, setState] = useState<SetupState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [steps, setSteps] = useState<SetupStep[]>([]);

  // Client management state
  const [selectedVpsId, setSelectedVpsId] = useState<number | ''>('');
  const [clients, setClients] = useState<WgClient[]>([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [addingClient, setAddingClient] = useState(false);
  const [configClient, setConfigClient] = useState<WgClient | null>(null);
  const [qrClient, setQrClient] = useState<WgClient | null>(null);

  const fetchClients = useCallback(async (vpsId: number) => {
    setClientsLoading(true);
    try {
      const res = await fetch(`/api/vps/${vpsId}/clients`);
      const json = await res.json();
      setClients(json.clients || []);
    } catch { setClients([]); }
    setClientsLoading(false);
  }, []);

  useEffect(() => {
    if (selectedVpsId) fetchClients(Number(selectedVpsId));
  }, [selectedVpsId, fetchClients]);

  useEffect(() => {
    if (data.servers.length > 0 && selectedVpsId === '') {
      setSelectedVpsId(data.servers[0].id);
    }
  }, [data.servers, selectedVpsId]);

  // Live elapsed timer for running steps
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stepStartRef = useRef<number>(0);

  const startStepTimer = (stepIndex: number) => {
    stepStartRef.current = Date.now();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const elapsed = ((Date.now() - stepStartRef.current) / 1000).toFixed(0);
      setSteps(prev => prev.map((s, idx) =>
        idx === stepIndex && s.status === 'running'
          ? { ...s, duration: `${elapsed}s` }
          : s
      ));
    }, 1000);
  };

  const stopStepTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };

  // Cleanup timer on unmount
  useEffect(() => () => stopStepTimer(), []);

  const handleDeploy = async () => {
    if (!ip.trim()) return;
    setState('deploying');
    setErrorMsg('');
    setSteps([]);

    try {
      // Step 1: Test connection and create server record
      const setupResult = await postApi('/vps/setup', {
        ip: ip.trim(), username: username.trim(),
        password: password.trim(), location: location.trim(),
      });

      if (!setupResult.success) {
        setState('error');
        setErrorMsg(setupResult.error || 'Bağlantı başarısız');
        return;
      }

      const vpsId = setupResult.id;

      // Step 2: Run setup steps one by one
      const initialSteps: SetupStep[] = SETUP_STEPS.map(s => ({
        ...s, status: 'pending' as StepStatus, message: '', duration: '',
      }));
      setSteps(initialSteps);

      // Per-step fetch timeout: 5 min for update/packages, 2 min for others
      const STEP_TIMEOUTS: Record<string, number> = {
        update: 5 * 60 * 1000,
        packages: 5 * 60 * 1000,
        wireguard: 3 * 60 * 1000,
      };
      const DEFAULT_TIMEOUT = 2 * 60 * 1000;

      let allSuccess = true;
      for (let i = 0; i < SETUP_STEPS.length; i++) {
        const stepKey = SETUP_STEPS[i].key;
        setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, status: 'running', duration: '0s' } : s));
        startStepTimer(i);

        try {
          const controller = new AbortController();
          const timeout = STEP_TIMEOUTS[stepKey] || DEFAULT_TIMEOUT;
          const timeoutId = setTimeout(() => controller.abort(), timeout);

          const res = await fetch(`/api/vps/${vpsId}/steps`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ step: stepKey }),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          stopStepTimer();

          const result = await res.json();
          setSteps(prev => prev.map((s, idx) => idx === i ? {
            ...s, status: result.status as StepStatus, message: result.message, duration: result.duration,
          } : s));
          if (result.status === 'error') {
            allSuccess = false;
            break;
          }
        } catch (err) {
          stopStepTimer();
          const isTimeout = err instanceof DOMException && err.name === 'AbortError';
          setSteps(prev => prev.map((s, idx) => idx === i ? {
            ...s,
            status: 'error',
            message: isTimeout ? 'Zaman aşımı — adım arka planda tamamlanmış olabilir' : 'Bağlantı hatası',
          } : s));
          allSuccess = false;
          break;
        }
      }

      setState(allSuccess ? 'success' : 'error');
      if (!allSuccess) setErrorMsg('Kurulum sırasında hata oluştu');
      if (allSuccess) { setIp(''); setPassword(''); setLocation(''); }
      await refetch();
    } catch (e) {
      stopStepTimer();
      setState('error');
      setErrorMsg(e instanceof Error ? e.message : 'Bağlantı başarısız');
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteApi(`/vps/${id}`);
      await refetch();
    } catch { /* */ }
  };

  const handleAddClient = async () => {
    if (!newClientName.trim() || !selectedVpsId) return;
    setAddingClient(true);
    try {
      await postApi(`/vps/${selectedVpsId}/clients`, { name: newClientName.trim() });
      setNewClientName('');
      await fetchClients(Number(selectedVpsId));
    } catch { /* */ }
    setAddingClient(false);
  };

  const tabs: { id: VpsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Sunucular', icon: <Activity size={14} /> },
    { id: 'clients', label: 'Client Yonetimi', icon: <Users size={14} /> },
    { id: 'settings', label: 'WireGuard Ayarlari', icon: <Settings size={14} /> },
  ];

  const categoryLabels: Record<string, string> = {
    interface: 'WireGuard Arayuz',
    peer_defaults: 'Peer Varsayilanlari',
  };

  const categoryIcons: Record<string, React.ReactNode> = {
    interface: <Network size={15} />,
    peer_defaults: <Globe size={15} />,
  };

  return (
    <div className="fade-in">
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3><Server size={20} style={{ marginRight: 8 }} />VPS WireGuard Sunuculari</h3>
          {activeTab === 'overview' && (
            <button className="btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
              <Plus size={14} />
              <span>Yeni VPS</span>
            </button>
          )}
        </div>
        <p className="subtitle">Kayitli VPN tunel sunuculari, baglanti durumlari ve WireGuard yapilandirmasi</p>
        <div className="service-tabs">
          {tabs.map(tab => (
            <button key={tab.id}
              className={`service-tab ${activeTab === tab.id ? 'service-tab-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}>
              {tab.icon}<span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'overview' && (
        <>
          {data.servers.length === 0 ? (
            <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
              <div className="empty-state">
                <Wifi size={40} />
                <p>Henuz VPS sunucusu eklenmedi</p>
                <button className="btn-primary" onClick={() => setShowForm(true)}>
                  <Plus size={14} /> Ilk VPS'i Ekle
                </button>
              </div>
            </div>
          ) : (
            <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
              <div className="vps-grid">
                {data.servers.map(server => (
                  <div key={server.id} className="vps-card">
                    <div className="vps-card-header">
                      <Server size={18} />
                      <span className={`svc-dot ${server.status === 'connected' ? 'svc-on' : 'svc-off'}`} />
                    </div>
                    <div className="vps-card-body">
                      <span className="vps-ip">{server.ip}</span>
                      <span className="vps-location">{server.location || server.username}</span>
                      <span className={`badge ${server.status === 'connected' ? 'badge-success' : server.status === 'error' ? 'badge-error' : 'badge-neutral'}`}>
                        {server.status}
                      </span>
                    </div>
                    <button className="icon-btn icon-btn-sm vps-delete" onClick={() => handleDelete(server.id)}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {showForm && (
            <div className="glass-panel form-panel" style={{ marginTop: 16, maxWidth: 700 }}>
              <div className="widget-header">
                <h3>Yeni WireGuard VPS Kur</h3>
                <Lock size={18} className="text-muted" />
              </div>
              <p className="subtitle">Otomatik WireGuard kurulumu ve tunel yapilandirmasi</p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label><Globe size={14} /><span>VPS IP</span></label>
                  <input type="text" placeholder="203.0.113.10" value={ip} onChange={e => setIp(e.target.value)} disabled={state === 'deploying'} />
                </div>
                <div className="form-group">
                  <label><Server size={14} /><span>Kullanici</span></label>
                  <input type="text" placeholder="root" value={username} onChange={e => setUsername(e.target.value)} disabled={state === 'deploying'} />
                </div>
                <div className="form-group">
                  <label><Lock size={14} /><span>Sifre</span></label>
                  <div style={{ position: 'relative' }}>
                    <input type={showPassword ? 'text' : 'password'} placeholder="********" value={password}
                      onChange={e => setPassword(e.target.value)} disabled={state === 'deploying'}
                      style={{ paddingRight: 36 }} />
                    <button type="button" onClick={() => setShowPassword(!showPassword)}
                      style={{
                        position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                        background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
                        padding: 4, display: 'flex',
                      }}>
                      {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
                <div className="form-group">
                  <label><Globe size={14} /><span>Lokasyon</span></label>
                  <input type="text" placeholder="Frankfurt" value={location} onChange={e => setLocation(e.target.value)} disabled={state === 'deploying'} />
                </div>
              </div>

              {steps.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '16px 0' }}>
                  {steps.map(step => <StepIndicator key={step.key} step={step} />)}
                </div>
              )}

              {state === 'success' && steps.length === 0 && (
                <div className="alert alert-success">
                  <CheckCircle size={16} /><span>WireGuard tuneli basariyla kuruldu!</span>
                </div>
              )}
              {state === 'error' && steps.length === 0 && (
                <div className="alert alert-error">
                  <AlertTriangle size={16} /><span>{errorMsg}</span>
                </div>
              )}

              <button className="btn-primary btn-full" onClick={handleDeploy} disabled={state === 'deploying' || !ip.trim()}>
                {state === 'deploying' ? <><Loader2 size={16} className="spin" /> Kuruluyor...</> : <><Lock size={16} /> Deploy Secure Tunnel</>}
              </button>
            </div>
          )}
        </>
      )}

      {activeTab === 'clients' && (
        <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
          <div className="widget-header">
            <h3>WireGuard Client Yonetimi</h3>
          </div>

          <div className="form-group" style={{ maxWidth: 400, marginTop: 16 }}>
            <label>VPS Sunucu Secin</label>
            <select value={selectedVpsId} onChange={e => setSelectedVpsId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Sunucu secin...</option>
              {data.servers.map(s => (
                <option key={s.id} value={s.id}>{s.ip} ({s.location || s.username})</option>
              ))}
            </select>
          </div>

          {selectedVpsId && (
            <>
              <div style={{
                display: 'flex', gap: 8, alignItems: 'center', marginTop: 16,
                padding: 12, background: 'rgba(0,0,0,0.15)', borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--panel-border)',
              }}>
                <input className="config-input" style={{ flex: 1, minWidth: 0 }}
                  placeholder="Client adi (orn: iPhone-Ali)" value={newClientName}
                  onChange={e => setNewClientName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddClient()} />
                <button className="btn-primary btn-sm" onClick={handleAddClient} disabled={addingClient || !newClientName.trim()}>
                  {addingClient ? <Loader2 size={13} className="spin" /> : <><Plus size={13} /> Yeni Client Ekle</>}
                </button>
              </div>

              {clientsLoading ? (
                <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                  <Loader2 size={24} className="spin" />
                </div>
              ) : clients.length === 0 ? (
                <div className="empty-state" style={{ marginTop: 20 }}>
                  <Users size={36} />
                  <p>Bu sunucu icin client bulunmuyor</p>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, marginTop: 16 }}>
                  {clients.map(client => (
                    <ClientCard key={client.id} client={client}
                      onShowConfig={() => setConfigClient(client)}
                      onShowQr={() => setQrClient(client)} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === 'settings' && (
        <div style={{ marginTop: 14 }}>
          <ServiceSettings service="wireguard" categoryLabels={categoryLabels} categoryIcons={categoryIcons} />
        </div>
      )}

      {configClient && <ConfigModal client={configClient} onClose={() => setConfigClient(null)} />}
      {qrClient && <QrModal client={qrClient} onClose={() => setQrClient(null)} />}
    </div>
  );
}
