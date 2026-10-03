import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, GlobeLock, Info, KeyRound, Loader2, Power, PowerOff, RefreshCw, Trash2, Undo2, X } from 'lucide-react';
import { useApi, putApi, postApi, deleteApi } from '../hooks/useApi';
import { toast } from '../toast';
import { Panel, Badge } from './ui';
import './GeoBlockPanel.css';

// Güvenlik → Geo-IP / Tehdit (backend geoBlock.ts, /api/geo): tehdit istihbaratı IP listeleri (Spamhaus DROP, FireHOL
// level1, isteğe bağlı AbuseIPDB) ve ülke engeli. Varsayılan kapalı; açma ve her değişiklik 5 dk denemedir (onaylanmazsa
// Pi kendiliğinden geri alır). Ayrı parça (React.lazy): ana paket büyümesin.

interface Settings {
  enabled: boolean; threatIn: boolean; threatOut: boolean;
  feeds: { spamhaus: boolean; firehol: boolean; abuseipdb: boolean };
  countriesIn: string[]; countriesOut: string[]; exempt: string[];
}
interface Source { id: string; label: string; kind: 'threat' | 'country'; fetchedAt: number; count: number; skipped: number; error: string }
interface Status {
  supported: boolean; settings: Settings; state: 'off' | 'trial' | 'on';
  trial: { settings: Settings; startedAt: number; until: number; now: number } | null;
  loaded: boolean; persisted: boolean;
  counts: { threat: number; geoIn: number; geoOut: number; allow: number; total: number; cap: number } | null;
  cap: number; profile: string | null;
  counters: { threatIn: number; geoIn: number; threatOut: number; geoOut: number; since: number | null } | null;
  sources: Source[]; exemptPorts: number[]; abuseKey: { set: boolean; masked: string }; lastError: string;
  trialSeconds: number; limits: { countries: number; exempt: number };
}

// ISO 3166-1 alfa-2 kodları (adlar tarayıcının Türkçe bölge adlarından: Intl.DisplayNames)
const CODES = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
  + 'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB '
  + 'GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH '
  + 'KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX '
  + 'MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE '
  + 'SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC '
  + 'VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' ');
// Bayrak emojisi kullanılmaz: Windows'ta Chrome / Edge çizmez (harf olarak görünür, kod iki kez okunurdu)
let regionNames: Intl.DisplayNames | null = null;
try { regionNames = new Intl.DisplayNames(['tr'], { type: 'region' }); } catch { regionNames = null; }
const ccName = (c: string) => { try { return regionNames?.of(c) || c; } catch { return c; } };
const fold = (s: string) => s.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');
const fmtNum = (n: number) => n.toLocaleString('tr-TR');
const fmtTime = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
// Muaf liste ayrı (metin kutusu) karşılaştırılır; açık / kapalı alanı biçim farkı sayılmaz
const sameSettings = (a: Settings, b: Settings) => JSON.stringify({ ...a, enabled: false, exempt: [] }) === JSON.stringify({ ...b, enabled: false, exempt: [] });

function CountryPicker({ value, onChange, disabled, max, label }: { value: string[]; onChange: (v: string[]) => void; disabled: boolean; max: number; label: string }) {
  const [q, setQ] = useState('');
  const all = useMemo(() => CODES.map(c => ({ c, n: ccName(c) })).sort((a, b) => a.n.localeCompare(b.n, 'tr')), []);
  const hits = useMemo(() => {
    const f = fold(q.trim());
    if (!f) return [];
    return all.filter(x => !value.includes(x.c) && (fold(x.n).includes(f) || x.c.toLowerCase() === f)).slice(0, 8);
  }, [q, all, value]);
  const add = (c: string) => { if (value.length < max) onChange([...value, c]); setQ(''); };
  return (
    <div className="geo-cc">
      {value.length > 0 && (
        <div className="geo-chips">
          {value.map(c => (
            <span key={c} className="geo-chip">
              {ccName(c)} <span className="geo-chip-code">{c}</span>
              <button type="button" className="geo-chip-x" disabled={disabled} aria-label={`${ccName(c)} kaldır`} onClick={() => onChange(value.filter(x => x !== c))}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <input className="config-input geo-cc-search" placeholder={value.length >= max ? `En çok ${max} ülke` : 'Ülke ara (ör. Rusya, CN)…'} value={q}
        disabled={disabled || value.length >= max} aria-label={label} onChange={e => setQ(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && hits[0]) { e.preventDefault(); add(hits[0].c); } }} />
      {hits.length > 0 && (
        <div className="geo-cc-hits" role="listbox" aria-label={`${label} — sonuçlar`}>
          {hits.map(h => (
            <button type="button" key={h.c} className="geo-cc-hit" role="option" aria-selected="false" onClick={() => add(h.c)}>
              {h.n} <span className="geo-chip-code">{h.c}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function GeoBlockPanel() {
  const { data: st, loading, refetch } = useApi<Status | null>('/geo/status', null, 5000);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [exemptText, setExemptText] = useState('');
  // Biçimin son eşitlendiği sunucu ayarı: kullanıcı bundan sonra bir şey değiştirmediyse sunucudaki her değişiklik (deneme
  // geri alındı / süresi doldu / kalıcı yapıldı) biçime yansır; değiştirdiyse düzenlemesi korunur.
  const [synced, setSynced] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');
  const [now, setNow] = useState(() => Date.now());
  // Deneme geri sayımı: sunucu saatiyle fark yalnız yeni durum gelince hesaplanır (her çizimde değil) → sayaç saniyede bir
  // ilerler ve tarayıcı saatinden bağımsızdır. Süre dolunca durum 2 sn'de bir sorulur (otomatik yenileme kapalı olsa da):
  // geri alınmış denemenin bandı ve "Kalıcı yap" düğmesi kalmasın.
  const trialNow = st?.trial?.now ?? 0;
  const until = st?.trial?.until ?? 0;
  const skew = useMemo(() => (trialNow ? trialNow - Date.now() : 0), [trialNow]);
  const remain = until ? Math.max(0, Math.round((until - (now + skew)) / 1000)) : 0;
  const expired = until > 0 && remain === 0;
  useEffect(() => {
    if (!until) return;
    // İlk adım hemen: deneme sayfa açıkken başladıysa saklı saat eski kalıp sayaç bir an 5 dk'nın üstünü göstermesin
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [until]);
  useEffect(() => {
    if (!expired) return;
    void refetch();
    const id = setInterval(() => { void refetch(); }, 2000);
    return () => clearInterval(id);
  }, [expired, refetch]);

  // Biçim: denemede deneme ayarı, değilse kayıtlı ayar.
  const server = st ? (st.trial ? st.trial.settings : st.settings) : null;
  const differs = (base: Settings | null) => !!(draft && base && (!sameSettings(draft, base) || exemptText.trim() !== base.exempt.join('\n')));
  const dirty = differs(server);
  const touched = differs(synced);
  useEffect(() => {
    if (!server || touched) return;
    setDraft(server);
    setExemptText(server.exempt.join('\n'));
    setSynced(server);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(server)]);

  if (loading && !st) return <div className="geo-loading"><Loader2 size={20} className="spin" /></div>;
  if (!st) return <p className="geo-note"><AlertTriangle size={14} /><span>Durum alınamadı.</span></p>;
  // Durum geldi, biçim bir sonraki adımda dolar (yukarıdaki eşitleme): hata değil, yükleniyor
  if (!draft) return <div className="geo-loading"><Loader2 size={20} className="spin" /></div>;

  const state = st.state;
  const set = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch });
  const setFeed = (k: keyof Settings['feeds'], v: boolean) => setDraft({ ...draft, feeds: { ...draft.feeds, [k]: v } });
  const exemptList = exemptText.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'İşlem başarısız');
      await refetch();
    } finally {
      setBusy(false);
    }
  };
  const apply = (enabled: boolean) => run(async () => {
    // Kapatırken yürürlükteki ayar gönderilir: biçimdeki kaydedilmemiş (belki hatalı) düzenleme kapatmayı engellemesin
    const body = enabled ? { ...draft, exempt: exemptList, enabled } : { ...(server ?? draft), enabled };
    const r = await putApi('/geo/settings', body) as Status;
    // Sunucunun düzelttiği biçim (ör. 203.0.113.7 → 203.0.113.7/32) biçime yansır: kaydedilen ayar "değişti" görünmesin
    const srv = r?.trial?.settings ?? r?.settings;
    if (srv) { setDraft(srv); setExemptText(srv.exempt.join('\n')); setSynced(srv); }
  }, enabled ? 'Deneme başladı — 5 dk içinde "Kalıcı yap" deyin' : 'Geo-IP / tehdit engeli kapatıldı');
  const turnOff = () => {
    if (!window.confirm('Geo-IP / tehdit engeli kapatılsın mı? Tüm engeller hemen kalkar.')) return;
    void apply(false);
  };

  const threatSources = st.sources.filter(s => s.kind === 'threat');
  const countrySources = st.sources.filter(s => s.kind === 'country');
  const mm = `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, '0')}`;
  const anyFeed = draft.feeds.spamhaus || draft.feeds.firehol || draft.feeds.abuseipdb;
  const nothing = !(draft.threatIn || draft.threatOut) && !draft.countriesIn.length && !draft.countriesOut.length;
  const canApply = st.supported && !busy && !nothing && (!(draft.threatIn || draft.threatOut) || anyFeed) && (!draft.feeds.abuseipdb || st.abuseKey.set);

  return (
    <div className="geo">
      <Panel title="Geo-IP / Tehdit Engeli" icon={<GlobeLock size={20} style={{ marginRight: 8 }} />}
        subtitle="Bilinen saldırgan ağlardan gelen bağlantıları ve ev ağından bu ağlara gidişi düşürür; isterseniz seçtiğiniz ülkeleri de engeller"
        badge={<Badge variant={state === 'on' ? 'success' : state === 'trial' ? 'warning' : 'neutral'}>{state === 'on' ? 'Açık' : state === 'trial' ? 'Deneme' : 'Kapalı'}</Badge>}
        actions={state !== 'off' || st.loaded
          ? <button className="btn-outline btn-sm btn-off" disabled={busy} onClick={turnOff}>
              {busy ? <Loader2 size={14} className="spin" /> : <PowerOff size={14} />} Kapat
            </button>
          : undefined}>
        {!st.supported && <p className="geo-note"><Info size={14} /><span>Bu sistemde uygulanamaz (yalnız Pi / Linux).</span></p>}

        {st.trial && (
          <div className="geo-trial" role="status">
            <div className="geo-trial-text">
              <strong>Deneme: {mm}</strong>
              <span>Kural uygulandı. Panel, internet ve Ev VPN'iniz çalışıyorsa <b>Kalıcı yap</b> deyin; süre dolarsa Pi kuralı
                kendiliğinden geri alır (panel kapansa da).</span>
            </div>
            <div className="geo-trial-actions">
              <button className="btn-primary btn-sm btn-on" disabled={busy} onClick={() => { void run(() => postApi('/geo/confirm', {}), 'Kalıcı yapıldı'); }}>
                <Check size={14} /> Kalıcı yap
              </button>
              <button className="btn-outline btn-sm btn-off" disabled={busy} onClick={() => { void run(() => postApi('/geo/revert', {}), 'Geri alındı'); }}>
                <Undo2 size={14} /> Geri al
              </button>
            </div>
          </div>
        )}
        {st.lastError && <p className="geo-note geo-warn"><AlertTriangle size={14} /><span>{st.lastError}</span></p>}

        <p className="geo-note">
          <Info size={14} />
          <span>Ev VPN'i (UDP {st.exemptPorts.join(', ')}), VPS sunucularınız, tünel uçları ve ev ağı (özel adresler) her zaman
            muaftır; Pi'nin kendi internet trafiği (güncelleme, DNS, VPS tüneli) hiç etkilenmez. Modem arkasındaki tek bacaklı
            kurulumda gelen yön yalnız Ev VPN portu için anlamlıdır; asıl değer giden tehdit engeli ve internet kartı kipindeki port
            yönlendirmeleridir.</span>
        </p>

        <div className="geo-grid">
          <section className="geo-box">
            <h4>Tehdit listeleri</h4>
            <label className="geo-check"><input type="checkbox" checked={draft.threatIn} disabled={busy} onChange={e => set({ threatIn: e.target.checked })} />
              <span>Gelen: internetten Pi'ye ve port yönlendirmelerine</span></label>
            <label className="geo-check"><input type="checkbox" checked={draft.threatOut} disabled={busy} onChange={e => set({ threatOut: e.target.checked })} />
              <span>Giden: ev ağından ve Ev VPN istemcilerinden tehdit adreslerine</span></label>
            <div className="geo-sub">Kaynaklar</div>
            <label className="geo-check"><input type="checkbox" checked={draft.feeds.spamhaus} disabled={busy} onChange={e => setFeed('spamhaus', e.target.checked)} />
              <span>Spamhaus DROP <em>— ele geçirilmiş / suç ağları</em></span></label>
            <label className="geo-check"><input type="checkbox" checked={draft.feeds.firehol} disabled={busy} onChange={e => setFeed('firehol', e.target.checked)} />
              <span>FireHOL level1 <em>— saldırı kaynakları, yanlış pozitif oranı düşük</em></span></label>
            <label className="geo-check"><input type="checkbox" checked={draft.feeds.abuseipdb} disabled={busy || !st.abuseKey.set} onChange={e => setFeed('abuseipdb', e.target.checked)} />
              <span>AbuseIPDB <em>— kendi ücretsiz anahtarınızla, günde bir çekim; Pi geri rapor göndermez</em></span></label>
            <div className="geo-key">
              <KeyRound size={14} />
              {st.abuseKey.set
                ? <>
                    <span className="geo-mono">Anahtar kayıtlı: {st.abuseKey.masked}</span>
                    <button className="btn-outline btn-sm btn-off" disabled={busy} onClick={() => { void run(() => deleteApi('/geo/abuseipdb-key'), 'Anahtar silindi'); }}>
                      <Trash2 size={14} /> Sil
                    </button>
                  </>
                : <>
                    <input className="config-input geo-key-input" type="password" autoComplete="off" placeholder="AbuseIPDB API anahtarı" value={key}
                      disabled={busy} aria-label="AbuseIPDB API anahtarı" onChange={e => setKey(e.target.value)} />
                    <button className="btn-primary btn-sm btn-on" disabled={busy || !key.trim()} onClick={() => { void run(async () => { await putApi('/geo/abuseipdb-key', { key: key.trim() }); setKey(''); }, 'Anahtar kaydedildi'); }}>
                      <Check size={14} /> Kaydet
                    </button>
                  </>}
            </div>
          </section>

          <section className="geo-box">
            <h4>Ülke engeli — gelen</h4>
            <p className="geo-help">Seçilen ülkelerde kayıtlı adreslerden Pi'ye ve port yönlendirmelerine gelen yeni bağlantılar düşer.</p>
            <CountryPicker value={draft.countriesIn} max={st.limits.countries} disabled={busy} label="Gelen ülke engeli" onChange={v => set({ countriesIn: v })} />
            <h4 className="geo-gap">Ülke engeli — giden</h4>
            <p className="geo-note geo-warn">
              <AlertTriangle size={14} />
              <span>Dikkat: büyük siteler ve uygulamalar (CDN, bulut) başka ülkede kayıtlı adresler kullanabilir; giden ülke engeli
                ilgisiz siteleri bozabilir. Yalnız gerçekten gerekiyorsa seçin.</span>
            </p>
            <CountryPicker value={draft.countriesOut} max={st.limits.countries} disabled={busy} label="Giden ülke engeli" onChange={v => set({ countriesOut: v })} />
            <p className="geo-help">Ülke verisi RIPEstat'tan gelir ve kayıt tabanlıdır: adresin kayıtlı olduğu ülkeyi gösterir, cihazın
              bulunduğu yeri değil.</p>
          </section>

          <section className="geo-box">
            <h4>Muaf adresler</h4>
            <p className="geo-help">Hiç engellenmeyecek IPv4 adresleri ya da aralıkları (ör. 203.0.113.7 ya da 198.51.100.0/24), satır başına bir tane;
              en çok {st.limits.exempt}.</p>
            <textarea className="config-input geo-exempt" rows={4} value={exemptText} disabled={busy} spellCheck={false}
              aria-label="Muaf adresler" onChange={e => setExemptText(e.target.value)} />
          </section>
        </div>

        <div className="geo-actions">
          {nothing && <span className="geo-help">Engellenecek bir şey seçilmedi.</span>}
          {(draft.threatIn || draft.threatOut) && !anyFeed && <span className="geo-help">Tehdit engeli için en az bir kaynak seçin.</span>}
          {state === 'off'
            ? <button className="btn-primary btn-on" disabled={!canApply} onClick={() => { void apply(true); }}>
                {busy ? <Loader2 size={16} className="spin" /> : <Power size={16} />} Aç (5 dk deneme)
              </button>
            : <button className="btn-primary btn-on" disabled={!canApply || !dirty} onClick={() => { void apply(true); }}>
                {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />} Değişiklikleri uygula (5 dk deneme)
              </button>}
        </div>
      </Panel>

      <Panel title="Durum" className="geo-gap-panel" size="medium"
        actions={state !== 'off'
          ? <button className="btn-outline btn-sm" disabled={busy} onClick={() => { void run(() => postApi('/geo/refresh', {}), 'Listeler yenilendi'); }}>
              <RefreshCw size={14} /> Listeleri şimdi yenile
            </button>
          : undefined}>
        {state === 'off' && !st.loaded && <p className="geo-help">Kapalı: kural, zamanlayıcı ve indirme yok (daha önce indirilen listeler yalnız önbellekte durur).</p>}
        {state === 'off' && st.loaded && (
          <p className="geo-note geo-warn"><AlertTriangle size={14} /><span>Ayar kapalı ama kural hâlâ yüklü (yarım kalmış deneme) — Kapat ile kaldırın.</span></p>
        )}
        {st.counters && (
          <div className="geo-stats">
            <div className="geo-stat"><span>Gelen tehdit</span><b>{fmtNum(st.counters.threatIn)}</b></div>
            <div className="geo-stat"><span>Giden tehdit</span><b>{fmtNum(st.counters.threatOut)}</b></div>
            <div className="geo-stat"><span>Gelen ülke</span><b>{fmtNum(st.counters.geoIn)}</b></div>
            <div className="geo-stat"><span>Giden ülke</span><b>{fmtNum(st.counters.geoOut)}</b></div>
          </div>
        )}
        {st.counters && <p className="geo-help">Düşürülen yeni bağlantı denemeleri (paket){st.counters.since ? `, ${fmtTime(st.counters.since)}'den beri` : ''}.</p>}
        {st.counts && (
          <p className="geo-help">
            {st.loaded ? 'Yüklü' : 'Son hesaplama (uygulanmadı)'}: tehdit {fmtNum(st.counts.threat)}, gelen ülke {fmtNum(st.counts.geoIn)}, giden ülke {fmtNum(st.counts.geoOut)} aralık
            (toplam {fmtNum(st.counts.total)} / tavan {fmtNum(st.counts.cap)}{st.profile ? `, ${st.profile === 'standard' ? 'standart' : 'hafif'} profil` : ''});
            muaf uç {fmtNum(st.counts.allow)}. {st.persisted ? 'Açılışta otomatik yüklenir.' : state === 'trial' ? 'Kalıcı değil (deneme).' : ''}
          </p>
        )}
        {[...threatSources, ...countrySources].length > 0 && (
          <div className="geo-table-wrap">
            <table className="geo-table">
              <thead><tr><th>Kaynak</th><th>Son çekim</th><th>Önek</th><th>Durum</th></tr></thead>
              <tbody>
                {[...threatSources, ...countrySources].map(s => (
                  <tr key={s.id}>
                    <td>{s.kind === 'country' ? <>{ccName(s.label)} <span className="geo-chip-code">{s.label}</span></> : s.label}</td>
                    <td>{fmtTime(s.fetchedAt)}</td>
                    <td>{fmtNum(s.count)}{s.skipped ? <span className="geo-muted"> ({fmtNum(s.skipped)} atlandı)</span> : null}</td>
                    <td className={s.error ? 'geo-bad' : 'geo-ok'}>{s.error ? `${s.error}${s.count ? ' — son kopya kullanılıyor' : ''}` : 'güncel'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="geo-help geo-muted">Listeler açıkken 12 saatte bir (AbuseIPDB ve ülkeler günde bir) yenilenir; /8'den geniş önekler
          ve özel adresler hiç uygulanmaz. Yalnız IPv4.</p>
      </Panel>
    </div>
  );
}
