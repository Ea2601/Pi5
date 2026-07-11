import { useSyncExternalStore, useEffect, useRef, useState, useCallback } from 'react';
import { CheckCircle, AlertTriangle, Info, X } from 'lucide-react';

/**
 * Global toast bildirim sistemi (react-hot-toast / sonner deseni).
 *
 * Kullanım — panellerde provider/hook GEREKMEZ, sadece içe aktar ve çağır:
 *   import { toast } from '../toast';
 *   toast.success('Ayarlar kaydedildi.');
 *   toast.error('Kaydetme başarısız.');
 *   toast.info('Servis yeniden başlatılıyor...');
 *
 * <Toaster /> bir kez App kökünde (sekmelerden bağımsız) mount edilir.
 */

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  duration: number; // ms; 0 = otomatik kapanmaz
}

export interface ToastOptions {
  duration?: number;
}

// ─── Modül-seviyesi store ───
const MAX_VISIBLE = 4;
const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 3200,
  info: 4200,
  error: 6000,
};

let items: ToastItem[] = [];
let counter = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getSnapshot(): ToastItem[] {
  return items;
}

function add(type: ToastType, message: string, opts?: ToastOptions): number {
  const msg = (message ?? '').toString().trim();
  if (!msg) return -1;
  const id = ++counter;
  const duration = opts?.duration ?? DEFAULT_DURATION[type];
  let next = [...items, { id, type, message: msg, duration }];
  // Ekranı taşırmamak için en eskileri düşür
  if (next.length > MAX_VISIBLE) next = next.slice(next.length - MAX_VISIBLE);
  items = next;
  emit();
  return id;
}

export function dismissToast(id: number): void {
  const next = items.filter(t => t.id !== id);
  if (next.length !== items.length) {
    items = next;
    emit();
  }
}

export const toast = {
  success: (message: string, opts?: ToastOptions) => add('success', message, opts),
  error: (message: string, opts?: ToastOptions) => add('error', message, opts),
  info: (message: string, opts?: ToastOptions) => add('info', message, opts),
  dismiss: dismissToast,
};

// ─── Görsel katman ───
const EXIT_MS = 200;

const ICONS: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle size={17} />,
  error: <AlertTriangle size={17} />,
  info: <Info size={17} />,
};

function ToastCard({ item }: { item: ToastItem }) {
  const [leaving, setLeaving] = useState(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const close = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    exitTimer.current = setTimeout(() => dismissToast(item.id), EXIT_MS);
  }, [item.id, leaving]);

  const startTimer = useCallback(() => {
    if (item.duration <= 0) return;
    dismissTimer.current = setTimeout(close, item.duration);
  }, [item.duration, close]);

  const clearAuto = useCallback(() => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
  }, []);

  useEffect(() => {
    startTimer();
    return () => {
      clearAuto();
      if (exitTimer.current) clearTimeout(exitTimer.current);
    };
  }, [startTimer, clearAuto]);

  return (
    <div
      className={`toast-card toast-${item.type} ${leaving ? 'toast-leaving' : ''}`}
      role="status"
      onMouseEnter={clearAuto}
      onMouseLeave={startTimer}
    >
      <span className="toast-icon">{ICONS[item.type]}</span>
      <span className="toast-message">{item.message}</span>
      <button className="toast-close" onClick={close} aria-label="Bildirimi kapat">
        <X size={14} />
      </button>
    </div>
  );
}

export function Toaster() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    <div className="toast-viewport" aria-live="polite" aria-label="Bildirimler">
      {list.map(item => <ToastCard key={item.id} item={item} />)}
    </div>
  );
}
