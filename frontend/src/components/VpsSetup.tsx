import {
  Server, Lock, Globe, Loader2, CheckCircle, AlertTriangle, Trash2, Plus,
  Wifi, Settings, Activity, Network, Eye, EyeOff, Copy, X, QrCode, Users,
  Home, Plug, Unplug, RefreshCw, ChevronDown, FileKey, Upload, Pencil, ShieldCheck
} from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useApi, getApi, postApi, putApi, deleteApi } from '../hooks/useApi';
import { ServiceSettings } from './ui/ServiceSettings';
import { Select } from './ui';
import { toast } from '../toast';
import type { VpsServer } from '../types';
import { PiVpnServer } from './PiVpnServer';
import { tunnelBadge, type TunnelInfo, type TunnelState } from '../vpsTunnel';
import './WgCard.css';

// tunnel-status yanıtı: connected = wg_vps<ID> arayüzü var (Tünel Kes / Bağla düğmesi), state = el sıkışmaya göre durum,
// rx / tx = tünelin toplam baytları (kart iki okumanın farkından hızı hesaplar), at = okuma anı (ms).
type TunnelStatus = TunnelInfo & { connected: boolean; rx: number | null; tx: number | null; at: number };
const TUNNEL_DOWN: TunnelStatus = { connected: false, state: 'down', handshakeAge: null, rx: null, tx: null, at: 0 };
const TUNNEL_STATES: TunnelState[] = ['up', 'connecting', 'stale', 'down'];
const parseTunnel = (d: unknown): TunnelStatus => {
  const o = (d && typeof d === 'object' ? d : {}) as { connected?: unknown; state?: unknown; handshakeAge?: unknown; rx?: unknown; tx?: unknown; at?: unknown };
  const connected = !!o.connected;
  const state = TUNNEL_STATES.includes(o.state as TunnelState) ? o.state as TunnelState : connected ? 'up' : 'down';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { connected, state, handshakeAge: num(o.handshakeAge), rx: num(o.rx), tx: num(o.tx), at: num(o.at) ?? Date.now() };
};

type SetupState = 'idle' | 'deploying' | 'success' | 'error';
// 'pivpn': Pi üzerindeki WireGuard sunucusu (Ev VPN'i) — dış VPS'lerden ve onların istemcilerinden ayrı alan.
type VpsTab = 'overview' | 'clients' | 'pivpn' | 'settings';
type StepStatus = 'pending' | 'running' | 'success' | 'error';

interface SetupStep {
  key: string;
  label: string;
  status: StepStatus;
  message: string;
  duration: string;
}

interface WgClient {
  id: number;
  vps_id: number;
  name: string;
  ip: string;
  public_key: string;
  config: string;
  qr_data: string;
  created_at: string;
  panel_access?: number | null; // 1 = paneli tünelden açabilir (uzaktan yönetim)
}

const SETUP_STEPS: { key: string; label: string }[] = [
  { key: 'connection', label: 'Baglanti Kontrolu' },
  { key: 'update', label: 'Sistem Guncellemesi' },
  { key: 'packages', label: 'Paket Kurulumu' },
  { key: 'maintenance', label: 'Gunluk Bakim Ayarlari' },
  { key: 'wireguard', label: 'WireGuard Kurulumu' },
  { key: 'handshake', label: 'Handshake Dogrulama' },
];

function StepIndicator({ step }: { step: SetupStep }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px', borderRadius: 'var(--radius-sm)',
      background: step.status === 'running' ? 'var(--accent-glow)' :
        step.status === 'success' ? 'var(--success-glow)' :
        step.status === 'error' ? 'var(--danger-glow)' : 'var(--surface-faint)',
      border: '1px solid',
      borderColor: step.status === 'running' ? 'rgba(59,130,246,0.2)' :
        step.status === 'success' ? 'rgba(34,197,94,0.2)' :
        step.status === 'error' ? 'rgba(239,68,68,0.2)' : 'var(--panel-border)',
      transition: 'all 0.3s ease',
    }}>
      <div style={{ flexShrink: 0 }}>
        {step.status === 'pending' && <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--text-muted)', opacity: 0.3 }} />}
        {step.status === 'running' && <Loader2 size={20} className="spin" style={{ color: 'var(--accent-color)' }} />}
        {step.status === 'success' && <CheckCircle size={20} style={{ color: 'var(--success-color)' }} />}
        {step.status === 'error' && <AlertTriangle size={20} style={{ color: 'var(--danger-color)' }} />}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: step.status === 'pending' ? 'var(--text-muted)' : 'var(--text-primary)' }}>
          {step.label}
        </div>
        {step.message && (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{step.message}</div>
        )}
      </div>
      {step.duration && step.status !== 'pending' && (
        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{step.duration}</span>
      )}
    </div>
  );
}

// Bu VPS'e yönlenen etkin kurallar, tünel düşünce ne olacağına göre (Kes / Sil onayı). Okunamazsa boş: onay sorulmaz,
// işlem eskisi gibi sürer.
async function vpsRuleUsage(id: number): Promise<{ block: string[]; isp: string[] }> {
  try {
    const r = await getApi<{ block?: string[]; isp?: string[] }>(`/vps/${id}/routing-usage`);
    return { block: r.block || [], isp: r.isp || [] };
  } catch {
    return { block: [], isp: [] };
  }
}
const ruleNames = (xs: string[]) => xs.slice(0, 6).join(', ') + (xs.length > 6 ? ` +${xs.length - 6}` : '');

// VPS istemcisini siler. VPS'e ulaşılamaz ya da wg0.conf güncellenemezse sunucu kaydı bırakır (VPS'te eş kalmasın) ve
// hatayı döner: kullanıcıya sorulur, onaylarsa yalnız listeden silinir (?force=1 — ör. VPS artık yok).
// panelAccess: istemcinin panel erişimi açık — panel şu an tünelden açıksa bu cihazın kendisi olabilir, önce sorulur.
async function deleteVpsClient(vpsId: number | string, clientId: number, name: string, panelAccess = false): Promise<boolean> {
  if (panelAccess && !confirmTunnelCut(`${name} istemcisini silmek — paneli şu an bu cihazdan açıyorsanız — bağlantınızı keser; yeniden açmak için ev ağından girmeniz gerekir.`)) return false;
  try {
    const r = await deleteApi(`/vps/${vpsId}/clients/${clientId}`);
    if (r?.warning) toast.info(`${name}: ${r.warning}`); else toast.success(`${name} silindi`);
    return true;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : 'silinemedi';
    if (!window.confirm(`${name} VPS'ten silinemedi: ${msg}\n\nYalnız listeden silinsin mi? VPS'te eş kalabilir — VPS artık yoksa bunu seçin.`)) {
      toast.error(`${name} silinmedi: ${msg}`);
      return false;
    }
    try {
      await deleteApi(`/vps/${vpsId}/clients/${clientId}?force=1`);
      toast.info(`${name} listeden silindi (VPS'te eş kalmış olabilir)`);
      return true;
    } catch (e2) {
      toast.error(`${name} silinemedi: ${e2 instanceof Error && e2.message ? e2.message : 'bilinmeyen hata'}`);
      return false;
    }
  }
}

// Uzaktan yönetim (backend remoteAccess.ts): VPS istemcisi paneli tünelden (http://10.66.66.2) açabilsin mi. Panel internete
// açılmaz; şifre yine sorulur. Kapalı anahtar yalnız panel koruması kalıcı açıkken ve başka bir VPS'te açık istemci yokken
// açılabilir (backend de reddeder); açık anahtar her zaman kapatılabilir.
const PANEL_TUNNEL_IP = '10.66.66.2';
const PANEL_TUNNEL_URL = `http://${PANEL_TUNNEL_IP}`;
// Panel şu an VPS tünelinden mi açık: tüneli ya da bu cihazın erişimini kesen işlem bu bağlantıyı da keser (yanıt gelmeyebilir)
// — önce açıkça sorulur. Evden açıkken soru yok.
function confirmTunnelCut(effect: string): boolean {
  return window.location.hostname !== PANEL_TUNNEL_IP
    || window.confirm(`Paneli şu an VPS tünelinden (${PANEL_TUNNEL_URL}) açıyorsunuz.\n\n${effect}\n\nDevam edilsin mi?`);
}
// Panel koruması (panel-auth.sh durumu) kalıcı açık değilken anahtarın notu: off = kapalı anahtar (kilitli), on = açık
// anahtar (backend erişimi durdurmuştur). 'error' / null (okunamadı / okunuyor) kilitlemez — karar backend'de.
const AUTH_HINT: Record<string, { off: string; on: string }> = {
  pending: {
    off: 'Panel koruması kapalı — önce üstteki banttan panel şifresini açıp kalıcı yapın; şifresiz panel tünelden açılmaz.',
    on: 'Panel koruması kapalı — erişim durduruldu; koruma açılınca döner.',
  },
  trial: {
    off: 'Panel koruması deneme süresinde — üstteki banttan kalıcı yapın, sonra açılabilir.',
    on: 'Panel koruması deneme süresinde — erişim, koruma kalıcı yapılınca döner.',
  },
  legacy: {
    off: 'Panel koruması eski yöntemle (elle yazılmış nginx ayarı) açık — uzaktan yönetim panelden yönetilen korumayı ister.',
    on: 'Panel koruması eski yöntemle açık — erişim durduruldu; panelden yönetilen koruma gerekir.',
  },
};
function PanelAccess({ vpsId, client, auth, lockedBy, tunnelDown, onChanged }: {
  vpsId: number | string; client: WgClient;
  auth: string | null;       // panel-auth durumu (null: okunuyor)
  lockedBy: string | null;   // panel erişimi başka bir VPS'te açık: onun adı
  tunnelDown: boolean;       // Pi ↔ VPS tüneli kapalı
  onChanged: () => void;
}) {
  const saved = Number(client.panel_access) === 1;
  // İstek sonucu, liste yeniden okunana dek gösterilir (anahtar eski konuma sıçramasın); liste değişince kendiliğinden düşer.
  const [shown, setShown] = useState<{ base: boolean; value: boolean } | null>(null);
  const on = shown && shown.base === saved ? shown.value : saved;
  const [busy, setBusy] = useState(false);
  const authHint = auth ? AUTH_HINT[auth] : undefined;
  const lockReason = on ? '' : authHint ? authHint.off
    : lockedBy ? `Panel erişimi ${lockedBy} VPS'inde açık — aynı anda tek VPS (önce onu kapatın).` : '';
  const toggle = async () => {
    if (!on && !window.confirm(
      `${client.name} paneli VPS tünelinden açabilsin mi?\n\n` +
      `• Bu cihaz VPS'e bağlıyken panel: ${PANEL_TUNNEL_URL} (panel şifresi yine sorulur; panel internete açılmaz)\n` +
      "• Cihaz Pi'nin SSH (22) ve DNS'ine (53) de ulaşır; Pi'deki diğer hizmetlere ve ev ağına ulaşmaz.\n" +
      "• Panel bu yolda şifrelenmemiş HTTP'dir: VPS'i yöneten (siz ya da sağlayıcınız) trafiği ve panel şifresini görebilir, " +
      "bu cihazın adresini kullanabilir. Yalnız kendi yönettiğiniz VPS'te ve kendi cihazlarınız için açın; panel şifresini " +
      'başka yerde kullanmayın, işiniz bitince kapatın.',
    )) return;
    if (on && !confirmTunnelCut(`${client.name} için panel erişimini kapatmak — paneli şu an bu cihazdan açıyorsanız — bağlantınızı hemen keser; yeniden açmak için ev ağından girmeniz gerekir.`)) return;
    setBusy(true);
    try {
      const r = await putApi(`/vps/${vpsId}/clients/${client.id}/panel-access`, { enabled: !on });
      setShown({ base: saved, value: Number(r?.panel_access) === 1 });
      toast.success(on ? `${client.name}: panel erişimi kapatıldı` : `${client.name}: panel erişimi açıldı — ${PANEL_TUNNEL_URL}`);
      onChanged();
    } catch (e) {
      toast.error(`${client.name}: ${errText(e, 'kaydedilemedi')}`);
    }
    setBusy(false);
  };
  const warn = (text: string) => <span className="wg-pa-warn"><AlertTriangle size={11} />{text}</span>;
  const live = !authHint && !tunnelDown; // açık anahtar şu an gerçekten çalışıyor (koruma açık, tünel ayakta)
  return (
    <div className="wg-pa">
      <button type="button" role="switch" aria-checked={on} aria-label={`${client.name}: panel erişimi (yönetici)`}
        title={lockReason || (on ? 'Panel erişimini kapat' : 'Panel erişimini aç')}
        className={`toggle-btn toggle-sm ${on ? 'toggle-on' : 'toggle-off'}`} disabled={busy || !!lockReason} onClick={toggle}>
        <div className="toggle-knob" />
      </button>
      <span className="wg-pa-text">
        <span className="wg-pa-label">Panel erişimi (yönetici){busy && <Loader2 size={11} className="spin" />}</span>
        {lockReason ? (
          <span className="wg-sub">{lockReason}</span>
        ) : on ? (
          <>
            <span className="wg-sub">Bu cihaz VPS'e bağlıyken panel: {live
              ? <a className="wg-pa-url" href={PANEL_TUNNEL_URL} target="_blank" rel="noreferrer">{PANEL_TUNNEL_URL}</a>
              : <span className="wg-mono">{PANEL_TUNNEL_URL}</span>}</span>
            {authHint ? warn(authHint.on)
              : tunnelDown ? warn('Tünel kapalı — panel şu an bu yoldan açılmaz; tünel bağlanınca (en geç 30 sn) çalışır.')
                : warn("Bu cihaz Pi'nin SSH ve DNS'ine de ulaşır.")}
            {auth === 'error' && <span className="wg-sub">Panel koruması durumu okunamadı.</span>}
          </>
        ) : (
          <span className="wg-sub">Kapalı — açılırsa bu cihaz VPS'e bağlıyken panel {PANEL_TUNNEL_URL} adresinde açılır.{auth === 'error' ? ' Panel koruması durumu okunamadı.' : ''}</span>
        )}
      </span>
    </div>
  );
}

function ClientCard({ client, vpsLabel, onShowConfig, onShowQr, onDelete, panelAccess }: {
  client: WgClient;
  vpsLabel: string;
  onShowConfig: () => void;
  onShowQr: () => void;
  onDelete: () => void;
  panelAccess: React.ReactNode;
}) {
  const [deleting, setDeleting] = useState(false);
  return (
    <div style={{
      padding: 16, borderRadius: 'var(--radius)',
      border: '1px solid var(--panel-border)',
      background: 'var(--surface-subtle)',
      transition: 'all 0.15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Users size={16} style={{ color: 'var(--accent-color)' }} />
        <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-strong)', flex: 1 }}>{client.name}</span>
        <button className="btn-outline btn-sm" style={{ fontSize: 10, padding: '2px 6px', color: 'var(--danger-color)', borderColor: 'var(--danger-color)' }}
          title="Client'ı sil (VPS'ten de kaldırır)"
          disabled={deleting}
          onClick={async () => { setDeleting(true); await onDelete(); setDeleting(false); }}>
          {deleting ? <Loader2 size={11} className="spin" /> : <Trash2 size={11} />}
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-muted)' }}>VPS</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', fontSize: 11 }}>{vpsLabel}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-muted)' }}>IP</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{client.ip}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-muted)' }}>Public Key</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', fontSize: 10 }}>
            {client.public_key.slice(0, 16)}...
          </span>
        </div>
      </div>
      {panelAccess}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn-outline btn-sm" style={{ flex: 1 }} onClick={onShowConfig}>
          <Lock size={12} /> Config
        </button>
        <button className="btn-outline btn-sm" style={{ flex: 1 }} onClick={onShowQr}>
          <QrCode size={12} /> QR
        </button>
      </div>
    </div>
  );
}

function ConfigModal({ client, onClose }: { client: WgClient; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(client.config);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* */ }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--overlay-strong)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <div className="glass-panel" style={{ padding: 24, maxWidth: 520, width: '90%' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Lock size={18} /> {client.name} - WireGuard Config
          </h3>
          <button className="icon-btn icon-btn-sm" onClick={onClose}><X size={14} /></button>
        </div>
        <pre style={{
          background: 'var(--code-bg)', border: '1px solid var(--panel-border)',
          borderRadius: 'var(--radius-sm)', padding: 16,
          fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--code-ink)',
          overflowX: 'auto', lineHeight: 1.8, whiteSpace: 'pre-wrap',
        }}>
          {client.config}
        </pre>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn-primary btn-sm" onClick={handleCopy}>
            {copied ? <><CheckCircle size={13} /> Kopyalandi</> : <><Copy size={13} /> Kopyala</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function QrModal({ client, onClose }: { client: WgClient; onClose: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--overlay-strong)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <div className="glass-panel" style={{ padding: 24, maxWidth: 360, width: '90%', textAlign: 'center' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <QrCode size={18} /> {client.name} - QR Kod
          </h3>
          <button className="icon-btn icon-btn-sm" onClick={onClose}><X size={14} /></button>
        </div>
        <div style={{
          background: 'var(--bg-surface)', borderRadius: 'var(--radius)',
          padding: 24, border: '1px solid var(--panel-border)',
        }}>
          <img src={client.qr_data} alt={`QR - ${client.name}`} style={{ width: '100%', maxWidth: 200 }} />
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
          Bu QR kodu WireGuard mobil uygulamasinda taratarak baglanabilirsiniz.
        </p>
      </div>
    </div>
  );
}

interface InternetStatus {
  internet: boolean; dns: boolean; forwarding: boolean;
  wireguard: boolean; nat: boolean; publicIp: string; allGood: boolean;
  // Hazır yapılandırma (kind 'import'): SSH denetimi yok — yalnız Pi'den tünel üzerinden ölçülen çıkış IP'si ve nedeni (note).
  kind?: string; fullTunnel?: boolean; note?: string;
}

interface RepairResult {
  check: string; status: 'ok' | 'fixed' | 'failed'; detail: string;
}

// ─── WireGuard (VPS) kartı ───
// Bilgi satırları her zaman yerinde durur (okunurken "okunuyor…"), değerler canlı güncellenir: tünel 10 sn'de bir
// (bağlanırken 5 sn), VPS denetimi (SSH: internet, DNS, yönlendirme, WireGuard, NAT, çıkış IP'si) açılışta ve 5 dk'da bir,
// kurallar dakikada bir. Trafik hızı iki tünel okumasının bayt farkından (backend tunnel-status rx / tx).
const TUNNEL_POLL_MS = 10000;
const TUNNEL_POLL_FAST_MS = 5000;
const CHECK_EVERY_MS = 5 * 60000;
const USAGE_EVERY_MS = 60000;
type Tone = 'ok' | 'info' | 'warn' | 'bad' | 'off' | 'wait';
const TUNNEL_TONE: Record<TunnelState, Tone> = { up: 'ok', connecting: 'info', stale: 'warn', down: 'off' };
const TUNNEL_TEXT: Record<TunnelState, string> = { up: 'Açık', connecting: 'Bağlanıyor…', stale: 'Yanıt vermiyor', down: 'Kapalı' };
const CHECKS: { key: 'internet' | 'dns' | 'forwarding' | 'wireguard' | 'nat'; label: string; title: string }[] = [
  { key: 'internet', label: 'İnternet', title: "VPS internete çıkabiliyor (8.8.8.8'e ping)" },
  { key: 'dns', label: 'DNS', title: 'VPS ad çözebiliyor' },
  { key: 'forwarding', label: 'Yönlendirme', title: 'VPS IP yönlendirmesi açık (ip_forward)' },
  { key: 'wireguard', label: 'WireGuard', title: "VPS'te wg0 arayüzü ayakta" },
  { key: 'nat', label: 'NAT', title: 'VPS çıkışta adres çeviriyor (MASQUERADE)' },
];
const fmtAgo = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} sn önce` : s < 3600 ? `${Math.floor(s / 60)} dk önce` : `${Math.floor(s / 3600)} sa önce`;
};
const fmtHs = (s: number | null) =>
  s === null ? 'el sıkışma yok' : `el sıkışma ${s < 120 ? `${s} sn` : s < 7200 ? `${Math.floor(s / 60)} dk` : `${Math.floor(s / 3600)} sa`} önce`;
const fmtRate = (Bps: number) => {
  const b = Bps * 8;
  return b < 1e3 ? `${Math.round(b)} bps` : b < 1e6 ? `${(b / 1e3).toFixed(b < 1e4 ? 1 : 0)} kbps` : `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} Mbps`;
};
const fmtBytes = (n: number) =>
  n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

// Satır yüksekliği durumdan bağımsız: değer ve (varsa) alt bilgi her zaman ayrı tek satır; alt bilgisi olan satır onu boşken de
// yer tutar. Denetim satırında çipler ayrı satırda, işaretleri sabit genişlikte.
function InfoRow({ label, tone, title, sub, children }: { label: string; tone?: Tone; title?: string; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="wg-row" title={title}>
      <span className="wg-row-label">{label}</span>
      <span className="wg-row-main">
        <span className="wg-row-value">{tone && <i className={`wg-dot wg-t-${tone}`} aria-hidden="true" />}{children}</span>
        {sub !== undefined && <span className="wg-sub wg-row-sub">{sub || ' '}</span>}
      </span>
    </div>
  );
}

// ─── Hazır yapılandırma (backend wgImport.ts / wgConf.ts) ───
// "Config ile bağlan" paneli ve kartın "Yapılandırmayı değiştir" penceresi aynı formu kullanır: metin yapıştırılır ya da .conf
// dosyası tarayıcıda okunur. Panel yapılandırmayı güvenli biçimde uygular; uygulanmayan / değiştirilen satırlar bildirilir.
const CONF_MAX_BYTES = 16 * 1024;
const CONF_PLACEHOLDER = `[Interface]
PrivateKey = …
Address = 10.2.0.2/32

[Peer]
PublicKey = …
AllowedIPs = 0.0.0.0/0
Endpoint = vpn.ornek.com:51820`;
const showConfNotes = (notes: unknown) => {
  if (Array.isArray(notes) && notes.length) toast.info(`Uygulanmayan / değiştirilen: ${notes.join(' · ')}`, { duration: 15000 });
};

function WgConfForm({ initialName = '', submitLabel, busyLabel, onSubmit, onCancel }: {
  initialName?: string; submitLabel: string; busyLabel: string;
  onSubmit: (name: string, config: string) => Promise<void>; // hata fırlatırsa formda gösterilir
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const readFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > CONF_MAX_BYTES) { setErr('Dosya çok büyük (en çok 16 KB) — WireGuard yapılandırması mı?'); return; }
    f.text().then(t => {
      setText(t);
      setErr('');
      if (!name.trim()) setName(f.name.replace(/\.conf$/i, '').slice(0, 60));
    }, () => setErr('Dosya okunamadı'));
  };
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr('');
    try { await onSubmit(name.trim(), text); } catch (e) { setErr(errText(e, 'Uygulanamadı')); }
    setBusy(false);
  };
  return (
    <div className="wg-conf">
      <div className="form-group">
        <label><Server size={14} /><span>Ad</span></label>
        <input type="text" placeholder="ör. Mullvad Stockholm" value={name} maxLength={60}
          onChange={e => setName(e.target.value)} disabled={busy} />
      </div>
      <div className="form-group">
        <label><FileKey size={14} /><span>WireGuard yapılandırması (.conf)</span></label>
        <textarea className="wg-conf-text" rows={10} spellCheck={false} autoComplete="off" aria-label="WireGuard yapılandırması"
          placeholder={CONF_PLACEHOLDER} value={text} onChange={e => setText(e.target.value)} disabled={busy} />
        <div className="wg-conf-tools">
          <input ref={fileRef} type="file" accept=".conf,text/plain" hidden
            onChange={e => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
          <button type="button" className="wg-btn wg-btn-sm" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Upload size={12} /> Dosyadan yükle
          </button>
          <span className="wg-sub">Sağlayıcının verdiği .conf dosyası ya da metni</span>
        </div>
      </div>
      <p className="wg-conf-note">
        <ShieldCheck size={14} />
        <span>Panel yapılandırmayı güvenli biçimde uygular: Pi'nin trafiği bu tünele kendiliğinden verilmez — hangi sitenin, uygulamanın
          ya da cihazın bu tünelden çıkacağını Routing kuralları belirler. DNS ve PostUp / PreUp gibi komut satırları uygulanmaz.
          Sunucu tarafından Pi'ye ve ev ağınıza yeni bağlantı açılamaz.</span>
      </p>
      {err && <div className="wg-err">{err}</div>}
      <div className="wg-conf-actions">
        <button className="btn-primary" onClick={submit} disabled={busy || !text.trim()}>
          {busy ? <><Loader2 size={16} className="spin" /> {busyLabel}</> : <><Plug size={16} /> {submitLabel}</>}
        </button>
        <button className="btn-outline" onClick={onCancel} disabled={busy}>Vazgeç</button>
      </div>
    </div>
  );
}

// Kartın "Yapılandırmayı değiştir" penceresi: kimlik ve bu tünele yönlenen kurallar korunur. Yapıştırılan metin kaybolmasın diye
// dışarı tıklayınca kapanmaz.
function ReplaceConfModal({ server, onClose, onDone }: { server: VpsServer; onClose: () => void; onDone: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--overlay-strong)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div className="glass-panel" role="dialog" aria-modal="true" aria-label="Yapılandırmayı değiştir"
        style={{ padding: 24, maxWidth: 560, width: '92%', maxHeight: '92vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Pencil size={18} /> Yapılandırmayı değiştir
          </h3>
          <button className="icon-btn icon-btn-sm" onClick={onClose} aria-label="Kapat"><X size={14} /></button>
        </div>
        <p className="subtitle" style={{ marginBottom: 14 }}>
          Bu tünele yönlenen kurallar korunur. Tünel açıksa yeni yapılandırmayla yeniden kurulur (birkaç saniye kesinti);
          kurulamazsa eskisi geri yüklenir. Tünel kesikse yalnız kaydedilir.
        </p>
        <WgConfForm initialName={server.location || ''} submitLabel="Kaydet ve uygula" busyLabel="Uygulanıyor…" onCancel={onClose}
          onSubmit={async (name, config) => {
            const r = await putApi(`/vps/${server.id}/config`, { name, config });
            toast.success(!r.applied ? 'Kaydedildi — tünel bağlanınca kullanılacak'
              : r.handshake ? 'Yeni yapılandırma uygulandı' : 'Yeni yapılandırma uygulandı — sunucunun yanıtı bekleniyor');
            showConfNotes(r.notes);
            onDone();
            onClose();
          }} />
      </div>
    </div>
  );
}

function VpsCard({ server, onConnect, onDisconnect, onDelete, onRefresh, tunnelNonce, panelAuth, panelLockedBy }: {
  server: VpsServer; onConnect: () => Promise<void>; onDisconnect: () => Promise<void>; onDelete: () => void; onRefresh: () => void;
  tunnelNonce: number; panelAuth: string | null; panelLockedBy: string | null;
}) {
  // VPS denetimi (SSH): istenen / biten sıra numarası — farklıysa denetim sürüyor.
  const [checkSeq, setCheckSeq] = useState(1);
  const [check, setCheck] = useState<{ seq: number; at: number; status: InternetStatus | null; error: string }>({ seq: 0, at: 0, status: null, error: '' });
  const checking = check.seq !== checkSeq;
  const [repairing, setRepairing] = useState(false);
  const [repairResults, setRepairResults] = useState<RepairResult[] | null>(null);
  // Pi tarafındaki wg_vps<ID> tünelinin canlı durumu ve trafik hızı.
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
  const [rate, setRate] = useState<{ down: number; up: number } | null>(null);
  const [tunnelPoll, setTunnelPoll] = useState(0);
  const lastRead = useRef<TunnelStatus | null>(null);
  const [usage, setUsage] = useState<{ block: string[]; isp: string[] } | null>(null);
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const refreshTunnel = () => setTunnelPoll(k => k + 1);
  // Hazır yapılandırmayla kurulan tünel (backend wgImport.ts): sunucu panelin değil — SSH denetimi, onarım ve istemciler yok;
  // çıkış IP'si Pi'den tünel üzerinden ölçülür, yapılandırma karttan değiştirilir.
  const imported = server.kind === 'import';
  const info = server.import_info;
  const [editing, setEditing] = useState(false);

  // İstemciler (açılır liste)
  const [showClients, setShowClients] = useState(false);
  const [clients, setClients] = useState<WgClient[]>([]);
  const [clientsSeq, setClientsSeq] = useState(0);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [configClient, setConfigClient] = useState<WgClient | null>(null);
  const [qrClient, setQrClient] = useState<WgClient | null>(null);

  // "… önce" metinleri için saat
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    getApi<{ clients?: WgClient[] }>(`/vps/${server.id}/clients`)
      .then(d => { if (alive) setClients(d.clients || []); }, () => { if (alive) setClients([]); });
    return () => { alive = false; };
  }, [server.id, clientsSeq]);

  // VPS denetimi: açılışta, 5 dk'da bir ve "Denetle" ile (checkSeq artar).
  useEffect(() => {
    let alive = true;
    const seq = checkSeq;
    fetch(`/api/vps/${server.id}/internet-check`)
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
        return d as InternetStatus;
      })
      .then(
        status => { if (alive) { setCheck({ seq, at: Date.now(), status, error: '' }); onRefresh(); } },
        e => { if (alive) setCheck({ seq, at: Date.now(), status: null, error: errText(e, 'VPS denetlenemedi') }); },
      );
    return () => { alive = false; };
    // onRefresh her çizimde yeni işlev: yalnız istenen denetim sırasıyla çalışır
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id, checkSeq]);
  useEffect(() => {
    const t = setInterval(() => setCheckSeq(s => s + 1), CHECK_EVERY_MS);
    return () => clearInterval(t);
  }, []);

  // Tünel: 10 sn'de bir (bağlanırken 5 sn). Durum değişince / kurulum bitince (tunnelNonce) / el ile hemen yeniden okunur.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      fetch(`/api/vps/${server.id}/tunnel-status`)
        .then(r => r.json())
        .then(parseTunnel, () => TUNNEL_DOWN)
        .then(t => {
          if (!alive) return;
          const p = lastRead.current;
          if (t.rx !== null && t.tx !== null && p && p.rx !== null && p.tx !== null && t.at > p.at) {
            const dt = (t.at - p.at) / 1000;
            const down = (t.rx - p.rx) / dt, up = (t.tx - p.tx) / dt;
            setRate(down >= 0 && up >= 0 ? { down, up } : null);
          } else if (t.rx === null) setRate(null);
          lastRead.current = t;
          setTunnel(t);
          timer = setTimeout(poll, t.state === 'connecting' ? TUNNEL_POLL_FAST_MS : TUNNEL_POLL_MS);
        });
    };
    poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [server.id, server.status, tunnelNonce, tunnelPoll]);

  // Bu VPS'ten çıkan kurallar (dakikada bir)
  useEffect(() => {
    let alive = true;
    const load = () => { void vpsRuleUsage(server.id).then(u => { if (alive) setUsage(u); }); };
    load();
    const t = setInterval(load, USAGE_EVERY_MS);
    return () => { alive = false; clearInterval(t); };
  }, [server.id, tunnelPoll]);

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true); setAddError('');
    try {
      const r = await postApi(`/vps/${server.id}/clients`, { name: newName.trim() });
      if (r.error) setAddError(r.error);
      else { setNewName(''); setClientsSeq(s => s + 1); toast.success(`${newName.trim()} eklendi`); }
    } catch (e) { setAddError(errText(e, 'Eklenemedi')); }
    setAdding(false);
  };

  // Silme iki adımlı: ilk tıklama onay ister (3 sn), ikincisi siler.
  const askDelete = (c: WgClient) => {
    if (confirmDel !== c.id) {
      setConfirmDel(c.id);
      setTimeout(() => setConfirmDel(x => (x === c.id ? null : x)), 3000);
      return;
    }
    setConfirmDel(null);
    setDeletingId(c.id);
    void deleteVpsClient(server.id, c.id, c.name, Number(c.panel_access) === 1)
      .then(ok => { if (ok) { setClientsSeq(s => s + 1); onRefresh(); } setDeletingId(null); });
  };

  const repair = async () => {
    setRepairing(true); setRepairResults(null);
    try {
      const r = await fetch(`/api/vps/${server.id}/auto-repair`, { method: 'POST' });
      const data = await r.json();
      setRepairResults(data.repairs || []);
      setTimeout(() => setCheckSeq(s => s + 1), 2000);
    } catch { setRepairResults([{ check: 'Bağlantı', status: 'failed', detail: 'SSH bağlantısı başarısız' }]); }
    setRepairing(false);
  };

  const toggleTunnel = async () => {
    if (!tunnel) return;
    const off = tunnel.connected;
    setBusy(off ? 'disconnect' : 'connect');
    try { await (off ? onDisconnect() : onConnect()); } catch (e) { toast.error(errText(e, off ? 'Tünel kesilemedi' : 'Bağlantı başarısız')); }
    setBusy(null);
    refreshTunnel();
  };

  const st = tunnel?.state;
  const headTone: Tone = st ? TUNNEL_TONE[st] : 'wait';
  const badge = tunnel ? tunnelBadge(tunnel) : null;
  const ns = check.status;
  const firstCheck = check.seq === 0;
  const allGood = !!ns && CHECKS.every(c => ns[c.key]);
  const vpsTone: Tone = server.status === 'connected' ? 'ok' : server.status === 'installing' ? 'info' : server.status === 'error' ? 'bad' : 'off';
  const vpsText = server.status === 'connected' ? 'Bağlı' : server.status === 'installing' ? 'Kuruluyor' : server.status === 'error' ? 'Hata' : 'Bağlı değil';
  const nRules = usage ? usage.block.length + usage.isp.length : 0;
  const title = server.location?.trim() || server.ip;

  return (
    <div className={`wg-card wg-t-${headTone}`}>
      <div className="wg-head">
        <div className="wg-avatar" aria-hidden="true">{imported ? <FileKey size={18} /> : <Server size={18} />}</div>
        <div className="wg-title">
          <strong>{title}</strong>
          {imported
            ? <span title={`${info?.endpoint || server.ip} — hazır yapılandırma (Config ile bağlan)`}>{server.ip} · config</span>
            : <span>{server.ip} · {server.username}</span>}
        </div>
        <span className={`wg-pill wg-t-${headTone}`} title={badge?.title || 'Tünel durumu okunuyor'}>
          <i className={`wg-dot wg-t-${headTone}`} aria-hidden="true" />{st ? TUNNEL_TEXT[st] : 'Okunuyor…'}
        </span>
        <button className="wg-icon-btn is-danger" onClick={onDelete} title={imported ? 'Tüneli sil' : "VPS'i sil"}
          aria-label={imported ? `${title} tünelini sil` : `${title} VPS'ini sil`}>
          <Trash2 size={14} />
        </button>
      </div>

      <div className="wg-rows">
        <InfoRow label="Tünel" tone={headTone} title={badge?.title}
          sub={st && st !== 'down' ? fmtHs(tunnel!.handshakeAge) : st === 'down' ? 'Pi ↔ VPS bağlantısı yok' : ''}>
          {st ? TUNNEL_TEXT[st] : <span className="wg-sub">okunuyor…</span>}
        </InfoRow>
        <InfoRow label="Trafik" title="Pi ↔ VPS tünelinden geçen anlık trafik (son 10 sn)"
          sub={tunnel?.connected && tunnel.rx !== null && tunnel.tx !== null ? `toplam ↓ ${fmtBytes(tunnel.rx)} ↑ ${fmtBytes(tunnel.tx)}` : ''}>
          {tunnel?.connected && tunnel.rx !== null && tunnel.tx !== null
            ? (rate ? <span className="wg-mono">↓ {fmtRate(rate.down)} · ↑ {fmtRate(rate.up)}</span> : <span className="wg-sub">ölçülüyor…</span>)
            : <span className="wg-sub">{tunnel ? 'tünel kapalı' : 'okunuyor…'}</span>}
        </InfoRow>
        {imported ? (
          <>
            <InfoRow label="Kapsam" sub={info ? `Pi'nin tünel adresi ${info.address}` : ''}
              title={info ? `Bu tünelin taşıyabildiği trafik: ${info.allowed_ips.join(', ')} — hangisinin gerçekten bu tünelden çıkacağını Routing kuralları belirler` : undefined}>
              {!info ? <span className="wg-sub">yapılandırma okunamadı</span>
                : info.full_tunnel ? 'Tüm trafik' : <span className="wg-mono wg-ellipsis">yalnız {info.allowed_ips.join(', ')}</span>}
            </InfoRow>
            <InfoRow label="Çıkış IP'si" title="Tünelden çıkan trafiğin internette göründüğü adres (Pi'den tünel üzerinden ölçülür)">
              {ns?.publicIp ? <span className="wg-mono">{ns.publicIp}</span>
                : <span className="wg-sub wg-ellipsis" title={ns?.note || check.error || undefined}>
                  {firstCheck || checking ? 'denetleniyor…' : ns?.note || check.error || '—'}</span>}
            </InfoRow>
          </>
        ) : (
        <>
        <InfoRow label="VPS" tone={vpsTone} title="VPS'e SSH ile erişim (denetim sonucuna göre)">{vpsText}</InfoRow>
        <InfoRow label="Çıkış IP'si" title="VPS'in internete çıktığı adres — tünelden çıkan trafik bu adresle görünür">
          {ns?.publicIp ? <span className="wg-mono">{ns.publicIp}</span> : <span className="wg-sub">{firstCheck ? 'denetleniyor…' : '—'}</span>}
        </InfoRow>
        <div className="wg-row wg-row-stack" title={check.error || undefined}>
          <span className="wg-row-head">
            <span className="wg-row-label">Denetim</span>
            <span className={`wg-sub${check.error && !ns && !checking ? ' wg-sub-bad' : ''}`}>
              {checking ? 'denetleniyor…' : check.error && !ns ? "VPS'e bağlanılamadı" : check.at ? fmtAgo(now - check.at) : ''}
            </span>
          </span>
          <span className="wg-chips">
            {CHECKS.map(c => {
              const tone: Tone = !ns ? (check.error && !checking ? 'bad' : 'wait') : ns[c.key] ? 'ok' : 'bad';
              const mark = !ns ? (check.error && !checking ? '?' : '·') : ns[c.key] ? '✓' : '✕';
              return <span key={c.key} className={`wg-chip wg-t-${tone}`} title={c.title}><b>{mark}</b>{c.label}</span>;
            })}
          </span>
        </div>
        </>
        )}
        <InfoRow label="Kurallar" title={usage && nRules ? [...usage.block, ...usage.isp].join(', ') : undefined}
          sub={usage && nRules ? `tünel düşerse ${usage.block.length} engellenir${usage.isp.length ? `, ${usage.isp.length} operatörden` : ''}` : ''}>
          {!usage ? <span className="wg-sub">okunuyor…</span> : nRules ? <span>{nRules} kural bu VPS'ten çıkıyor</span>
            : <span className="wg-sub">yönlendirilen kural yok</span>}
        </InfoRow>
      </div>

      {!imported && ns && !allGood && (
        <div className="wg-alert">
          <div className="wg-alert-head">
            <AlertTriangle size={14} /> <span>Bazı denetimler başarısız</span>
            <button className="wg-btn wg-btn-sm" onClick={repair} disabled={repairing}>
              {repairing ? <><Loader2 size={12} className="spin" /> Onarılıyor…</> : 'Otomatik onar'}
            </button>
          </div>
          {repairResults && (
            <ul className="wg-repair">
              {repairResults.map((r, i) => (
                <li key={i} className={`wg-t-${r.status === 'ok' ? 'ok' : r.status === 'fixed' ? 'info' : 'bad'}`}>
                  <strong>{r.check}</strong><span>{r.status === 'ok' ? 'sorun yok' : r.status === 'fixed' ? 'onarıldı' : 'onarılamadı'}</span>
                  <small>{r.detail}</small>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="wg-actions">
        {server.status === 'installing' && !tunnel?.connected ? null : (
          <button className={`wg-btn wg-btn-grow ${tunnel?.connected ? 'wg-btn-danger' : 'wg-btn-primary'}`} onClick={toggleTunnel}
            disabled={!tunnel || busy !== null}>
            {busy ? <Loader2 size={14} className="spin" /> : tunnel?.connected ? <Unplug size={14} /> : <Plug size={14} />}
            {busy === 'connect' ? 'Bağlanıyor…' : busy === 'disconnect' ? 'Kesiliyor…' : tunnel?.connected ? 'Tüneli kes' : 'Tüneli bağla'}
          </button>
        )}
        <button className="wg-btn" onClick={() => { setCheckSeq(s => s + 1); refreshTunnel(); }} disabled={checking}
          title={imported ? "Tüneli ve çıkış IP'sini şimdi denetle" : "VPS'i ve tüneli şimdi denetle"}>
          <RefreshCw size={14} className={checking ? 'spin' : ''} /> Denetle
        </button>
        {imported ? (
          <button className="wg-btn wg-btn-drawer" onClick={() => setEditing(true)}
            title="Yeni yapılandırma yapıştırın (ör. sağlayıcıda sunucu değişti) — bu tünele yönlenen kurallar korunur">
            <span className="wg-btn-left"><Pencil size={14} /> Yapılandırmayı değiştir</span>
          </button>
        ) : (
        <button className="wg-btn wg-btn-drawer" onClick={() => setShowClients(v => !v)} aria-expanded={showClients} title="Bu VPS'in VPN istemcileri">
          <span className="wg-btn-left"><Users size={14} /> İstemciler <span className="wg-count">{clients.length}</span></span>
          <ChevronDown size={14} className="wg-chev" />
        </button>
        )}
      </div>

      {editing && (
        <ReplaceConfModal server={server} onClose={() => setEditing(false)}
          onDone={() => { onRefresh(); refreshTunnel(); setCheckSeq(s => s + 1); }} />
      )}

      {!imported && showClients && (
        <div className="wg-clients">
          <div className="wg-add">
            <input className="config-input" type="text" placeholder="Yeni istemci adı (örn. iPhone-Ali)" aria-label="Yeni istemci adı"
              value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()} />
            <button className="wg-btn wg-btn-primary" onClick={handleAdd} disabled={adding || !newName.trim()}>
              {adding ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Ekle
            </button>
          </div>
          {addError && <div className="wg-err">{addError}</div>}
          {clients.length === 0 ? (
            <div className="wg-empty"><Users size={18} /><span>Henüz istemci yok — ad yazıp Ekle'ye basın; telefon için QR kodu oluşur.</span></div>
          ) : (
            <ul className="wg-client-list">
              {clients.map(c => (
                <li key={c.id} className="wg-client">
                  <span className="wg-client-av" aria-hidden="true">{c.name.charAt(0).toLocaleUpperCase('tr-TR')}</span>
                  <span className="wg-client-main">
                    <strong>{c.name}</strong>
                    <span className="wg-mono">{c.ip}</span>
                  </span>
                  <span className="wg-client-actions">
                    <button className="wg-icon-btn" onClick={() => setConfigClient(c)} title="Yapılandırma dosyası" aria-label={`${c.name} yapılandırması`}>
                      <FileKey size={15} />
                    </button>
                    {c.qr_data && (
                      <button className="wg-icon-btn" onClick={() => setQrClient(c)} title="QR kod" aria-label={`${c.name} QR kodu`}>
                        <QrCode size={15} />
                      </button>
                    )}
                    <button className={`wg-icon-btn is-danger${confirmDel === c.id ? ' is-confirm' : ''}`} onClick={() => askDelete(c)}
                      disabled={deletingId === c.id} title={confirmDel === c.id ? 'Silmek için yeniden tıklayın' : "İstemciyi sil (VPS'ten de kaldırılır)"}
                      aria-label={`${c.name} istemcisini sil`}>
                      {deletingId === c.id ? <Loader2 size={14} className="spin" /> : confirmDel === c.id ? 'Sil?' : <Trash2 size={14} />}
                    </button>
                  </span>
                  <PanelAccess vpsId={server.id} client={c} auth={panelAuth} lockedBy={panelLockedBy}
                    tunnelDown={tunnel?.state === 'down'} onChanged={() => { setClientsSeq(s => s + 1); onRefresh(); }} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {configClient && <ConfigModal client={configClient} onClose={() => setConfigClient(null)} />}
      {qrClient && <QrModal client={qrClient} onClose={() => setQrClient(null)} />}
    </div>
  );
}

export function VpsSetup() {
  const [activeTab, setActiveTab] = useState<VpsTab>('overview');
  const { data, refetch } = useApi<{ servers: VpsServer[] }>('/vps/list', { servers: [] });
  // Uzaktan yönetim anahtarı yalnız panel koruması kalıcı açıkken açılabilir (null: henüz okunmadı / okunamadı).
  const { data: panelAuthData } = useApi<{ state?: string } | null>('/panel-auth/status', null);
  const panelAuth = panelAuthData?.state ?? null;
  // Panel erişimi aynı anda tek VPS'te: açık olan VPS'in adı, öbür VPS'lerin anahtarlarına (kendisine null).
  const paServer = data.servers.find(s => (s.panel_access || 0) > 0);
  const panelLockedBy = (id: number) => (paServer && paServer.id !== id ? `${paServer.location || 'VPS'} (${paServer.ip})` : null);
  const [ip, setIp] = useState('');
  const [username, setUsername] = useState('root');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [location, setLocation] = useState('');
  const [state, setState] = useState<SetupState>('idle');
  // Kurulum bitince artırılır → kartlar tünel durumunu yeniden okur.
  const [tunnelNonce, setTunnelNonce] = useState(0);
  const [showForm, setShowForm] = useState(false);
  // "Config ile bağlan": hazır WireGuard yapılandırmasıyla tünel (backend wgImport.ts)
  const [showImport, setShowImport] = useState(false);
  const [steps, setSteps] = useState<SetupStep[]>([]);

  // Client management state
  const [selectedVpsId, setSelectedVpsId] = useState<number | ''>('');
  // Seçili VPS'in tüneli (liste okuması; kapalı / bilinmiyor → panel erişimi şu an bu yoldan çalışmaz notu).
  const selTunnel = data.servers.find(s => s.id === Number(selectedVpsId))?.tunnel;
  const selTunnelDown = !selTunnel || selTunnel.state === 'down';
  const [clients, setClients] = useState<WgClient[]>([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [addingClient, setAddingClient] = useState(false);
  const [configClient, setConfigClient] = useState<WgClient | null>(null);
  const [qrClient, setQrClient] = useState<WgClient | null>(null);

  // silent: kartlar yerinde kalır (bekleme simgesi yok) — anahtar değişince / sekmeye dönünce yeniden okuma.
  const fetchClients = useCallback(async (vpsId: number, silent = false) => {
    if (!silent) setClientsLoading(true);
    try {
      const res = await fetch(`/api/vps/${vpsId}/clients`);
      const json = await res.json();
      setClients(json.clients || []);
    } catch { if (!silent) setClients([]); }
    if (!silent) setClientsLoading(false);
  }, []);

  useEffect(() => {
    if (selectedVpsId) fetchClients(Number(selectedVpsId));
  }, [selectedVpsId, fetchClients]);

  // Client Yönetimi yalnız panelin kurduğu VPS'ler içindir: hazır yapılandırmayla kurulan tünelin sunucusunda istemci açılamaz.
  const clientServers = data.servers.filter(s => s.kind !== 'import');
  useEffect(() => {
    const first = data.servers.find(s => s.kind !== 'import');
    if (first && selectedVpsId === '') {
      setSelectedVpsId(first.id);
    }
  }, [data.servers, selectedVpsId]);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
  }, []);

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  const startPolling = useCallback((vpsId: number) => {
    stopPolling();
    pollingRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/vps/${vpsId}/setup-status`);
        const data = await res.json();
        if (data.steps) {
          setSteps(data.steps.map((s: any) => ({
            key: s.key,
            label: SETUP_STEPS.find(ss => ss.key === s.key)?.label || s.key,
            status: s.status as StepStatus,
            message: s.message || '',
            duration: s.duration || '',
          })));
        }
        if (data.overall === 'success') {
          stopPolling();
          setState('success');
          setIp(''); setPassword(''); setLocation('');
          setTunnelNonce(n => n + 1);
          refetch();
        } else if (data.overall === 'error') {
          stopPolling();
          setState('error');
          toast.error('Kurulum sırasında hata oluştu');
          refetch();
        }
      } catch { /* polling error, will retry next interval */ }
    }, 1500);
  }, [stopPolling, refetch]);

  const handleDeploy = async () => {
    if (!ip.trim()) return;
    setState('deploying');

    // Initialize steps as pending
    setSteps(SETUP_STEPS.map(s => ({
      ...s, status: 'pending' as StepStatus, message: '', duration: '',
    })));

    try {
      // POST /vps/setup — tests connection, saves record, starts async background job
      const setupResult = await postApi('/vps/setup', {
        ip: ip.trim(), username: username.trim(),
        password: password.trim(), location: location.trim(),
      });

      if (!setupResult.success) {
        setState('error');
        toast.error(setupResult.error || 'Bağlantı başarısız');
        setSteps([]);
        return;
      }

      // Backend is now running steps in background — start polling for live updates
      startPolling(setupResult.id);
    } catch (e) {
      setState('error');
      toast.error(e instanceof Error ? e.message : 'Bağlantı başarısız');
      setSteps([]);
    }
  };

  const handleDelete = async (id: number) => {
    // Silmede bu VPS'e yönlenen kurallar operatöre (ISP) çevrilir, panelden eklenen istemciler VPS'ten de silinir — biri
    // varsa önce sorulur.
    if ((data.servers.find(s => s.id === id)?.panel_access || 0) > 0
      && !confirmTunnelCut("VPS'i silmek bu bağlantıyı keser; uzaktan yönetim ancak ev ağından yeniden kurulur.")) return;
    const u = await vpsRuleUsage(id);
    const all = [...u.block, ...u.isp];
    const nClients = await getApi<{ clients?: unknown[] }>(`/vps/${id}/clients`).then(r => r.clients?.length || 0, () => 0);
    const lines = [
      ...(all.length ? [`Bu VPS'e yönlenen ${all.length} kural operatöre (ISP) çevrilecek: ${ruleNames(all)}`] : []),
      ...(nClients ? [`${nClients} VPN istemcisi VPS'ten de silinecek (bağlantıları kesilir)`] : []),
    ];
    if (lines.length && !window.confirm(`VPS silinsin mi?\n\n${lines.join('\n')}`)) return;
    try {
      await deleteApi(`/vps/${id}`);
      await refetch();
    } catch { /* */ }
  };

  const handleAddClient = async () => {
    if (!newClientName.trim() || !selectedVpsId) return;
    setAddingClient(true);
    try {
      const result = await postApi(`/vps/${selectedVpsId}/clients`, { name: newClientName.trim() });
      if (result.error) {
        toast.error(result.error);
      } else {
        setNewClientName('');
        await fetchClients(Number(selectedVpsId));
      }
    } catch (e: any) {
      toast.error(e.message || 'Client eklenemedi');
    }
    setAddingClient(false);
  };

  const handleQuickAdd = async () => {
    if (!ip.trim() || !username.trim()) return;
    setState('deploying');
    try {
      const result = await postApi('/vps/add', {
        ip: ip.trim(), username: username.trim(),
        password: password.trim(), location: location.trim(),
      });
      if (result.success) {
        setState('success');
        toast.success('VPS kaydedildi — Pi5 tüneli için kartta "Tünel Bağla"ya basın');
        setIp(''); setPassword(''); setLocation('');
        setShowForm(false);
        await refetch();
      } else {
        setState('error');
        toast.error(result.error || 'Eklenemedi');
      }
    } catch (e: any) {
      setState('error');
      toast.error(e.message || 'Eklenemedi');
    }
  };

  const tabs: { id: VpsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Sunucular', icon: <Activity size={14} /> },
    { id: 'clients', label: 'Client Yonetimi', icon: <Users size={14} /> },
    { id: 'pivpn', label: "Ev VPN'i (Pi)", icon: <Home size={14} /> },
    { id: 'settings', label: 'WireGuard Ayarlari', icon: <Settings size={14} /> },
  ];

  const categoryLabels: Record<string, string> = {
    interface: 'WireGuard Arayuz',
    peer_defaults: 'Peer Varsayilanlari',
  };

  const categoryIcons: Record<string, React.ReactNode> = {
    interface: <Network size={15} />,
    peer_defaults: <Globe size={15} />,
  };

  return (
    <div className="fade-in">
      <div className="glass-panel widget-large">
        <div className="widget-header">
          <h3><Server size={20} style={{ marginRight: 8 }} />WireGuard</h3>
          {activeTab === 'overview' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button className="btn-outline btn-sm" onClick={() => setShowImport(!showImport)}
                title="VPN sağlayıcısının ya da başka bir sunucunun hazır WireGuard yapılandırmasıyla bağlan">
                <FileKey size={14} />
                <span>Config ile bağlan</span>
              </button>
              <button className="btn-primary btn-sm" onClick={() => setShowForm(!showForm)}>
                <Plus size={14} />
                <span>Yeni VPS</span>
              </button>
            </div>
          )}
        </div>
        <p className="subtitle">VPS tünelleri ve canlı durumları, VPN istemcileri, Ev VPN'i ve WireGuard ayarları</p>
        <div className="service-tabs">
          {tabs.map(tab => (
            <button key={tab.id}
              className={`service-tab ${activeTab === tab.id ? 'service-tab-active' : ''}`}
              onClick={() => {
                setActiveTab(tab.id);
                // Client Yönetimi'ne dönünce güncel liste (Sunucular'da yapılan panel erişimi / silme değişiklikleri).
                if (tab.id === 'clients' && activeTab !== 'clients') {
                  void refetch();
                  if (selectedVpsId) void fetchClients(Number(selectedVpsId), true);
                }
              }}>
              {tab.icon}<span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'overview' && (
        <>
          {data.servers.length === 0 ? (
            <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
              <div className="empty-state">
                <Wifi size={40} />
                <p>Henuz VPS sunucusu eklenmedi</p>
                <button className="btn-primary" onClick={() => setShowForm(true)}>
                  <Plus size={14} /> Ilk VPS'i Ekle
                </button>
                <button className="btn-outline" onClick={() => setShowImport(true)}>
                  <FileKey size={14} /> Config ile bağlan
                </button>
              </div>
            </div>
          ) : (
            <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
              <div className="wg-grid">
                {data.servers.map(server => (
                  <VpsCard key={server.id} server={server}
                    onConnect={async () => {
                      const r = await postApi(`/vps/${server.id}/connect`, {});
                      if (r.tunnel) toast.success('Pi5 tüneli kuruldu');
                      else toast.error(`Pi5 tüneli kurulamadı${r.tunnelError ? `: ${r.tunnelError}` : ''}`);
                      await refetch();
                    }}
                    onDisconnect={async () => {
                      // Panel bu tünelden açıksa (uzaktan yönetim) kesmek bağlantıyı da keser; kesilen tünel kendiliğinden dönmez.
                      if ((server.panel_access || 0) > 0 && !confirmTunnelCut(
                        'Tüneli kesmek bu bağlantıyı keser ve tünel kendiliğinden geri gelmez: yeniden bağlamak için ev ağından girmeniz gerekir.',
                      )) return;
                      // Tünel kesilince "engelle" kuralları açılmaz (trafik operatöre sızmaz) — kural varsa önce sorulur.
                      const u = await vpsRuleUsage(server.id);
                      if (u.block.length || u.isp.length) {
                        const lines = [
                          ...(u.block.length ? [`Engellenecek (${u.block.length}): ${ruleNames(u.block)} — tünel kapalıyken bu siteler açılmaz.`] : []),
                          ...(u.isp.length ? [`Operatörden devam edecek (${u.isp.length}): ${ruleNames(u.isp)}`] : []),
                        ];
                        if (!window.confirm(`Tünel kesilsin mi?\n\n${lines.join('\n')}\n\nKural başına seçim: Routing → "Tünel düşerse".`)) return;
                      }
                      await postApi(`/vps/${server.id}/disconnect`, {});
                      await refetch();
                    }}
                    onDelete={() => handleDelete(server.id)}
                    onRefresh={refetch}
                    tunnelNonce={tunnelNonce}
                    panelAuth={panelAuth}
                    panelLockedBy={panelLockedBy(server.id)} />
                ))}
              </div>
            </div>
          )}

          {showImport && (
            <div className="glass-panel form-panel" style={{ marginTop: 16, maxWidth: 700 }}>
              <div className="widget-header">
                <h3>Hazır yapılandırmayla bağlan</h3>
                <FileKey size={18} className="text-muted" />
              </div>
              <p className="subtitle">
                VPN sağlayıcınızın (Mullvad, Proton …), başkasının ya da şirketinizin WireGuard sunucusu: sunucuya bir şey kurulmaz,
                Pi bu yapılandırmayla bağlanır ve tünel Routing'de çıkış olarak seçilebilir.
              </p>
              <WgConfForm submitLabel="Bağlan" busyLabel="Bağlanıyor…" onCancel={() => setShowImport(false)}
                onSubmit={async (name, config) => {
                  const r = await postApi('/vps/import', { name, config });
                  toast.success(r.handshake ? "Tünel kuruldu — Routing'de bu çıkışı seçebilirsiniz"
                    : "Tünel kuruldu, sunucunun yanıtı bekleniyor — Routing'de bu çıkışı seçebilirsiniz");
                  if (r.fullTunnel === false) toast.info('Bölünmüş tünel: yalnız sunucunun verdiği aralıklara giden trafik bu tünelden çıkabilir', { duration: 9000 });
                  showConfNotes(r.notes);
                  setShowImport(false);
                  setTunnelNonce(n => n + 1);
                  await refetch();
                }} />
            </div>
          )}

          {showForm && (
            <div className="glass-panel form-panel" style={{ marginTop: 16, maxWidth: 700 }}>
              <div className="widget-header">
                <h3>Yeni WireGuard VPS Kur</h3>
                <Lock size={18} className="text-muted" />
              </div>
              <p className="subtitle">Otomatik WireGuard kurulumu ve tunel yapilandirmasi</p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label><Globe size={14} /><span>VPS IP</span></label>
                  <input type="text" placeholder="203.0.113.10" value={ip} onChange={e => setIp(e.target.value)} disabled={state === 'deploying'} />
                </div>
                <div className="form-group">
                  <label><Server size={14} /><span>Kullanici</span></label>
                  <input type="text" placeholder="root" value={username} onChange={e => setUsername(e.target.value)} disabled={state === 'deploying'} />
                </div>
                <div className="form-group">
                  <label><Lock size={14} /><span>Sifre</span></label>
                  <div style={{ position: 'relative' }}>
                    <input type={showPassword ? 'text' : 'password'} placeholder="********" value={password}
                      onChange={e => setPassword(e.target.value)} disabled={state === 'deploying'}
                      style={{ paddingRight: 36 }} />
                    <button type="button" onClick={() => setShowPassword(!showPassword)}
                      style={{
                        position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                        background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
                        padding: 4, display: 'flex',
                      }}>
                      {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
                <div className="form-group">
                  <label><Globe size={14} /><span>Lokasyon</span></label>
                  <input type="text" placeholder="Frankfurt" value={location} onChange={e => setLocation(e.target.value)} disabled={state === 'deploying'} />
                </div>
              </div>

              {steps.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '16px 0' }}>
                  {steps.map(step => <StepIndicator key={step.key} step={step} />)}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-primary" style={{ flex: 1 }} onClick={handleDeploy} disabled={state === 'deploying' || !ip.trim()}>
                  {state === 'deploying' ? <><Loader2 size={16} className="spin" /> Kuruluyor...</> : <><Lock size={16} /> Deploy Secure Tunnel</>}
                </button>
                <button className="btn-outline" onClick={handleQuickAdd} disabled={state === 'deploying' || !ip.trim()} title="SSH kurulumu yapmadan sadece kaydet (zaten kurulu VPS'ler icin)">
                  <Plus size={16} /> Hizli Ekle
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === 'clients' && (
        <div className="glass-panel widget-large" style={{ marginTop: 14 }}>
          <div className="widget-header">
            <h3>WireGuard Client Yonetimi</h3>
          </div>

          <div className="form-group" style={{ maxWidth: 400, marginTop: 16 }}>
            <label>VPS Sunucu Secin</label>
            <Select value={selectedVpsId} onChange={e => setSelectedVpsId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Sunucu secin...</option>
              {clientServers.map(s => (
                <option key={s.id} value={s.id}>{s.ip} ({s.location || s.username})</option>
              ))}
            </Select>
          </div>

          {selectedVpsId && (
            <>
              <div style={{
                display: 'flex', gap: 8, alignItems: 'center', marginTop: 16,
                padding: 12, background: 'var(--surface-sunken)', borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--panel-border)',
              }}>
                <input className="config-input" style={{ flex: 1, minWidth: 0 }}
                  placeholder="Client adi (orn: iPhone-Ali)" value={newClientName}
                  onChange={e => setNewClientName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddClient()} />
                <button className="btn-primary btn-sm" onClick={handleAddClient} disabled={addingClient || !newClientName.trim()}>
                  {addingClient ? <Loader2 size={13} className="spin" /> : <><Plus size={13} /> Yeni Client Ekle</>}
                </button>
              </div>

              {clientsLoading ? (
                <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                  <Loader2 size={24} className="spin" />
                </div>
              ) : clients.length === 0 ? (
                <div className="empty-state" style={{ marginTop: 20 }}>
                  <Users size={36} />
                  <p>Bu sunucu icin client bulunmuyor</p>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, marginTop: 16 }}>
                  {clients.map(client => (
                    <ClientCard key={client.id} client={client}
                      vpsLabel={data.servers.find(s => s.id === Number(selectedVpsId))?.ip + ' (' + (data.servers.find(s => s.id === Number(selectedVpsId))?.location || data.servers.find(s => s.id === Number(selectedVpsId))?.username || '') + ')'}
                      onShowConfig={() => setConfigClient(client)}
                      onShowQr={() => setQrClient(client)}
                      onDelete={async () => {
                        if (await deleteVpsClient(selectedVpsId, client.id, client.name, Number(client.panel_access) === 1)) {
                          await fetchClients(Number(selectedVpsId));
                          void refetch();
                        }
                      }}
                      panelAccess={<PanelAccess vpsId={selectedVpsId} client={client} auth={panelAuth}
                        lockedBy={panelLockedBy(Number(selectedVpsId))}
                        tunnelDown={selTunnelDown}
                        onChanged={() => { void fetchClients(Number(selectedVpsId), true); void refetch(); }} />} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === 'pivpn' && <PiVpnServer />}

      {activeTab === 'settings' && (
        <div style={{ marginTop: 14 }}>
          <ServiceSettings service="wireguard" categoryLabels={categoryLabels} categoryIcons={categoryIcons} />
        </div>
      )}

      {configClient && <ConfigModal client={configClient} onClose={() => setConfigClient(null)} />}
      {qrClient && <QrModal client={qrClient} onClose={() => setQrClient(null)} />}
    </div>
  );
}
