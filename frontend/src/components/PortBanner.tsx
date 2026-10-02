import { useEffect, useState } from 'react';
import { Network } from 'lucide-react';
import { getApi, postApi } from '../hooks/useApi';
import { effectivePoll } from '../prefs';
import { toast } from '../toast';
import { portBus, KIND_TEXT, notifyPortsChanged, onPortsChanged, openPortWizard, type PortsResp } from '../ports';
import './PortBanner.css';

// Tak-çalıştır bandı: algılama açıkken (Cihaz Rolleri → Tak-çalıştır algılama; varsayılan kapalı) yeni takılan ve rolü
// seçilmemiş ağ kartı varsa "rolünü seç" der. Rol buradan atanmaz: düğme sihirbazı açar, sihirbaz mevcut onaylı paneli
// (WAN router / yedek hat) kart seçili getirir. Durum bir kez okunur; yoklama (15 sn, Ayarlar → Performans'a uyar) yalnız
// algılama açıkken. Uyduda / eski arka uçta istek hata verir: bant gizli kalır, yoklama yapılmaz.
export function PortBanner() {
  const [data, setData] = useState<PortsResp | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      clearTimeout(timer);
      const d = await getApi<PortsResp>('/ports').catch(() => null);
      if (!alive) return;
      setData(d);
      const ms = d?.enabled ? effectivePoll(15000) : null;
      if (ms) timer = setTimeout(() => { void load(); }, ms);
    };
    void load();
    const off = onPortsChanged(() => { void load(); });
    return () => { alive = false; clearTimeout(timer); off(); };
  }, []);

  const pending = data?.enabled ? data.pending : [];
  if (!pending.length) return null;
  const p = pending[0];

  const dismiss = async () => {
    setBusy(true);
    try {
      await postApi(`/ports/${encodeURIComponent(p.mac)}/dismiss`, {});
      toast.info(`${p.name} yoksayıldı`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Yoksayılamadı');
    }
    setBusy(false);
    notifyPortsChanged();
  };

  return (
    <div className="panel-auth-banner panel-auth-offer pb-banner" role="status">
      <Network size={16} />
      <span>
        <strong>Yeni ağ kartı bulundu — rolünü seç:</strong> {p.name} ({portBus(p)}{p.driver ? `, ${p.driver}` : ''}{p.kind !== 'ethernet' ? `, ${KIND_TEXT[p.kind]}` : ''})
        {pending.length > 1 ? ` ve ${pending.length - 1} kart daha` : ''}. Rol kendiliğinden atanmaz.
      </span>
      <div className="panel-auth-actions">
        <button className="btn-primary btn-sm" onClick={() => openPortWizard(p.mac)} disabled={busy}>Rolünü seç</button>
        <button className="btn-outline btn-sm pb-off" onClick={dismiss} disabled={busy}>Yoksay</button>
      </div>
    </div>
  );
}
