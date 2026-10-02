import { RefreshCw, Power, Trash2, Download, Terminal, Zap, Clock, Plus, Play, X, Edit3, Check, Calendar } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useApi, getApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';
import type { CronJob } from '../types';
import { toast } from '../toast';
import { startSystemUpdate } from '../systemUpdate';

interface LogResponse {
  logs: string[];
}

// Panelin değiştiremediği zamanlanmış görevler (Klyrix Gate gece güncellemesi, Pi-hole'un kendi görevleri).
interface SystemCron { source: string; schedule: string; command: string }

// Sunucu UTC "YYYY-MM-DD HH:MM:SS" döner → yerel saat.
const fmtRun = (s: string) => {
  const d = new Date(/[zZ]|[+]/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

type MaintTab = 'logs' | 'cron';

export function SystemLogs() {
  const [activeTab, setActiveTab] = useState<MaintTab>('logs');

  const tabs: { id: MaintTab; label: string; icon: React.ReactNode }[] = [
    { id: 'logs', label: 'Terminal Logları', icon: <Terminal size={14} /> },
    { id: 'cron', label: 'Cron Görevleri', icon: <Clock size={14} /> },
  ];

  return (
    <div className="fade-in">
      <Panel title="Sistem Bakım & Zamanlanmış Görevler" icon={<Terminal size={20} style={{ marginRight: 8 }} />}
        subtitle="Otomatik günlük OS güncellemeleri, zamanlanmış yeniden başlatma, AdBlock senkronizasyonu">
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

      {activeTab === 'logs' && <LogsView />}
      {activeTab === 'cron' && <CronView />}
    </div>
  );
}

function LogsView() {
  const { data, refetch } = useApi<LogResponse>('/logs', { logs: [] }, 5000);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [data.logs]);

  const handleAction = async (action: string, endpoint: string, body: Record<string, unknown>) => {
    setActionLoading(action);
    try {
      await postApi(endpoint, body);
      await refetch();
    } catch (e) {
      // Zapret güncelleme / yeniden başlatma / log temizleme başarısızsa söylensin (eskiden yalnız dönen simge duruyordu)
      toast.error(e instanceof Error && e.message ? e.message : 'İşlem başarısız');
    }
    setActionLoading(null);
  };

  // Güncelleme arka planda sürer; bitene kadar izlenir, sonuç bildirim olarak gösterilir.
  const handleUpdate = async () => {
    setActionLoading('update');
    try {
      await startSystemUpdate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Güncelleme başarısız');
    }
    setActionLoading(null);
  };

  const getLogLevel = (log: string): string => {
    if (log.includes('ERROR')) return 'error';
    if (log.includes('WARN') || log.includes('CRITICAL')) return 'warn';
    if (log.includes('CRON')) return 'cron';
    if (log.includes('MAINTENANCE')) return 'maint';
    return 'info';
  };

  const logs = data.logs?.length ? data.logs : [
    '[2026-03-25T04:18:00Z] SYSTEM: Node.js Backend Engine Started',
    '[2026-03-25T04:18:02Z] CRON: Cron jobs engine initialized.',
  ];

  const filteredLogs = filter === 'all' ? logs : logs.filter(l => getLogLevel(l) === filter);

  return (
    <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
      <div className="maintenance-row">
        <div className="maintenance-actions">
          <button className="btn-primary btn-sm" disabled={actionLoading !== null}
            onClick={handleUpdate}>
            <RefreshCw size={14} className={actionLoading === 'update' ? 'spin' : ''} />
            <span>OS Update</span>
          </button>
          <button className="btn-outline btn-sm" disabled={actionLoading !== null}
            onClick={() => handleAction('zapret', '/services/setup', { action: 'zapret' })}>
            <Zap size={14} />
            <span>Zapret Güncelle</span>
          </button>
          <button className="btn-outline btn-sm" disabled={actionLoading !== null}
            onClick={() => { if (confirm('Pi 5 yeniden başlatılsın mı?')) handleAction('reboot', '/system/reboot', {}); }}>
            <Power size={14} />
            <span>Reboot Pi 5</span>
          </button>
          <button className="btn-outline btn-sm" onClick={refetch}>
            <Download size={14} />
            <span>Yenile</span>
          </button>
          <button className="btn-ghost btn-sm" disabled={actionLoading !== null}
            onClick={() => handleAction('clear', '/logs/clear', {})}>
            <Trash2 size={14} />
            <span>Temizle</span>
          </button>
        </div>

        <div className="log-filters">
          {['all', 'error', 'warn', 'cron', 'maint', 'info'].map(f => (
            <button key={f} className={`filter-btn ${filter === f ? 'filter-active' : ''}`}
              onClick={() => setFilter(f)}>
              {f === 'all' ? 'Tümü' : f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="terminal-log" ref={terminalRef}>
        {filteredLogs.map((log, i) => (
          <div key={i} className={`log-line log-${getLogLevel(log)}`}>
            {log}
          </div>
        ))}
        {filteredLogs.length === 0 && (
          <div className="log-line log-info">Bu filtrede kayıt bulunamadı.</div>
        )}
      </div>
    </div>
  );
}

function CronView() {
  const { data, refetch } = useApi<{ jobs: CronJob[]; system?: SystemCron[] }>('/cron/jobs', { jobs: [] }, 5000);
  const [showAdd, setShowAdd] = useState(false);
  const [newJob, setNewJob] = useState({ name: '', schedule: '', command: '', description: '' });
  const [editId, setEditId] = useState<number | null>(null);
  const [editData, setEditData] = useState({ name: '', schedule: '', command: '', description: '' });
  const [running, setRunning] = useState<number | null>(null);
  // "Şimdi çalıştır"ın sonucu: görev satırının altında son çıktı (sunucu son 60 satırı tutar).
  const [outputs, setOutputs] = useState<Record<number, { output: string; rc: number | null }>>({});
  // Sayfadan çıkılınca yoklama durur (görev Pi'de sürer; sonucu listede ve Bildirimler'de).
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Her değişiklik Pi'nin zamanlayıcısına yazılır; geçersiz zamanlama ya da yazım hatası sunucudan mesajla döner.
  const guarded = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      if (okMsg) toast.success(okMsg);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İşlem başarısız');
      return false;
    } finally {
      await refetch();
    }
  };

  const handleAdd = async () => {
    if (!newJob.name || !newJob.schedule || !newJob.command) return;
    if (await guarded(() => postApi('/cron/jobs', newJob), 'Görev eklendi ve zamanlayıcıya yazıldı')) {
      setNewJob({ name: '', schedule: '', command: '', description: '' });
      setShowAdd(false);
    }
  };

  const handleToggle = async (job: CronJob) => {
    await guarded(() => putApi(`/cron/jobs/${job.id}`, { enabled: !job.enabled }));
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Görev silinsin mi? Pi\'nin zamanlayıcısından da kaldırılır.')) return;
    await guarded(() => deleteApi(`/cron/jobs/${id}`), 'Görev silindi');
  };

  // Görev panelin dışında çalışır (zamanlanmış çalıştırmayla aynı betik ve kilit, üst sınır 1 saat); bitene kadar yoklanır.
  const handleRun = async (id: number) => {
    setRunning(id);
    try {
      await postApi(`/cron/jobs/${id}/run`, {});
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Görev başlatılamadı');
      setRunning(null);
      return;
    }
    toast.info('Görev başladı — bitince sonucu burada görünecek');
    await refetch();
    // Yoklama hatası (ör. panel servisi yeniden başlıyor) görevi etkilemez: süre dolana kadar yeniden denenir.
    const deadline = Date.now() + 65 * 60 * 1000;
    let finished = false;
    while (alive.current && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      if (!alive.current) return;
      let o: { running: boolean; output: string; rc: number | null };
      try {
        o = await getApi<{ running: boolean; output: string; rc: number | null }>(`/cron/jobs/${id}/output`);
      } catch { continue; }
      if (o.running) continue;
      finished = true;
      setOutputs(prev => ({ ...prev, [id]: { output: o.output, rc: o.rc } }));
      if (o.rc === 0) toast.success('Görev tamamlandı');
      else toast.error(`Görev hata verdi${o.rc !== null ? ` (çıkış kodu ${o.rc})` : ''}`);
      break;
    }
    if (!alive.current) return;
    if (!finished) toast.info('Görev hâlâ sürüyor — sonucu listede görünecek');
    setRunning(null);
    await refetch();
  };

  const startEdit = (job: CronJob) => {
    setEditId(job.id);
    setEditData({ name: job.name, schedule: job.schedule, command: job.command, description: job.description });
  };

  const saveEdit = async () => {
    if (editId === null) return;
    if (await guarded(() => putApi(`/cron/jobs/${editId}`, editData), 'Görev güncellendi')) setEditId(null);
  };

  const cronHelp: Record<string, string> = {
    '* * * * *': 'Her dakika',
    '*/5 * * * *': 'Her 5 dakika',
    '*/10 * * * *': 'Her 10 dakika',
    '0 * * * *': 'Her saat başı',
    '0 */6 * * *': 'Her 6 saatte bir',
    '0 0 * * *': 'Her gece 00:00',
    '0 3 * * *': 'Her gece 03:00',
    '0 4 * * 0': 'Her Pazar 04:00',
    '0 5 1 * *': 'Her ayın 1\'i',
    '0 12 1 */2 *': 'Her 2 ayda bir',
  };

  return (
    <div style={{ marginTop: 14 }}>
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3><Clock size={18} style={{ marginRight: 8 }} />Zamanlanmış Görevler (Cron Jobs)</h3>
          <button className="btn-primary btn-sm" onClick={() => setShowAdd(!showAdd)}>
            <Plus size={14} /> Yeni Görev
          </button>
        </div>
        <p className="subtitle">
          Buradaki görevler Pi'nin zamanlayıcısına (cron) yazılır ve gerçekten çalışır: açıp kapatmak ya da saatini değiştirmek
          hemen etkili olur. Hata veren çalıştırmaların çıktısı Sistem Logları'nda "CRON" filtresiyle görünür.
        </p>

        {showAdd && (
          <div className="cron-add-form">
            <div className="cron-add-grid">
              <div className="form-group">
                <label>Görev Adı</label>
                <input className="config-input" type="text" placeholder="OS Güncelleme"
                  value={newJob.name} onChange={e => setNewJob({ ...newJob, name: e.target.value })} />
              </div>
              <div className="form-group">
                <label><Calendar size={12} /> Cron Zamanlaması</label>
                <input className="config-input" type="text" placeholder="0 3 * * *"
                  value={newJob.schedule} onChange={e => setNewJob({ ...newJob, schedule: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Komut</label>
                <input className="config-input" type="text" placeholder="apt update && apt upgrade -y"
                  value={newJob.command} onChange={e => setNewJob({ ...newJob, command: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Açıklama</label>
                <input className="config-input" type="text" placeholder="Günlük paket güncellemesi"
                  value={newJob.description} onChange={e => setNewJob({ ...newJob, description: e.target.value })} />
              </div>
            </div>
            <div className="cron-add-actions">
              <button className="btn-primary btn-sm" onClick={handleAdd}
                disabled={!newJob.name || !newJob.schedule || !newJob.command}>
                <Check size={13} /> Ekle
              </button>
              <button className="btn-outline btn-sm" onClick={() => setShowAdd(false)}>
                <X size={13} /> İptal
              </button>
            </div>
            <div className="cron-help">
              <span className="cron-help-title">Cron formatı: dakika saat gün ay haftanın_günü</span>
              <div className="cron-help-grid">
                {Object.entries(cronHelp).map(([expr, desc]) => (
                  <button key={expr} className="cron-help-item"
                    onClick={() => setNewJob({ ...newJob, schedule: expr })}>
                    <code>{expr}</code>
                    <span>{desc}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="cron-list">
          {data.jobs.map(job => (
            <div key={job.id} className={`cron-row ${!job.enabled ? 'cron-row-disabled' : ''}`}>
              {editId === job.id ? (
                <div className="cron-edit-row">
                  <input className="config-input" value={editData.name}
                    onChange={e => setEditData({ ...editData, name: e.target.value })} />
                  <input className="config-input cron-schedule-input" value={editData.schedule}
                    onChange={e => setEditData({ ...editData, schedule: e.target.value })} />
                  <input className="config-input" value={editData.command}
                    onChange={e => setEditData({ ...editData, command: e.target.value })} />
                  <input className="config-input" value={editData.description}
                    onChange={e => setEditData({ ...editData, description: e.target.value })} />
                  <button className="btn-primary btn-sm" onClick={saveEdit}><Check size={13} /></button>
                  <button className="btn-outline btn-sm" onClick={() => setEditId(null)}><X size={13} /></button>
                </div>
              ) : (
                <>
                  <button
                    className={`toggle-btn toggle-sm ${job.enabled ? 'toggle-on' : 'toggle-off'}`}
                    onClick={() => handleToggle(job)}
                  >
                    <div className="toggle-knob" />
                  </button>
                  <div className="cron-info">
                    <div className="cron-name">
                      <strong>{job.name}</strong>
                      {job.status === 'running' && <Badge variant="info">Çalışıyor</Badge>}
                      {job.status === 'success' && <Badge variant="success">Başarılı</Badge>}
                      {job.status === 'error' && <Badge variant="error">Hata</Badge>}
                    </div>
                    <span className="cron-desc">{job.description}</span>
                    <div className="cron-details">
                      <code className="cron-schedule">{job.schedule}</code>
                      <span className="cron-command">{job.command}</span>
                    </div>
                    {job.last_run && (
                      <span className="cron-desc">Son çalışma: {fmtRun(job.last_run)}</span>
                    )}
                    {outputs[job.id] && (
                      <div className="cron-output">
                        <div className="cron-output-head">
                          <span>Son çıktı{outputs[job.id].rc !== null ? ` · çıkış kodu ${outputs[job.id].rc}` : ''}</span>
                          <button className="icon-btn icon-btn-sm" onClick={() => setOutputs(prev => { const n = { ...prev }; delete n[job.id]; return n; })} title="Kapat" aria-label="Çıktıyı kapat"><X size={11} /></button>
                        </div>
                        <pre>{outputs[job.id].output.trim() || '(çıktı yok)'}</pre>
                      </div>
                    )}
                  </div>
                  <div className="cron-actions">
                    <button className="icon-btn icon-btn-sm" onClick={() => handleRun(job.id)}
                      disabled={running === job.id || job.status === 'running' || !job.enabled}
                      title="Şimdi çalıştır">
                      <Play size={13} className={running === job.id || job.status === 'running' ? 'spin' : ''} />
                    </button>
                    <button className="icon-btn icon-btn-sm" onClick={() => startEdit(job)} title="Düzenle">
                      <Edit3 size={13} />
                    </button>
                    <button className="icon-btn icon-btn-sm cron-delete" onClick={() => handleDelete(job.id)} title="Sil">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
          {data.jobs.length === 0 && (
            <div className="empty-state" style={{ padding: '30px' }}>
              <Clock size={32} />
              <p>Henüz zamanlanmış görev yok</p>
            </div>
          )}
        </div>

        <div className="list-summary">
          <span>{data.jobs.filter(j => j.enabled).length} aktif</span>
          <span>{data.jobs.filter(j => !j.enabled).length} devre dışı</span>
          <span>{data.jobs.length} toplam</span>
        </div>

        {(data.system?.length ?? 0) > 0 && (
          <div className="cron-system">
            <h4 className="widget-title">Sistem görevleri <span className="cron-desc">— panelden değiştirilemez</span></h4>
            <div className="cron-list">
              {data.system!.map((s, i) => (
                <div key={i} className="cron-row cron-row-system">
                  <div className="cron-info">
                    <div className="cron-name"><strong>{s.source}</strong></div>
                    <div className="cron-details">
                      <code className="cron-schedule">{s.schedule}</code>
                      <span className="cron-command">{s.command}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
