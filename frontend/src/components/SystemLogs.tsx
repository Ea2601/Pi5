import { RefreshCw, Power, Trash2, Download, Terminal, Zap, Clock, Plus, Play, X, Edit3, Check, Calendar } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';
import type { CronJob } from '../types';

interface LogResponse {
  logs: string[];
}

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
    } catch { /* */ }
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
            onClick={() => handleAction('update', '/services/setup', { action: 'pihole' })}>
            <RefreshCw size={14} className={actionLoading === 'update' ? 'spin' : ''} />
            <span>OS Update</span>
          </button>
          <button className="btn-outline btn-sm" disabled={actionLoading !== null}
            onClick={() => handleAction('zapret', '/services/setup', { action: 'zapret' })}>
            <Zap size={14} />
            <span>Zapret Güncelle</span>
          </button>
          <button className="btn-outline btn-sm" disabled={actionLoading !== null}
            onClick={() => handleAction('reboot', '/services/setup', { action: 'firewall' })}>
            <Power size={14} />
            <span>Reboot Pi 5</span>
          </button>
          <button className="btn-outline btn-sm" onClick={refetch}>
            <Download size={14} />
            <span>Yenile</span>
          </button>
          <button className="btn-ghost btn-sm">
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
  const { data, refetch } = useApi<{ jobs: CronJob[] }>('/cron/jobs', { jobs: [] }, 5000);
  const [showAdd, setShowAdd] = useState(false);
  const [newJob, setNewJob] = useState({ name: '', schedule: '', command: '', description: '' });
  const [editId, setEditId] = useState<number | null>(null);
  const [editData, setEditData] = useState({ name: '', schedule: '', command: '', description: '' });
  const [running, setRunning] = useState<number | null>(null);

  const handleAdd = async () => {
    if (!newJob.name || !newJob.schedule || !newJob.command) return;
    await postApi('/cron/jobs', newJob);
    setNewJob({ name: '', schedule: '', command: '', description: '' });
    setShowAdd(false);
    await refetch();
  };

  const handleToggle = async (job: CronJob) => {
    await putApi(`/cron/jobs/${job.id}`, { enabled: !job.enabled });
    await refetch();
  };

  const handleDelete = async (id: number) => {
    await deleteApi(`/cron/jobs/${id}`);
    await refetch();
  };

  const handleRun = async (id: number) => {
    setRunning(id);
    await postApi(`/cron/jobs/${id}/run`, {});
    setTimeout(async () => {
      setRunning(null);
      await refetch();
    }, 2500);
  };

  const startEdit = (job: CronJob) => {
    setEditId(job.id);
    setEditData({ name: job.name, schedule: job.schedule, command: job.command, description: job.description });
  };

  const saveEdit = async () => {
    if (editId === null) return;
    await putApi(`/cron/jobs/${editId}`, editData);
    setEditId(null);
    await refetch();
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
        <p className="subtitle">Sistemde otomatik çalışan tüm zamanlanmış görevler</p>

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
                  </div>
                  <div className="cron-actions">
                    <button className="icon-btn icon-btn-sm" onClick={() => handleRun(job.id)}
                      disabled={running === job.id || !job.enabled}
                      title="Şimdi çalıştır">
                      <Play size={13} className={running === job.id ? 'spin' : ''} />
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
      </div>
    </div>
  );
}
