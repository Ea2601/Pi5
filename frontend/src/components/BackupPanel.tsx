import { useState, useEffect, useRef } from 'react';
import {
  Download, Upload, Archive, Check, AlertTriangle, Clock,
  Settings, Shield, Users, Globe, Calendar, Database, Trash2
} from 'lucide-react';
import { postApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';

interface BackupHistoryItem {
  id: string;
  date: string;
  size: string;
  items: number;
}

const BACKUP_HISTORY_KEY = 'pi5_backup_history';

export function BackupPanel() {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [history, setHistory] = useState<BackupHistoryItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(BACKUP_HISTORY_KEY);
      if (stored) setHistory(JSON.parse(stored));
    } catch { /* */ }
  }, []);

  const saveHistory = (items: BackupHistoryItem[]) => {
    setHistory(items);
    localStorage.setItem(BACKUP_HISTORY_KEY, JSON.stringify(items));
  };

  const handleExport = async () => {
    setExporting(true);
    setResult(null);
    try {
      const res = await fetch('/api/backup/export');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pi5-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);

      const newItem: BackupHistoryItem = {
        id: crypto.randomUUID(),
        date: new Date().toLocaleString('tr-TR'),
        size: `${(blob.size / 1024).toFixed(1)} KB`,
        items: Object.keys(data).length
      };
      saveHistory([newItem, ...history].slice(0, 20));
      setResult({ type: 'success', msg: 'Yedek başarıyla indirildi.' });
    } catch (e: unknown) {
      setResult({ type: 'error', msg: e instanceof Error ? e.message : 'Yedek alınamadı.' });
    }
    setExporting(false);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setResult(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await postApi('/backup/import', data);
      setResult({ type: 'success', msg: 'Yapılandırma başarıyla geri yüklendi.' });
    } catch (err: unknown) {
      setResult({ type: 'error', msg: err instanceof Error ? err.message : 'Geri yükleme başarısız.' });
    }
    setImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const clearHistory = () => {
    saveHistory([]);
  };

  const backupSections = [
    { icon: <Settings size={16} />, label: 'Servis Yapılandırmaları', desc: 'Pi-hole, Zapret, Unbound, Fail2Ban ayarları' },
    { icon: <Globe size={16} />, label: 'Yönlendirme Kuralları', desc: 'Trafik kuralları ve VPS yapılandırmaları' },
    { icon: <Users size={16} />, label: 'Cihaz Profilleri', desc: 'Kayıtlı cihazlar, gruplar ve engelleme listeleri' },
    { icon: <Calendar size={16} />, label: 'Cron Görevleri', desc: 'Zamanlanmış görevler ve otomatik bakım' },
    { icon: <Shield size={16} />, label: 'Güvenlik Duvarı', desc: 'UFW kuralları ve port yapılandırmaları' },
    { icon: <Database size={16} />, label: 'DNS Listeleri', desc: 'Beyaz liste, kara liste ve yerel DNS kayıtları' },
  ];

  return (
    <div className="fade-in">
      <Panel
        title="Yedekleme & Geri Yükleme"
        icon={<Archive size={20} style={{ marginRight: 8 }} />}
        subtitle="Tüm yapılandırmaları yedekle ve geri yükle"
        badge={history.length > 0 ? <Badge variant="info">Son: {history[0].date}</Badge> : undefined}
      >
        {result && (
          <div style={{
            padding: '10px 14px', borderRadius: 8, marginBottom: 12,
            background: result.type === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${result.type === 'success' ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
            display: 'flex', alignItems: 'center', gap: 8
          }}>
            {result.type === 'success' ? <Check size={16} style={{ color: '#10b981' }} /> : <AlertTriangle size={16} style={{ color: '#ef4444' }} />}
            <span style={{ color: result.type === 'success' ? '#10b981' : '#ef4444' }}>{result.msg}</span>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {/* Export Section */}
          <div style={{
            background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: 20,
            border: '1px solid rgba(255,255,255,0.06)'
          }}>
            <h4 style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Download size={18} style={{ color: '#3b82f6' }} /> Yedek Al
            </h4>
            <p className="text-muted" style={{ fontSize: 13, marginBottom: 14 }}>
              Tüm yapılandırmaları JSON dosyası olarak indir
            </p>
            <button className="btn-primary" onClick={handleExport} disabled={exporting} style={{ width: '100%' }}>
              <Download size={14} />
              {exporting ? 'İndiriliyor...' : 'Yedek Al'}
            </button>
          </div>

          {/* Import Section */}
          <div style={{
            background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: 20,
            border: '1px solid rgba(255,255,255,0.06)'
          }}>
            <h4 style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Upload size={18} style={{ color: '#f59e0b' }} /> Geri Yükle
            </h4>
            <p className="text-muted" style={{ fontSize: 13, marginBottom: 14 }}>
              Daha önce alınan bir yedek dosyasını yükle
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleImport}
              style={{ display: 'none' }}
            />
            <button className="btn-outline" onClick={() => fileInputRef.current?.click()}
              disabled={importing} style={{ width: '100%' }}>
              <Upload size={14} />
              {importing ? 'Yükleniyor...' : 'Dosya Seç ve Yükle'}
            </button>
          </div>
        </div>
      </Panel>

      {/* What gets backed up */}
      <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
        <div className="widget-header">
          <h3><Database size={18} style={{ marginRight: 8 }} />Yedeklenen Bileşenler</h3>
        </div>
        <div className="list-items">
          {backupSections.map(section => (
            <div key={section.label} className="list-item" style={{ gap: 12 }}>
              <div style={{
                width: 34, height: 34, borderRadius: 8, background: 'rgba(59,130,246,0.1)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3b82f6', flexShrink: 0
              }}>
                {section.icon}
              </div>
              <div>
                <strong style={{ fontSize: 13 }}>{section.label}</strong>
                <div className="text-muted" style={{ fontSize: 12 }}>{section.desc}</div>
              </div>
              <Check size={16} style={{ color: '#10b981', marginLeft: 'auto' }} />
            </div>
          ))}
        </div>
      </div>

      {/* Backup History */}
      <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
        <div className="widget-header">
          <h3><Clock size={18} style={{ marginRight: 8 }} />Yedekleme Geçmişi</h3>
          {history.length > 0 && (
            <button className="btn-outline btn-sm" onClick={clearHistory}>
              <Trash2 size={13} /> Geçmişi Temizle
            </button>
          )}
        </div>
        <div className="list-items">
          {history.map(item => (
            <div key={item.id} className="list-item">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Archive size={14} style={{ color: '#3b82f6' }} />
                <span style={{ fontSize: 13 }}>{item.date}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="text-muted" style={{ fontSize: 12 }}>{item.size}</span>
                <Badge variant="neutral">{item.items} bileşen</Badge>
              </div>
            </div>
          ))}
          {history.length === 0 && (
            <div className="empty-state" style={{ padding: 30 }}>
              <Archive size={32} />
              <p>Henüz yedekleme yapılmadı</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
