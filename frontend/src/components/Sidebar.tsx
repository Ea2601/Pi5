import { useEffect, useMemo, useRef } from 'react';
import { X, LogOut, ChevronLeft, Home, Globe, AlertTriangle } from 'lucide-react';
import type { TabId } from '../types';
import { BRAND } from '../brand';
import { NAV_TABS, type NavTab } from '../nav';
import { gateAppBack, gateAppStatus, useGateApp } from '../gateApp';

// Derlenen version.json sürümü (vite.config.ts define)
declare const __APP_VERSION__: string;

interface SidebarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  // Telefon/tablet: menü soldan açılan çekmecedir (≥1024px'te her zaman görünür, bu değerler etkisizdir)
  open: boolean;
  onClose: () => void;
  // Giriş ekranı modunda çıkış (telefonda üst çubukta kullanıcı alanı gizli olduğu için menünün altında)
  onLogout?: () => void;
  // Gösterilecek menü (mesh uydusunda ağ geçidi sayfaları çıkarılır — nav.ts navTabsFor); verilmezse tam menü.
  tabs?: NavTab[];
}

// Her öğenin grubu: grup adı yalnız grubun ilk öğesinde yazılı, sonrakiler onu taşır (tam menüden bir kez hesaplanır).
const GROUP_OF = (() => {
  let g = '';
  const m = new Map<string, string>();
  for (const t of NAV_TABS) { if (t.group) g = t.group; m.set(t.id, g); }
  return m;
})();
// Grup başlığı grubun görünen ilk öğesinin üstünde gösterilir (uydu menüsünde grubun ilk öğesi gizli olabilir).
function groupStarts(tabs: NavTab[]): string[] {
  let last = '';
  return tabs.map(t => {
    const g = GROUP_OF.get(t.id) || '';
    const start = g && g !== last ? g : '';
    if (g) last = g;
    return start;
  });
}

export function Sidebar({ activeTab, onTabChange, open, onClose, onLogout, tabs = NAV_TABS }: SidebarProps) {
  const starts = useMemo(() => groupStarts(tabs), [tabs]);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  // Klyrix/Gate uygulamasının içinde: en üstte cihaz listesine dönüş + bağlantı durumu (gateApp.ts)
  const app = useGateApp();
  const appSt = app ? gateAppStatus(app) : null;

  // Çekmece açılınca odak kapat düğmesine gelir (klavye/ekran okuyucu menünün içinden başlar); kapanınca açan düğmeye döner.
  useEffect(() => {
    if (open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // Çekmece açıldığı anda düğme tarayıcıda henüz "gizli" sayılır (visibility bir sonraki karede uygulanır) ve focus()
      // etkisiz kalır: odak, düğme odaklanabilir olana kadar sonraki karelerde denenir (en çok 0,5 sn).
      const started = performance.now();
      let raf = 0;
      const tryFocus = () => {
        const btn = closeRef.current;
        if (!btn) return;
        btn.focus();
        if (document.activeElement !== btn && performance.now() - started < 500) raf = requestAnimationFrame(tryFocus);
      };
      raf = requestAnimationFrame(tryFocus);
      return () => cancelAnimationFrame(raf);
    } else if (returnFocus.current) {
      returnFocus.current.focus();
      returnFocus.current = null;
    }
  }, [open]);

  return (
    <>
      <div className={`sidebar-backdrop ${open ? 'is-open' : ''}`} onClick={onClose} aria-hidden="true" />
      <nav id="app-nav" className={`glass-panel sidebar ${open ? 'is-open' : ''}`} aria-label="Ana menü">
        <div className="logo">
          {/* Orijinal vektör lockup (font path'e gömülü — bozulmaz). Temaya göre dark/light. */}
          <img className="logo-lockup logo-lockup-dark" src="/klyrix-gate-horizontal-dark.svg" alt={BRAND.name} />
          <img className="logo-lockup logo-lockup-light" src="/klyrix-gate-horizontal-light.svg" alt={BRAND.name} />
          <button ref={closeRef} className="icon-btn sidebar-close" onClick={onClose} aria-label="Menüyü kapat" title="Menüyü kapat">
            <X size={18} />
          </button>
        </div>
        <ul className="nav-links">
          {app && appSt && (
            <li>
              <button className={`nav-item nav-app-back nav-app-${appSt.tone}`} onClick={() => { onClose(); gateAppBack(); }}>
                <ChevronLeft size={17} />
                <span className="nav-app-text">
                  <span>Cihazlar</span>
                  <small>{appSt.text}</small>
                </span>
                {appSt.tone === 'bad' ? <AlertTriangle size={15} /> : app.via === 'remote' ? <Globe size={15} /> : <Home size={15} />}
              </button>
            </li>
          )}
          {tabs.map((tab, i) => {
            const showGroup = starts[i];
            const active = activeTab === tab.id;
            const Icon = tab.icon;
            return (
              <li key={tab.id}>
                {showGroup && <span className="nav-group">{showGroup}</span>}
                <button
                  className={`nav-item ${tab.sub ? 'nav-item-sub' : ''} ${active ? 'active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onTabChange(tab.id)}
                >
                  <Icon size={tab.sub ? 15 : 17} /><span>{tab.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="sidebar-footer">
          {onLogout && (
            <button className="nav-item sidebar-logout" onClick={onLogout}>
              <LogOut size={17} /><span>Çıkış yap</span>
            </button>
          )}
          <div className="version-badge">{BRAND.name}{__APP_VERSION__ ? ` v${__APP_VERSION__}` : ''}</div>
        </div>
      </nav>
    </>
  );
}
