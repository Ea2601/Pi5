import { Children, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

// Temaya uygun açılır liste — native <select> yerine (tarayıcının kendi açılır penceresi temayı / koyu modu izlemiyordu).
// Doğrudan yerine geçer: <select> → <Select>; <option>/<optgroup> çocukları, value / defaultValue, onChange(e => e.target.value)
// (değer native'deki gibi METİN), className, style, disabled, title aynen çalışır. Kontrolsüz kullanımda onChange içinde
// `e.target.value = ''` seçimi sıfırlar (Kasa sayfasındaki "+ ekle" menüleri). Liste body'ye taşınır (portal): kartların
// overflow'una takılmaz, modal / menü çekmecesinin üstünde açılır. Klavye: ↑↓ Home End PageUp PageDown Enter Space Esc Tab,
// harfle arama. Ekran okuyucu: combobox + listbox (aria-activedescendant).

export type SelectChangeEvent = { target: { value: string; name?: string }; currentTarget: { value: string; name?: string } };

type Opt = { value: string; label: string; disabled: boolean; group?: string };

export interface SelectProps {
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (e: SelectChangeEvent) => void;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  title?: string;
  name?: string;
  id?: string;
  'aria-label'?: string;
  children?: ReactNode;
}

const textOf = (n: ReactNode): string => {
  if (n == null || typeof n === 'boolean') return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  if (isValidElement(n)) return textOf((n.props as { children?: ReactNode }).children);
  return '';
};

// <option> / <optgroup> çocuklarından düz liste (grup adı seçeneğin üstünde başlık olarak gösterilir)
function collect(children: ReactNode, group?: string, out: Opt[] = []): Opt[] {
  Children.forEach(children, ch => {
    if (!isValidElement(ch)) return;
    const el = ch as ReactElement<{ value?: string | number; disabled?: boolean; label?: string; children?: ReactNode }>;
    if (el.type === 'option') {
      const label = textOf(el.props.children);
      out.push({ value: el.props.value !== undefined ? String(el.props.value) : label, label, disabled: !!el.props.disabled, group });
    } else if (el.type === 'optgroup') {
      collect(el.props.children, el.props.label || '', out);
    } else {
      collect(el.props.children, group, out); // Fragment vb.
    }
  });
  return out;
}

export function Select({ value, defaultValue, onChange, className = '', style, disabled, title, name, id, children, ...rest }: SelectProps) {
  const opts = useMemo(() => collect(children), [children]);
  const controlled = value !== undefined;
  const [inner, setInner] = useState<string>(() => (defaultValue !== undefined ? String(defaultValue) : opts[0]?.value ?? ''));
  const current = controlled ? String(value) : inner;
  // Değer listede yoksa native gibi ilk seçenek görünür
  const selIdx = Math.max(0, opts.findIndex(o => o.value === current));
  const selected = opts[selIdx];

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selIdx);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxH: number; up: boolean; font: string } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ s: '', t: 0 });
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-o${i}`;

  const enabledFrom = (i: number, dir: 1 | -1) => {
    for (let k = i; k >= 0 && k < opts.length; k += dir) if (!opts[k].disabled) return k;
    return -1;
  };

  const place = useCallback(() => {
    const b = btnRef.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const vh = window.innerHeight, vw = window.innerWidth;
    const below = vh - r.bottom - 8, above = r.top - 8;
    const want = Math.min(300, opts.length * 36 + 12);
    const up = below < Math.min(want, 180) && above > below;
    const width = Math.min(Math.max(r.width, 160), vw - 16);
    const left = Math.min(Math.max(8, r.left), vw - width - 8);
    setPos({ left, top: up ? r.top - 4 : r.bottom + 4, width, maxH: Math.max(120, Math.min(300, up ? above : below)), up, font: getComputedStyle(b).fontFamily });
  }, [opts.length]);

  const openList = () => {
    if (disabled || opts.length === 0) return;
    const start = opts[selIdx]?.disabled ? enabledFrom(0, 1) : selIdx;
    setActive(start < 0 ? 0 : start);
    place();
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };

  const choose = (i: number) => {
    const o = opts[i];
    if (!o || o.disabled) return;
    close();
    if (o.value === current) return; // native gibi: değişmediyse change yok
    if (!controlled) setInner(o.value);
    const target = {
      name,
      get value() { return o.value; },
      // Kontrolsüz kullanımda `e.target.value = ''` gösterilen seçimi sıfırlar
      set value(v: string) { if (!controlled) setInner(String(v)); },
    };
    onChange?.({ target, currentTarget: target });
  };

  // Açıkken: dışarı tıklanınca kapan; sayfa kayar / boyut değişirse konumu tazele
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || listRef.current?.contains(t)) return;
      close(false);
    };
    const onMove = () => place();
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, place]);

  // Etkin seçenek görünür alanda kalsın
  useLayoutEffect(() => {
    if (!open) return;
    document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  const typeAhead = (key: string) => {
    const now = Date.now();
    typed.current = { s: (now - typed.current.t < 600 ? typed.current.s : '') + key.toLowerCase(), t: now };
    const s = typed.current.s;
    // Tek harf: bir sonraki eşleşmeye geç; hızlı yazılan birkaç harf: bulunduğu yerden başlayarak daralt
    const start = (open ? active : selIdx) + (s.length > 1 ? 0 : 1);
    for (let k = 0; k < opts.length; k++) {
      const j = (start + k) % opts.length;
      if (!opts[j].disabled && opts[j].label.toLowerCase().startsWith(s)) return j;
    }
    return -1;
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const k = e.key;
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') { e.preventDefault(); openList(); return; }
      if (k.length === 1 && /\S/.test(k)) { const j = typeAhead(k); if (j >= 0) { e.preventDefault(); openList(); setActive(j); } }
      return;
    }
    const move = (i: number, dir: 1 | -1) => { const j = enabledFrom(Math.max(0, Math.min(opts.length - 1, i)), dir); if (j >= 0) setActive(j); };
    switch (k) {
      case 'ArrowDown': e.preventDefault(); move(active + 1, 1); break;
      case 'ArrowUp': e.preventDefault(); move(active - 1, -1); break;
      case 'Home': e.preventDefault(); move(0, 1); break;
      case 'End': e.preventDefault(); move(opts.length - 1, -1); break;
      case 'PageDown': e.preventDefault(); move(active + 8, 1); break;
      case 'PageUp': e.preventDefault(); move(active - 8, -1); break;
      case 'Enter': case ' ': e.preventDefault(); choose(active); break;
      case 'Escape': e.preventDefault(); close(); break;
      case 'Tab': close(false); break;
      default:
        if (k.length === 1 && /\S/.test(k)) { const j = typeAhead(k); if (j >= 0) setActive(j); }
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        id={id}
        name={name}
        title={title}
        className={`ui-select-trigger ${className}`}
        style={style}
        disabled={disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optId(active) : undefined}
        aria-label={rest['aria-label']}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKey}
      >
        <span className="ui-select-value">{selected?.label ?? ''}</span>
        <ChevronDown size={14} className={`ui-select-chevron ${open ? 'is-open' : ''}`} aria-hidden="true" />
      </button>
      {open && pos && createPortal(
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          className={`ui-select-pop ${pos.up ? 'is-up' : ''}`}
          style={{
            left: pos.left, width: pos.width, maxHeight: pos.maxH, fontFamily: pos.font,
            ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
          }}
          onMouseDown={e => e.preventDefault() /* odak düğmede kalsın */}
        >
          {opts.map((o, i) => (
            <div key={`${i}-${o.value}`}>
              {o.group !== undefined && (i === 0 || opts[i - 1].group !== o.group) && (
                <div className="ui-select-group" role="presentation">{o.group}</div>
              )}
              <div
                id={optId(i)}
                role="option"
                aria-selected={i === selIdx}
                aria-disabled={o.disabled || undefined}
                className={`ui-select-opt ${i === active ? 'is-active' : ''} ${o.group !== undefined ? 'in-group' : ''}`}
                onMouseEnter={() => { if (!o.disabled) setActive(i); }}
                onClick={() => choose(i)}
              >
                <span className="ui-select-opt-label">{o.label}</span>
                {i === selIdx && <Check size={14} className="ui-select-check" aria-hidden="true" />}
              </div>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
