// Cihaz rolü (R2): ana cihaz (ağ geçidi) ya da mesh uydusu. /etc/pi5-gateway/role ("role=main|satellite"), install.sh
// ilk kurulumda yazar, panel (Cihaz Rolleri → Uydular) değiştirir. Dosya yoksa ana cihaz — rol özelliğinden önceki
// kurulumlar aynen çalışır. Açılışta bir kez okunur: rol değişince backend yeniden başlatılır (index.ts /api/system/role).
import fs from 'fs';

export type DeviceRole = 'main' | 'satellite';
export const ROLE_FILE = '/etc/pi5-gateway/role';

export function readRole(file = ROLE_FILE): DeviceRole {
  try {
    const m = /^role=(\w+)\s*$/m.exec(fs.readFileSync(file, 'utf8'));
    return m?.[1] === 'satellite' ? 'satellite' : 'main';
  } catch {
    return 'main';
  }
}

export function writeRole(role: DeviceRole, file = ROLE_FILE): void {
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `role=${role}\n`, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

export const STARTUP_ROLE: DeviceRole = readRole();
export const isSatellite = (): boolean => STARTUP_ROLE === 'satellite';
