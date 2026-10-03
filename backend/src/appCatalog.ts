// Uygulama mağazası kataloğu (G3.3, Altyapı → Uygulamalar; çalıştırma apps.ts + scripts/apps.sh). Katalog repo içinde
// sabittir ve panel güncellemesiyle gelir: uzak katalog, telemetri yok. İmajlar DİJESTLE sabitlenir (çok mimarili dizin
// dijesti — arm64 ve amd64 aynı kayıttan): etiket sonradan değişse de başka imaj çekilmez. İmaj yalnız kullanıcı "Kur"
// deyince kayıt defterinden çekilir.
//  - Tek ağ: klx-apps (198.18.64.0/24, RFC 2544 — RFC1918 değil: Samba / mDNS / Syncthing / ebeveyn / Fail2Ban "özel ağ"
//    muafiyetleri konteynerlere geçmez). Her uygulamanın sabit adresi var (güvenlik duvarı kuralları adrese bağlı).
//  - Portlar yalnız ev ağı adresine yayınlanır (DNAT: apps.ts renderAppsNft); internetten / yedek hattan erişim yok.
//  - Doğrulayıcı (validateAppSpec) şunları REDDEDER: host ağı, privileged, docker / podman soketi (ya da başka bir
//    *.sock / /run bağlaması), cap_add, aygıt geçişi. Tek istisna: Home Assistant'ın Zigbee / Z-Wave USB çubuğu — yalnız
//    kullanıcının açık onayıyla, TEK aygıt, /dev/serial/by-id altından (validateUsbDevice).
//  - AdGuard Home kataloğa ALINMAZ: 53 / 67 / 80'de Pi-hole ve nginx ile çakışır; ebeveyn denetimi, VPS alan adı
//    yönlendirmesi ve tüm ağ DNS yönlendirmesi Pi-hole'a bağlıdır (EXCLUDED_APPS — gerekçe arayüzde).
//  - Bellek alt sınırı uygulama başına (minMemMiB, platform.sh bellek sınıfıyla karşılaştırılır); birim sınırları
//    (MemoryMax / CPUQuota) bellek darlığında DNS'ten önce uygulamanın ölmesi için (OOMScoreAdjust=500, apps.ts).

export const APPS_NET = 'klx-apps';
export const APPS_SUBNET = '198.18.64.0/24';
export const APPS_GATEWAY = '198.18.64.1';
export const APPS_DATA = '/mnt/klyrix-data/apps';

export type AppId = 'homeassistant' | 'vaultwarden';
export interface AppVolume { host: string; container: string }
export interface AppSpec {
  id: AppId;
  name: string;
  summary: string;
  version: string;            // gösterim için (dijestin karşılığı olan sürüm)
  image: string;              // depo@sha256:<64 hex> (dijest yoksa etiket + digestPending)
  digestPending?: boolean;
  minMemMiB: number;          // platform bellek sınıfı alt sınırı
  diskMB: number;             // yaklaşık açılmış imaj boyutu (indirme ilerlemesi ve boş yer denetimi)
  ip: string;                 // klx-apps içindeki sabit adres
  port: number;               // ev ağı adresine yayınlanan port
  containerPort: number;
  scheme: 'http' | 'https';
  healthPath: string;
  volumes: AppVolume[];
  env: Record<string, string>;
  memoryMax: string;          // systemd MemoryMax
  cpuQuota: string;           // systemd CPUQuota
  lanAccessOption: boolean;   // "Ev ağına erişim" anahtarı sunulur (varsayılan KAPALI)
  usbOption: boolean;         // isteğe bağlı tek USB aygıtı (açık onayla)
  signupsOption?: boolean;    // "Yeni hesap açılabilir" anahtarı (SIGNUPS_ALLOWED; varsayılan açık — ilk hesap için)
  tls: boolean;               // kurulumda yerel öz-imzalı sertifika üretilir
  notes: string[];
  // Doğrulayıcının reddettiği alanlar (katalogda bulunmamalı; yanlışlıkla eklenirse kurulum açılmaz)
  network?: string;
  privileged?: boolean;
  capAdd?: string[];
  devices?: string[];
}

export const APP_CATALOG: AppSpec[] = [
  {
    id: 'homeassistant',
    name: 'Home Assistant',
    summary: 'Ev otomasyonu: akıllı ev cihazlarını tek yerden yönetin, otomasyon kurun.',
    version: '2026.9.4',
    image: 'ghcr.io/home-assistant/home-assistant@sha256:3e6710a7ab2a61311d9d899b719f6c3657791c63e8f4942cec4ebc42401d6b76',
    minMemMiB: 4096,
    diskMB: 2200,
    ip: '198.18.64.10',
    port: 8123,
    containerPort: 8123,
    scheme: 'http',
    healthPath: '/',
    volumes: [{ host: `${APPS_DATA}/homeassistant/config`, container: '/config' }],
    env: {},
    memoryMax: '1536M',
    cpuQuota: '200%',
    lanAccessOption: true,
    usbOption: true,
    tls: false,
    notes: [
      'Köprü ağında çalışır (host ağı güvenlik nedeniyle kapalı): cihaz keşfi (mDNS / SSDP) sınırlıdır; cihazları adresiyle ekleyin.',
      'Ev ağındaki cihazları yönetmesi için "Ev ağına erişim" anahtarını açın (varsayılan kapalı).',
    ],
  },
  {
    id: 'vaultwarden',
    name: 'Vaultwarden',
    summary: 'Bitwarden uyumlu parola kasası: parolalarınız evinizdeki cihazda.',
    version: '1.37.3',
    image: 'docker.io/vaultwarden/server@sha256:1587c45feaa479f1f5e8af3b00eded36bff77bcf1880cf8dbf0541706dd470e0',
    minMemMiB: 2048,
    diskMB: 300,
    ip: '198.18.64.11',
    port: 8222,
    containerPort: 8222,
    scheme: 'https',
    healthPath: '/alive',
    volumes: [{ host: `${APPS_DATA}/vaultwarden/data`, container: '/data' }],
    env: {
      ROCKET_PORT: '8222',
      ROCKET_TLS: '{certs="/data/tls/cert.pem",key="/data/tls/key.pem"}',
    },
    memoryMax: '256M',
    cpuQuota: '100%',
    lanAccessOption: false,
    usbOption: false,
    signupsOption: true,
    tls: true,
    notes: [
      'Tarayıcıların parola kasası için güvenli bağlantı (HTTPS) gerekir: kurulumda bu cihaza özel bir sertifika üretilir. Tarayıcı ilk girişte sertifika uyarısı verir; yalnız ev ağından ya da Ev VPN\'den erişin.',
      'İnternete açılmaz. Yönetici sayfası kapalıdır: hesaplarınızı açtıktan sonra bu sayfadaki «Yeni hesap açılabilsin» anahtarını kapatın (uygulama yeniden başlar).',
    ],
  },
];

// Kataloğa bilerek alınmayanlar (arayüzde gerekçesiyle gösterilir)
export const EXCLUDED_APPS: { name: string; reason: string }[] = [
  {
    name: 'AdGuard Home',
    reason: 'Pi-hole ile aynı işi yapar ve aynı portları (DNS 53, DHCP 67, web 80) ister. Ebeveyn denetimi, VPS alan adı yönlendirmesi ve tüm ağın DNS yönlendirmesi Pi-hole\'a bağlıdır; ikinci bir DNS sunucusu bu kuralları atlatır.',
  },
];

export const appById = (id: unknown): AppSpec | undefined => APP_CATALOG.find(a => a.id === id);

const DIGEST_RE = /^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
const SOCK_RE = /(^|\/)[^/]*\.sock$|^\/(var\/)?run(\/|$)/;
const ipNum = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const inAppsNet = (ip: string) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip.split('.').every(o => Number(o) <= 255)
  && Math.floor(ipNum(ip) / 256) === Math.floor(ipNum(APPS_GATEWAY) / 256);
// Panelin ve sistemin kullandığı portlar: yayınlanan uygulama portu bunlarla çakışamaz
const RESERVED_PORTS = new Set([22, 53, 67, 68, 80, 123, 443, 445, 3001, 3002, 5335, 5353, 5390, 8008, 8080, 8095, 8384, 22000, 51820, 51821]);

// Saf doğrulayıcı: hata listesi (boşsa geçerli) ve uyarılar. Kurulum ancak hata yoksa açılır.
export function validateAppSpec(a: AppSpec): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!/^[a-z][a-z0-9]{1,23}$/.test(a.id)) errors.push('kimlik geçersiz');
  if (a.network !== undefined && a.network !== APPS_NET) errors.push(`ağ yalnız ${APPS_NET} olabilir (host ağı yasak)`);
  if (a.privileged) errors.push('privileged yasak');
  if (a.capAdd && a.capAdd.length) errors.push('cap_add yasak');
  if (a.devices && a.devices.length) errors.push('aygıt geçişi yasak (Home Assistant USB çubuğu yalnız kurulumda, açık onayla)');
  if (!DIGEST_RE.test(a.image)) {
    if (a.digestPending && /^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+:[A-Za-z0-9._-]+$/.test(a.image)) warnings.push('imaj dijestle sabitlenmemiş (dijest sonra)');
    else errors.push('imaj dijestle (depo@sha256:…) sabitlenmeli');
  }
  if (!inAppsNet(a.ip) || /\.(0|1|255)$/.test(a.ip)) errors.push(`adres ${APPS_SUBNET} içinde olmalı (.0 / .1 / .255 hariç)`);
  if (!Number.isInteger(a.port) || a.port < 1024 || a.port > 65535 || RESERVED_PORTS.has(a.port)) errors.push('yayınlanan port geçersiz ya da ayrılmış');
  if (!Number.isInteger(a.containerPort) || a.containerPort < 1 || a.containerPort > 65535) errors.push('konteyner portu geçersiz');
  if (!Number.isInteger(a.minMemMiB) || a.minMemMiB < 2048) errors.push('bellek alt sınırı en az 2048 MiB');
  if (!/^\d+[KMG]$/.test(a.memoryMax)) errors.push('MemoryMax geçersiz');
  if (!/^\d+%$/.test(a.cpuQuota)) errors.push('CPUQuota geçersiz');
  if (!/^\/[A-Za-z0-9._/-]*$/.test(a.healthPath)) errors.push('sağlık yolu geçersiz');
  if (!a.volumes.length) warnings.push('kalıcı hacim yok');
  for (const v of a.volumes) {
    const norm = (p: string) => p.split('/').filter(Boolean);
    if (!v.host.startsWith(`${APPS_DATA}/${a.id}/`) || norm(v.host).includes('..') || !/^[A-Za-z0-9._/-]+$/.test(v.host)) {
      errors.push(`hacim yalnız ${APPS_DATA}/${a.id}/ altında olabilir: ${v.host}`);
    }
    if (SOCK_RE.test(v.host) || /docker|podman/.test(v.host)) errors.push(`soket / motor dizini bağlanamaz: ${v.host}`);
    if (!/^\/[A-Za-z0-9._/-]+$/.test(v.container) || norm(v.container).includes('..') || SOCK_RE.test(v.container)
      || /^\/(proc|sys|dev)(\/|$)/.test(v.container) || v.container === '/') {
      errors.push(`konteyner yolu geçersiz: ${v.container}`);
    }
  }
  for (const [k, val] of Object.entries(a.env)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) errors.push(`ortam değişkeni adı geçersiz: ${k}`);
    if (/[\n\r]/.test(val) || val.length > 512) errors.push(`ortam değişkeni değeri geçersiz: ${k}`);
  }
  if (a.signupsOption && 'SIGNUPS_ALLOWED' in a.env) errors.push('SIGNUPS_ALLOWED panel anahtarıyla yazılır, katalogda olamaz');
  return { errors, warnings };
}

// Home Assistant'ın isteğe bağlı USB aygıtı: yalnız kalıcı ad (/dev/serial/by-id/…) — tek aygıt; ttyUSB / ttyACM
// numarası her takışta değişebilir, ayrıca /dev geneli ya da başka bir aygıt sınıfı geçmez.
export function validateUsbDevice(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (!/^\/dev\/serial\/by-id\/[A-Za-z0-9._:+-]{1,200}$/.test(v)) return null;
  return v;
}
