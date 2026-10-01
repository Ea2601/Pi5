import { useState } from 'react';
import { Share2, Monitor, Apple, Smartphone, Tv, KeyRound, Power, Loader2, XCircle, Usb, HardDrive, User, Copy, Link2 } from 'lucide-react';
import { postApi } from '../hooks/useApi';
import { Modal, Panel } from './ui';
import { toast } from '../toast';
import { copyText } from '../clipboard';

// Ağ paylaşımı (backend share.ts → scripts/share.sh): veri diskinin paylaşım bölümü ve panelden "Ağda paylaş" denen USB
// diskler, ev ağındaki cihazlara SMB ile açılır. Erişim kullanıcı adı + şifreyle; ev ağı ve Ev VPN yöneticileri (misafir
// VPN profilleri, VPS tünelleri ve internet erişemez). Açma paket kurduğu için depolama işi olarak koşar (ilerleme şeridi).
export interface ShareUsb { name: string; uuid: string; fstype: string; mounted: boolean; device: string }
export interface ShareStatus {
  supported?: boolean; installed?: boolean; enabled?: boolean; user?: string; smbd?: boolean; wsdd?: boolean; avahi?: boolean;
  shareDir?: string; usb?: ShareUsb[]; host?: string; ip?: string;
  name?: string; nameOk?: boolean; // sabit ad (Pi-hole yerel DNS, ör. paylasim.lan) ve gerçekten çözülüyor mu
}
export interface SharePartInfo { size: number | null; used: number | null; avail: number | null }

const FS_LABEL: Record<string, string> = { exfat: 'exFAT', vfat: 'FAT32', ntfs3: 'NTFS', 'ntfs-3g': 'NTFS', ext4: 'ext4' };
function size(b: number | null): string {
  if (b == null) return '—';
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(b >= 1e11 ? 0 : 1)} GB`;
  return `${Math.round(b / 1e6)} MB`;
}

async function copyAddr(text: string) {
  if (await copyText(text)) toast.success(`Kopyalandı: ${text}`);
  else toast.error('Kopyalanamadı — adresi elle seçip kopyalayın');
}
function CopyButton({ text }: { text: string }) {
  return (
    <button className="sh-copy" title={`Kopyala: ${text}`} aria-label={`Kopyala: ${text}`} onClick={() => void copyAddr(text)}>
      <Copy size={12} />
    </button>
  );
}

export function SharePanel({ st, busy, sharePart, usbPart, hasShareSpace, onChanged }: {
  st: ShareStatus; busy: boolean; sharePart: SharePartInfo | null; usbPart: (device: string) => SharePartInfo | null;
  hasShareSpace: boolean; onChanged: () => void;
}) {
  const [modal, setModal] = useState<'' | 'enable' | 'password' | 'disable'>('');
  const host = st.host || 'klyrix';
  const ip = st.ip || '192.168.x.x';
  // Sabit ad çözülüyorsa adresler adla (IP değişse de aynı kalır), çözülmüyorsa IP ile
  const name = st.name || 'paylasim.lan';
  const at = st.nameOk ? name : ip;
  const main = st.shareDir ? 'Paylasim' : (st.usb || [])[0]?.name || '';
  const unc = (share: string) => `\\\\${at}${share ? `\\${share}` : ''}`;
  const smb = (share: string) => `smb://${at}${share ? `/${share}` : ''}`;

  return (
    <Panel title="Ağ paylaşımı" icon={<Share2 size={20} style={{ marginRight: 8 }} />} className="sh-panel"
      subtitle="Diskleri ev ağındaki bilgisayar, telefon ve TV'lere açar (Windows, Mac, iPhone, Android)"
      actions={st.enabled ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn-outline btn-sm" disabled={busy} onClick={() => setModal('password')}><KeyRound size={13} /> Şifreyi değiştir</button>
          <button className="btn-outline btn-sm" disabled={busy} onClick={() => setModal('disable')}><Power size={13} /> Paylaşımı kapat</button>
        </div>
      ) : undefined}>
      {st.supported === false && <div className="empty-state" style={{ padding: 20 }}>Ağ paylaşımı yalnız Pi üzerinde çalışır.</div>}

      {st.supported && !st.enabled && (
        <div className="sh-off">
          <p className="st-help" style={{ marginTop: 0 }}>
            {hasShareSpace
              ? <>Veri diskinin <strong>paylaşım alanı</strong>{sharePart?.size ? ` (${size(sharePart.size)})` : ''} ağda <code>Paylasim</code> adıyla görünür. </>
              : <>Veri diskinde paylaşım bölümü yok: yalnız USB diskler paylaşılabilir. </>}
            Takılı USB diskleri aşağıdaki disk kartlarından tek tek <strong>Ağda paylaş</strong> ile açabilirsiniz; diskler silinmez.
          </p>
          <p className="st-help">
            Erişim kullanıcı adı ve şifreyle; yalnız ev ağındaki cihazlar ve Ev VPN'ine <strong>yönetici</strong> profiliyle bağlananlar.
            Misafir VPN profilleri ve internet erişemez. İlk açılışta gerekli paketler kurulur (birkaç dakika).
          </p>
          <button className="btn-primary btn-sm" style={{ marginTop: 10 }} disabled={busy} onClick={() => setModal('enable')}>
            <Share2 size={13} /> Paylaşımı aç
          </button>
        </div>
      )}

      {st.supported && st.enabled && (
        <>
          <div className="st-chips" style={{ marginTop: 6 }}>
            <span className={`st-chip ${st.smbd ? 'st-chip-ok' : 'st-chip-bad'}`}>{st.smbd ? 'Paylaşım çalışıyor' : 'Paylaşım durdu'}</span>
            <span className={`st-chip ${st.wsdd ? 'st-chip-ok' : 'st-chip-warn'}`}>{st.wsdd ? 'Windows ağında görünür' : 'Windows ağında görünmüyor (adresle bağlanın)'}</span>
            <span className={`st-chip ${st.avahi ? 'st-chip-ok' : 'st-chip-warn'}`}>{st.avahi ? 'Mac / iPhone\'da görünür' : 'Mac / iPhone\'da görünmüyor (adresle bağlanın)'}</span>
          </div>

          <div className="sh-connect">
            <h4><Link2 size={14} /> Adres</h4>
            <div className="sh-addr"><span className="sh-addr-label">Windows</span><code>{unc(main)}</code><CopyButton text={unc(main)} /></div>
            <div className="sh-addr"><span className="sh-addr-label">Mac / iPhone</span><code>{smb(main)}</code><CopyButton text={smb(main)} /></div>
            {st.nameOk
              ? <p className="st-help" style={{ marginTop: 2 }}>
                  <code>{name}</code> Pi'nin adresi değişse de aynı kalır. Pi'yi DNS olarak kullanan cihazlarda (Pi'nin dağıttığı adresler,
                  Ev VPN'i) çalışır; DNS'i elle değiştirilmiş bir cihazda IP ile bağlanın: <code>{`\\\\${ip}`}</code>. Bu adresler
                  tarayıcıda açılmaz: Dosya Gezgini'nin ya da Finder'ın adres çubuğuna yazın.
                </p>
              : <p className="st-help" style={{ marginTop: 2 }}>
                  <code>{name}</code> adı Pi-hole'da henüz çözülmüyor (paylaşım yeni açıldıysa bir dakika içinde hazır olur); şimdilik
                  IP ile. Bu adresler tarayıcıda açılmaz: Dosya Gezgini'nin ya da Finder'ın adres çubuğuna yazın.
                </p>}
          </div>

          <div className="sh-connect">
            <h4><Share2 size={14} /> Nasıl bağlanılır</h4>
            <div className="sh-row"><Monitor size={15} /><span><strong>Windows:</strong> Dosya Gezgini'nin adres çubuğuna <code>{unc(main)}</code>, ya da <strong>Ağ</strong> → <code>{host.toUpperCase()}</code>. Her açılışta hazır olsun: <strong>Bu Bilgisayar → ••• → Ağ sürücüsüne bağlan</strong> → Klasör <code>{unc(main)}</code>, <strong>Farklı kimlik bilgileri kullanarak bağlan</strong> işaretli.</span></div>
            <div className="sh-row"><Apple size={15} /><span><strong>Mac:</strong> Finder → <strong>Git → Sunucuya Bağlan</strong> → <code>{smb(main)}</code> (<strong>+</strong> ile sık kullanılanlara eklenir)</span></div>
            <div className="sh-row"><Smartphone size={15} /><span><strong>iPhone / iPad:</strong> Dosyalar → <strong>•••</strong> → <strong>Sunucuya Bağlan</strong> → <code>{smb('')}</code></span></div>
            <div className="sh-row"><Tv size={15} /><span><strong>Android / TV:</strong> SMB destekleyen dosya yöneticisi ya da medya oynatıcı → <code>{at}</code></span></div>
            <div className="sh-row"><User size={15} /><span>Kullanıcı adı <code>{st.user}</code> ve paylaşım şifresi. Evin dışından: Ev VPN'ine yönetici profiliyle bağlıyken aynı adresler.</span></div>
          </div>

          <div className="sh-shares">
            <h4><HardDrive size={14} /> Paylaşılanlar</h4>
            {st.shareDir && (
              <div className="st-place-row">
                <span className="st-place-label"><code>Paylasim</code> — veri diskinin paylaşım alanı <CopyButton text={unc('Paylasim')} /></span>
                <span className="st-place-where">{sharePart ? `${size(sharePart.avail)} boş / ${size(sharePart.size)}` : st.shareDir}</span>
                <span className="st-chip st-chip-ok">açık</span>
              </div>
            )}
            {(st.usb || []).map(u => {
              const p = u.device ? usbPart(u.device) : null;
              return (
                <div key={u.uuid} className="st-place-row">
                  <span className="st-place-label"><Usb size={13} /> <code>{u.name}</code> — USB disk ({FS_LABEL[u.fstype] || u.fstype}) <CopyButton text={unc(u.name)} /></span>
                  <span className="st-place-where">{u.mounted && p ? `${size(p.avail)} boş / ${size(p.size)}` : 'disk takılı değil — takınca kendiliğinden açılır'}</span>
                  <span className={`st-chip ${u.mounted ? 'st-chip-ok' : 'st-chip-warn'}`}>{u.mounted ? 'açık' : 'takılı değil'}</span>
                </div>
              );
            })}
            {!st.shareDir && !(st.usb || []).length && (
              <div className="st-muted" style={{ fontSize: 13 }}>Henüz paylaşılan bir şey yok: aşağıdaki USB disk kartlarından <strong>Ağda paylaş</strong>.</div>
            )}
          </div>
        </>
      )}

      {modal === 'enable' && <EnableModal user={st.user || ''} onClose={() => setModal('')} onDone={() => { setModal(''); onChanged(); }} />}
      {modal === 'password' && <PasswordModal onClose={() => setModal('')} />}
      {modal === 'disable' && <DisableModal onClose={() => setModal('')} onDone={() => { setModal(''); onChanged(); }} />}
    </Panel>
  );
}

function usePost() {
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const send = async (url: string, body: Record<string, unknown>) => {
    setSending(true);
    setErr('');
    try {
      const r = await postApi(url, body);
      setSending(false);
      return r;
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'İşlem başarısız');
      setSending(false);
      return null;
    }
  };
  return { sending, err, setErr, send };
}

function PasswordFields({ pw, pw2, setPw, setPw2 }: { pw: string; pw2: string; setPw: (s: string) => void; setPw2: (s: string) => void }) {
  return (
    <>
      <div className="form-group">
        <label htmlFor="sh-pw">Şifre (en az 8 karakter)</label>
        <input id="sh-pw" type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} />
      </div>
      <div className="form-group">
        <label htmlFor="sh-pw2">Şifre (tekrar)</label>
        <input id="sh-pw2" type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} />
      </div>
      {pw2 && pw !== pw2 && <div className="st-muted" style={{ fontSize: 12, marginTop: -6 }}>Şifreler aynı değil</div>}
    </>
  );
}

const pwOk = (pw: string, pw2: string) => pw.length >= 8 && pw.length <= 64 && pw === pw2;

function EnableModal({ user, onClose, onDone }: { user: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(user || 'klyrix');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const { sending, err, send } = usePost();
  const nameOk = /^[a-z][a-z0-9_-]{2,31}$/.test(name);
  const submit = async () => {
    if (await send('/storage/share/enable', { user: name, password: pw })) onDone();
  };
  return (
    <Modal open onClose={onClose} title="Ağ paylaşımını aç" width={460}
      actions={
        <>
          <button className="btn-outline btn-sm" onClick={onClose}>Vazgeç</button>
          <button className="btn-primary btn-sm" disabled={!nameOk || !pwOk(pw, pw2) || sending} onClick={submit}>
            {sending ? <Loader2 size={13} className="spin" /> : <Share2 size={13} />} Aç
          </button>
        </>
      }>
      <div className="form-group">
        <label htmlFor="sh-user">Kullanıcı adı</label>
        <input id="sh-user" value={name} disabled={!!user} autoComplete="off" spellCheck={false}
          onChange={e => setName(e.target.value.toLowerCase())} />
      </div>
      {!nameOk && <div className="st-muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 10 }}>3-32 karakter; küçük harfle başlar, küçük harf / rakam / - / _</div>}
      <PasswordFields pw={pw} pw2={pw2} setPw={setPw} setPw2={setPw2} />
      <p className="st-help" style={{ marginTop: 4 }}>
        Bu bilgiler yalnız paylaşıma bağlanırken sorulur; panel şifresinden ayrıdır. Şifre panelde saklanmaz, yalnız paylaşım
        hizmetine kaydedilir. İlk açılışta gerekli paketler kurulur (birkaç dakika); ilerlemeyi sayfanın üstünde görürsünüz.
      </p>
      {err && <div className="routing-apply routing-apply-err"><XCircle size={14} /><span>{err}</span></div>}
    </Modal>
  );
}

function PasswordModal({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const { sending, err, send } = usePost();
  const submit = async () => {
    if (await send('/storage/share/password', { password: pw })) {
      toast.success('Paylaşım şifresi değiştirildi — cihazlarda bir kez yeniden girmeniz gerekebilir');
      onClose();
    }
  };
  return (
    <Modal open onClose={onClose} title="Paylaşım şifresini değiştir" width={420}
      actions={
        <>
          <button className="btn-outline btn-sm" onClick={onClose}>Vazgeç</button>
          <button className="btn-primary btn-sm" disabled={!pwOk(pw, pw2) || sending} onClick={submit}>
            {sending ? <Loader2 size={13} className="spin" /> : <KeyRound size={13} />} Değiştir
          </button>
        </>
      }>
      <PasswordFields pw={pw} pw2={pw2} setPw={setPw} setPw2={setPw2} />
      {err && <div className="routing-apply routing-apply-err"><XCircle size={14} /><span>{err}</span></div>}
    </Modal>
  );
}

function DisableModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { sending, err, send } = usePost();
  const submit = async () => {
    if (await send('/storage/share/disable', {})) { toast.success('Ağ paylaşımı kapatıldı'); onDone(); }
  };
  return (
    <Modal open onClose={onClose} title="Ağ paylaşımını kapat" width={420}
      actions={
        <>
          <button className="btn-outline btn-sm" onClick={onClose}>Vazgeç</button>
          <button className="btn-primary btn-sm" disabled={sending} onClick={submit}>
            {sending ? <Loader2 size={13} className="spin" /> : <Power size={13} />} Evet, kapat
          </button>
        </>
      }>
      <p className="st-help" style={{ marginTop: 0 }}>
        Cihazlar paylaşıma bağlanamaz. Dosyalar, kullanıcı adı ve USB disklerin paylaşım ayarı kalır; yeniden açınca hepsi geri gelir.
      </p>
      {err && <div className="routing-apply routing-apply-err"><XCircle size={14} /><span>{err}</span></div>}
    </Modal>
  );
}
