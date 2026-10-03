import { useState, useEffect, useRef, lazy, Suspense, Component } from 'react';
import type { ReactNode } from 'react';
import {
  Download, Upload, Archive, Check, Clock,
  Settings, Shield, Users, Globe, Calendar, CalendarSync, Database, Trash2
} from 'lucide-react';
import { postApi, useApi } from '../hooks/useApi';
import { Panel, Badge } from './ui';
import { toast } from '../toast';

// Bulut Yedeği ayrı parça (React.lazy): ana paket büyümesin — yalnız Yedekleme sayfası açılınca yüklenir.
const CloudBackupPanel = lazy(() => import('./CloudBackupPanel').then(m => ({ default: m.CloudBackupPanel })));
// Cihaz Yedekleme (Syncthing) de ayrı parça
const DeviceBackupPanel = lazy(() => import('./DeviceBackupPanel').then(m => ({ default: m.DeviceBackupPanel })));

// Parça yüklenemezse (panel güncellemesinden sonra eski sekmede eski dosya adı artık yok) ya da bölüm hata verirse yalnız bu
// bölüm yerine kısa bir not çıkar: sayfanın geri kalanı (indir / geri yükle) çalışmaya devam eder. React.lazy başarısız
// içe aktarmayı önbellekte tuttuğu için çözüm sayfayı yenilemektir.
class CloudBackupBoundary extends Component<{ children: ReactNode; name?: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.error(`${this.props.name || 'Bulut yedeği'} bölümü:`, error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="glass-panel" style={{ marginTop: 14, padding: '14px 16px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <span className="text-muted" style={{ fontSize: 13, flex: '1 1 220px' }}>{this.props.name || 'Bulut yedeği'} bölümü yüklenemedi — sayfayı yenileyin.</span>
        <button className="btn-outline btn-sm" onClick={() => window.location.reload()}>Sayfayı yenile</button>
      </div>
    );
  }
}

interface BackupHistoryItem {
  id: string;
  date: string;
  size: string;
  items: number;     // tablo sayısı (eski kayıtlar yalnız bunu taşır)
  records?: number;  // toplam kayıt
}

// "Yedeklenen bileşenler" listesi sunucudan (BACKUP_MANIFEST): eskiden burada sabitti ve eksik / yanlıştı
interface BackupManifest { sections: { key: string; label: string; desc: string; count: number }[]; excluded?: string }
const SECTION_ICONS: Record<string, ReactNode> = {
  services: <Settings size={16} />, routing: <Globe size={16} />, devices: <Users size={16} />,
  firewall: <Shield size={16} />, dns: <Database size={16} />, system: <Calendar size={16} />, calendar: <CalendarSync size={16} />,
  calendar_rules: <CalendarSync size={16} />,
};

const BACKUP_HISTORY_KEY = 'pi5_backup_history';

export function BackupPanel() {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [history, setHistory] = useState<BackupHistoryItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: manifest, error: manifestError, refetch: refetchManifest } = useApi<BackupManifest | null>('/backup/manifest', null);

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
        items: Object.keys(data?.data || {}).length,
        records: Object.values(data?.data || {}).reduce((a: number, v) => a + (Array.isArray(v) ? v.length : 0), 0),
      };
      saveHistory([newItem, ...history].slice(0, 20));
      toast.success('Yedek başarıyla indirildi.');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Yedek alınamadı.');
    }
    setExporting(false);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const when = typeof data?.created_at === 'string' ? new Date(data.created_at).toLocaleString('tr-TR') : 'tarihi bilinmiyor';
      // Kurallar ve listeler yedektekiyle DEĞİŞİR (yedekten sonra eklenenler silinir), ayarlar birleştirilir; sonra Pi'ye uygulanır.
      if (!window.confirm(`Bu yedek geri yüklensin mi? (${when})\n\nYedekteki kurallar ve listeler şimdikilerin yerine geçer — yedekten sonra eklediğiniz kurallar silinir. Ayarlar birleştirilir.\n\nArdından yönlendirme kuralları, Cron görevleri, Pi-hole listeleri, sabit IP rezervasyonları, port yönlendirmeleri, Fail2Ban, Unbound ve (kuruluysa) güvenlik duvarı yeniden uygulanır.`)) {
        setImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
      const r = await postApi('/backup/import', data) as { message?: string; applied?: { item: string; ok: boolean; detail?: string }[] };
      const failed = (r.applied || []).filter(a => !a.ok);
      const ok = (r.applied || []).filter(a => a.ok).map(a => a.item);
      toast.success(`${r.message || 'Yedek geri yüklendi.'}${ok.length ? ` Uygulandı: ${ok.join(', ')}.` : ''}`);
      for (const a of (r.applied || []).filter(a => a.ok && a.detail)) toast.info(`${a.item}: ${a.detail}`);
      for (const f of failed) toast.error(`${f.item} uygulanamadı: ${f.detail || 'bilinmeyen hata'}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Geri yükleme başarısız.');
    }
    setImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const clearHistory = () => {
    saveHistory([]);
  };

  return (
    <div className="fade-in">
      <Panel
        title="Yedekleme & Geri Yükleme"
        icon={<Archive size={20} style={{ marginRight: 8 }} />}
        subtitle="Tüm yapılandırmaları yedekle ve geri yükle"
        badge={history.length > 0 ? <Badge variant="info">Son: {history[0].date}</Badge> : undefined}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {/* Export Section */}
          <div style={{
            background: 'var(--surface-soft)', borderRadius: 8, padding: 20,
            border: '1px solid var(--line-soft)'
          }}>
            <h4 style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Download size={18} style={{ color: 'var(--accent-color)' }} /> Yedek Al
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
            background: 'var(--surface-soft)', borderRadius: 8, padding: 20,
            border: '1px solid var(--line-soft)'
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

      {/* Bulut yedeği (kullanıcının kendi S3 uyumlu kovası) — yukarıdaki indir / yükle aynen kalır */}
      <CloudBackupBoundary>
        <Suspense fallback={null}>
          <CloudBackupPanel />
        </Suspense>
      </CloudBackupBoundary>

      {/* Cihaz yedekleme (bilgisayar / telefon / tablet → Pi'nin diski, Syncthing) */}
      <CloudBackupBoundary name="Cihaz yedekleme">
        <Suspense fallback={null}>
          <DeviceBackupPanel />
        </Suspense>
      </CloudBackupBoundary>

      {/* What gets backed up */}
      <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
        <div className="widget-header">
          <h3><Database size={18} style={{ marginRight: 8 }} />Yedeklenen Bileşenler</h3>
        </div>
        <div className="list-items">
          {(manifest?.sections || []).map(section => (
            <div key={section.key} className="list-item" style={{ gap: 12 }}>
              <div style={{
                width: 34, height: 34, borderRadius: 8, background: 'rgba(59,130,246,0.1)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-color)', flexShrink: 0
              }}>
                {SECTION_ICONS[section.key] || <Database size={16} />}
              </div>
              <div style={{ minWidth: 0 }}>
                <strong style={{ fontSize: 13 }}>{section.label}</strong>
                <div className="text-muted" style={{ fontSize: 12 }}>{section.desc}</div>
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <Badge variant="neutral">{section.count} kayıt</Badge>
                <Check size={16} style={{ color: 'var(--success-color)' }} />
              </div>
            </div>
          ))}
          {!manifest && manifestError && (
            <div className="list-item" style={{ gap: 10 }}>
              <span className="text-muted" style={{ fontSize: 13, flex: 1 }}>Liste okunamadı ({manifestError}).</span>
              <button className="btn-outline btn-sm" onClick={() => { void refetchManifest(); }}>Yeniden dene</button>
            </div>
          )}
          {manifest?.excluded && (
            <div className="text-muted" style={{ fontSize: 12, padding: '10px 4px 2px' }}>{manifest.excluded}</div>
          )}
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
                <Archive size={14} style={{ color: 'var(--accent-color)' }} />
                <span style={{ fontSize: 13 }}>{item.date}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="text-muted" style={{ fontSize: 12 }}>{item.size}</span>
                <Badge variant="neutral">{item.records !== undefined ? `${item.records} kayıt` : `${item.items} tablo`}</Badge>
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
