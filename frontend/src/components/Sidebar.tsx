import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { TabId } from '../types';
import { BRAND } from '../brand';
import { NAV_TABS } from '../nav';

interface SidebarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  // Telefon/tablet: menü soldan açılan çekmecedir (≥1024px'te her zaman görünür, bu değerler etkisizdir)
  open: boolean;
  onClose: () => void;
}

// Grup başlığı yalnız grubun ilk öğesinin üstünde gösterilir (liste sabit: modül yüklenirken bir kez hesaplanır)
const GROUP_START = (() => {
  let last = '';
  return NAV_TABS.map(t => {
    const start = !!t.group && t.group !== last;
    if (t.group) last = t.group;
    return start;
  });
})();

export function Sidebar({ activeTab, onTabChange, open, onClose }: SidebarProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // Çekmece açılınca odak kapat düğmesine gelir (klavye/ekran okuyucu menünün içinden başlar); kapanınca açan düğmeye döner.
  useEffect(() => {
    if (open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      closeRef.current?.focus();
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
          {NAV_TABS.map((tab, i) => {
            const showGroup = GROUP_START[i];
            const active = activeTab === tab.id;
            const Icon = tab.icon;
            return (
              <li key={tab.id}>
                {showGroup && <span className="nav-group">{tab.group}</span>}
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
        <div className="sidebar-footer"><div className="version-badge">{BRAND.name} {BRAND.version}</div></div>
      </nav>
    </>
  );
}
