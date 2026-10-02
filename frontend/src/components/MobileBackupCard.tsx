import { useEffect, useRef, useState } from 'react';
import { Smartphone, Loader2, Plus, Trash2, Power, AlertTriangle, Info, QrCode, Copy, UserPlus, User, ShieldCheck, KeyRound } from 'lucide-react';
import { useApi, postApi, getApi } from '../hooks/useApi';
import { Modal, Select, SelectOption } from './ui';
import { toast } from '../toast';
import { copyText } from '../clipboard';

// Klyrix/Gate Sync (backend mobile.ts + mobileStore.ts): kişilerin telefonları yedeklerini uçtan uca şifreli olarak Pi'nin
// özel alanına gönderir (ağ paylaşımında görünmez; Pi içeriği göremez). Panel kişileri, telefonlarını ve kullanılan yeri
// gösterir; yedeklerin listesi, geri yükleme ve silme uygulamada. Telefon bir kişi için üretilen tek kullanımlık kodla (QR)
// eşleşir. Uygulamanın eski sürümüyle eşleşen telefonlar (şifresiz, Yedekler klasörü) ayrı listelenir.
interface Target { key: string; kind: 'internal' | 'usb'; name: string; mounted: boolean; fstype: string; free: number | null; size: number | null; problem: string | null }
interface LegacyDevice { id: number; name: string; platform: string; created_at: string; last_seen: string; files: number; bytes: number }
interface PersonDevice { id: number; name: string; platform: string; created_at: string; last_seen: string }
interface Person {
  id: string; name: string; target: string; targetLabel: string; problem: string | null; keySet: boolean; createdAt: string;
  devices: PersonDevice[]; snapshots: number; trash: number; lastBackup: string | null; bytes: number; objects: number;
}
interface MobileStatus {
  supported: boolean; enabled: boolean; listening: boolean; error: string; port: number; target: string; targets: Target[];
  profiles: Person[]; legacy: LegacyDevice[]; syncOn: boolean; lastDevice: { id: number; name: string; person: string } | null;
  pairing: { code: string; expires: number; person: string } | null; hosts: string[];
}
interface RemoveResult { removed?: number; kept?: number; filesKept?: boolean }
interface PairInfo { code: string; expires: number; qr: string; hosts: string[]; person: string; lastId: number }

function size(b: number | null): string {
  if (b == null) return '?';
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return b > 0 ? `${Math.max(1, Math.round(b / 1e3))} KB` : '0';
}
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const seen = (iso: string) => when(iso) || 'henüz bağlanmadı';
const platformName = (p: string) => (p === 'ios' ? 'iPhone / iPad' : p === 'android' ? 'Android' : 'Telefon');
const targetLabel = (t: Target) => (t.kind === 'internal' ? 'Dahili disk' : `USB: ${t.name}`);
const targetNote = (t: Target) => (!t.mounted ? 'bağlı değil' : t.problem ? `${t.fstype || '?'} — ext4 gerekir` : `${size(t.free)} boş`);
const errText = (e: unknown, d: string) => (e instanceof Error && e.message ? e.message : d);

export function MobileBackupCard() {
  const { data, refetch } = useApi<MobileStatus | null>('/mobile', null, 15000);
  const [busy, setBusy] = useState('');
  const [pair, setPair] = useState<PairInfo | null>(null);
  const [adding, setAdding] = useState(false);
  if (!data || !data.supported) return null;

  const post = async (key: string, url: string, body: Record<string, unknown>, okMsg: string | ((r: RemoveResult) => string)) => {
    setBusy(key);
    try {
      const r = await postApi(url, body) as RemoveResult;
      toast.success(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    } catch (e) {
      toast.error(errText(e, 'İşlem başarısız'));
    }
    setBusy('');
    void refetch();
  };
  const startPair = async (key: string, body: { profile?: string; person?: string }): Promise<boolean> => {
    setBusy(key);
    try {
      const r = await postApi('/mobile/pair', body) as Omit<PairInfo, 'lastId'>;
      setPair({ ...r, lastId: data.lastDevice?.id ?? 0 });
      return true;
    } catch (e) {
      toast.error(errText(e, 'Eşleştirme kodu alınamadı'));
      return false;
    } finally {
      setBusy('');
    }
  };
  const removePerson = (p: Person) => {
    const what = p.problem
      ? 'Disk bağlı değil: kayıtlar silinir, şifreli dosyalar diskte kalır (anahtar olmadan açılamaz).'
      : `${p.snapshots + p.trash} yedek ve ${size(p.bytes)} şifreli veri Pi'den kalıcı olarak silinir.`;
    if (!window.confirm(`${p.name} kaldırılsın mı?\n\n${p.devices.length} telefonun bağlantısı kesilir. ${what} Bu geri alınamaz.`)) return;
    void post(`rmp${p.id}`, '/mobile/people/remove', { id: p.id }, r => (r?.filesKept ? `${p.name} kaldırıldı (dosyalar diskte kaldı)` : `${p.name} ve yedekleri silindi`));
  };
  const removeDevice = (d: PersonDevice, p: Person) => {
    if (!window.confirm(`${d.name} kaldırılsın mı?\n\nTelefon bir daha yedekleyemez (yeniden eşleştirilene kadar). ${p.name} kişisinin yedekleri durur.`)) return;
    void post(`rm${d.id}`, '/mobile/devices/remove', { id: d.id }, `${d.name} kaldırıldı`);
  };
  const removeLegacy = (d: LegacyDevice, files: boolean) => {
    const msg = files
      ? `${d.name} ve Yedekler klasörüne yüklediği ${d.files} dosya (${size(d.bytes)}) silinsin mi?\n\nBu geri alınamaz.`
      : `${d.name} kaldırılsın mı?\n\nTelefon bir daha yükleyemez. Yüklediği ${d.files} dosya Yedekler klasöründe kalır.`;
    if (!window.confirm(msg)) return;
    void post(`${files ? 'rmf' : 'rm'}${d.id}`, '/mobile/devices/remove', { id: d.id, files },
      r => (files ? `${d.name} kaldırıldı — ${r?.removed ?? 0} dosya silindi${r?.kept ? `, ${r.kept} dosya silinemedi` : ''}` : `${d.name} kaldırıldı`));
  };
  const usable = data.targets.filter(t => !t.problem);
  const current = data.targets.find(t => t.key === data.target);

  return (
    <section>
      <h4 className="dv-h"><Smartphone size={14} /> Telefon ve tablet — Klyrix/Gate Sync</h4>
      <div className="dv-card">
        <div className="dv-card-main">
          <span className="dv-meta">
            {data.enabled
              ? `Her kişinin telefonları yedeklerini uçtan uca şifreli gönderir (ev ağında ya da Ev VPN'iyle, port ${data.port}): Pi ve ağdaki başkaları içeriği göremez, yedekler ağ paylaşımında görünmez. Yedekler uygulamadan listelenir, geri yüklenir ve silinir (silinen 30 gün çöpte kalır).`
              : 'Açınca Klyrix/Gate Sync uygulaması (iOS / Android) telefonların fotoğraf ve videolarını uçtan uca şifreli olarak Pi\'ye yedekler — QR kodla eşleşir, Syncthing gerekmez. Pi telefondaki hiçbir şeyi silmez.'}
          </span>
        </div>
        {data.enabled
          ? <button className="btn-outline btn-sm btn-off" disabled={!!busy} onClick={() => void post('off', '/mobile/settings', { enabled: false }, 'Mobil yedekleme kapatıldı')}>
              {busy === 'off' ? <Loader2 size={13} className="spin" /> : <Power size={13} />} Kapat
            </button>
          : <button className="btn-primary btn-sm btn-on" disabled={!!busy || !usable.length}
              onClick={() => void post('on', '/mobile/settings', { enabled: true, target: usable.some(t => t.key === data.target) ? data.target : usable[0]?.key }, 'Mobil yedekleme açıldı')}>
              {busy === 'on' ? <Loader2 size={13} className="spin" /> : <Power size={13} />} Aç
            </button>}
      </div>
      {!usable.length && !data.enabled && (
        <div className="dv-note dv-note-warn"><AlertTriangle size={16} /><span>
          Uygun yedek diski yok: telefon yedekleri ext4 biçimli bir diske yazılır (veri diski ya da ext4 USB disk). Depolama'dan diski hazırlayın.
        </span></div>
      )}
      {data.enabled && data.error && (
        <div className="dv-note dv-note-bad"><AlertTriangle size={16} /><span>Mobil yedekleme dinleyicisi açılamadı: {data.error}</span></div>
      )}
      {data.enabled && (
        <>
          <div className="dv-card">
            <div className="dv-card-main">
              <strong>Yeni kişilerin diski</strong>
              <span className="dv-meta">Bir kişinin yedekleri, kişi eklendiğinde seçili olan diskte kalır.</span>
            </div>
            <Select className="config-select" value={data.target} disabled={!!busy}
              onChange={e => void post('t', '/mobile/settings', { target: e.target.value }, 'Yeni kişilerin diski değişti')}>
              {data.targets.map(t => <SelectOption key={t.key} value={t.key} disabled={!!t.problem} cols={[targetLabel(t), targetNote(t)]} />)}
            </Select>
          </div>
          {current?.problem && (
            <div className="dv-note dv-note-warn"><AlertTriangle size={16} /><span>{current.problem}</span></div>
          )}

          {data.profiles.map(p => (
            <PersonCard key={p.id} p={p} busy={busy} listening={data.listening}
              onPair={() => void startPair(`pair${p.id}`, { profile: p.id })} onRemove={() => removePerson(p)} onRemoveDevice={d => removeDevice(d, p)} />
          ))}
          {!data.profiles.length && (
            <div className="dv-note dv-note-info"><Info size={16} /><span>
              Henüz kişi yok. Kişi ekleyin (ör. kendiniz, eşiniz, çocuğunuz): her kişinin yedekleri ayrı ve şifreli tutulur; aynı kişinin
              telefonları birbirinin yedeğini görür, başka kişiler göremez.
            </span></div>
          )}
          <button className="btn-primary btn-sm btn-on" style={{ marginTop: 8 }} disabled={!!busy || !data.listening} onClick={() => setAdding(true)}>
            <UserPlus size={13} /> Kişi ekle
          </button>

          {data.legacy.length > 0 && (
            <>
              <h4 className="dv-h"><Smartphone size={14} /> Uygulamanın eski sürümüyle eşleşen telefonlar</h4>
              <div className="dv-note dv-note-warn"><AlertTriangle size={16} /><span>
                Bu telefonlar fotoğraflarını <strong>şifresiz</strong> olarak Yedekler klasörüne yükler{data.syncOn ? '' : ' (Cihaz Yedekleme kapalı olduğu için şu an yükleyemiyor)'}.
                Uygulamayı güncelleyip telefonu bir kişiye yeniden eşleştirin, sonra buradan kaldırın.
              </span></div>
              {data.legacy.map(d => (
                <div key={d.id} className="dv-card">
                  <div className="dv-card-main">
                    <strong>{d.name}</strong>
                    <span className="dv-meta">{platformName(d.platform)} · {d.files} dosya · {size(d.bytes)} · son bağlantı: {seen(d.last_seen)}</span>
                  </div>
                  <div className="dv-card-actions">
                    <button className="btn-outline btn-sm btn-off" disabled={!!busy} onClick={() => removeLegacy(d, false)}>
                      {busy === `rm${d.id}` ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} Kaldır
                    </button>
                    <button className="btn-outline btn-sm btn-off" disabled={!!busy || !d.files} onClick={() => removeLegacy(d, true)}>
                      {busy === `rmf${d.id}` ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} Dosyalarıyla sil
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}
      {adding && <NewPersonModal busy={busy === 'pairnew'} onClose={() => setAdding(false)}
        onSubmit={async name => { if (await startPair('pairnew', { person: name })) setAdding(false); }} />}
      {pair && <PairModal pair={pair} onClose={() => { setPair(null); void postApi('/mobile/pair/cancel', {}).catch(() => {}); void refetch(); }}
        onPaired={(name, person) => { setPair(null); toast.success(`${name} eşleştirildi${person ? ` — ${person}` : ''}`); void refetch(); }} />}
    </section>
  );
}

function PersonCard({ p, busy, listening, onPair, onRemove, onRemoveDevice }: {
  p: Person; busy: string; listening: boolean; onPair: () => void; onRemove: () => void; onRemoveDevice: (d: PersonDevice) => void;
}) {
  const backups = p.snapshots ? `${p.snapshots} yedek · ${size(p.bytes)} · son yedek: ${when(p.lastBackup)}` : p.bytes ? `ilk yedek sürüyor · ${size(p.bytes)}` : 'henüz yedek yok';
  return (
    <div className="dv-card" style={{ alignItems: 'flex-start' }}>
      <div className="dv-card-main">
        <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}><User size={14} /> {p.name}</strong>
        <span className="dv-meta">{backups}{p.trash ? ` · çöpte ${p.trash}` : ''} · {p.targetLabel}</span>
        {p.problem && <span className="dv-meta" style={{ color: 'var(--warning-color)' }}><AlertTriangle size={12} /> {p.problem}</span>}
        {!p.keySet && p.devices.length > 0 && (
          <span className="dv-meta"><KeyRound size={12} /> Şifreleme anahtarı henüz kurulmadı — telefonda kurulumu bitirin (kurtarma anahtarı adımı).</span>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
          {p.devices.map(d => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Smartphone size={13} style={{ flexShrink: 0, color: 'var(--text-secondary)' }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                {d.name} <span className="dv-meta">· {platformName(d.platform)} · son bağlantı: {seen(d.last_seen)}</span>
              </span>
              <button className="dv-icon-btn" title="Telefonu kaldır" aria-label={`${d.name} telefonunu kaldır`} disabled={!!busy} onClick={() => onRemoveDevice(d)}>
                {busy === `rm${d.id}` ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
              </button>
            </div>
          ))}
          {!p.devices.length && <span className="dv-meta">Telefon yok — yedekleri Pi'de duruyor; bu kişiye telefon ekleyip kurtarma anahtarıyla açabilirsiniz.</span>}
        </div>
      </div>
      <div className="dv-card-actions">
        <button className="btn-outline btn-sm btn-on" disabled={!!busy || !listening} onClick={onPair}>
          {busy === `pair${p.id}` ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} Telefon ekle
        </button>
        <button className="btn-outline btn-sm btn-off" disabled={!!busy} onClick={onRemove}>
          {busy === `rmp${p.id}` ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} Kişiyi kaldır
        </button>
      </div>
    </div>
  );
}

function NewPersonModal({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (name: string) => void }) {
  const [name, setName] = useState('');
  const ok = name.trim().length > 0;
  return (
    <Modal open onClose={onClose} title="Kişi ekle" width={420} actions={<>
      <button className="btn-outline btn-sm" onClick={onClose}>Vazgeç</button>
      <button className="btn-primary btn-sm btn-on" disabled={!ok || busy} onClick={() => onSubmit(name.trim())}>
        {busy ? <Loader2 size={13} className="spin" /> : <QrCode size={13} />} Eşleştirme kodu al
      </button>
    </>}>
      <div className="form-group">
        <label htmlFor="mb-person">Kişinin adı</label>
        <input id="mb-person" className="config-input" maxLength={40} value={name} autoFocus placeholder="ör. Ayşe"
          onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && ok && !busy) onSubmit(name.trim()); }} />
      </div>
      <div className="dv-note dv-note-info"><ShieldCheck size={16} /><span>
        Kişinin ilk telefonu bir şifreleme anahtarı üretir ve size bir <strong>kurtarma anahtarı</strong> gösterir. Onu yazıp saklayın:
        telefon kaybolursa yedekler yalnız onunla açılır — Pi'de ve panelde anahtar yoktur.
      </span></div>
    </Modal>
  );
}

// Eşleştirme penceresi: QR + kod + kalan süre; telefon eşleşince (yeni cihaz kaydı görülünce) kendiliğinden kapanır
function PairModal({ pair, onClose, onPaired }: { pair: PairInfo; onClose: () => void; onPaired: (name: string, person: string) => void }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.round((pair.expires - Date.now()) / 1000)));
  const done = useRef(false);
  const paired = useRef(onPaired);
  useEffect(() => { paired.current = onPaired; }, [onPaired]);
  useEffect(() => {
    const t = window.setInterval(() => setLeft(Math.max(0, Math.round((pair.expires - Date.now()) / 1000))), 1000);
    return () => window.clearInterval(t);
  }, [pair.expires]);
  useEffect(() => {
    let alive = true;
    const t = window.setInterval(async () => {
      try {
        const s = await getApi<MobileStatus>('/mobile');
        if (alive && !done.current && s.lastDevice && s.lastDevice.id > pair.lastId) {
          done.current = true;
          paired.current(s.lastDevice.name, s.lastDevice.person);
        }
      } catch { /* sonraki turda */ }
    }, 3000);
    return () => { alive = false; window.clearInterval(t); };
  }, [pair.lastId]);
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  return (
    <Modal open onClose={onClose} title={`Telefon ekle — ${pair.person}`} width={440} actions={<button className="btn-outline btn-sm" onClick={onClose}>Kapat</button>}>
      {left > 0 ? (
        <div style={{ textAlign: 'center' }}>
          {pair.qr ? <img src={pair.qr} alt="Eşleştirme QR kodu" width={220} height={220} style={{ imageRendering: 'pixelated', background: '#fff', borderRadius: 8, padding: 6 }} />
            : <div className="dv-note dv-note-info"><QrCode size={16} /><span>QR üretilemedi — kodu elle girin.</span></div>}
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 26, fontWeight: 700, letterSpacing: 2, margin: '10px 0 2px' }}>{pair.code}</div>
          <div className="dv-meta">{mmss} içinde kullanın · tek kullanımlık</div>
          <button className="btn-outline btn-sm" style={{ marginTop: 8 }} onClick={() => void copyText(pair.code).then(ok => (ok ? toast.success('Kopyalandı') : toast.error('Kopyalanamadı')))}>
            <Copy size={13} /> Kodu kopyala
          </button>
        </div>
      ) : (
        <div className="dv-note dv-note-warn"><AlertTriangle size={16} /><span>Kodun süresi doldu — kapatıp yeniden «Telefon ekle»ye basın.</span></div>
      )}
      <ol className="dv-hint" style={{ textAlign: 'left', marginTop: 14, paddingLeft: 18 }}>
        <li>Telefonda <strong>Klyrix/Gate Sync</strong> uygulamasını açın → <strong>Pi'ye bağlan</strong>.</li>
        <li>Bu QR kodu okutun (ya da kodu yazın). Telefon Pi ile aynı ev ağında olmalı; evden uzaktaysanız Ev VPN'ini açın.</li>
        <li>Kişinin ilk telefonuysa uygulama kurtarma anahtarını gösterir: yazıp saklayın. Kişinin başka telefonu varsa uygulama kurtarma anahtarını sorar.</li>
      </ol>
      <div className="dv-note dv-note-info" style={{ marginTop: 10 }}><Info size={16} /><span>
        Pi'nin adresleri: {pair.hosts.join(', ')}. Uygulama henüz mağazada değilse geliştirici sürümüyle kurulur (depodaki mobile/ klasörü).
      </span></div>
    </Modal>
  );
}
