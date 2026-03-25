import { useState } from 'react';
import { Save, RotateCcw, ChevronDown, ChevronRight, Info } from 'lucide-react';
import { useApi, putApi, postApi } from '../../hooks/useApi';
import type { ConfigItem } from '../../types';

interface ServiceSettingsProps {
  service: string;
  categoryLabels?: Record<string, string>;
  categoryIcons?: Record<string, React.ReactNode>;
}

export function ServiceSettings({ service, categoryLabels = {}, categoryIcons = {} }: ServiceSettingsProps) {
  const { data, refetch } = useApi<{ service: string; config: Record<string, ConfigItem[]> }>(
    `/services/${service}/config`, { service, config: {} }
  );
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const hasChanges = Object.keys(changes).length > 0;

  const getValue = (key: string, original: string) => {
    return changes[key] !== undefined ? changes[key] : original;
  };

  const handleChange = (key: string, value: string) => {
    setChanges(prev => ({ ...prev, [key]: value }));
    setResult(null);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await putApi(`/services/${service}/config`, { changes });
      setChanges({});
      setResult({ type: 'success', msg: 'Ayarlar kaydedildi.' });
      await refetch();
    } catch (e: any) {
      setResult({ type: 'error', msg: e.message });
    }
    setSaving(false);
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await postApi(`/services/${service}/restart`, {});
      setResult({ type: 'success', msg: 'Servis yeniden başlatılıyor...' });
    } catch (e: any) {
      setResult({ type: 'error', msg: e.message });
    }
    setTimeout(() => setRestarting(false), 2500);
  };

  const toggleCollapse = (cat: string) => {
    setCollapsed(prev => ({ ...prev, [cat]: !prev[cat] }));
  };

  const renderInput = (item: ConfigItem) => {
    const val = getValue(item.key, item.value);
    const isChanged = changes[item.key] !== undefined && changes[item.key] !== item.value;

    if (item.type === 'boolean') {
      return (
        <button
          className={`toggle-btn ${val === 'true' ? 'toggle-on' : 'toggle-off'}`}
          onClick={() => handleChange(item.key, val === 'true' ? 'false' : 'true')}
        >
          <div className="toggle-knob" />
        </button>
      );
    }

    if (item.type === 'select') {
      const opts = item.options ? item.options.split(',') : [];
      return (
        <select
          className={`config-select ${isChanged ? 'config-changed' : ''}`}
          value={val}
          onChange={e => handleChange(item.key, e.target.value)}
        >
          <option value={val}>{val}</option>
          {opts.filter(o => o !== val).map(o => (
            <option key={o} value={o.trim()}>{o.trim()}</option>
          ))}
        </select>
      );
    }

    return (
      <input
        className={`config-input ${isChanged ? 'config-changed' : ''}`}
        type={item.type === 'number' ? 'number' : 'text'}
        value={val}
        onChange={e => handleChange(item.key, e.target.value)}
      />
    );
  };

  return (
    <div className="service-settings">
      <div className="settings-toolbar">
        <div className="settings-toolbar-left">
          {result && (
            <span className={`settings-result ${result.type === 'success' ? 'text-success' : 'text-danger'}`}>
              {result.msg}
            </span>
          )}
        </div>
        <div className="settings-toolbar-right">
          <button className="btn-outline btn-sm" onClick={handleRestart} disabled={restarting}>
            <RotateCcw size={13} className={restarting ? 'spin' : ''} />
            {restarting ? 'Yeniden Başlatılıyor...' : 'Servisi Yeniden Başlat'}
          </button>
          <button className="btn-primary btn-sm" onClick={handleSave} disabled={!hasChanges || saving}>
            <Save size={13} />
            {saving ? 'Kaydediliyor...' : `Kaydet${hasChanges ? ` (${Object.keys(changes).length})` : ''}`}
          </button>
        </div>
      </div>

      {Object.entries(data.config).map(([category, items]) => (
        <div key={category} className="config-category">
          <button className="config-category-header" onClick={() => toggleCollapse(category)}>
            <span className="config-category-icon">
              {categoryIcons[category] || <Info size={15} />}
            </span>
            <span className="config-category-title">{categoryLabels[category] || category}</span>
            <span className="config-category-count">{items.length} ayar</span>
            {collapsed[category] ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          </button>
          {!collapsed[category] && (
            <div className="config-items">
              {items.map(item => (
                <div key={item.key} className="config-item">
                  <div className="config-item-info">
                    <span className="config-item-label">{item.label}</span>
                    <span className="config-item-desc">{item.description}</span>
                  </div>
                  <div className="config-item-control">
                    {renderInput(item)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
