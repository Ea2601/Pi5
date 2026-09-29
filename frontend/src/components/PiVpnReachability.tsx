import { useState, type ReactNode } from 'react';
import { Router, Loader2, CheckCircle, XCircle, AlertTriangle, MinusCircle, RefreshCw, Globe, ChevronRight } from 'lucide-react';
import { postApi } from '../hooks/useApi';
import { toast } from '../toast';

// Ev VPN'i — dışarıdan bağlantı testi ve senaryo rehberi (backend wgServer.ts reachabilityTest). Test evden çıkış yolunu
// (kaç cihaz arka arkaya, operatör CGNAT'ı) okur ve bağlı VPS tüneli üzerinden evin adresine deneme paketleri yollar;
// sonuca göre kullanıcıya yalnız kendi durumunun adımları gösterilir:
//  - ulaşıyor → telefonu bağlama adımları ve telefon tarafı sorun giderme
//  - tek modem → modemde tek kural;  arka arkaya iki (ya da daha çok) cihaz → her cihazda bir içeridekine kural
//  - CGNAT → modem ayarı işe yaramaz, operatörden genel IP istenir
interface ReachHop { ttl: number; ip: string; kind: 'private' | 'cgnat' | 'public' | 'none' }
interface ReachResult {
  at: string; running: boolean; port: number; piLanIp: string; gateway: string; publicIp: string;
  endpoint: { host: string; source: 'ddns' | 'ip' | 'none' }; ddnsIps: string[]; ddnsOk: boolean | null;
  hops: ReachHop[]; routers: string[]; cgnatHop: string;
  external: { status: 'reachable' | 'unreachable' | 'untested'; via: string; reason: string; sent: number; received: number };
  scenario: 'reachable' | 'cgnat' | 'nat' | 'unknown';
}

type Tone = 'ok' | 'bad' | 'warn' | 'muted';
const TONE_ICON = { ok: CheckCircle, bad: XCircle, warn: AlertTriangle, muted: MinusCircle };
// Sekme değişince son sonuç kaybolmasın (sayfa yenilenene kadar).
let lastResult: ReachResult | null = null;

const subnetOf = (ip: string) => `${ip.split('.').slice(0, 3).join('.')}.x`;
// routers[0] Pi'nin bağlı olduğu cihaz (ağ geçidi), sonuncusu internete bağlı olan. Kısa adlar cümle içinde ve cümle
// başında ayrı yazılır (toUpperCase/toLowerCase Türkçe İ/i'yi bozar).
function deviceLabel(i: number, n: number) {
  if (n <= 1) return { title: 'Modem / router', short: 'modem', Short: 'Modem' };
  if (i === 0) return { title: "İç router (Pi'nin bağlı olduğu)", short: 'iç router', Short: 'İç router' };
  if (i === n - 1) return { title: 'Dış cihaz (internete bağlı; genelde operatörün modemi)', short: 'dış cihaz', Short: 'Dış cihaz' };
  return { title: 'Ara cihaz', short: 'ara cihaz', Short: 'Ara cihaz' };
}

function Check({ tone, title, children }: { tone: Tone; title: string; children: ReactNode }) {
  const Icon = TONE_ICON[tone];
  return (
    <li className={`pivpn-check pivpn-check-${tone}`}>
      <Icon size={16} />
      <div><strong>{title}</strong><span>{children}</span></div>
    </li>
  );
}

export function PiVpnReachability({ running }: { running: boolean }) {
  const [result, setResult] = useState<ReachResult | null>(lastResult);
  const [testing, setTesting] = useState(false);

  const run = async () => {
    setTesting(true);
    try {
      const r = await postApi('/wg-server/reachability', {}) as ReachResult;
      lastResult = r;
      setResult(r);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Test yapılamadı');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="pivpn-reach">
      <div className="pivpn-reach-head">
        <span className="pivpn-reach-title"><Router size={15} /> Dışarıdan bağlantı</span>
        <button className="btn-outline btn-sm" onClick={run} disabled={testing}>
          {testing ? <Loader2 size={13} className="spin" /> : result ? <RefreshCw size={13} /> : <Globe size={13} />}
          {testing ? ' Test ediliyor…' : result ? ' Yeniden test et' : ' Testi başlat'}
        </button>
      </div>
      {testing ? (
        <p className="subtitle">Evden internete giden yol inceleniyor ve dışarıdan evin adresine deneme paketleri gönderiliyor (10-15 sn)…</p>
      ) : !result ? (
        <p className="subtitle">
          Ev dışındaki bir telefonun Pi'ye ulaşıp ulaşamayacağını ölçer ve modem(ler)de ne yapmanız gerektiğini adım adım
          gösterir. İlk kurulumda ve telefon bağlanamadığında çalıştırın.
        </p>
      ) : (
        <ReachView r={result} running={running} />
      )}
    </div>
  );
}

function ReachView({ r, running }: { r: ReachResult; running: boolean }) {
  const ext = r.external;
  const n = r.routers.length;
  // Dışarıdan ulaşılıyorsa kurallar zaten yerinde: çift NAT artık uyarı değil, bilgi.
  const reachable = ext.status === 'reachable';
  const pathTone: Tone = r.cgnatHop && !reachable ? 'bad' : n >= 2 && !reachable ? 'warn' : n >= 1 ? 'ok' : 'muted';
  const pathText = r.cgnatHop ? `Operatör paylaşımlı IP kullanıyor (CGNAT, ${r.cgnatHop})`
    : n >= 2 ? `${n} cihaz arka arkaya (çift NAT): ${reachable ? 'yönlendirme hepsinde çalışıyor' : 'her birinde kural gerekir'}`
      : n === 1 ? 'Tek modem / router' : 'Anlaşılamadı';
  const extTone: Tone = ext.status === 'reachable' ? 'ok' : ext.status === 'unreachable' ? 'bad' : 'muted';
  const received = Math.min(ext.received, ext.sent);

  return (
    <>
      <ul className="pivpn-checks">
        <Check tone={running ? 'ok' : 'warn'} title="Ev VPN'i">
          {running ? 'Çalışıyor' : 'Kapalı. Test modem ayarlarını yine de sınar; bağlanmak için yukarıdaki anahtarla açın.'}
        </Check>
        <Check tone={!r.publicIp || r.ddnsOk === false ? 'bad' : r.endpoint.source === 'ddns' ? 'ok' : 'warn'} title="Evin dış adresi">
          {!r.publicIp ? 'Alınamadı (internet bağlantısını kontrol edin)'
            : r.endpoint.source === 'ddns'
              ? <><code>{r.endpoint.host}</code> → {r.ddnsIps.join(', ') || 'çözülemedi'} {r.ddnsOk ? '(güncel)' : `— evin adresi ${r.publicIp}, DDNS eski`}</>
              : <><code>{r.publicIp}</code> (DDNS tanımlı değil)</>}
        </Check>
        <Check tone={pathTone} title="Evden internete giden yol">
          <span className="pivpn-path">
            <span>İnternet</span>
            {[...r.routers].reverse().map(ip => <span key={ip}><ChevronRight size={12} />{ip}</span>)}
            <span><ChevronRight size={12} />Pi {r.piLanIp}</span>
          </span>
          {pathText}
        </Check>
        <Check tone={extTone} title={`Dışarıdan erişim (UDP ${r.port})`}>
          {ext.status === 'reachable' ? `Ulaşıyor: ${ext.via} üzerinden gönderilen ${ext.sent} deneme paketinin ${received}'i Pi'ye ulaştı.`
            : ext.status === 'unreachable' ? `Ulaşmıyor: ${ext.via} üzerinden gönderilen ${ext.sent} deneme paketinin hiçbiri Pi'ye ulaşmadı.`
              : `Dışarıdan deneme yapılamadı: ${ext.reason}. Aşağıdaki adımlardan sonra telefonla (Wi-Fi kapalı) deneyin.`}
        </Check>
      </ul>

      {r.ddnsOk === false && (
        <div className="routing-apply routing-apply-err">
          <AlertTriangle size={14} />
          <span>
            DDNS adı evin güncel adresini göstermiyor; telefonlar eski adrese gider. <strong>Ağ Yönetimi → DDNS</strong> sayfasında
            <strong> IP Kontrol Et</strong>'e basın ve birkaç dakika sonra testi yenileyin. QR'lar DDNS adını kullandığı için
            yeniden taranması gerekmez.
          </span>
        </div>
      )}
      {r.endpoint.source !== 'ddns' && r.publicIp && (
        <div className="routing-apply">
          <AlertTriangle size={14} />
          <span>
            DDNS tanımlı değil: QR'lar evin şu anki adresini içerir; operatör adresi değiştirince (genelde birkaç haftada bir)
            QR'ları yeniden taramak gerekir. <strong>Ağ Yönetimi → DDNS</strong> sayfasından ücretsiz bir ad (ör. DuckDNS)
            tanımlamanız önerilir.
          </span>
        </div>
      )}

      {r.scenario === 'reachable' ? <GuideReady r={r} running={running} />
        : r.scenario === 'cgnat' ? <GuideCgnat r={r} />
          : <GuideForward r={r} />}
    </>
  );
}

function GuideReady({ r, running }: { r: ReachResult; running: boolean }) {
  return (
    <div className="pivpn-guide pivpn-guide-ok">
      <h4>Hazır: ev dışından bağlanılabilir</h4>
      <ol>
        {!running && <li>Yukarıdaki anahtarla <strong>Ev VPN'ini açın</strong>.</li>}
        <li>Aşağıdan cihaz ekleyin; açılan QR'ı telefondaki WireGuard uygulamasında <strong>+ → QR koddan oluştur</strong> ile tarayın.</li>
        <li>Denemeyi <strong>Wi-Fi kapalıyken</strong> (mobil veride) yapın; ev Wi-Fi'ındayken yapılan deneme bir şey göstermez.</li>
        <li>Listede cihazın yanında <strong>bağlı</strong> görünmeli. Telefonda <code>ifconfig.me</code> açılınca evin adresi (<code>{r.publicIp}</code>) çıkmalı.</li>
      </ol>
      <details className="pivpn-howto">
        <summary>Telefon yine de bağlanmıyorsa</summary>
        <ol>
          <li>Cihazın <strong>QR</strong> düğmesiyle QR'ı yeniden gösterip tarayın (sunucu adresi <code>{r.endpoint.host}:{r.port}</code>).</li>
          <li>Başka bir ağda deneyin (farklı operatör, arkadaşın Wi-Fi'ı): bazı mobil operatörler ve otel/kafe ağları UDP trafiğini kısıtlar.</li>
          <li><strong>SSH Terminal</strong>'de <code>sudo wg show wg_pi</code> çalıştırın: cihazın altında <code>latest handshake</code> satırı yoksa telefonun paketleri Pi'ye ulaşmıyordur.</li>
        </ol>
      </details>
    </div>
  );
}

function GuideCgnat({ r }: { r: ReachResult }) {
  return (
    <div className="pivpn-guide pivpn-guide-bad">
      <h4>Operatör paylaşımlı IP kullanıyor (CGNAT)</h4>
      <p>
        Evden çıkış yolunda <code>{r.cgnatHop}</code> adresi görüldü (100.64–100.127 aralığı): operatör aynı genel IP'yi birden
        çok aboneyle paylaştırıyor. Bu durumda dışarıdan gelen bağlantı hiçbir modem ayarıyla açılamaz.
      </p>
      <ol>
        <li>Operatörü arayıp <strong>genel (public) IPv4 adresi</strong> isteyin. Birçok operatör bunu ücretsiz ya da küçük bir ücretle açar.</li>
        <li>Genel IP tanımlanınca (modemi yeniden başlatmanız gerekebilir) burada <strong>Yeniden test et</strong>'e basın; sonuç sizi modem adımlarına götürür.</li>
        <li>O zamana kadar ev dışında VPN gerekiyorsa <strong>VPS WireGuard → Client Yonetimi</strong>'nden dış VPS istemcisi ekleyebilirsiniz; trafik evden değil VPS'ten çıkar.</li>
      </ol>
    </div>
  );
}

// Tek modem ya da arka arkaya birden çok cihaz: her cihazda bir içeridekine (ilkinde Pi'ye) UDP yönlendirmesi.
function GuideForward({ r }: { r: ReachResult }) {
  const routers = r.routers.length ? r.routers : r.gateway ? [r.gateway] : [];
  const n = routers.length;
  const outer = routers[n - 1] || '';
  return (
    <div className={`pivpn-guide ${r.external.status === 'unreachable' ? 'pivpn-guide-bad' : ''}`}>
      <h4>{n >= 2 ? `${n} cihazda port yönlendirmesi gerekiyor` : 'Modemde port yönlendirmesi gerekiyor'}</h4>
      {n >= 2 ? (
        <p>
          İnternetten gelen bağlantı önce <code>{outer}</code> adresindeki cihaza, oradan içerideki cihaza ve en son Pi'ye
          ulaşır. Her cihaz bağlantıyı bir içerideki cihaza iletmelidir; kuralların sırası önemli değildir.
        </p>
      ) : n === 0 ? (
        <p>Ev ağının yapısı otomatik anlaşılamadı. Pi'nin bağlı olduğu modemde aşağıdaki kuralı ekleyin.</p>
      ) : null}
      {(n ? routers : ['']).map((ip, i) => {
        const prev = i > 0 ? deviceLabel(i - 1, n) : null;
        return (
          <div key={ip || i} className="pivpn-device">
            <h5>{n >= 2 ? `${i + 1}. ` : ''}{deviceLabel(i, n).title}{ip ? <> — <code>{ip}</code></> : null}</h5>
            <ol>
              <li>
                Ev ağındaki bir cihazdan tarayıcıda <code>http://{ip || '192.168.1.1'}</code> adresini{ip ? '' : ' (modemin adresi; genelde bu)'} açıp
                giriş yapın. Şifre genelde cihazın altındaki etikette yazar{i > 0 ? '; operatörün cihazıysa şifreyi operatörden isteyebilirsiniz' : ''}.
              </li>
              <li>
                <strong lang="en">Port Forwarding</strong> (Port Yönlendirme, NAT, <span lang="en">Virtual Server</span>,
                <span lang="en"> Port Mapping</span>) bölümünde yeni kural ekleyin.
                {i > 0 && <> Örnek: Huawei'de <strong lang="en">Forward Rules → Port Mapping</strong>, ZTE'de <strong lang="en">NAT → Port Forwarding</strong>.</>}
              </li>
              <li>
                Protokol <strong>UDP</strong> · dış port <strong>{r.port}</strong> · iç port <strong>{r.port}</strong> · iç cihaz{' '}
                {!prev
                  ? <><strong>{r.piLanIp || "Pi'nin adresi"}</strong> (Pi); kaydedin.</>
                  : <>listeden <strong>{prev.short}</strong> (adresi <code>{subnetOf(ip)}</code> biçiminde); kaydedin.</>}
              </li>
              {!prev ? (
                <li>Web arayüzü kuralı kaydetmiyorsa üreticinin telefon uygulamasını deneyin (ör. Linksys: <span lang="en">Advanced Settings → Port Settings → Single Port Forwarding</span>).</li>
              ) : (
                <li>
                  {prev.Short} adresini bu cihazdan otomatik alır: <strong>DHCP sabit IP / adres rezervasyonu</strong> ile bugünkü
                  adresini sabitleyin. Yoksa yeniden başlatmada adres değişir ve kural boşa düşer.
                </li>
              )}
            </ol>
          </div>
        );
      })}
      <p className="pivpn-guide-final">
        Kuralları kaydedince <strong>Yeniden test et</strong>'e basın. <strong>Ulaşıyor</strong> görününce telefonda mobil veriyle bağlanın.
      </p>
      {n >= 2 && (
        <p className="pivpn-guide-note">
          Daha kolay yol: operatörü arayıp modemi <strong lang="en">bridge</strong> moduna almasını isteyin; o zaman yalnız
          1. cihazdaki kural yeter.
          {outer.startsWith('10.') && ` Not: ${outer} evinizdeki bir cihaz değil, operatörün ağına ait de olabilir. Evde tek modem varsa yalnız 1. cihazdaki kural yeterlidir; kural varken hâlâ ulaşılamıyorsa operatör gelen bağlantıları engelliyor olabilir — operatörden genel (public) IP isteyin.`}
        </p>
      )}
    </div>
  );
}
