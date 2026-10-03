// İnternet kartı (WAN router, R3): port yönlendirme — internetten Pi'nin dış adresine gelen bağlantıyı ev ağındaki bir
// cihaza iletir (oyun konsolu, NAS, kamera). Bağlantının kendisi (profiller, deneme / onay, pi5_wan / pi5_wan_nat
// güvenlik duvarı) scripts/net-mode.sh `wan`'dadır.
//  - Kayıtlar panelin tablosunda (port_forwards) durur; yalnız internet kartı açıkken (ev ağı yalnız ev ağına çevrilmiş,
//    wan_lan=1) uygulanır: ip pi5_wan_fwd (prerouting, dstnat) → /etc/nftables.d/pi5-wan-fwd.conf. İletim izni net-mode'un
//    pi5_wan tablosunda (ct status dnat). WAN kapalıyken tablo kaldırılır, kayıtlar durur.
//  - Hedef yalnız ev ağındaki (client ağı) bir cihaz adresi; dış port tek ya da aralık. İç port yalnız tek portta
//    verilebilir (verilmezse dış portla aynı); aralıkta portlar olduğu gibi iletilir.
//  - UPnP yok (kullanıcı kararı): portlar yalnız panelden açılır. UDP 51820 Ev VPN'ine, UDP 51821 şubeler arası SD-WAN
//    merkezine (Pi, sdwan.ts) ayrılmıştır.
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dbAll, dbGet, dbRun, dbInsert } from './db';
import { isLinux, readNetModeState, wanActive, uplinkIfaces } from './system';

const execFileP = promisify(execFile);
export const FWD_NFT = '/etc/nftables.d/pi5-wan-fwd.conf';
// Pi'nin kendi dinlediği WireGuard portları: Ev VPN'i (wg_pi) ve SD-WAN merkezi (wg_s2s0) — yönlendirilemez.
const RESERVED_UDP = [51820, 51821];
const RESERVED_LABEL: Record<number, string> = { 51820: "Ev VPN'ine", 51821: 'şubeler arası SD-WAN merkezine' };
const MAX_RANGE = 1000;

export type FwdProto = 'tcp' | 'udp' | 'both';
export interface PortForward {
  id: number; name: string; proto: FwdProto; ext_from: number; ext_to: number; dest_ip: string; dest_port: number | null;
  enabled: number; created_at?: string;
}
export type ForwardInput = Pick<PortForward, 'name' | 'proto' | 'ext_from' | 'ext_to' | 'dest_ip' | 'dest_port'>;

let tablesReady: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  tablesReady ??= dbRun(`CREATE TABLE IF NOT EXISTS port_forwards (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', proto TEXT NOT NULL,
      ext_from INTEGER NOT NULL, ext_to INTEGER NOT NULL, dest_ip TEXT NOT NULL, dest_port INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`)
    .catch(e => { tablesReady = null; throw e; });
  return tablesReady;
}

// ─── Saf yardımcılar (test edilir) ───
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const isIpv4 = (s: string) => { const m = IPV4.exec(s); return !!m && m.slice(1).every(o => Number(o) <= 255); };
const ipNum = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const portOk = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 65535;
const protoSet = (p: FwdProto): ('tcp' | 'udp')[] => (p === 'both' ? ['tcp', 'udp'] : [p]);

// Girdi doğrulaması. client = ev ağı ("192.168.0.1/24"): hedef bu ağda, ağ / yayın / Pi'nin adresi değil.
// existing: aynı protokolde dış port aralığı çakışmasın (kendi kaydı hariç: exceptId).
export function validateForward(input: any, client: string, existing: PortForward[], exceptId?: number):
  { ok: true; value: ForwardInput } | { ok: false; error: string } {
  const name = typeof input?.name === 'string' ? input.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '';
  const proto = input?.proto;
  if (proto !== 'tcp' && proto !== 'udp' && proto !== 'both') return { ok: false, error: 'Protokol TCP, UDP ya da ikisi olmalı' };
  const ext_from = Number(input?.ext_from);
  const ext_to = input?.ext_to === undefined || input?.ext_to === null || input?.ext_to === '' ? ext_from : Number(input.ext_to);
  if (!portOk(ext_from) || !portOk(ext_to)) return { ok: false, error: 'Dış port 1-65535 arasında olmalı' };
  if (ext_to < ext_from) return { ok: false, error: 'Port aralığının sonu başından küçük olamaz' };
  if (ext_to - ext_from + 1 > MAX_RANGE) return { ok: false, error: `Port aralığı en çok ${MAX_RANGE} port olabilir` };
  const rawDp = input?.dest_port;
  const dest_port = rawDp === undefined || rawDp === null || rawDp === '' ? null : Number(rawDp);
  if (dest_port !== null && !portOk(dest_port)) return { ok: false, error: 'İç port 1-65535 arasında olmalı' };
  if (dest_port !== null && ext_to !== ext_from) return { ok: false, error: 'Port aralığında iç port verilemez (portlar olduğu gibi iletilir)' };
  const dest_ip = String(input?.dest_ip || '').trim();
  if (!isIpv4(dest_ip)) return { ok: false, error: 'Hedef cihazın adresi geçersiz (ör. 192.168.0.50)' };
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(client || '');
  if (!m || !isIpv4(m[1])) return { ok: false, error: 'Ev ağı bilinmiyor (sabit adres kaydı yok)' };
  const prefix = Number(m[2]);
  const div = 2 ** (32 - prefix);
  const net = Math.floor(ipNum(m[1]) / div) * div;
  const n = ipNum(dest_ip);
  if (Math.floor(n / div) * div !== net) return { ok: false, error: `Hedef ev ağında (${client}) olmalı` };
  if (n === net || n === net + div - 1) return { ok: false, error: 'Hedef ağ ya da yayın adresi olamaz' };
  if (dest_ip === m[1]) return { ok: false, error: "Hedef Pi'nin kendisi olamaz" };
  const reserved = proto !== 'tcp' ? RESERVED_UDP.find(p => p >= ext_from && p <= ext_to) : undefined;
  if (reserved !== undefined) {
    return { ok: false, error: `UDP ${reserved} ${RESERVED_LABEL[reserved]} (Pi) ayrılmıştır` };
  }
  for (const e of existing) {
    if (e.id === exceptId) continue;
    const shared = protoSet(proto).some(p => protoSet(e.proto).includes(p));
    if (shared && ext_from <= e.ext_to && e.ext_from <= ext_to) {
      return { ok: false, error: `Dış port ${e.ext_from === e.ext_to ? e.ext_from : `${e.ext_from}-${e.ext_to}`} zaten yönlendiriliyor${e.name ? ` (${e.name})` : ''}` };
    }
  }
  return { ok: true, value: { name, proto, ext_from, ext_to, dest_ip, dest_port } };
}

// nft dosyası: boş-tanımla → sil → yeniden-tanımla (idempotent). Kural yoksa ya da internet kartı kapalıysa yalnız siler.
export function buildFwdNft(rules: PortForward[], wanIfs: string[]): string {
  const head = ['table ip pi5_wan_fwd {}', 'delete table ip pi5_wan_fwd'];
  const on = rules.filter(r => r.enabled);
  if (!wanIfs.length || !on.length) return head.join('\n') + '\n';
  const ifs = `{ ${wanIfs.map(i => `"${i}"`).join(', ')} }`;
  const lines: string[] = [];
  for (const r of on) {
    const dport = r.ext_from === r.ext_to ? `${r.ext_from}` : `${r.ext_from}-${r.ext_to}`;
    const to = r.dest_port ? `${r.dest_ip}:${r.dest_port}` : r.dest_ip;
    for (const p of protoSet(r.proto)) lines.push(`        iifname ${ifs} ${p} dport ${dport} dnat to ${to}`);
  }
  return [...head, 'table ip pi5_wan_fwd {', '    chain prerouting {',
    '        type nat hook prerouting priority dstnat; policy accept;', ...lines, '    }', '}'].join('\n') + '\n';
}

// ─── Kayıtlar ───
export async function listForwards(): Promise<PortForward[]> {
  await ensureTables();
  return (await dbAll('SELECT * FROM port_forwards ORDER BY ext_from, id')) as PortForward[];
}

function clientNet(): string {
  return readNetModeState()?.client || '';
}

export async function addForward(input: any): Promise<PortForward> {
  const v = validateForward(input, clientNet(), await listForwards());
  if (!v.ok) throw Object.assign(new Error(v.error), { status: 400 });
  const x = v.value;
  const id = await dbInsert('INSERT INTO port_forwards (name, proto, ext_from, ext_to, dest_ip, dest_port, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)',
    [x.name, x.proto, x.ext_from, x.ext_to, x.dest_ip, x.dest_port]);
  await applyPortForwards();
  return (await dbGet('SELECT * FROM port_forwards WHERE id = ?', [id])) as PortForward;
}

export async function setForwardEnabled(id: number, enabled: boolean): Promise<void> {
  await ensureTables();
  const row = (await dbGet('SELECT * FROM port_forwards WHERE id = ?', [id])) as PortForward | undefined;
  if (!row) throw Object.assign(new Error('Kayıt bulunamadı'), { status: 404 });
  if (enabled) {
    // Kapalıyken eklenen başka bir kayıtla çakışıyor olabilir.
    const v = validateForward(row, clientNet(), await listForwards(), id);
    if (!v.ok) throw Object.assign(new Error(v.error), { status: 400 });
  }
  await dbRun('UPDATE port_forwards SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
  await applyPortForwards();
}

// Yedekten geri yükleme: her satır elle eklenmiş gibi doğrulanır (bozuk / elle düzenlenmiş yedek nft kuralına karışmasın);
// geçersiz ya da öncekilerle çakışan satır atlanır, açık / kapalı durumu korunur. Ev ağı bilinmiyorsa (sabit adres kaydı
// yok) hiçbiri doğrulanamaz: error döner, tablo geri yüklenmez (mevcutlar kalır). Tablo burada (işlemden önce) kurulur.
export async function prepareForwardRestore(rows: any[]): Promise<{ rows: Omit<PortForward, 'id'>[]; skipped: number; error?: string }> {
  await ensureTables();
  const client = clientNet();
  if (rows.length && !client) return { rows: [], skipped: 0, error: 'ev ağı (sabit adres kaydı) bilinmiyor' };
  const ok: PortForward[] = [];
  let skipped = 0;
  for (const row of rows) {
    const v = row && typeof row === 'object' ? validateForward(row, client, ok) : null;
    if (!v || !v.ok) { skipped++; continue; }
    ok.push({ id: -1 - ok.length, ...v.value, enabled: Number(row.enabled ?? 1) ? 1 : 0 });
  }
  return { rows: ok.map(({ id: _id, ...r }) => r), skipped };
}

export async function deleteForward(id: number): Promise<void> {
  await ensureTables();
  await dbRun('DELETE FROM port_forwards WHERE id = ?', [id]);
  await applyPortForwards();
}

// Kuralları uygular (internet kartı açılınca / kapanınca, kayıt değişince, açılışta, nftables yeniden başlatılınca).
// Hata fırlatmaz: sonucu döner (ağ işlemlerini bozmasın).
export async function applyPortForwards(): Promise<{ applied: number; error?: string }> {
  if (!isLinux) return { applied: 0 };
  let rules: PortForward[] = [];
  try { rules = await listForwards(); } catch (e: any) { return { applied: 0, error: e?.message || String(e) }; }
  const ns = readNetModeState();
  // Ana hat + yedek hat (yedek hat devredeyken ve açık IP'liyse yönlendirmeler ondan da çalışır).
  const ifs = wanActive(ns) && ns.wanLan ? uplinkIfaces(ns) : [];
  const text = buildFwdNft(rules, ifs);
  const applied = ifs.length ? rules.filter(r => r.enabled).length : 0;
  try {
    fs.mkdirSync('/etc/nftables.d', { recursive: true });
    fs.writeFileSync(`${FWD_NFT}.tmp`, text);
    fs.renameSync(`${FWD_NFT}.tmp`, FWD_NFT);
    await execFileP('nft', ['-f', FWD_NFT], { timeout: 10000 });
    // Uygulanacak kural yoksa dosya da kalkar (açılışta boşuna yüklenmesin).
    if (!applied) fs.rmSync(FWD_NFT, { force: true });
    return { applied };
  } catch (e: any) {
    const error = String(e?.stderr || e?.message || e).trim();
    console.error(`[wan] port yönlendirme (pi5_wan_fwd) uygulanamadı: ${error}`);
    return { applied: 0, error };
  }
}
