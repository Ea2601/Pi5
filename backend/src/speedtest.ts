import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';

const isLinux = os.platform() === 'linux';

// Hız testi — Ookla Speedtest CLI (resmi; kurulum scripts/ookla-ensure.sh). En yakın sunucuyu gecikmeye göre kendisi
// seçer, çoklu bağlantı kullanır, jitter ve paket kaybını gerçekten ölçer. Eskiden Python speedtest-cli kullanılıyordu:
// sunucu listesini Speedtest'in eski servisinden alıyor, o servis BAE bağlantısına yalnız Almanya/Polonya sunucuları
// döndürüyordu (2026-09-28) → Essen gibi uzak sunucu, düşük sonuç; jitter sunucu gecikmesinin kopyası, paket kaybı hep 0'dı.
// Ookla programı yoksa speedtest-cli'ye düşülür (jitter / paket kaybı "bilinmiyor" = null).
// Ekranlar (klyrix_oled.py) "test sürüyor" bilgisini STATE_FILE'dan okur: eskiden `pgrep -f speedtest` kabuk üzerinden
// çalıştığı için kendi kabuğunu da buluyor, ekran hep "SPEEDTEST RUNNING" gösteriyordu.

const OOKLA_BIN = '/usr/local/bin/ookla-speedtest';
const LEGACY_BIN = '/usr/bin/speedtest-cli';
// Ookla programı lisans kabulünü $HOME/.config/ookla'ya yazar; HOME tanımsızken çöküyor (pi5-backend servisinde HOME yok).
const OOKLA_HOME = '/var/lib/pi5-speedtest';
const STATE_DIR = '/run/pi5-speedtest';
const STATE_FILE = `${STATE_DIR}/state`;
const TIMEOUT_MS = 150000;

export type SpeedResult = {
  download_mbps: number; upload_mbps: number; ping_ms: number;
  jitter_ms: number | null; packet_loss: number | null; server: string; isp: string;
};

// Araç kurulu değil (HTTP 503) — diğer hatalar ölçüm hatasıdır.
export class SpeedtestUnavailable extends Error {}

const r1 = (v: number) => Math.round(v * 10) / 10;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// `ookla-speedtest -f json`: her satır bir JSON nesnesi; sonuç "type":"result", hatalar "type":"log","level":"error".
// Hızlar bayt/sn (Mbps = bayt/sn × 8 / 1e6), süreler ms, paket kaybı yüzde (ölçülemezse alan yok).
export function parseOoklaJson(stdout: string): SpeedResult {
  const objs: any[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { objs.push(JSON.parse(t)); } catch { /* yarım satır */ }
  }
  const d = objs.find(o => o?.type === 'result');
  if (!d) {
    const err = [...objs].reverse().find(o => o?.type === 'log' && o?.level === 'error');
    throw new Error(err?.message ? `Ookla: ${err.message}` : 'Ookla sonucu okunamadı');
  }
  const dl = num(d.download?.bandwidth), ul = num(d.upload?.bandwidth), ping = num(d.ping?.latency);
  if (dl === null || ul === null || ping === null) throw new Error('Ookla sonucu eksik (indirme/yükleme/ping yok)');
  const s = d.server || {};
  const where = [s.location, s.country].filter(Boolean);
  const server = [s.name, where.length ? `${where[0]}${where[1] ? ` (${where[1]})` : ''}` : ''].filter(Boolean).join(' — ') || 'Bilinmiyor';
  const jitter = num(d.ping?.jitter), loss = num(d.packetLoss);
  return {
    download_mbps: r1((dl * 8) / 1e6),
    upload_mbps: r1((ul * 8) / 1e6),
    ping_ms: r1(ping),
    jitter_ms: jitter === null ? null : r1(jitter),
    packet_loss: loss === null ? null : Math.round(loss * 100) / 100,
    server,
    isp: typeof d.isp === 'string' && d.isp ? d.isp : 'Bilinmiyor',
  };
}

// speedtest-cli --json: hızlar bit/sn. Jitter ve paket kaybı ölçmez → null (eskiden jitter yerine sunucu gecikmesi,
// paket kaybı yerine 0 yazılıyordu).
export function parseLegacyJson(stdout: string): SpeedResult {
  const d = JSON.parse(stdout);
  const s = d.server || {};
  return {
    download_mbps: r1(Number(d.download) / 1e6),
    upload_mbps: r1(Number(d.upload) / 1e6),
    ping_ms: r1(Number(d.ping)),
    jitter_ms: null,
    packet_loss: null,
    server: `speedtest-cli: ${s.sponsor ? `${s.sponsor} — ${s.name}` : 'Bilinmiyor'}${s.cc ? ` (${s.cc})` : ''}`,
    isp: d.client?.isp || 'Bilinmiyor',
  };
}

// Kabuksuz çalıştırma: zaman aşımında sinyal doğrudan programa gider (kabuk ara katmanı yok → arkada süreç kalmaz).
function execTool(bin: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      const e: any = err;
      if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new Error('Hız testi çıktısı sınırı aştı'));
      if (e.killed) return reject(new Error(`Hız testi ${TIMEOUT_MS / 1000} sn içinde bitmedi`));
      if (e.signal) return reject(new Error(`Hız testi programı çöktü (${e.signal})`));
      // Ookla hata iletisini stdout'a JSON "log" satırı olarak yazar; yoksa stderr'in son satırı.
      try { parseOoklaJson(String(stdout)); } catch (pe: any) { if (/^Ookla: /.test(pe.message)) return reject(pe); }
      const last = String(stderr || '').trim().split('\n').pop() || e.message;
      reject(new Error(`Hız testi başarısız: ${last.slice(0, 300)}`));
    });
  });
}

function markRunning(engine: string) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, `running=1\nstarted=${Math.floor(Date.now() / 1000)}\nengine=${engine}\n`);
  } catch { /* ekran göstergesi — ölçümü engellemez */ }
}
function clearRunning() {
  try { fs.unlinkSync(STATE_FILE); } catch { /* yok */ }
}
// Backend ölçüm sırasında çöktüyse kalan durum dosyası silinir (ekran "sürüyor"da takılmasın).
if (isLinux) clearRunning();

// Tek ölçüm; aynı anda iki ölçümün önlenmesi çağıranın işidir (index.ts measureAndStore).
export async function runSpeedTest(): Promise<SpeedResult> {
  if (!isLinux) throw new SpeedtestUnavailable('Hız testi yalnız Pi üzerinde çalışır');
  const ookla = fs.existsSync(OOKLA_BIN);
  if (!ookla && !fs.existsSync(LEGACY_BIN)) {
    throw new SpeedtestUnavailable('Hız testi programı kurulu değil — Ayarlar → Güncelle ile Ookla Speedtest kurulur');
  }
  markRunning(ookla ? 'ookla' : 'speedtest-cli');
  try {
    if (ookla) {
      fs.mkdirSync(OOKLA_HOME, { recursive: true });
      const out = await execTool(OOKLA_BIN, ['--accept-license', '--accept-gdpr', '-f', 'json', '-p', 'no'],
        { ...process.env, HOME: OOKLA_HOME });
      return parseOoklaJson(out);
    }
    return parseLegacyJson(await execTool(LEGACY_BIN, ['--json']));
  } finally {
    clearRunning();
  }
}
