import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Share2, AlertTriangle, CheckCircle, Info, Trash2 } from 'lucide-react';
import { getApi, postApi, deleteApi } from '../hooks/useApi';
import { toast } from '../toast';
import { Panel, Badge } from './ui';

// Uydular (R2 mesh): ana cihazda uydu ekleme (6 haneli kod), eşleşmiş uydular, kablosuz mesh omurgası; uyduda ana cihazla
// eşleşme ve durum. Uydu ana cihazın ev Wi-Fi'ını aynı ağ adı ve şifreyle (farklı kanalda) yayınlar. Veri /api/mesh/state
// (backend/src/mesh.ts); rol değişimi /api/system/role (backend yeniden başlar).

type SatStatus = {
  name?: string; version?: string; sat_stage?: string; active?: boolean; bridge?: boolean; band?: string; channel?: number | null;
  backhaul?: 'wired' | 'mesh'; mesh_peers?: number; stations?: string[]; error?: string;
};
type Satellite = { id: string; name: string; mac: string | null; ip: string | null; last_seen: number | null; online: boolean; status: SatStatus | null };
type MainMesh = { capable: string[]; configured: boolean; id: string; channel: number | null; iface: boolean; wpa: boolean; attached: boolean; peers: number };
type MainState = {
  role: 'main'; satellites: Satellite[]; pairing: { active: boolean; expires_at: number } | null; mesh: MainMesh;
  wifi: { stage: string; ssid: string; band: string; channel: number | null } | null; addresses: string[];
};
type SatState = {
  role: 'satellite';
  satellite: {
    paired: boolean; main: string; name: string; paired_at: number; last_sync: number; last_error: string; revoked: boolean;
    sat_stage: string; ssid: string; band: string; channel: number | null; active: boolean; bridge: boolean; ip: string; guard_result: string;
    mesh: { capable: string[]; configured: boolean; attached: boolean; peers: number };
  };
};
type State = MainState | SatState;

const EN = ({ children }: { children: ReactNode }) => <span lang="en">{children}</span>;
const errText = (e: unknown, fb: string) => (e instanceof Error && e.message ? e.message : fb);
const bandText = (b?: string) => (b === 'a' ? '5 GHz' : '2,4 GHz');
const ago = (ts: number | null | undefined) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  return s < 60 ? 'az önce' : s < 3600 ? `${Math.floor(s / 60)} dk önce` : s < 86400 ? `${Math.floor(s / 3600)} sa önce` : new Date(ts * 1000).toLocaleString('tr-TR');
};
const fmtLeft = (left: number) => `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

function Alert({ kind, children }: { kind: 'ok' | 'err' | 'info'; children: ReactNode }) {
  return (
    <div className={`routing-apply routing-apply-${kind === 'err' ? 'err' : 'ok'} hw-alert-${kind}`}>
      {kind === 'err' ? <AlertTriangle size={14} /> : kind === 'ok' ? <CheckCircle size={14} /> : <Info size={14} />}
      <span>{children}</span>
    </div>
  );
}

// Rol değişimi: backend rol dosyasını yazar ve yeniden başlar; sayfa birkaç saniye sonra yenilenir.
async function changeRole(role: 'main' | 'satellite') {
  await postApi('/system/role', { role });
  toast.info('Panel yeniden başlıyor — sayfa birkaç saniye içinde yenilenir');
  setTimeout(() => window.location.reload(), 8000);
}

export function MeshPanel({ onChange }: { onChange?: () => void }) {
  const [st, setSt] = useState<State | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [code, setCode] = useState<{ code: string; expires_at: number } | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [meshCh, setMeshCh] = useState(36);
  const [mainAddr, setMainAddr] = useState('');
  const [joinCode, setJoinCode] = useState('');

  const load = useCallback(async () => {
    try { setSt(await getApi<State>('/mesh/state')); setErr(null); } catch (e) { setErr(errText(e, 'durum okunamadı')); }
  }, []);
  const pairingActive = !!code && code.expires_at > now;
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    // Kod açıkken (uydu gelmesi beklenirken) sık, değilse seyrek.
    const id = setInterval(() => { void load(); }, pairingActive ? 5000 : 30000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [load, pairingActive]);
  useEffect(() => { const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(t); }, []);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast.error(errText(e, 'İşlem başarısız')); }
    setBusy(null);
    await load();
    onChange?.();
  };

  if (!st) return err ? <Panel title="Uydular" icon={<Share2 size={18} style={{ marginRight: 8 }} />}><p className="rl-muted">Durum okunamadı: {err}</p></Panel> : null;

  if (st.role === 'satellite') {
    const s = st.satellite;
    const badge = s.revoked ? <Badge variant="warning">Eşleşme kaldırıldı</Badge>
      : s.paired ? (s.active && s.bridge ? <Badge variant="success">Yayında</Badge> : <Badge variant="info">Eşleşti</Badge>) : <Badge variant="neutral">Eşleşmedi</Badge>;
    const join = () => act('join', async () => {
      toast.info('Eşleşiyor ve yayın açılıyor — 1-3 dakika sürebilir');
      const r = await postApi('/mesh/join', { main: mainAddr.trim(), code: joinCode.trim() });
      setJoinCode('');
      if (r?.applied) toast.error(`Eşleşildi ama yayın açılamadı: ${r.applied}`); else toast.success("Eşleşildi — ana cihazın Wi-Fi'ı bu uydudan da yayınlanıyor");
    });
    const leave = () => {
      if (!window.confirm('Eşleşme kaldırılacak ve bu uydunun yayını kapanacak. Devam edilsin mi?')) return;
      void act('leave', async () => { await postApi('/mesh/leave', {}); toast.info('Eşleşme kaldırıldı — yayın kapandı'); });
    };
    return (
      <Panel title="Uydu" icon={<Share2 size={18} style={{ marginRight: 8 }} />} actions={badge}
        subtitle="Bu cihaz mesh uydusu: ana cihazın ev Wi-Fi'ını aynı ağ adı ve şifreyle yayınlar.">
        <div className="hw-body">
          {s.revoked && <Alert kind="err">Ana cihaz bu uydunun eşleşmesini kaldırdı; yayın kapatıldı. Yeniden eşleştirmek için ana cihazdan yeni kod alın.</Alert>}
          {(!s.paired || s.revoked) && (
            <>
              <span className="dhcp-muted">Ana cihazın panelinde Cihaz Rolleri → Uydular → Uydu ekle'ye basın; gösterilen adresi ve kodu buraya yazın. İlk eşleştirme için uydu kabloyla bağlı olmalı.</span>
              <div className="hw-form ms-join">
                <label className="hw-field"><span>Ana cihazın adresi</span>
                  <input className="config-input" type="text" inputMode="decimal" spellCheck={false} placeholder="192.168.1.153" value={mainAddr} onChange={e => setMainAddr(e.target.value)} /></label>
                <label className="hw-field hw-field-sm"><span>Kod</span>
                  <input className="config-input ms-code-input" type="text" inputMode="numeric" maxLength={6} placeholder="000000" value={joinCode} onChange={e => setJoinCode(e.target.value.replace(/\D/g, ''))} /></label>
              </div>
              <div className="panel-auth-actions">
                <button className="btn-primary btn-sm" onClick={join} disabled={!!busy || !/^[A-Za-z0-9.-]+(:\d+)?$/.test(mainAddr.trim()) || !/^\d{6}$/.test(joinCode)}>
                  {busy === 'join' ? 'Eşleşiyor…' : 'Eşleştir'}
                </button>
              </div>
            </>
          )}
          {s.paired && !s.revoked && (
            <>
              {s.last_error && <Alert kind="err">{s.last_error}</Alert>}
              <dl className="hw-facts">
                <div><dt>Ana cihaz</dt><dd className="rl-mono">{s.main}</dd></div>
                <div><dt>Son senkron</dt><dd>{ago(s.last_sync)}</dd></div>
                <div><dt>Yayın</dt><dd>{s.ssid ? `${s.ssid} · ${bandText(s.band)} · kanal ${s.channel || '—'}` : 'henüz açılmadı'}{s.ssid && !s.active ? ' (kapalı)' : ''}</dd></div>
                <div><dt>Köprü</dt><dd className="rl-mono">{s.bridge ? `br0 ${s.ip || ''}` : s.sat_stage === 'none' ? '—' : `kurulamadı${s.guard_result ? ` (${s.guard_result})` : ''}`}</dd></div>
                <div><dt>Kablosuz mesh</dt><dd>{!s.mesh.capable.length ? 'radyo yok' : s.mesh.configured ? `${s.mesh.attached ? 'köprüde' : 'hazır (kablo bağlı)'} · ${s.mesh.peers} komşu` : 'ana cihazda kapalı'}</dd></div>
              </dl>
              <div className="panel-auth-actions">
                <button className="btn-outline btn-sm" onClick={() => act('sync', async () => { await postApi('/mesh/sync-now', {}); toast.success('Eşitlendi'); })} disabled={!!busy}>
                  {busy === 'sync' ? 'Eşitleniyor…' : 'Şimdi eşitle'}
                </button>
                <button className="btn-outline btn-sm" onClick={leave} disabled={!!busy}>{busy === 'leave' ? 'Kaldırılıyor…' : 'Eşleşmeyi kaldır'}</button>
              </div>
            </>
          )}
          <div className="ms-role">
            <span className="dhcp-muted">Bu cihazı ana cihaz (ağ geçidi) olarak kullanmak için:</span>
            <button className="btn-outline btn-sm" disabled={!!busy} onClick={() => {
              if (!window.confirm('Bu cihaz ana cihaza çevrilecek: uydu yayını ve eşleşmesi kaldırılır, panel yeniden başlar. Devam edilsin mi?')) return;
              void act('role', () => changeRole('main'));
            }}>{busy === 'role' ? 'Çevriliyor…' : 'Ana cihaza çevir'}</button>
          </div>
        </div>
      </Panel>
    );
  }

  // ─── Ana cihaz ───
  const wifiOn = st.wifi?.stage === 'on';
  const sats = st.satellites;
  const left = pairingActive ? code!.expires_at - now : 0;
  // Saat saniyede bir güncellenir: kod gelince hemen tazelenir (yoksa geri sayım bir an "10:01" gösterir).
  const addPair = () => act('pair', async () => { const c = await postApi('/mesh/pairing', {}); setNow(Math.floor(Date.now() / 1000)); setCode(c); });
  const cancelPair = () => act('pair-cancel', async () => { await deleteApi('/mesh/pairing'); setCode(null); });
  const remove = (s: Satellite) => {
    if (!window.confirm(`"${s.name}" uydusu kaldırılacak; uydu bir dakika içinde yayınını kapatır. Devam edilsin mi?`)) return;
    void act(`rm-${s.id}`, async () => {
      await deleteApi(`/mesh/satellites/${encodeURIComponent(s.id)}`);
      toast.info(`${s.name} kaldırıldı`);
    });
  };
  const m = st.mesh;
  return (
    <Panel title="Uydular" icon={<Share2 size={18} style={{ marginRight: 8 }} />}
      actions={<Badge variant={sats.some(s => s.online) ? 'success' : 'neutral'}>{sats.length ? `${sats.length} uydu` : 'Uydu yok'}</Badge>}
      subtitle="Mesh: ikinci Klyrix cihazları bu cihazın ev Wi-Fi'ını evin başka yerlerinde aynı ağ adı ve şifreyle yayınlar.">
      <div className="hw-body">
        {!wifiOn && <Alert kind="info">Uydular bu cihazın ev <EN>Wi-Fi</EN>'ını yayınlar: önce yukarıdaki Ev <EN>Wi-Fi</EN>'ı panelinden açıp kalıcı yapın.</Alert>}
        {wifiOn && st.wifi && (
          <dl className="hw-facts">
            <div><dt>Yayınlanan ağ</dt><dd>{st.wifi.ssid} · {bandText(st.wifi.band)}</dd></div>
            <div><dt>Ana cihazın kanalı</dt><dd>{st.wifi.channel || '—'} (uydular farklı kanal kullanır)</dd></div>
            <div><dt>Dolaşım</dt><dd>Aynı ağ adı ve şifre — telefon güçlü sinyale kendisi geçer</dd></div>
          </dl>
        )}
        {pairingActive ? (
          <div className="ms-pair">
            <div className="ms-code" aria-label="Eşleştirme kodu">{code!.code.slice(0, 3)} {code!.code.slice(3)}</div>
            <div className="ms-pair-info">
              <strong>Uydu cihazda girin</strong>
              <span>Ana cihaz adresi: {st.addresses.map(a => <code key={a}>{a}</code>)}</span>
              <span>Kurulumun sonunda ya da uydunun panelinde (Cihaz Rolleri → Uydu). Kod {fmtLeft(left)} içinde, bir kez geçerli.</span>
              <div className="panel-auth-actions">
                <button className="btn-outline btn-sm" onClick={cancelPair} disabled={!!busy}>İptal</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="panel-auth-actions">
            <button className="btn-primary btn-sm" onClick={addPair} disabled={!!busy || !wifiOn} title={!wifiOn ? "Önce ev Wi-Fi'ını açın" : undefined}>
              {busy === 'pair' ? 'Kod alınıyor…' : 'Uydu ekle'}
            </button>
          </div>
        )}
        {sats.length > 0 && (
          <table className="rl-table ms-table">
            <thead><tr><th>Uydu</th><th>Adres</th><th>Durum</th><th>Yayın</th><th>Bağlantı</th><th className="rl-num">Cihaz</th><th /></tr></thead>
            <tbody>
              {sats.map(s => (
                <tr key={s.id}>
                  <td data-label="Uydu" className="rl-strong">{s.name}</td>
                  <td data-label="Adres" className="rl-mono">{s.ip || '—'}</td>
                  <td data-label="Durum">{s.online ? <Badge variant="success">Çevrimiçi</Badge> : <span className="rl-muted">Çevrimdışı · {ago(s.last_seen)}</span>}</td>
                  <td data-label="Yayın">{s.status?.active ? `${bandText(s.status.band)} · kanal ${s.status.channel || '—'}` : <span className="rl-muted">{s.status?.error || 'kapalı'}</span>}</td>
                  <td data-label="Bağlantı">{s.status?.backhaul === 'mesh' ? `Mesh (${s.status.mesh_peers || 0} komşu)` : 'Kablo'}</td>
                  <td data-label="Cihaz" className="rl-num">{s.status?.stations?.length ?? 0}</td>
                  <td data-label="" className="rl-c">
                    <button className="icon-btn" title="Uyduyu kaldır" aria-label={`${s.name} uydusunu kaldır`} onClick={() => remove(s)} disabled={!!busy}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h4 className="rl-sub">Kablosuz mesh</h4>
        {!m.capable.length ? (
          <span className="dhcp-muted">Uydular kablo olmadan bağlanabilsin diye iki cihazda da mesh destekli <EN>Wi-Fi</EN> radyosu gerekir (ör. ALFA AWUS036ACM). Pi'nin dahili radyosu desteklemez.</span>
        ) : m.configured ? (
          <>
            <dl className="hw-facts">
              <div><dt>Mesh ağı</dt><dd className="rl-mono">{m.id}</dd></div>
              <div><dt>Kanal</dt><dd>{m.channel} (5 GHz)</dd></div>
              <div><dt>Durum</dt><dd>{m.wpa && m.attached ? `çalışıyor · ${m.peers} komşu` : m.iface ? 'başlatılıyor' : 'radyo bekleniyor'}</dd></div>
            </dl>
            <div className="panel-auth-actions">
              <button className="btn-outline btn-sm" disabled={!!busy} onClick={() => {
                if (!window.confirm('Kablosuz mesh kapatılacak; kablosuz bağlanan uydular ana cihaza ulaşamaz. Devam edilsin mi?')) return;
                void act('mesh', async () => { await postApi('/mesh/wireless', { enabled: false }); toast.info('Kablosuz mesh kapatıldı'); });
              }}>{busy === 'mesh' ? 'Kapatılıyor…' : 'Kablosuz mesh\'i kapat'}</button>
            </div>
          </>
        ) : (
          <div className="hw-form ms-mesh">
            <label className="hw-field hw-field-sm"><span>Mesh kanalı (5 GHz)</span>
              <select value={meshCh} onChange={e => setMeshCh(Number(e.target.value))}>{[36, 40, 44, 48].map(c => <option key={c} value={c}>{c}</option>)}</select></label>
            <div className="panel-auth-actions">
              <button className="btn-primary btn-sm" disabled={!!busy} onClick={() => act('mesh', async () => {
                await postApi('/mesh/wireless', { enabled: true, channel: meshCh });
                toast.success('Kablosuz mesh açıldı — uydular bir dakika içinde katılır');
              })}>{busy === 'mesh' ? 'Açılıyor…' : 'Kablosuz mesh\'i aç'}</button>
            </div>
          </div>
        )}
        <div className="ms-role">
          <span className="dhcp-muted">Bu cihazı başka bir ana cihazın uydusu yapmak için (sabit adres, ev Wi-Fi'ı ve Pi DHCP kapalı olmalı):</span>
          <button className="btn-outline btn-sm" disabled={!!busy} onClick={() => {
            if (!window.confirm('Bu cihaz uyduya çevrilecek: ağ geçidi özellikleri kapanır, panel yeniden başlar. Devam edilsin mi?')) return;
            void act('role', () => changeRole('satellite'));
          }}>{busy === 'role' ? 'Çevriliyor…' : 'Uyduya çevir'}</button>
        </div>
      </div>
    </Panel>
  );
}
