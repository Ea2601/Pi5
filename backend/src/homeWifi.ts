// Ev Wi-Fi'ı (net-mode.sh `home`, köprü br0): Pi'nin kendi yayınına bağlı cihazların MAC adresleri. Kesin kaynak
// `iw dev <kart> station dump` (kartla ilişkili istasyonlar); iw kurulu değilse köprünün MAC tablosunda o porttan
// öğrenilen adresler (`bridge fdb`). Ağ haritası bu cihazları ölçümsüz "Wi-Fi" gösterir; "Kalıcı yap" onayı da ancak bu
// yayına bağlı bir cihazdan kabul edilir (yayının gerçekten çalıştığının kanıtı).
import { execFile } from 'child_process';
import util from 'util';

const execFileP = util.promisify(execFile);
const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i;
const IFNAME = /^[A-Za-z0-9_.-]{1,15}$/;

// "Station aa:bb:cc:dd:ee:ff (on wlan0)" satırları.
export function parseStationDump(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^Station ([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b/gim)) out.add(m[1].toLowerCase());
  return out;
}

// "aa:bb:cc:dd:ee:ff dev wlan0 master br0" satırları. Kalıcı (permanent) girişler kartın kendi adresleri, çoklu yayın
// adresleri (33:33:…, 01:00:5e:…) cihaz değildir.
export function parseFdb(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const mac = line.trim().split(/\s+/)[0] || '';
    if (!MAC.test(mac) || /\bpermanent\b/.test(line) || /^(33:33|01:00:5e):/i.test(mac)) continue;
    out.add(mac.toLowerCase());
  }
  return out;
}

export async function readHomeStations(iface: string, bridge: string): Promise<Set<string>> {
  if (!IFNAME.test(iface) || !IFNAME.test(bridge)) return new Set();
  try {
    const { stdout } = await execFileP('iw', ['dev', iface, 'station', 'dump'], { timeout: 4000 });
    return parseStationDump(stdout);
  } catch { /* iw yok ya da kart yayında değil */ }
  try {
    const { stdout } = await execFileP('bridge', ['fdb', 'show', 'br', bridge, 'brport', iface], { timeout: 4000 });
    return parseFdb(stdout);
  } catch {
    return new Set();
  }
}
