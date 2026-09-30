// HDMI ekran (kiosk): Pi'nin HDMI çıkışındaki tek ekranlı gösterge paneli. Pi'deki tarayıcı http://localhost/kiosk.html
// açar (pi5-kiosk servisi); panelden "Kiosk aç" ile her tarayıcıda da görülebilir.
//  - Tema ve vurgu rengi paneldeki ayarı izler (ya da HDMI Ekran ayarından sabitlenir); 60 sn'de bir yeniden okunur.
//  - Panel güncellenince (build.json kimliği değişince) sayfa kendini yeniler: ekran günlerce açık kalır.
//  - Ekran koruma: tüm görüntü birkaç dakikada bir 1-2 piksel kayar (TV / OLED'de sabit öğeler iz bırakmasın).
import { useEffect, useMemo, useState } from 'react';
import { BrandMark } from '../components/BrandMark';
import { NetworkBackdrop } from '../components/NetworkBackdrop';
import { applyThemeClass } from '../theme';
import { normalizeConfig, type KioskConfig, type KioskTileId } from './config';
import { usePoll, useOffline } from './data';
import { useStatus, useHostname } from './status';
import { SpeedTile, SystemTile, DnsTile, InternetTile, TunnelsTile, DevicesTile, SecurityTile, AlertTicker } from './tiles';

const ACCENTS = ['blue', 'green', 'purple', 'orange'];
const SHIFTS: [number, number][] = [[0, 0], [2, 1], [-1, 2], [-2, -1], [1, -2], [2, -2], [-2, 1]];

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function Kiosk() {
  const cfgRaw = usePoll<{ config?: unknown }>('/case/kiosk', 60000);
  const settings = usePoll<{ settings?: Record<string, string> }>('/settings', 60000);
  const hw = usePoll<{ board?: string }>('/system/hardware', 120000);
  const hostname = useHostname();
  const cfg: KioskConfig = useMemo(() => normalizeConfig(cfgRaw?.config), [cfgRaw]);
  const on = (id: KioskTileId) => cfg.tiles.find(t => t.id === id)?.enabled !== false;
  const offline = useOffline();
  const now = useClock();
  const status = useStatus();

  // Tema + vurgu rengi (panel ayarı ya da kioska özel sabit tema)
  const s = settings?.settings;
  useEffect(() => {
    const theme = cfg.theme === 'panel' ? (s?.theme === 'light' ? 'light' : 'dark') : cfg.theme;
    applyThemeClass(theme);
    const root = document.documentElement;
    root.classList.remove(...ACCENTS.map(a => `accent-${a}`));
    if (s?.accent_color && ACCENTS.includes(s.accent_color)) root.classList.add(`accent-${s.accent_color}`);
  }, [cfg.theme, s?.theme, s?.accent_color]);

  // Ekran koruma: 4 dk'da bir küçük kaydırma
  const [shift, setShift] = useState(0);
  useEffect(() => {
    if (!cfg.shift) return;
    const t = setInterval(() => setShift(i => (i + 1) % SHIFTS.length), 240000);
    return () => clearInterval(t);
  }, [cfg.shift]);

  // Yeni sürüm: build.json kimliği değişince yenile
  useEffect(() => {
    let first = '';
    const check = async () => {
      try {
        const r = await fetch('/build.json', { cache: 'no-store' });
        if (!r.ok) return;
        const id = String((await r.json())?.id || '');
        if (!first) first = id;
        else if (id && id !== first) location.reload();
      } catch { /* ağ yok: sonra yine denenir */ }
    };
    void check();
    const t = setInterval(check, 60000);
    return () => clearInterval(t);
  }, []);

  // Fare kıpırdayınca imleç 3 sn görünür (dokunmatikte hiç görünmez)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const show = () => {
      document.body.classList.add('k-pointer');
      clearTimeout(t);
      t = setTimeout(() => document.body.classList.remove('k-pointer'), 3000);
    };
    window.addEventListener('mousemove', show);
    return () => { window.removeEventListener('mousemove', show); clearTimeout(t); };
  }, []);

  const [sx, sy] = cfg.shift ? SHIFTS[shift] : SHIFTS[0];
  const topTiles = (on('system') ? 1 : 0) + (on('dns') ? 1 : 0);
  const bottom = (['internet', 'tunnels', 'devices', 'security'] as KioskTileId[]).filter(on);
  const hasTop = on('traffic') || topTiles > 0;
  // "Raspberry Pi 5 Model B Rev 1.1" → "Raspberry Pi 5"
  const board = (hw?.board || '').replace(/^(Raspberry Pi \d+).*$/, '$1');
  const sub = [hostname, board].filter(Boolean).join(' · ');

  return (
    <>
      <NetworkBackdrop variant="panel" />
      {offline && <div className="k-offline">Panel API'sine ulaşılamıyor — veriler güncel olmayabilir</div>}
      <div className="k-app" style={{ ['--k-shift-x' as string]: `${sx}px`, ['--k-shift-y' as string]: `${sy}px` }}>
        <header className="k-head">
          <div className="k-brand">
            <BrandMark size={44} />
            <div className="k-brand-text">
              <span className="k-wordmark">Klyrix<span>/gate</span></span>
              <span className="k-brand-sub">{sub || 'Secure Gateway'}</span>
            </div>
          </div>
          <div className={`k-status k-status-${status.level}`} title={status.text}>
            <span className="k-status-dot" />
            <span>{status.text}</span>
          </div>
          <div className="k-clock">
            <span className="k-clock-time">{now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</span>
            <span className="k-clock-date">
              {now.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' })}
            </span>
          </div>
        </header>

        <main className={`k-main ${!hasTop || !bottom.length ? 'k-one' : ''}`}>
          {hasTop && (
            <section className={`k-top ${!on('traffic') || !topTiles ? 'k-top-solo' : ''}`}>
              {on('traffic') && <SpeedTile />}
              {topTiles > 0 && (
                <div className="k-stack">
                  {on('system') && <SystemTile />}
                  {on('dns') && <DnsTile />}
                </div>
              )}
            </section>
          )}
          {bottom.length > 0 && (
            <section className="k-bottom">
              {on('internet') && <InternetTile />}
              {on('tunnels') && <TunnelsTile />}
              {on('devices') && <DevicesTile />}
              {on('security') && <SecurityTile />}
            </section>
          )}
        </main>

        {on('alerts') ? <AlertTicker /> : <div />}
      </div>
    </>
  );
}
