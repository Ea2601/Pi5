// Uygulama mağazası (G3.3, Altyapı → Uygulamalar): NVMe veri diskli ana cihazda OCI konteyner uygulamaları (Home Assistant,
// Vaultwarden). Motor: Podman (Debian paketi, daemon yok); her uygulama kendi systemd birimi (Quadlet: pi5-app-<id>).
//  - VARSAYILAN KAPALI: motor paketi bile kurulmaz. Kullanıcı "Mağazayı etkinleştir" deyinceye kadar köprü, nft tablosu,
//    birim, dosya yoktur (/etc/pi5-gateway/apps/state yok → buradaki her yol hiçbir şey yapmaz).
//  - Uygunluk: ana cihaz; profil standard ve bellek sınıfı ≥ 2048 MiB (uygulama başına alt sınır katalogda); arm64 / amd64;
//    klyrix-data NVMe diskte bağlı (SD karta asla yazılmaz); yedek hatta çıkılırken iş başlamaz (indirme kotası).
//  - Ağ: tek ağ klx-apps 198.18.64.0/24 (RFC1918 dışı). netavark'ın güvenlik duvarı sürücüsü 'none' (containers.conf.d):
//    netavark hiçbir nft kuralı yazmaz (nftables sürücüsü tüm iletime 'ct state invalid drop' ekliyor ve kaldırınca tablo
//    kalıyordu — G3.3 adım 1 bulgusu). NAT, port yayını ve yalıtımın tamamı bizim tablomuzda: inet pi5_apps
//    (renderAppsNft; forward / input öncelik -8 — plan 0.5): uygulama ağına yalnız ev ağı arayüzlerinden (ev ağı kaynak
//    adresiyle, modem hariç) yayınlanan portlara (DNAT) ve Ev VPN YÖNETİCİLERİNDEN; internet kartı / yedek hat → kesin drop; segmentler
//    (seg*, portal istemcileri), wg_s2s*, Ev VPN misafirleri → açıkça drop; VPS istemcileri ve geri kalan her şey → drop
//    (izin listesinde değiller). Konteyner → özel ağlara yeni bağlantı drop
//    ("Ev ağına erişim" açık uygulama yalnız ev ağına çıkar); konteyner → Pi yalnız DNS (53); internete çıkış açık.
//    Politikası drop olan tablolara (inet filter, inet pi5_filter) izin zincirleri pi5_apps_fwd / pi5_apps_in (apps.sh jumps).
//  - Kalıcılık: /etc/nftables.d/pi5-apps.conf (açılışta include + pi5-gw-restore), "nftables yeniden uygula" kancası
//    (index.ts) ve Ev VPN kural kancası (onWgRulesChanged: pi5_filter yeniden kurulunca), dakikalık denetim (ağ adresi
//    değişince / tablo silinince), post-update ve açılışta apps.sh ensure.
//  - İşler (enable / install / uninstall / disable) pi5-backend'in DIŞINDA: systemd-run --unit=pi5-apps (scripts/apps.sh).
//    Depolama / güncelleme / bulut yedeği işleriyle karşılıklı kapı (storage.ts holdJobGate 'apps', update.ts).
//  - Uyduda kapalı (uçlar 409, açılış '!isSatellite'). HA: düğüme bağlı (paylaşımlı depolama yok).
//  - Gizli değer: Vaultwarden TLS anahtarı uygulama hacminde 0600 (apps.sh); ortam dosyaları /etc/pi5-gateway/apps 0600.
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type express from 'express';
import { dbAll } from './db';
import { recordEvent } from './events';
import { isSatellite } from './role';
import { isLinux, readNetModeState, uplinkIfaces, getLanIdentity, sameNetActive, readFailoverStatus, HOME_BRIDGE } from './system';
import { readPlatform, type Platform } from './hardware';
import { storageStatus, holdJobGate, freeJobGate, type StorageStatus } from './storage';
import { parseKv } from './update';
import { onWgRulesChanged } from './wgServer';
import {
  APP_CATALOG, EXCLUDED_APPS, APPS_NET, APPS_SUBNET, APPS_GATEWAY, appById, validateAppSpec, validateUsbDevice, type AppSpec, type AppId,
} from './appCatalog';

const execFileP = promisify(execFile);

const CONF_DIR = '/etc/pi5-gateway/apps';
const STATE_FILE = `${CONF_DIR}/state`;          // apps.sh yazar: stage=trial|on, trial_ends
const NFT_STAGE = `${CONF_DIR}/pi5-apps.nft`;    // burada üretilir; apps.sh fw sınayıp /etc/nftables.d/pi5-apps.conf olarak yükler
const QUADLET_DIR = '/etc/containers/systemd';
const DATA_ROOT = '/mnt/klyrix-data';
const SCRIPT = path.resolve(__dirname, '../../scripts/apps.sh');
const JOB_UNIT = 'pi5-apps';
const JOB_DIR = '/run/pi5-apps';
const JOB_STATE = `${JOB_DIR}/state`;
const JOB_OUTPUT = `${JOB_DIR}/output`;
const JOB_LOCK = '/run/pi5-apps.lock';
// apps.sh rollback yazar (deneme «Kalıcı yap» denmeden geri alındı: at=<sn>); backend bir kez olay yazar (.noted)
const ROLLBACK_MARK = `${JOB_DIR}/rolled_back`;
const ROLLBACK_NOTED = `${ROLLBACK_MARK}.noted`;
// Kullanıcının «Durdur» dediği uygulama (apps.sh stop yazar, start / install / uninstall siler): açılışta / onarımda başlamaz
const stoppedFlag = (id: string) => `${CONF_DIR}/${id}.stopped`;
const JOB_MAX_RUNTIME_S = 3600;
const START_GRACE_S = 15;
export const APPS_TRIAL_S = 300;
const WG_ADMIN_IF = 'wg_pi';
// Konteynerin yeni bağlantı açamayacağı iç ağlar (RFC1918, CGNAT, link-local, uygulama ağı aralığı, çoklu yayın)
const PRIVATE_DROP = ['10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4'];
const IFNAME_RE = /^[A-Za-z0-9_.-]{1,15}$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const CIDR_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/([12]?\d|3[0-2])$/;

// ─── Saf üreticiler (birim testleri: g33 düzeneği) ─────────────────────────────────────────────────────────────────

export interface AppsNftApp { id: string; ip: string; port: number; containerPort: number; lanAccess: boolean }
export interface AppsNftCtx {
  lanIfaces: string[];   // ev ağı arayüzleri (getLanIdentity + br0 / Wi-Fi köprüsünün ev tarafı)
  lanIps: string[];      // Pi'nin ev ağı adresleri: portlar YALNIZ bunlara yayınlanır
  homeNets: string[];    // ev ağı ağları ("Ev ağına erişim" açık uygulamanın çıkabileceği tek yer)
  uplinks: string[];     // internet kartı + yedek hat arayüzleri: uygulama ağına kesin drop
  vpnAdmins: string[];   // Ev VPN yöneticilerinin adresleri (misafirler izin listesinde yok)
  apps: AppsNftApp[];    // kurulu uygulamalar
  // Ev ağı kaynağı SAYILMAYAN adresler: Pi'nin ağ geçidi (tek bacakta modem). Port yönlendirmesini kaynak adres çevirisiyle
  // yapan modemde internetten gelen istek modemin ev ağı adresiyle gelir.
  gateways?: string[];
}
const set = (xs: string[], quote = false) => `{ ${xs.map(x => (quote ? `"${x}"` : x)).join(', ')} }`;
const uniq = (xs: string[]) => [...new Set(xs)];

export function renderAppsNft(c: AppsNftCtx): string {
  const lanIfs = uniq(c.lanIfaces.filter(i => IFNAME_RE.test(i) && i !== APPS_NET));
  const uplinks = uniq(c.uplinks.filter(i => IFNAME_RE.test(i) && i !== APPS_NET));
  const lanIps = uniq(c.lanIps.filter(ip => IPV4_RE.test(ip)));
  const homeNets = uniq(c.homeNets.filter(n => CIDR_RE.test(n)));
  const admins = uniq(c.vpnAdmins.filter(ip => IPV4_RE.test(ip)));
  const gws = uniq((c.gateways || []).filter(ip => IPV4_RE.test(ip)));
  const apps = c.apps.filter(a => IPV4_RE.test(a.ip) && Number.isInteger(a.port) && Number.isInteger(a.containerPort));
  const dnat = lanIps.length ? apps.map(a => `    ip daddr ${set(lanIps)} tcp dport ${a.port} dnat ip to ${a.ip}:${a.containerPort}`) : [];
  const lanAcc = uniq(apps.filter(a => a.lanAccess).map(a => a.ip));
  return [
    '# Klyrix Gate — Uygulamalar (G3.3). backend/src/apps.ts üretir, scripts/apps.sh yükler; elle değiştirmeyin.',
    'table inet pi5_apps {}',
    'delete table inet pi5_apps',
    'table inet pi5_apps {',
    '  chain prerouting {',
    '    type nat hook prerouting priority dstnat; policy accept;',
    ...dnat,
    '  }',
    // Pi'nin kendisinden yayınlanan porta (sağlık denetimi, HDMI paneli)
    '  chain output {',
    '    type nat hook output priority dstnat; policy accept;',
    ...dnat,
    '  }',
    '  chain postrouting {',
    '    type nat hook postrouting priority srcnat; policy accept;',
    `    ip saddr ${APPS_SUBNET} oifname != "${APPS_NET}" masquerade`,
    '  }',
    '  chain forward {',
    '    type filter hook forward priority -8; policy accept;',
    // Baştan yalnız yanıt yönü ve ilişkili paketler (ICMP hataları) geçer: izinli bir bağlantının özgün yöndeki HER paketi
    // aşağıdaki güncel kurallardan yeniden geçer — "Ev ağına erişim" kapatılınca ya da Ev VPN yöneticisi misafire
    // düşürülünce açık bağlantılar da (MQTT, websocket …) hemen kesilir.
    '    ct direction reply accept',
    '    ct state related accept',
    // Uygulama ağıyla ilgisi olmayan iletim (ev ağı → internet …) kısa yoldan geçer: aşağıdaki kuralların hiçbiri ona uymaz
    `    iifname != "${APPS_NET}" ip daddr != ${APPS_SUBNET} accept`,
    `    iifname "${APPS_NET}" ip saddr != ${APPS_SUBNET} drop`,
    // İnternet kartı / yedek hat: kesin drop (pi5_wan / pi5_bak'ın 'ct status dnat accept'i bunu açamaz)
    ...(uplinks.length ? [`    iifname ${set(uplinks, true)} ip daddr ${APPS_SUBNET} drop`] : []),
    // Segmentler (G1.2 seg<VID>: IoT / misafir / DMZ / POS, misafir portalı istemcileri), şube tünelleri (G4.4 wg_s2s*) ve
    // Ev VPN misafirleri açıkça düşer: aşağıdaki izin listesine yanlışlıkla girseler de uygulamalara ulaşamazlar.
    `    iifname "seg*" ip daddr ${APPS_SUBNET} drop`,
    `    iifname "wg_s2s*" ip daddr ${APPS_SUBNET} drop`,
    `    iifname "${WG_ADMIN_IF}"${admins.length ? ` ip saddr != ${set(admins)}` : ''} ip daddr ${APPS_SUBNET} drop`,
    // Ev ağı: yalnız ev ağı arayüzünden, ev ağı kaynak adresiyle ve yayınlanan porttan (DNAT) — modemde açılmış bir port
    // yönlendirmesi (internet kaynaklı adres) de uygulamaya ulaşmaz. Ağ geçidinin (modem) kendi adresi ev ağı kaynağı
    // sayılmaz: kaynak adres çevirisiyle port yönlendiren modemde internetten gelen istek bu adresle gelir.
    ...(lanIfs.length && homeNets.length
      ? [`    iifname ${set(lanIfs, true)} ip saddr ${set(homeNets)}${gws.length ? ` ip saddr != ${set(gws)}` : ''} ip daddr ${APPS_SUBNET} ct status dnat accept`]
      : []),
    ...(admins.length ? [`    iifname "${WG_ADMIN_IF}" ip saddr ${set(admins)} ip daddr ${APPS_SUBNET} ct status dnat accept`] : []),
    `    ip daddr ${APPS_SUBNET} drop`,
    ...(lanAcc.length && homeNets.length ? [`    iifname "${APPS_NET}" ip saddr ${set(lanAcc)} ip daddr ${set(homeNets)} accept`] : []),
    `    iifname "${APPS_NET}" ip daddr ${set(PRIVATE_DROP)} drop`,
    '  }',
    '  chain input {',
    '    type filter hook input priority -8; policy accept;',
    `    iifname "${APPS_NET}" ct state established,related accept`,
    `    iifname "${APPS_NET}" ip saddr ${APPS_SUBNET} meta l4proto { tcp, udp } th dport 53 accept`,
    `    iifname "${APPS_NET}" drop`,
    `    iifname != { "${APPS_NET}", "lo" } ip daddr ${APPS_SUBNET} drop`,
    '  }',
    // Pi'den uygulama ağına çoklu yayın gitmez: Wi-Fi köprüsü kipindeki mDNS yansıtıcısı (avahi, net-mode.sh) ev ağındaki
    // cihazların duyurularını (ad, adres, hizmet) yalıtılmış uygulama ağına taşımasın.
    '  chain output_mcast {',
    '    type filter hook output priority -8; policy accept;',
    `    oifname "${APPS_NET}" ip daddr 224.0.0.0/4 drop`,
    `    oifname "${APPS_NET}" ip6 daddr ff02::fb drop`,
    '  }',
    '}',
    '',
  ].join('\n');
}

// Quadlet birimi (/etc/containers/systemd/pi5-app-<id>.container → pi5-app-<id>.service). ExecStartPre: pi5_apps tablosu
// yoksa uygulama başlamaz (açılışta tablo yüklenmeden konteyner ağa açılmasın — fail-closed). Bellek darlığında önce
// uygulama ölür (OOMScoreAdjust=500; DNS / panel 0). MemorySwapMax=0: sınırı aşan uygulama takasa (zram — yine bellek — ya
// da SD karttaki takas dosyası) taşmaz, kendi cgroup'unda öldürülür ve yeniden başlar (g33 e2e: takas açıkken MemoryMax'ta
// durup takasa yazıyordu). İmaj açılışta çekilmez (Pull=never: yalnız "Kur" işinde). Kullanıcının «Durdur» dediği uygulama
// (<id>.stopped, apps.sh stop) açılışta da başlamaz.
export function renderQuadlet(a: AppSpec, opts: { usbDevice?: string | null } = {}): string {
  const usb = opts.usbDevice ? validateUsbDevice(opts.usbDevice) : null;
  return [
    '# Klyrix Gate — Uygulamalar (G3.3). backend/src/apps.ts üretir, scripts/apps.sh kurar; elle değiştirmeyin.',
    ...(a.tls ? ['# klyrix-tls'] : []),
    `# klyrix-port ${a.containerPort}`,
    '[Unit]',
    `Description=Klyrix Gate uygulaması: ${a.name}`,
    'After=network-online.target nftables.service pi5-gw-restore.service',
    'Wants=network-online.target',
    `RequiresMountsFor=${DATA_ROOT}/apps/${a.id}`,
    `ConditionPathExists=!${stoppedFlag(a.id)}`,
    '',
    '[Container]',
    `ContainerName=pi5-app-${a.id}`,
    `Image=${a.image}`,
    'Pull=never',
    `Network=${APPS_NET}`,
    `IP=${a.ip}`,
    `DNS=${APPS_GATEWAY}`,
    ...a.volumes.map(v => `Volume=${v.host}:${v.container}`),
    `EnvironmentFile=${CONF_DIR}/${a.id}.env`,
    'NoNewPrivileges=true',
    'Timezone=local',
    ...(usb ? [`AddDevice=${usb}`] : []),
    'PodmanArgs=--oom-score-adj=500 --pids-limit=2048',
    '',
    '[Service]',
    'ExecStartPre=/usr/sbin/nft list table inet pi5_apps',
    `MemoryMax=${a.memoryMax}`,
    'MemorySwapMax=0',
    `CPUQuota=${a.cpuQuota}`,
    'OOMScoreAdjust=500',
    'Nice=5',
    'Restart=always',
    'RestartSec=30',
    'TimeoutStartSec=300',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

// Ortam dosyası (/etc/pi5-gateway/apps/<id>.env, 0600): katalogdaki sabit değerler + panelden değişen ayarlar
// (Vaultwarden: yeni hesap açılabilir mi — SIGNUPS_ALLOWED; yönetici sayfası kapalı olduğu için tek yol bu).
export function renderEnvFile(a: AppSpec, opts: { signups?: boolean } = {}): string {
  const env: Record<string, string> = { ...a.env };
  if (a.signupsOption) env.SIGNUPS_ALLOWED = opts.signups === false ? 'false' : 'true';
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + (Object.keys(env).length ? '\n' : '');
}

// ─── Uygunluk (saf değerlendirme + canlı girdi) ──────────────────────────────────────────────────────────────────────
export interface AppsCheck { key: string; label: string; ok: boolean; detail: string }
export interface AppsEligibility { ok: boolean; checks: AppsCheck[]; memClassMiB: number | null; onBackup: boolean }
export interface EligibilityInput {
  satellite: boolean; platform: Pick<Platform, 'profile' | 'memClassMiB' | 'arch'> | null;
  storage: Pick<StorageStatus, 'disks' | 'layout'> | null; onBackup: boolean;
}
export function evalEligibility(i: EligibilityInput): AppsEligibility {
  const p = i.platform;
  const dataDisk = i.storage?.layout?.dataDev ? i.storage.disks.find(d => d.parts.some(x => x.path === i.storage?.layout?.dataDev)) : undefined;
  const nvme = !!i.storage?.layout?.dataMounted && dataDisk?.kind === 'nvme';
  const checks: AppsCheck[] = [
    { key: 'role', label: 'Ana cihaz', ok: !i.satellite, detail: i.satellite ? 'Bu cihaz uydu: uygulamalar ana cihazda çalışır' : 'Ana cihaz' },
    {
      key: 'memory', label: 'Bellek ve profil', ok: !!p && p.profile === 'standard' && p.memClassMiB >= 2048,
      detail: !p ? 'Platform bilgisi okunamadı' : p.profile !== 'standard' ? 'Az bellekli (lite) profil: uygulamalar kapalı'
        : p.memClassMiB < 2048 ? `En az 2 GB bellek gerekir (bu cihaz ${p.memClassMiB} MB)` : `${Math.round(p.memClassMiB / 1024)} GB bellek`,
    },
    {
      key: 'arch', label: 'İşlemci mimarisi', ok: !!p && (p.arch === 'arm64' || p.arch === 'amd64'),
      detail: !p ? 'Platform bilgisi okunamadı' : p.arch === 'arm64' || p.arch === 'amd64' ? p.arch : `${p.arch || 'bilinmiyor'}: yalnız arm64 / amd64`,
    },
    {
      key: 'nvme', label: 'NVMe veri diski', ok: nvme,
      detail: nvme ? `${dataDisk?.model || dataDisk?.name || 'NVMe'} (klyrix-data bağlı)`
        : !i.storage?.layout?.dataDev ? 'NVMe disk veri diski olarak hazırlanmamış (Depolama → Diski hazırla). SD karta uygulama kurulmaz.'
          : !i.storage.layout.dataMounted ? 'Veri bölümü (klyrix-data) bağlı değil' : 'Veri diski NVMe değil: uygulamalar yalnız NVMe diskte çalışır',
    },
    {
      key: 'uplink', label: 'Ana hat', ok: !i.onBackup,
      detail: i.onBackup ? 'Yedek hattan çıkılıyor: imaj indirme kotayı tüketmesin diye kurulum ana hat dönünce' : 'Ana hattan çıkılıyor',
    },
  ];
  return { ok: checks.every(c => c.ok), checks, memClassMiB: p?.memClassMiB ?? null, onBackup: i.onBackup };
}

function onBackupLine(): boolean {
  const ns = readNetModeState();
  return ns?.bakStage === 'on' && readFailoverStatus()?.active === 'backup';
}

async function eligibility(): Promise<AppsEligibility> {
  const [platform, storage] = await Promise.all([readPlatform().catch(() => null), storageStatus().catch(() => null)]);
  return evalEligibility({ satellite: isSatellite(), platform, storage, onBackup: onBackupLine() });
}

// ─── Durum ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export type EngineStage = 'off' | 'trial' | 'on';
export function readEngineState(): { stage: EngineStage; trialEnds: number } {
  let kv: Record<string, string> = {};
  try { kv = parseKv(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { stage: 'off', trialEnds: 0 }; }
  const stage: EngineStage = kv.stage === 'trial' || kv.stage === 'on' ? kv.stage : 'off';
  return { stage, trialEnds: /^\d+$/.test(kv.trial_ends || '') ? Number(kv.trial_ends) : 0 };
}
const engineOn = () => readEngineState().stage !== 'off';

// Veri bölümü (klyrix-data) bağlı mı: bağlı değilken /mnt/klyrix-data/apps SD karttaki boş bağlama noktasıdır (silme /
// "veriler duruyor" kararı oradan verilmez)
function dataMounted(): boolean {
  try { return fs.readFileSync('/proc/mounts', 'utf8').split('\n').some(l => l.split(' ')[1] === DATA_ROOT); } catch { return false; }
}

// Deneme süresi dolup motor geri alındıysa (apps.sh rollback: zamanlayıcı ya da açılış) bir kez zile uyarı yazılır
function readRollback(): number | null {
  try {
    const at = parseKv(fs.readFileSync(ROLLBACK_MARK, 'utf8')).at || '';
    return /^\d+$/.test(at) ? Number(at) : null;
  } catch { return null; }
}
async function noteRollback(): Promise<void> {
  const at = readRollback();
  if (at === null) return;
  let noted = '';
  try { noted = fs.readFileSync(ROLLBACK_NOTED, 'utf8').trim(); } catch { /* yok */ }
  if (noted === String(at)) return;
  fs.writeFileSync(ROLLBACK_NOTED, `${at}\n`);
  await recordEvent('apps', 'Uygulama motoru denemesi «Kalıcı yap» denmediği için geri alındı — yeniden etkinleştirebilirsiniz', 'warning');
}

// <id>.conf: lan_access (varsayılan kapalı), usb, signups (yeni hesap — varsayılan açık: ilk hesap açılabilsin)
interface AppConf { lanAccess: boolean; usbDevice: string; signups: boolean }
function readAppConf(id: AppId): AppConf {
  let kv: Record<string, string> = {};
  try { kv = parseKv(fs.readFileSync(`${CONF_DIR}/${id}.conf`, 'utf8')); } catch { /* yok */ }
  return { lanAccess: kv.lan_access === '1', usbDevice: validateUsbDevice(kv.usb) || '', signups: kv.signups !== '0' };
}
function writeFileAtomic(file: string, text: string, mode: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}
function writeAppConf(id: AppId, c: AppConf) {
  writeFileAtomic(`${CONF_DIR}/${id}.conf`, `lan_access=${c.lanAccess ? 1 : 0}\nusb=${c.usbDevice}\nsignups=${c.signups ? 1 : 0}\n`, 0o600);
}
const installed = (id: AppId) => fs.existsSync(`${QUADLET_DIR}/pi5-app-${id}.container`);

// Rol uyduya çevrilirken (index.ts /api/system/role): uyduda uygulamalar yönetilemez (uçlar 409, açılış onarımı çalışmaz)
// ama birimler ve pi5-apps.conf açılışta yine yüklenir — motor açıkken rol değiştirilmez. Kapalıyken (birimler kenarda)
// hiçbir şey çalışmaz: engel yok.
export function appsBlocksSatellite(): string | null {
  return readEngineState().stage !== 'off' || APP_CATALOG.some(a => installed(a.id))
    ? 'Uygulama motoru açık — önce kapatın (Altyapı → Uygulamalar → Motoru kapat)' : null;
}

async function vpnAdmins(): Promise<string[]> {
  const rows = await dbAll("SELECT ip FROM wg_server_peers WHERE role = 'admin'").catch(() => []);
  return (rows as { ip: string }[]).map(r => String(r.ip || '')).filter(ip => IPV4_RE.test(ip));
}

// Canlı bağlam (dışa açık: düzenek testleri gerçek arayüzlerle üretilen kuralı sınar)
export async function appsNftContext(): Promise<AppsNftCtx> {
  const ns = readNetModeState();
  const id = await getLanIdentity().catch(() => null);
  const uplinks = uplinkIfaces(ns);
  const apIf = ns && (ns.apStage === 'trial' || ns.apStage === 'on') ? ns.apIface : '';
  const lanIfaces: string[] = [];
  if (id) lanIfaces.push(id.iface, ...id.secondary.map(s => s.iface));
  if (ns && sameNetActive(ns)) lanIfaces.push(ns.repLan);
  if (fs.existsSync(`/sys/class/net/${HOME_BRIDGE}`)) lanIfaces.push(HOME_BRIDGE);
  const lan = uniq(lanIfaces).filter(i => i && !uplinks.includes(i) && i !== apIf && !/^(wg|lo|klx-|veth|docker|podman)/.test(i));
  const lanIps = id ? uniq([id.ip, id.transit.ip]) : [];
  // network zaten önekli ("192.168.0.0/24", system.ts networkOf)
  const homeNets = id ? uniq([id.network, id.transit.network]) : [];
  const apps = APP_CATALOG.filter(a => installed(a.id))
    .map(a => ({ id: a.id, ip: a.ip, port: a.port, containerPort: a.containerPort, lanAccess: a.lanAccessOption && readAppConf(a.id).lanAccess }));
  // Ağ geçidi: tek bacakta modem (ev ağı kaynağı sayılmaz); internet kartı kipinde internet tarafındadır (zararsız)
  const gateways = id?.gateway && IPV4_RE.test(id.gateway) ? [id.gateway] : [];
  return { lanIfaces: lan, lanIps, homeNets, uplinks, vpnAdmins: await vpnAdmins(), apps, gateways };
}

// ─── Güvenlik duvarı: üret → (değiştiyse ya da tablo yoksa) apps.sh fw ───────────────────────────────────────────────
let applying: Promise<void> = Promise.resolve();
const tableExists = () => execFileP('nft', ['list', 'table', 'inet', 'pi5_apps'], { timeout: 5000 }).then(() => true, () => false);
async function doReapply(force: boolean): Promise<void> {
  if (!isLinux || isSatellite() || !engineOn()) return;
  const text = renderAppsNft(await appsNftContext());
  let cur = '';
  try { cur = fs.readFileSync(NFT_STAGE, 'utf8'); } catch { /* ilk */ }
  const loaded = (() => { try { return fs.readFileSync('/etc/nftables.d/pi5-apps.conf', 'utf8'); } catch { return ''; } })();
  if (!force && cur === text && loaded === text && (await tableExists())) return;
  if (cur !== text) writeFileAtomic(NFT_STAGE, text, 0o600);
  await execFileP('bash', [SCRIPT, 'fw'], { timeout: 60000 }).catch((e: any) => {
    throw new Error(String(e?.stdout || '').match(/error=(.*)/)?.[1] || String(e?.stderr || e?.message || e).trim().split('\n').pop() || 'yüklenemedi');
  });
}
// Sıralı; hata günlüğe (yeniden uygula kancaları beklemez). force: tablo varken de atlama zincirleri yeniden kurulur.
export function reapplyApps(force = false): Promise<void> {
  const next = applying.then(() => doReapply(force)).catch((e: any) => console.error('[uygulamalar] güvenlik duvarı uygulanamadı:', e?.message || e));
  applying = next;
  return next;
}

// ─── İşler (scripts/apps.sh, systemd-run --unit=pi5-apps) ────────────────────────────────────────────────────────────
export type AppsCmd = 'enable' | 'disable' | 'install' | 'uninstall';
export interface AppsJob {
  state: 'idle' | 'running' | 'done' | 'failed'; id?: string; cmd?: AppsCmd; app?: string; step?: string; pct?: number;
  msg?: string; error?: string; startedAt?: number; finishedAt?: number; log?: string[];
}
const numOf = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
function readJob(): Record<string, string> | null {
  try { return parseKv(fs.readFileSync(JOB_STATE, 'utf8')); } catch { return null; }
}
function writeJob(text: string) {
  fs.mkdirSync(JOB_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${JOB_STATE}.b${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, JOB_STATE);
}
function jobLog(lines = 30): string[] {
  try {
    const buf = fs.readFileSync(JOB_OUTPUT);
    return buf.subarray(Math.max(0, buf.length - 32768)).toString('utf8').split('\n').filter(Boolean).slice(-lines);
  } catch { return []; }
}
async function unitState(unit: string): Promise<'active' | 'inactive' | 'unknown'> {
  try {
    const { stdout } = await execFileP('systemctl', ['show', '-p', 'ActiveState', '--value', `${unit}.service`], { timeout: 5000 });
    return /^(active|activating|deactivating|reloading)$/.test(stdout.trim()) ? 'active' : 'inactive';
  } catch { return 'unknown'; }
}
export async function appsJob(): Promise<AppsJob> {
  const kv = readJob();
  if (!kv?.id) return { state: 'idle' };
  const base = {
    id: kv.id, cmd: kv.cmd as AppsCmd, app: kv.app || undefined, step: kv.step || undefined, pct: numOf(kv.pct), msg: kv.msg || undefined,
    error: kv.error || undefined, startedAt: numOf(kv.started), finishedAt: numOf(kv.finished), log: jobLog(),
  };
  if (kv.state === 'running') {
    const young = Math.floor(Date.now() / 1000) - (base.startedAt ?? 0) < START_GRACE_S;
    if (young || (await unitState(JOB_UNIT)) !== 'inactive') return { ...base, state: 'running' };
    return { ...base, state: 'failed', error: 'İş yarıda kesildi — ayrıntı aşağıdaki günlükte' };
  }
  return { ...base, state: kv.state === 'done' ? 'done' : 'failed' };
}

const CMD_LABEL: Record<AppsCmd, string> = {
  enable: 'Uygulama motorunu açma', disable: 'Uygulama motorunu kapatma', install: 'Uygulama kurulumu', uninstall: 'Uygulama kaldırma',
};
let notedId = '';
let watchTimer: NodeJS.Timeout | null = null;
function watchJob(): void {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    appsJob().then(async j => {
      if (j.state === 'running') return;
      if (watchTimer) clearInterval(watchTimer);
      watchTimer = null;
      if (!j.id || j.id === notedId) return;
      notedId = j.id;
      const name = j.app ? appById(j.app)?.name || j.app : '';
      const label = `${CMD_LABEL[j.cmd as AppsCmd] || 'Uygulama işi'}${name ? ` (${name})` : ''}`;
      if (j.state === 'done') await recordEvent('apps', j.msg || `${label} tamamlandı`);
      else await recordEvent('apps', `${label} başarısız: ${j.error || 'ayrıntı Uygulamalar sayfasında'}`, 'warning');
      await reapplyApps(true);
    }).catch(() => { /* sonraki turda */ });
  }, 5000);
}

let launching = false;
async function launchAppsJob(cmd: AppsCmd, args: string[], startMsg: string, app = ''): Promise<{ id: string }> {
  if (!fs.existsSync(SCRIPT)) throw new Error('scripts/apps.sh bulunamadı — paneli güncelleyin');
  if (launching) throw new Error('Bir uygulama işi başlatılıyor');
  launching = true;
  try {
    const holder = holdJobGate('apps');
    if (holder) throw new Error(holder === 'storage' ? 'Depolama işi başlatılıyor — bitince yeniden deneyin' : 'Bulut yedeği işi başlatılıyor — bitince yeniden deneyin');
    try {
      const [own, storage, upd, vault] = await Promise.all([unitState(JOB_UNIT), unitState('pi5-storage'), unitState('pi5-update'), unitState('pi5-vault')]);
      if ([own, storage, upd, vault].includes('unknown')) throw new Error('İş durumu okunamadı (systemctl) — birazdan yeniden deneyin');
      if (own === 'active') throw new Error('Bir uygulama işi zaten sürüyor');
      if (storage === 'active') throw new Error('Depolama işi sürüyor — bitince yeniden deneyin');
      if (upd === 'active') throw new Error('Panel güncellemesi sürüyor — bitince yeniden deneyin');
      if (vault === 'active') throw new Error('Bulut yedeği sürüyor — bitince yeniden deneyin');
      try { await execFileP('flock', ['-n', JOB_LOCK, 'true'], { timeout: 5000 }); } catch { throw new Error('Başka bir uygulama işlemi sürüyor — birazdan yeniden deneyin'); }
      const id = String(Date.now());
      const started = Math.floor(Date.now() / 1000);
      fs.mkdirSync(JOB_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(JOB_OUTPUT, '');
      writeJob(`id=${id}\nstate=running\ncmd=${cmd}\napp=${app}\nstarted=${started}\npct=0\nstep=Başlatılıyor\n`);
      try {
        await execFileP('systemd-run', [
          '--quiet', '--collect', `--unit=${JOB_UNIT}`, '--service-type=exec', '--description=Klyrix Gate uygulama işi',
          '-p', `RuntimeMaxSec=${JOB_MAX_RUNTIME_S}`, `--setenv=PI5_APPS_ID=${id}`, '/bin/bash', SCRIPT, cmd, ...args,
        ], { timeout: 15000 });
      } catch (e: any) {
        const msg = String(e?.stderr || e?.message || e).trim().split('\n').pop() || 'systemd-run hatası';
        fs.writeFileSync(JOB_OUTPUT, `İş başlatılamadı: ${msg}\n`);
        writeJob(`id=${id}\nstate=failed\ncmd=${cmd}\napp=${app}\nstarted=${started}\nfinished=${Math.floor(Date.now() / 1000)}\nerror=İş başlatılamadı: ${msg}\n`);
        throw new Error(`Uygulama işi başlatılamadı: ${msg}`);
      }
      await recordEvent('apps', startMsg);
      watchJob();
      return { id };
    } finally {
      freeJobGate('apps');
    }
  } finally {
    launching = false;
  }
}

// ─── Sağlık ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function probe(a: AppSpec): Promise<boolean> {
  return new Promise(resolve => {
    const mod = a.scheme === 'https' ? https : http;
    const req = mod.get({
      host: a.ip, port: a.containerPort, path: a.healthPath, timeout: 2500,
      ...(a.scheme === 'https' ? { rejectUnauthorized: false } : {}),
    }, res => { res.resume(); resolve((res.statusCode || 0) > 0 && (res.statusCode || 0) < 500); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
async function appHealth(a: AppSpec): Promise<'ok' | 'starting' | 'stopped' | 'failed'> {
  try {
    const { stdout } = await execFileP('systemctl', ['show', '-p', 'ActiveState', '--value', `pi5-app-${a.id}.service`], { timeout: 5000 });
    const st = stdout.trim();
    if (st === 'failed') return 'failed';
    if (st !== 'active' && st !== 'activating' && st !== 'reloading') return 'stopped';
    return (await probe(a)) ? 'ok' : 'starting';
  } catch { return 'failed'; }
}

const podmanInstalled = () => ['/usr/bin/podman', '/bin/podman'].some(p => fs.existsSync(p));
// Konteynerlerin DNS'i Pi-hole'dur (198.18.64.1): Pi-hole yalnız "yerel" (LOCAL — bağlı ağlar, klx-apps dahil) ya da "tüm
// arayüzler" (ALL) kipinde yanıtlar; SINGLE / BIND yalnız ev ağı kartını dinler (wgServer.ts dnsOk ile aynı denetim).
const dnsListening = () => execFileP('pihole-FTL', ['--config', 'dns.listeningMode'], { timeout: 5000 })
  .then(r => r.stdout.trim().toUpperCase(), () => '');
function freeMb(): number | null {
  try { const s = fs.statfsSync(DATA_ROOT); return Math.floor((s.bavail * s.bsize) / 1e6); } catch { return null; }
}

// ─── Açılış: etkinse güvenlik duvarı + uygulamalar (öz-onarım) ve dakikalık denetim ──────────────────────────────────
let started = false;
export function startApps(): void {
  if (!isLinux || isSatellite() || started) return;
  started = true;
  // Ev VPN'i kuralları / pi5_filter yeniden kurulunca atlama zincirleri ve yönetici listesi yenilensin (kapalıyken no-op)
  onWgRulesChanged(() => reapplyApps(true));
  setTimeout(() => {
    if (!engineOn()) return;
    // apps.sh ensure: deneme sürerken cihaz yeniden açıldıysa geri alma zamanlayıcısı (systemd-run, geçici) kaybolmuştur —
    // süresi geçtiyse deneme geri alınır, geçmediyse kalan süreye yeniden kurulur; yapılandırma ve ağ onarılır.
    void execFileP('bash', [SCRIPT, 'ensure'], { timeout: 120000 })
      .catch((e: any) => console.error('[uygulamalar] açılış denetimi:', String(e?.stderr || e?.message || e).trim().split('\n').pop()))
      .then(() => (engineOn() ? reapplyApps(true).then(async () => {
        for (const a of APP_CATALOG) {
          // Kullanıcının durdurduğu uygulama başlatılmaz
          if (installed(a.id) && !fs.existsSync(stoppedFlag(a.id)) && (await unitState(`pi5-app-${a.id}`)) === 'inactive') {
            await execFileP('systemctl', ['start', '--no-block', `pi5-app-${a.id}.service`], { timeout: 15000 }).catch(() => {});
          }
        }
      }) : undefined));
    appsJob().then(j => { if (j.state === 'running') watchJob(); }).catch(() => {});
  }, 20000);
  // Ağ adresi / arayüz değişince (sabit IP, internet kartı, köprü) ya da tablo silinince yeniden üretilir. Deneme geri
  // alındıysa (motor artık kapalı) zile bir kez uyarı.
  setInterval(() => {
    noteRollback().catch(() => { /* sonraki turda */ });
    if (engineOn()) void reapplyApps();
  }, 60000);
}

// ─── API ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void;
const appIdOf = (v: unknown): AppSpec | undefined => (typeof v === 'string' ? appById(v) : undefined);

export function registerAppsRoutes(app: express.Express, deps: { guard: Mw; writeLimiter: Mw }): void {
  app.use('/api/apps', (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? next() : deps.writeLimiter(req, res, next)), (req, res, next) => {
    if (isSatellite()) return res.status(409).json({ error: 'Bu cihaz uydu — uygulamalar ana cihazda çalışır' });
    deps.guard(req, res, next);
  });

  app.get('/api/apps', async (_req, res) => {
    try {
      if (!isLinux) return res.json({ supported: false });
      const [elig, job, lm] = await Promise.all([eligibility(), appsJob(), dnsListening()]);
      const eng = readEngineState();
      const id = await getLanIdentity().catch(() => null);
      const mounted = dataMounted();
      await noteRollback().catch(() => { /* dakikalık denetimde */ });
      const catalog = await Promise.all(APP_CATALOG.map(async a => {
        const v = validateAppSpec(a);
        const inst = installed(a.id);
        const conf = readAppConf(a.id);
        const memOk = (elig.memClassMiB ?? 0) >= a.minMemMiB;
        return {
          id: a.id, name: a.name, summary: a.summary, version: a.version, port: a.port, scheme: a.scheme, minMemMiB: a.minMemMiB,
          diskMB: a.diskMB, lanAccessOption: a.lanAccessOption, usbOption: a.usbOption, signupsOption: !!a.signupsOption, tls: a.tls,
          notes: a.notes, valid: !v.errors.length, warnings: v.warnings, memOk,
          installed: inst, lanAccess: a.lanAccessOption && conf.lanAccess, usbDevice: conf.usbDevice || null,
          signups: !!a.signupsOption && conf.signups,
          dataExists: mounted && fs.existsSync(`${DATA_ROOT}/apps/${a.id}`),
          health: inst && eng.stage !== 'off' ? await appHealth(a) : null,
        };
      }));
      res.json({
        supported: true,
        eligibility: elig,
        // rolledBackAt: deneme «Kalıcı yap» denmeden geri alındıysa zamanı (sayfa uyarısı; yeni etkinleştirme / kapatma siler)
        engine: { ...eng, installed: podmanInstalled(), trialSeconds: APPS_TRIAL_S, rolledBackAt: eng.stage === 'off' ? readRollback() : null },
        now: Math.floor(Date.now() / 1000), job, catalog, excluded: EXCLUDED_APPS, openHost: id?.ip || '', freeMb: freeMb(),
        network: { name: APPS_NET, subnet: APPS_SUBNET },
        dns: { listening: lm, ok: !lm || lm === 'LOCAL' || lm === 'ALL' },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/apps/job', async (_req, res) => {
    try { res.json(await appsJob()); } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // HA için USB aygıtları (kalıcı adlar)
  app.get('/api/apps/usb', (_req, res) => {
    let list: string[] = [];
    try { list = fs.readdirSync('/dev/serial/by-id').map(n => `/dev/serial/by-id/${n}`).filter(p => validateUsbDevice(p)); } catch { /* yok */ }
    res.json({ devices: list });
  });

  // Motor: enable (deneme) | confirm (kalıcı yap) | disable / rollback (kapat — veriler kalır)
  app.post('/api/apps/engine', async (req, res) => {
    try {
      if (!isLinux) return res.status(400).json({ error: 'Uygulamalar yalnız Pi üzerinde çalışır' });
      const action = req.body?.action;
      const eng = readEngineState();
      if (action === 'enable') {
        if (eng.stage !== 'off') return res.status(409).json({ error: 'Uygulama motoru zaten açık' });
        const elig = await eligibility();
        if (!elig.ok) return res.status(409).json({ error: `Bu cihaz uygun değil: ${elig.checks.filter(c => !c.ok).map(c => c.detail).join('; ')}` });
        // Kural dosyası işten ÖNCE üretilir: apps.sh önce sınar (nft -c), sonra deneme zamanlayıcısını kurar
        const ctx = await appsNftContext();
        writeFileAtomic(NFT_STAGE, renderAppsNft(ctx), 0o600);
        const r = await launchAppsJob('enable', ['--trial', String(APPS_TRIAL_S)], 'Uygulama motoru açılıyor (Podman kurulumu + 5 dk deneme)');
        return res.json({ success: true, ...r });
      }
      if (action === 'confirm') {
        if (eng.stage !== 'trial') return res.status(409).json({ error: 'Deneme sürmüyor' });
        const job = await appsJob();
        if (job.state === 'running') return res.status(409).json({ error: 'Motor açma işi sürüyor — bitince kalıcı yapın' });
        // Süre dolduysa geri alma başlamıştır / başlamak üzeredir (apps.sh confirm da kilit altında yeniden denetler)
        if (eng.trialEnds <= Math.floor(Date.now() / 1000)) return res.status(409).json({ error: 'Deneme süresi doldu — motor geri alınıyor; yeniden etkinleştirin' });
        await execFileP('bash', [SCRIPT, 'confirm'], { timeout: 30000 }).catch((e: any) => {
          throw new Error(String(e?.stdout || '').match(/error=(.*)/)?.[1] || 'kalıcı yapılamadı');
        });
        await recordEvent('apps', 'Uygulama motoru kalıcı yapıldı');
        return res.json({ success: true });
      }
      if (action === 'disable' || action === 'rollback') {
        if (eng.stage === 'off' && !fs.existsSync(CONF_DIR)) return res.status(409).json({ error: 'Uygulama motoru zaten kapalı' });
        const r = await launchAppsJob('disable', [], action === 'rollback' ? 'Uygulama motoru denemesi geri alınıyor' : 'Uygulama motoru kapatılıyor (uygulama verileri kalır)');
        return res.json({ success: true, ...r });
      }
      res.status(400).json({ error: 'Geçersiz işlem' });
    } catch (e: any) {
      res.status(409).json({ error: e.message });
    }
  });

  app.post('/api/apps/:id/install', async (req, res) => {
    try {
      const a = appIdOf(req.params.id);
      if (!a) return res.status(404).json({ error: 'Uygulama katalogda yok' });
      if (!isLinux) return res.status(400).json({ error: 'Uygulamalar yalnız Pi üzerinde çalışır' });
      if (readEngineState().stage !== 'on') return res.status(409).json({ error: 'Önce uygulama motorunu açıp kalıcı yapın' });
      if (installed(a.id)) return res.status(409).json({ error: `${a.name} zaten kurulu` });
      const v = validateAppSpec(a);
      if (v.errors.length) return res.status(409).json({ error: `Katalog girdisi reddedildi: ${v.errors.join('; ')}` });
      const elig = await eligibility();
      if (!elig.ok) return res.status(409).json({ error: `Bu cihaz uygun değil: ${elig.checks.filter(c => !c.ok).map(c => c.detail).join('; ')}` });
      if ((elig.memClassMiB ?? 0) < a.minMemMiB) return res.status(409).json({ error: `${a.name} için en az ${a.minMemMiB / 1024} GB bellek gerekir` });
      const free = freeMb();
      if (free !== null && free < a.diskMB * 1.5) return res.status(409).json({ error: `Veri diskinde yer az: ${free} MB boş, en az ${Math.ceil(a.diskMB * 1.5)} MB gerekir` });
      if (a.tls && req.body?.tlsAck !== true) return res.status(400).json({ error: 'Sertifika uyarısını onaylayın (tarayıcı ilk girişte uyarı verir)' });
      let usb = '';
      if (req.body?.usbDevice) {
        if (!a.usbOption) return res.status(400).json({ error: 'Bu uygulamaya aygıt verilemez' });
        const d = validateUsbDevice(req.body.usbDevice);
        if (!d || !fs.existsSync(d)) return res.status(400).json({ error: 'USB aygıtı bulunamadı (/dev/serial/by-id)' });
        if (req.body?.usbConsent !== true) return res.status(400).json({ error: 'USB aygıtını uygulamaya vermeyi onaylayın' });
        usb = d;
      }
      const lanAccess = a.lanAccessOption && req.body?.lanAccess === true;
      // Yeni hesap ayarı yeniden kurulumda korunur (verileri duran kasada kayıtlar kendiliğinden yeniden açılmasın)
      const signups = readAppConf(a.id).signups;
      writeAppConf(a.id, { lanAccess, usbDevice: usb, signups });
      writeFileAtomic(`${CONF_DIR}/${a.id}.env`, renderEnvFile(a, { signups }), 0o600);
      writeFileAtomic(`${CONF_DIR}/pi5-app-${a.id}.container`, renderQuadlet(a, { usbDevice: usb || null }), 0o644);
      const id = await getLanIdentity().catch(() => null);
      const ips = id ? uniq([id.ip, id.transit.ip]).filter(ip => IPV4_RE.test(ip)) : [];
      const r = await launchAppsJob('install', [a.id, '--disk-mb', String(a.diskMB), ...ips.flatMap(ip => ['--lan-ip', ip])], `${a.name} kuruluyor (imaj indiriliyor)`, a.id);
      res.json({ success: true, ...r });
    } catch (e: any) {
      res.status(409).json({ error: e.message });
    }
  });

  app.post('/api/apps/:id/uninstall', async (req, res) => {
    try {
      const a = appIdOf(req.params.id);
      if (!a) return res.status(404).json({ error: 'Uygulama katalogda yok' });
      if (!isLinux) return res.status(400).json({ error: 'Uygulamalar yalnız Pi üzerinde çalışır' });
      const purge = req.body?.purge === true;
      if (purge && String(req.body?.confirm || '').trim() !== a.name) return res.status(400).json({ error: `Verileri silmek için "${a.name}" yazın` });
      // Veri bölümü bağlı değilken veriler silinemez (bağlama noktası SD karttaki boş klasördür)
      if (purge && !dataMounted()) return res.status(409).json({ error: 'Veri diski (klyrix-data) bağlı değil — veriler silinemez; disk bağlanınca yeniden deneyin' });
      if (!installed(a.id) && !(purge && fs.existsSync(`${DATA_ROOT}/apps/${a.id}`))) return res.status(409).json({ error: `${a.name} kurulu değil` });
      const r = await launchAppsJob('uninstall', [a.id, ...(purge ? ['--purge'] : [])], `${a.name} kaldırılıyor${purge ? ' (veriler siliniyor)' : ' (veriler kalır)'}`, a.id);
      res.json({ success: true, ...r });
    } catch (e: any) {
      res.status(409).json({ error: e.message });
    }
  });

  // Express 5: yolda düzenli ifade yok — iki ayrı uç (apps.sh start|stop ID: başlatma yalnız veri diski bağlı ve pi5_apps
  // yüklüyken)
  const startStop = (op: 'start' | 'stop') => async (req: express.Request, res: express.Response) => {
    try {
      const a = appIdOf(req.params.id);
      if (!a) return res.status(404).json({ error: 'Uygulama katalogda yok' });
      if (!isLinux || !installed(a.id) || !engineOn()) return res.status(409).json({ error: `${a.name} kurulu değil` });
      if ((await appsJob()).state === 'running') return res.status(409).json({ error: 'Bir uygulama işi sürüyor — bitince yeniden deneyin' });
      await execFileP('bash', [SCRIPT, op, a.id], { timeout: 330000 }).catch((e: any) => {
        const why = String(e?.stdout || '').match(/error=(.*)/)?.[1] || String(e?.stderr || e?.message || e).trim().split('\n').pop();
        throw new Error(`${a.name} ${op === 'start' ? 'başlatılamadı' : 'durdurulamadı'}: ${why}`);
      });
      await recordEvent('apps', `${a.name} ${op === 'start' ? 'başlatıldı' : 'durduruldu'}`);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  };
  app.post('/api/apps/:id/start', startStop('start'));
  app.post('/api/apps/:id/stop', startStop('stop'));

  // Uygulama anahtarları (yalnız sunan uygulama): "Ev ağına erişim" (varsayılan kapalı) → kural dosyası yeniden üretilir;
  // "Yeni hesap açılabilsin" (Vaultwarden) → ortam dosyası yeniden yazılır, çalışıyorsa uygulama yeniden başlar.
  app.put('/api/apps/:id', async (req, res) => {
    try {
      const a = appIdOf(req.params.id);
      if (!a) return res.status(404).json({ error: 'Uygulama katalogda yok' });
      const { lanAccess, signups } = req.body || {};
      if (lanAccess === undefined && signups === undefined) return res.status(400).json({ error: 'Değiştirilecek ayar yok' });
      if (lanAccess !== undefined && !a.lanAccessOption) return res.status(400).json({ error: 'Bu uygulamada ev ağına erişim anahtarı yok' });
      if (signups !== undefined && !a.signupsOption) return res.status(400).json({ error: 'Bu uygulamada yeni hesap anahtarı yok' });
      if ((lanAccess !== undefined && typeof lanAccess !== 'boolean') || (signups !== undefined && typeof signups !== 'boolean')) {
        return res.status(400).json({ error: 'Ayar değeri true / false olmalı' });
      }
      if (!installed(a.id)) return res.status(409).json({ error: `${a.name} kurulu değil` });
      const cur = readAppConf(a.id);
      const next: AppConf = { ...cur, ...(lanAccess !== undefined ? { lanAccess } : {}), ...(signups !== undefined ? { signups } : {}) };
      writeAppConf(a.id, next);
      if (lanAccess !== undefined && lanAccess !== cur.lanAccess) {
        await reapplyApps(true);
        await recordEvent('apps', `${a.name}: ev ağına erişim ${lanAccess ? 'açıldı' : 'kapatıldı'}`);
      }
      if (signups !== undefined && signups !== cur.signups) {
        writeFileAtomic(`${CONF_DIR}/${a.id}.env`, renderEnvFile(a, { signups }), 0o600);
        if (engineOn()) await execFileP('systemctl', ['try-restart', `pi5-app-${a.id}.service`], { timeout: 120000 }).catch(() => {});
        await recordEvent('apps', `${a.name}: yeni hesap açma ${signups ? 'açıldı' : 'kapatıldı'}`);
      }
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
