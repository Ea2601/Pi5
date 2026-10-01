import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Share2, AlertTriangle, CheckCircle, Info, Trash2, Search, Download } from 'lucide-react';
import { getApi, postApi, deleteApi } from '../hooks/useApi';
import { toast } from '../toast';
import { Panel, Badge } from './ui';
import './MeshPanel.css';

// Uydular (R2 mesh): ana cihazda uydu ekleme (6 haneli kod), eşleşmiş uydular, kablosuz mesh omurgası; uyduda ana cihazla
// eşleşme ve durum. Uydu ana cihazın ev Wi-Fi'ını aynı ağ adı ve şifreyle (farklı kanalda) yayınlar. Veri /api/mesh/state
// (backend/src/mesh.ts); rol değişimi /api/system/role (backend yeniden başlar). Ağdaki diğer Klyrix cihazları
// /api/mesh/discover (ağ geçidi + mDNS): yalnız adres önerir — eşleşme yine kodla, rol yine o cihazın kendi panelinden.
// Uydu sürümleri ana cihazın sürümüyle karşılaştırılır; eski uyduya güncelleme isteği yalnız şifreli (v2) eşleşmeyle gider,
// uydu güncellemeyi GitHub'dan kendisi indirir (POST /api/mesh/satellites/:id/update).

// Uydunun güncelleme durumu (uydu bildirir; günlük metni yok). at: saniye; req: ana cihazın isteğinin işi. update_cap:
// uydunun yazılımı uzaktan güncelleme isteğini anlıyor (bu özellikten eski sürüm göndermez). update_retry_in: uydunun
// 10 dk sınırından kalan süre (sn, bildirim anına göre → last_seen + update_retry_in).
type UpdateState = { state: 'running' | 'done' | 'failed'; reason?: string; at?: number; req?: boolean };
type SatStatus = {
  name?: string; version?: string; sat_stage?: string; active?: boolean; bridge?: boolean; band?: string; channel?: number | null;
  backhaul?: 'wired' | 'mesh'; mesh_peers?: number; stations?: string[]; error?: string; update_cap?: boolean; update_state?: UpdateState | null;
  update_retry_in?: number;
};
// proto: 2 = şifreli kanal (v2), 1 = eski eşleşme (taşıyıcı anahtar, şifresiz). update_req: bekleyen güncelleme isteği.
type Satellite = {
  id: string; name: string; mac: string | null; ip: string | null; last_seen: number | null; online: boolean; status: SatStatus | null; proto?: number;
  update_req?: { pending: boolean; at: number } | null;
};
// unknown: mesh.sh durumu okunamadı (kapalı demek değil).
type MainMesh = { capable: string[]; configured: boolean; id: string; channel: number | null; iface: boolean; wpa: boolean; attached: boolean; peers: number; unknown?: boolean };
type MainState = {
  role: 'main'; satellites: Satellite[]; pairing: { active: boolean; expires_at: number } | null; mesh: MainMesh;
  wifi: { stage: string; ssid: string; band: string; channel: number | null } | null; addresses: string[];
};
type SatState = {
  role: 'satellite';
  satellite: {
    paired: boolean; main: string; name: string; paired_at: number; last_sync: number; last_error: string; revoked: boolean; proto?: number;
    sat_stage: string; ssid: string; band: string; channel: number | null; active: boolean; bridge: boolean; ip: string; guard_result: string;
    mesh: { capable: string[]; configured: boolean; attached: boolean; peers: number; unknown?: boolean };
  };
};
type State = MainState | SatState;
// Keşif sonucu doğrulanmamıştır (kimlik yanıtını ağdaki herkes verebilir). conflict: aynı kimlik birden çok adreste
// (cihazın birden çok adresi ya da taklit); mdns_blocked: bu cihazın güvenlik duvarı mDNS'e henüz izin vermiyor.
type KlyrixDevice = { id: string; name: string; ip: string; role: 'main' | 'satellite'; paired: boolean; pairing: boolean; proto: number; source: 'gateway' | 'mdns'; conflict?: boolean };
type Discovery = { devices: KlyrixDevice[]; mdns: 'ok' | 'unavailable'; mdns_blocked?: boolean };
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const EN = ({ children }: { children: ReactNode }) => <span lang="en">{children}</span>;
const errText = (e: unknown, fb: string) => (e instanceof Error && e.message ? e.message : fb);
const bandText = (b?: string) => (b === 'a' ? '5 GHz' : '2,4 GHz');
const ago = (ts: number | null | undefined) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  return s < 60 ? 'az önce' : s < 3600 ? `${Math.floor(s / 60)} dk önce` : s < 86400 ? `${Math.floor(s / 3600)} sa önce` : new Date(ts * 1000).toLocaleString('tr-TR');
};
const fmtLeft = (left: number) => `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
// Sürüm karşılaştırması: sayısal parçalar tek tek (2.24.9 < 2.24.84), "v" öneki ve sondaki ek yok sayılır.
// null = karşılaştırılamaz (sürüm yok / biçim tanınmadı).
const verParts = (v?: string) => { const m = /^v?(\d+(?:\.\d+)*)/.exec(String(v || '').trim()); return m ? m[1].split('.').map(Number) : null; };
function cmpVer(a?: string, b?: string): number | null {
  const x = verParts(a), y = verParts(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
// Güncellenemeyen eski uydu: satırda kısa not, tam açıklama düğmenin ve notun başlığında. Şifreli eşleşme (v2) 2.24.75 ile
// geldi: daha eski yazılımlı v1 uydu yeniden eşleşmede yine v1 olur — önce kendi panelinden güncellenmeli.
const V1_UPDATE_HINT = 'Eski eşleşme — güncelleme isteği için yeniden eşleştirin';
const V1_UPDATE_SHORT = 'Güncelleme isteği için yeniden eşleştirin';
const V2_PAIR_SINCE = '2.24.75';
const OLDSW_UPDATE_HINT = 'Uydunun yazılımı şifreli eşleşmeyi desteklemiyor (2.24.75 öncesi) — önce uydunun kendi panelinden (Ayarlar → Sistem Güncellemesi) güncelleyin, sonra yeniden eşleştirin';
const OLDSW_UPDATE_SHORT = 'Önce uydunun kendi panelinden güncelleyin, sonra yeniden eşleştirin';
const NOCAP_UPDATE_HINT = 'Uydunun yazılımı uzaktan güncellemeyi desteklemiyor — uydunun kendi panelinden güncelleyin (gece güncellemesi de getirir)';
const NOCAP_UPDATE_SHORT = 'Uydunun kendi panelinden güncelleyin';
const UPDATE_CONFIRM = "Uydu güncellemeyi GitHub'dan kendisi indirir (birkaç dakika sürer); bu sırada uydunun Wi-Fi yayını kısa süre kesilebilir. Devam edilsin mi?";
// "Tümünü güncelle": istekler sırayla gider ama her uydu isteği kendi senkronunda alır — güncellemeler aşağı yukarı aynı anda.
const UPDATE_ALL_CONFIRM = "Uydular isteği bir dakika içinde alır ve aşağı yukarı aynı anda güncellenir (her biri GitHub'dan kendisi indirir, birkaç dakika sürer); bu sırada uyduların Wi-Fi yayını kısa süre kesilebilir — bu cihazın yayını sürer. Devam edilsin mi?";
// Süren güncelleme en çok 30 dk (update.ts UPDATE_MAX_RUNTIME_S) + pay: daha eski "güncelleniyor" bildirimi bayattır.
const RUN_STALE_S = 1800 + 120;
const hhmm = (ts: number) => new Date(ts * 1000).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

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
  const [disc, setDisc] = useState<Discovery | null>(null);
  const [discErr, setDiscErr] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [mainVer, setMainVer] = useState('');
  const [mainHasUpdate, setMainHasUpdate] = useState(false);

  const load = useCallback(async () => {
    try { setSt(await getApi<State>('/mesh/state')); setErr(null); } catch (e) { setErr(errText(e, 'durum okunamadı')); }
  }, []);
  // Ağda ara (en çok ~9 sn: mDNS taraması + adayların kimlik yanıtı). Sonuç yalnız öneri; hiçbir şey değiştirmez.
  const discover = useCallback(async () => {
    setFinding(true);
    try { setDisc(await getApi<Discovery>('/mesh/discover')); setDiscErr(null); } catch (e) { setDisc(null); setDiscErr(`Ağda aranamadı: ${errText(e, 'bilinmeyen hata')}`); }
    setFinding(false);
  }, []);
  // Ana cihaz: diğer Klyrix cihazları listesi sayfa açılınca bir kez aranır (uyduda yalnız "Ağda ara" ile).
  const role = st?.role;
  useEffect(() => {
    if (role !== 'main') return;
    const t = setTimeout(() => { void discover(); }, 0);
    return () => clearTimeout(t);
  }, [role, discover]);
  // Ana cihazın sürümü (uydu sürümleri bununla karşılaştırılır) ve bu cihazın kendi güncellemesi var mı (üst çubuğun da
  // kullandığı denetim; backend 60 sn önbellekli). version.json okunamazsa sürüm bilinmiyor sayılır (yedek değer değil).
  useEffect(() => {
    if (role !== 'main') return;
    let alive = true;
    getApi<{ version?: string; build?: number; date?: string }>('/system/version')
      .then(v => { if (alive) setMainVer(v?.date === 'unknown' && !v?.build ? '' : String(v?.version || '')); }).catch(() => {});
    getApi<{ available?: boolean }>('/system/update-check').then(u => { if (alive) setMainHasUpdate(u?.available === true); }).catch(() => {});
    return () => { alive = false; };
  }, [role]);
  const pairingActive = !!code && code.expires_at > now;
  // Çevrimiçi bir uydunun güncelleme isteği bekliyor ya da güncellemesi sürüyorken durum daha sık okunur (çevrimdışı uydunun
  // isteği 24 saate kadar bekleyebilir: onun için sık okuma yok).
  const updWatch = st?.role === 'main' && st.satellites.some(s => s.online && (!!s.update_req || s.status?.update_state?.state === 'running'));
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    // Kod açıkken (uydu gelmesi beklenirken) sık, değilse seyrek.
    const id = setInterval(() => { void load(); }, pairingActive ? 5000 : updWatch ? 10000 : 30000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [load, pairingActive, updWatch]);
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
    // Ağda bulunan ana cihazlar: tıklanınca adres alanına yazılır; kod yine elle girilir (eşleşmenin tek güvencesi).
    const mains = (disc?.devices || []).filter(d => d.role === 'main' && IPV4.test(d.ip));
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
              <div className="msd-find">
                <button className="btn-outline btn-sm msd-find-btn" onClick={() => { void discover(); }} disabled={!!busy || finding}>
                  <Search size={14} /> {finding ? 'Aranıyor…' : 'Ağda ara'}
                </button>
                {disc && !finding && (mains.length ? mains.map(d => (
                  <button key={`${d.id}|${d.ip}`} type="button" className={`msd-chip${mainAddr.trim() === d.ip ? ' msd-chip-on' : ''}`} onClick={() => setMainAddr(d.ip)}
                    aria-pressed={mainAddr.trim() === d.ip} title="Adres alanına yaz — ana cihazda Uydu ekle'ye basınca gösterilen adreslerden biri olmalı; kod yine gerekli">
                    <span className="msd-chip-name">{d.name || 'Klyrix'}</span>
                    <span className="rl-mono">{d.ip}</span>
                    {d.pairing && <span className="msd-chip-tag">kod açık</span>}
                    {d.conflict && <span className="msd-chip-warn">aynı kimlik</span>}
                  </button>
                )) : <span className="dhcp-muted">Ağda ana cihaz bulunamadı — adresi elle yazın. Ana cihazın güvenlik duvarı bu sürümden önce kurulduysa orada Firewall → Deploy Et (mDNS keşfi öyle açılır).</span>)}
              </div>
              {mains.some(d => d.conflict) && !finding && (
                <span className="msd-note">Aynı kimlik birden çok adreste yanıt verdi — ana cihazın birden çok adresi olabilir ya da ağdaki biri onu taklit ediyor. Ana cihazda Uydu ekle'ye basınca gösterilen adreslerden birini seçin.</span>
              )}
              {disc?.mdns === 'unavailable' && !finding && <span className="msd-note">mDNS kullanılamıyor (avahi) — yalnız ağ geçidi yoklandı.</span>}
              {disc?.mdns_blocked && !finding && <span className="msd-note">Bu cihazın güvenlik duvarı (eski kurallar) gelen mDNS'i engelliyor — ana cihaz yalnız ağ geçidiyse bulunur; bulunamazsa adresi elle yazın.</span>}
              {discErr && !finding && <span className="msd-note">{discErr}</span>}
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
                {/* Kurulan kanal: eşleşmede v1'e düşürme uydu tarafında da görünsün. */}
                <div><dt>Eşleşme</dt><dd>{s.proto === 2 ? <Badge variant="success">Şifreli</Badge>
                  : s.proto === 1 ? <Badge variant="warning">Eski eşleşme (şifresiz)</Badge> : '—'}</dd></div>
                <div><dt>Son senkron</dt><dd>{ago(s.last_sync)}</dd></div>
                <div><dt>Yayın</dt><dd>{s.ssid ? `${s.ssid} · ${bandText(s.band)} · kanal ${s.channel || '—'}` : 'henüz açılmadı'}{s.ssid && !s.active ? ' (kapalı)' : ''}</dd></div>
                <div><dt>Köprü</dt><dd className="rl-mono">{s.bridge ? `br0 ${s.ip || ''}` : s.sat_stage === 'none' ? '—' : `kurulamadı${s.guard_result ? ` (${s.guard_result})` : ''}`}</dd></div>
                <div><dt>Kablosuz mesh</dt><dd>{s.mesh.unknown ? 'durum okunamadı' : !s.mesh.capable.length ? 'radyo yok' : s.mesh.configured ? `${s.mesh.attached ? 'köprüde' : 'hazır (kablo bağlı)'} · ${s.mesh.peers} komşu` : 'ana cihazda kapalı'}</dd></div>
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
  // Uydunun 10 dk sınırı (en erken yeni istek, ana cihaz saatiyle) ve süren güncelleme: çevrimdışı uydunun ya da 30 dk
  // sınırını aşmış "güncelleniyor" bildirimi bayattır (düğmeyi gizlemez).
  const retryAt = (s: Satellite) => (s.status?.update_retry_in ? (s.last_seen || 0) + s.status.update_retry_in : 0);
  const runningLive = (s: Satellite) => {
    const us = s.status?.update_state;
    return us?.state === 'running' && s.online && (!us.at || now - us.at <= RUN_STALE_S);
  };
  // Güncelleme: yalnız çevrimiçi, şifreli (v2), isteği anlayan, ana cihazdan eski, isteği / güncellemesi sürmeyen ve 10 dk
  // sınırında olmayan uydular.
  const canUpdate = (s: Satellite) => s.online && s.proto === 2 && !!s.status?.update_cap && cmpVer(s.status?.version, mainVer) === -1
    && !s.update_req && !runningLive(s) && retryAt(s) <= now;
  const eligible = sats.filter(canUpdate);
  const requestUpdate = (s: Satellite) => postApi(`/mesh/satellites/${encodeURIComponent(s.id)}/update`, {});
  const updateOne = (s: Satellite) => {
    if (!window.confirm(`"${s.name}" uydusu güncellenecek. ${UPDATE_CONFIRM}`)) return;
    void act(`upd-${s.id}`, async () => { await requestUpdate(s); toast.success(`${s.name}: güncelleme isteği gönderildi — uydu bir dakika içinde alır`); });
  };
  // Sırayla, tek tek istek: biri başarısız olsa da diğerleri gönderilir. Onay hangi uyduların istekte olduğunu (ve hangi
  // eski uyduların olmadığını) adıyla söyler.
  const updateAll = () => {
    const list = eligible;
    if (!list.length) return;
    const skipped = sats.filter(s => cmpVer(s.status?.version, mainVer) === -1 && !canUpdate(s));
    const msg = `${list.length} uyduya güncelleme isteği gönderilecek: ${list.map(s => s.name).join(', ')}.`
      + (skipped.length ? ` Bu istekte olmayan eski uydular: ${skipped.map(s => s.name).join(', ')} (satırlarındaki nota bakın).` : '')
      + ` ${UPDATE_ALL_CONFIRM}`;
    if (!window.confirm(msg)) return;
    void act('upd-all', async () => {
      let ok = 0;
      const errs: string[] = [];
      for (const s of list) {
        try { await requestUpdate(s); ok++; } catch (e) { errs.push(`${s.name}: ${errText(e, 'istek gönderilemedi')}`); }
      }
      if (ok) toast.success(`${ok} uyduya güncelleme isteği gönderildi — her biri bir dakika içinde alır`);
      if (errs.length) toast.error(errs.join('; '));
    });
  };
  const verCell = (s: Satellite) => {
    const v = s.status?.version || '';
    const c = cmpVer(v, mainVer);
    const us = s.status?.update_state;
    const live = runningLive(s);
    const wait = retryAt(s);
    const waiting = wait > now;
    // Biten / başarısız güncelleme 24 saat gösterilir; süren her zaman (bayatsa "son bilinen").
    const showState = !!us && (us.state === 'running' || !us.at || now - us.at < 86400);
    const stateText = !us ? '' : us.state === 'running'
      ? (live ? `güncelleniyor${us.reason ? ` — ${us.reason}` : ''}` : `son bilinen: güncelleniyordu${s.online ? ' (30 dk sınırı aşıldı)' : ' — uydu çevrimdışı'}`)
      : us.state === 'done' ? 'güncellendi' : `başarısız${us.reason ? `: ${us.reason}` : ''}`;
    const [hintShort, hintFull] = s.proto !== 2
      ? (cmpVer(v, V2_PAIR_SINCE) === -1 ? [OLDSW_UPDATE_SHORT, OLDSW_UPDATE_HINT] : [V1_UPDATE_SHORT, V1_UPDATE_HINT])
      : [NOCAP_UPDATE_SHORT, NOCAP_UPDATE_HINT];
    const canAsk = c === -1 && s.proto === 2 && !!s.status?.update_cap && !s.update_req && !live;
    const noAsk = c === -1 && (s.proto !== 2 || !s.status?.update_cap) && !s.update_req;
    // Üst satır: sürüm + rozet + düğme (sığmazsa alta kayar); altında durum, bağlantı ve not.
    return (
      <div className="msu-cell">
        <span className="msu-top">
          <span className="msu-ver">
            <span className="rl-mono">{v || '—'}</span>
            {c === 0 ? <Badge variant="success">güncel</Badge> : c === -1 ? <Badge variant="warning">eski</Badge> : c === 1 ? <Badge variant="info">daha yeni</Badge> : null}
          </span>
          {canAsk && (
            <button className="btn-outline btn-sm msu-btn" onClick={() => updateOne(s)} disabled={!!busy || !s.online || waiting}
              aria-label={`${s.name} uydusunu güncelle`}
              title={waiting ? `Uydu 10 dakikada en çok bir güncelleme başlatır — yeniden istek en erken ${hhmm(wait)}`
                : s.online ? "Uydu güncellemeyi GitHub'dan kendisi indirir" : 'Uydu çevrimdışı'}>
              <Download size={13} /> {busy === `upd-${s.id}` ? 'İsteniyor…' : 'Güncelle'}
            </button>
          )}
          {noAsk && (
            <button className="btn-outline btn-sm msu-btn" disabled title={hintFull} aria-label={`${s.name} uydusunu güncelle`}><Download size={13} /> Güncelle</button>
          )}
        </span>
        {s.update_req ? (
          <span className="msu-state">istek gönderildi — {s.online ? 'uydu bir dakika içinde alır' : 'uydu çevrimdışı, bağlanınca alır'}</span>
        ) : showState && us ? (
          <span className={`msu-state msu-state-${us.state === 'running' && !live ? 'stale' : us.state}`}>{stateText}</span>
        ) : null}
        {!s.update_req && showState && us?.state === 'failed' && !!s.ip && IPV4.test(s.ip) && (
          <a className="msu-link" href={`http://${s.ip}/#settings`} target="_blank" rel="noopener noreferrer"
            title="Uydunun kendi paneli: Ayarlar → Sistem Güncellemesi (adımlar ve günlük)">ayrıntı: uydunun paneli</a>
        )}
        {canAsk && waiting && <span className="msu-hint">Yeniden istek: en erken {hhmm(wait)}</span>}
        {noAsk && <span className="msu-hint" title={hintFull}>{hintShort}</span>}
      </div>
    );
  };
  const m = st.mesh;
  // Ağdaki diğer Klyrix cihazları (bu cihazın uydular tablosundakiler hariç): yalnız bilgi + kendi panellerine bağlantı.
  const others = (disc?.devices || []).filter(d => IPV4.test(d.ip) && !sats.some(s => s.id === d.id));
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
          <div className="msu-bar">
            <span className="dhcp-muted">
              Bu cihazın sürümü <span className="rl-mono">{mainVer || '—'}</span>. Eski uydular güncellemeyi GitHub'dan kendileri indirir; istek yalnız şifreli eşleşmeyle gider.
            </span>
            <button className="btn-outline btn-sm msu-btn" onClick={updateAll} disabled={!!busy || !eligible.length}
              title={eligible.length ? undefined : 'Güncellenecek çevrimiçi, şifreli eşleşmiş eski uydu yok'}>
              <Download size={13} /> {busy === 'upd-all' ? 'İsteniyor…' : `Tümünü güncelle${eligible.length ? ` (${eligible.length})` : ''}`}
            </button>
          </div>
        )}
        {sats.length > 0 && mainHasUpdate && (
          <Alert kind="info">Bu cihaz için de yeni sürüm var: önce bu cihazı güncelleyin (Ayarlar → Sistem Güncellemesi), sonra uyduları — uydular GitHub'daki son sürümü indirir.</Alert>
        )}
        {sats.length > 0 && (
          <div className="msu-scroll">
            <table className="rl-table ms-table">
              <thead><tr><th>Uydu</th><th>Adres</th><th>Durum</th><th>Sürüm</th><th>Yayın</th><th>Bağlantı</th><th>Eşleşme</th><th className="rl-num">Cihaz</th><th /></tr></thead>
              <tbody>
                {sats.map(s => (
                  <tr key={s.id}>
                    <td data-label="Uydu" className="rl-strong">{s.name}</td>
                    <td data-label="Adres" className="rl-mono">{s.ip || '—'}</td>
                    <td data-label="Durum">{s.online ? <Badge variant="success">Çevrimiçi</Badge> : <span className="rl-muted">Çevrimdışı · {ago(s.last_seen)}</span>}</td>
                    <td data-label="Sürüm">{verCell(s)}</td>
                    <td data-label="Yayın">{s.status?.active ? `${bandText(s.status.band)} · kanal ${s.status.channel || '—'}` : <span className="rl-muted">{s.status?.error || 'kapalı'}</span>}</td>
                    <td data-label="Bağlantı">{s.status?.backhaul === 'mesh' ? `Mesh (${s.status.mesh_peers || 0} komşu)` : 'Kablo'}</td>
                    <td data-label="Eşleşme">{s.proto === 2 ? <Badge variant="success">Şifreli</Badge>
                      : s.proto === 1 ? <Badge variant="warning">Eski eşleşme (şifresiz) — yeniden eşleştirin</Badge> : '—'}</td>
                    <td data-label="Cihaz" className="rl-num">{s.status?.stations?.length ?? 0}</td>
                    <td data-label="" className="rl-c">
                      <button className="icon-btn" title="Uyduyu kaldır" aria-label={`${s.name} uydusunu kaldır`} onClick={() => remove(s)} disabled={!!busy}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h4 className="rl-sub">Ağdaki diğer Klyrix cihazları</h4>
        <div className="msd-find">
          <button className="btn-outline btn-sm msd-find-btn" onClick={() => { void discover(); }} disabled={finding}>
            <Search size={14} /> {finding ? 'Aranıyor…' : 'Yeniden ara'}
          </button>
          {disc?.mdns === 'unavailable' && !finding && <span className="msd-note">mDNS kullanılamıyor (avahi) — yalnız ağ geçidi yoklandı.</span>}
          {disc?.mdns_blocked && !finding && <span className="msd-note">Bu cihazın güvenlik duvarı mDNS'e henüz izin vermiyor (kurallar bu sürümden önce yüklendi) — Firewall sayfasında Deploy Et; diğer cihazlar ancak öyle görünür ve bu cihazı bulur.</span>}
          {discErr && !finding && <span className="msd-note">{discErr}</span>}
        </div>
        {others.length > 0 ? (
          <>
            <ul className="msd-list">
              {others.map(d => (
                <li key={`${d.id}|${d.ip}`} className="msd-item">
                  <span className="rl-strong msd-item-name">{d.name || 'Klyrix'}</span>
                  <Badge variant={d.role === 'main' ? 'info' : 'neutral'}>{d.role === 'main' ? 'Ana cihaz' : 'Uydu'}</Badge>
                  {d.role === 'satellite' && <span className="rl-muted">{d.paired ? 'eşleşmiş' : 'eşleşmemiş'}</span>}
                  {d.conflict && <span className="msd-chip-warn">aynı kimlik birden çok adreste</span>}
                  <a className="rl-mono msd-link" href={`http://${d.ip}/`} target="_blank" rel="noopener noreferrer" title="Doğrulanmamış adres — o cihazın kendi ekranındaki adresle karşılaştırın">{d.ip}</a>
                  <span className="msd-item-hint">{d.role === 'main'
                    ? "O cihazın panelinde Cihaz Rolleri → Uyduya çevir; sonra burada Uydu ekle'ye basıp çıkan kodu o cihaza girin."
                    : d.paired ? 'Başka bir ana cihaza bağlı — önce o cihazın panelinde Eşleşmeyi kaldır, sonra burada Uydu ekle.'
                      : "Burada Uydu ekle'ye basın, kodu o cihazın panelinde (Cihaz Rolleri → Uydu) girin."}</span>
                </li>
              ))}
            </ul>
            <span className="dhcp-muted">Liste doğrulanmamıştır: ağdaki herhangi bir cihaz kendini böyle tanıtabilir. Kodu girmeden önce adresin o cihazın kendi ekranında (HDMI) ya da modemin DHCP listesinde yazanla aynı olduğunu kontrol edin.</span>
          </>
        ) : disc && !finding ? <span className="dhcp-muted">Ağda başka Klyrix cihazı bulunamadı.</span> : null}
        <h4 className="rl-sub">Kablosuz mesh</h4>
        {m.unknown ? (
          <span className="dhcp-muted">Kablosuz mesh durumu okunamadı — birazdan yeniden denenir; mesh ayarı değiştirilmedi.</span>
        ) : !m.capable.length ? (
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
