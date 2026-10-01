import { NodeSSH } from 'node-ssh';
import * as fs from 'fs';
import * as path from 'path';
import { shq } from './util';

const configDir = path.resolve(__dirname, '../../core');
const isLinux = process.platform === 'linux';

interface VpsConnectOptions {
  ip: string;
  username: string;
  password?: string;
  privateKeyPath?: string;
}

// ─── VPS wg0.conf blokları ───
// Bloklar [Interface] / [Peer] başlığıyla başlar; bir bloğun hemen üstündeki yorum ("# ad") ve boş satırlar o bloğa aittir.
// mode=remove: PublicKey'i `key` olan ya da AllowedIPs'inde `aip` bulunan [Peer] bloğu (yorumuyla) atılır, gerisi aynen
// yazılır. mode=peers: yalnız [Peer] blokları yazılır (kurulum yinelenirken eşler korunsun). Ad eşleşmesi YOK: eskiden
// `sed '/# ad/,/^$/d'` alt dizi eşleşmesiyle "Pi" adlı istemci silinince "# Pi5-Gateway" bloğu da gidiyordu. mawk / gawk.
export const WG_BLOCKS_AWK = String.raw`
function keep() { if (mode == "peers") return hdr == "[Peer]"; return !(hdr == "[Peer]" && hit) }
function emit() { if (cur != "" && keep()) printf "%s", cur; cur = ""; hdr = ""; hit = 0 }
{
  t = $0; sub(/^[ \t]+/, "", t); sub(/[ \t\r]+$/, "", t)
  if (substr(t, 1, 1) == "[") { emit(); cur = pend $0 "\n"; pend = ""; hdr = t; next }
  if (t == "" || substr(t, 1, 1) == "#") { pend = pend $0 "\n"; next }
  cur = cur pend $0 "\n"; pend = ""
  if (hdr != "[Peer]") next
  k = t; sub(/[ \t]*=.*$/, "", k); v = t; sub(/^[^=]*=[ \t]*/, "", v)
  if (k == "PublicKey" && key != "" && v == key) hit = 1
  if (k == "AllowedIPs" && aip != "") { n = split(v, a, /[ \t]*,[ \t]*/); for (i = 1; i <= n; i++) if (a[i] == aip) hit = 1 }
}
END { emit(); if (mode != "peers") printf "%s", pend }
`;
// VPS'te çalışır (bash -s -- KEY AIP AWK): önce yedek (wg0.conf.bak-<zaman>, son 5 tutulur), sonra eş atılır ve sonuç
// doğrulanır — [Interface] duruyor, eş sayısı tam 1 azaldı, (Pi'nin kendi eşi silinmiyorsa) Pi eşi (10.66.66.2/32)
// yerinde. Tutmazsa dosyaya dokunulmaz. Çıktı: result=removed|notfound|failed, detail=...
export const WG_REMOVE_PEER_SH = String.raw`set -u
KEY=$1; AIP=$2; AWKP=$3
F=/etc/wireguard/wg0.conf
PI=10.66.66.2/32
if [ ! -f "$F" ]; then echo "result=notfound"; echo "detail=wg0.conf yok"; exit 0; fi
TS=$(date +%s)
if ! cp -p "$F" "$F.bak-$TS"; then echo "result=failed"; echo "detail=yedek alınamadı"; exit 0; fi
ls -1t "$F".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f --
if ! awk -v mode=remove -v key="$KEY" -v aip="$AIP" "$AWKP" "$F" > "$F.tmp"; then
  rm -f "$F.tmp"; echo "result=failed"; echo "detail=wg0.conf işlenemedi"; exit 0
fi
b=$(grep -c '^[[:space:]]*\[Peer\]' "$F"); a=$(grep -c '^[[:space:]]*\[Peer\]' "$F.tmp"); i=$(grep -c '^[[:space:]]*\[Interface\]' "$F.tmp")
pat='^[[:space:]]*AllowedIPs[[:space:]]*=[[:space:]]*10\.66\.66\.2/32[[:space:]]*$'
pb=$(grep -cE "$pat" "$F"); pa=$(grep -cE "$pat" "$F.tmp")
if [ "$a" -eq "$b" ]; then rm -f "$F.tmp"; echo "result=notfound"; echo "detail=eş wg0.conf'ta yok"; exit 0; fi
if [ "$i" -ne 1 ] || [ "$a" -ne $((b - 1)) ] || { [ "$AIP" != "$PI" ] && [ "$pa" -ne "$pb" ]; }; then
  rm -f "$F.tmp"
  echo "result=failed"; echo "detail=doğrulama tutmadı (eş $b→$a, [Interface] $i, Pi eşi $pb→$pa) — wg0.conf değiştirilmedi"; exit 0
fi
if chmod 600 "$F.tmp" && mv -f "$F.tmp" "$F"; then echo "result=removed"; echo "detail=yedek: $F.bak-$TS"; exit 0; fi
rm -f "$F.tmp"; echo "result=failed"; echo "detail=wg0.conf yazılamadı"
`;
export interface PeerRemoval { result: 'removed' | 'notfound' | 'failed'; detail: string }
async function removePeerFromConfig(ssh: NodeSSH, sel: { publicKey?: string; allowedIp?: string }): Promise<PeerRemoval> {
  const r = await ssh.execCommand(`bash -s -- ${shq(sel.publicKey || '')} ${shq(sel.allowedIp || '')} ${shq(WG_BLOCKS_AWK)}`,
    { stdin: WG_REMOVE_PEER_SH });
  const kv: Record<string, string> = {};
  for (const line of String(r.stdout || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const result = kv.result === 'removed' || kv.result === 'notfound' ? kv.result : 'failed';
  return { result, detail: kv.detail || String(r.stderr || '').trim().slice(0, 200) || 'VPS yanıt vermedi' };
}
/**
 * VPS'ten bir WireGuard istemcisini açık anahtarıyla siler: çalışan arayüzden (wg set … remove) ve wg0.conf'tan
 * (yedekli, doğrulamalı — bkz. WG_REMOVE_PEER_SH). SSH hatası fırlatılır.
 */
export async function removeWireGuardClient(opts: VpsConnectOptions, publicKey: string): Promise<PeerRemoval> {
  const ssh = await connectSSH(opts);
  try {
    await ssh.execCommand(`wg set wg0 peer ${shq(publicKey)} remove 2>/dev/null || true`);
    return await removePeerFromConfig(ssh, { publicKey });
  } finally {
    try { ssh.dispose(); } catch { /* */ }
  }
}

// VPS panelden silinirken panelin eklediği istemciler tek SSH oturumunda kaldırılır (kayıtları silinince panel onları artık
// göstermez / silemez; kalırlarsa ör. kaybolan telefon bağlanmayı sürdürürdü). İlk başarısızlıkta durur.
export async function removeWireGuardClients(opts: VpsConnectOptions, publicKeys: string[]): Promise<PeerRemoval[]> {
  const ssh = await connectSSH(opts);
  const out: PeerRemoval[] = [];
  try {
    for (const key of publicKeys) {
      await ssh.execCommand(`wg set wg0 peer ${shq(key)} remove 2>/dev/null || true`);
      const r = await removePeerFromConfig(ssh, { publicKey: key });
      out.push(r);
      if (r.result === 'failed') break;
    }
    return out;
  } finally {
    try { ssh.dispose(); } catch { /* */ }
  }
}

/**
 * Connect to VPS via SSH — supports password and/or private key auth
 */
// Kurulum yolu (bağlantı testi + kurulum adımları) sabırlı bağlanır: yeni kurulmuş (reinstall) VPS ilk dakikalarda SSH
// anahtarlarını üretip sshd'yi yeniden başlatır, ilk açılış işleri el sıkışmayı yavaşlatır — eskiden tek deneme / 15 sn,
// ilk deneme düşüyordu. Kurulumda 30 sn, ağ hatasında 5 ve 15 sn sonra yeniden; şifre / anahtar hatası yeniden denenmez.
// Diğer işlemler (istemci ekle / sil …) eskisi gibi tek deneme / 15 sn: ulaşılamayan VPS'te panel uzun beklemesin.
const isAuthError = (e: any) => e?.level === 'client-authentication' || /authentication methods failed/i.test(String(e?.message || ''));
const SETUP_RETRY_WAITS_MS = [5000, 15000];
async function connectSSH(opts: VpsConnectOptions, patient = false): Promise<NodeSSH> {
  const ssh = new NodeSSH();
  const connectOpts: Record<string, unknown> = {
    host: opts.ip,
    username: opts.username,
    readyTimeout: patient ? 30000 : 15000,
  };

  // Try password auth if provided
  if (opts.password) {
    connectOpts.password = opts.password;
  }

  // Try private key if provided and file exists
  if (opts.privateKeyPath && fs.existsSync(opts.privateKeyPath)) {
    connectOpts.privateKeyPath = opts.privateKeyPath;
  }

  // If neither password nor valid key, try default key locations
  if (!opts.password && !connectOpts.privateKeyPath) {
    const defaultKeys = [
      path.join(process.env.HOME || '/root', '.ssh/id_rsa'),
      path.join(process.env.HOME || '/root', '.ssh/id_ed25519'),
    ];
    for (const keyPath of defaultKeys) {
      if (fs.existsSync(keyPath)) {
        connectOpts.privateKeyPath = keyPath;
        break;
      }
    }
  }

  const waits = patient ? SETUP_RETRY_WAITS_MS : [];
  for (let attempt = 0; ; attempt++) {
    const conn = attempt ? new NodeSSH() : ssh;
    try {
      await conn.connect(connectOpts);
      return conn;
    } catch (e: any) {
      try { conn.dispose(); } catch { /* */ }
      if (isAuthError(e) || attempt >= waits.length) throw e;
      await new Promise(r => setTimeout(r, waits[attempt]));
    }
  }
}

/**
 * Test SSH connection only — returns true if connection succeeds
 */
export async function testSSHConnection(opts: VpsConnectOptions): Promise<{ success: boolean; message: string }> {
  try {
    const ssh = await connectSSH(opts, true);
    const result = await ssh.execCommand('echo "connection_ok" && uname -a');
    ssh.dispose();
    return { success: true, message: result.stdout.trim() };
  } catch (err: any) {
    return { success: false, message: err.message || 'Bağlantı başarısız' };
  }
}

/**
 * Execute a setup step on the VPS
 */
export async function executeSetupStep(
  opts: VpsConnectOptions,
  step: string
): Promise<{ status: 'success' | 'error'; message: string; duration: string }> {
  // SSH to VPS works from any platform
  const startTime = Date.now();
  try {
    const ssh = await connectSSH(opts, true);
    let cmd = '';
    let successMsg = '';
    let failMsg = 'Adım başarısız';

    switch (step) {
      case 'connection':
        cmd = 'echo "ok" && uptime';
        successMsg = 'SSH bağlantısı başarılı';
        break;
      case 'update':
        cmd = `
          export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
          set -o pipefail
          # Yeni kurulmuş VPS: ilk açılış işleri (cloud-init) ve otomatik güncellemeler paket yöneticisini kilitler —
          # eskiden apt anında düşüyor, adım yine "başarılı" görünüyordu. İlk açılış beklenir, apt kilidi 10 dk beklenir.
          if command -v cloud-init >/dev/null 2>&1; then timeout 600 cloud-init status --wait >/dev/null 2>&1 || true; fi
          APT="apt-get -o DPkg::Lock::Timeout=600"
          $APT update -qq && $APT upgrade -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" 2>&1 | tail -5
        `;
        successMsg = 'Sistem güncellendi';
        failMsg = 'Sistem güncellenemedi';
        break;
      case 'packages':
        // resolvconf kurulmaz: sunucunun wg0.conf'unda DNS satırı yok; Ubuntu'da systemd-resolved ile çakışıp VPS'in DNS'ini
        // bozuyordu (sonraki apt işlemleri takılıyordu).
        cmd = `
          export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
          set -o pipefail
          # Yeni kurulmuş VPS: ilk açılış işleri (cloud-init) ve otomatik güncellemeler paket yöneticisini kilitler —
          # eskiden apt anında düşüyor, adım yine "başarılı" görünüyordu. İlk açılış beklenir, apt kilidi 10 dk beklenir.
          if command -v cloud-init >/dev/null 2>&1; then timeout 600 cloud-init status --wait >/dev/null 2>&1 || true; fi
          APT="apt-get -o DPkg::Lock::Timeout=600"
          $APT install -y -qq wireguard wireguard-tools qrencode iptables curl iptables-persistent 2>&1 | tail -5
          MISSING=""
          for c in wg wg-quick iptables qrencode curl; do command -v "$c" >/dev/null 2>&1 || MISSING="$MISSING $c"; done
          if [ -n "$MISSING" ]; then echo "Kurulamayan:$MISSING" >&2; exit 1; fi
          echo "Tum paketler kurulu"
        `;
        successMsg = 'WireGuard ve bağımlılıklar kuruldu';
        failMsg = 'Paketler kurulamadı';
        break;
      case 'maintenance':
        // set -e yok: IPv6'sız VPS'te sysctl'in ipv6 satırı hata verip betiği NAT'tan önce kesiyordu. Sonda forward ve NAT
        // gerçekten açık mı denetlenir.
        cmd = `
          # 1. Verify internet connectivity
          echo "--- Internet baglanti kontrolu ---"
          if ! ping -c 1 -W 3 8.8.8.8 &>/dev/null; then
            echo "UYARI: VPS internete cikamıyor! Ağ ayarları kontrol ediliyor..."
            # Check and fix DNS
            if ! grep -q "nameserver" /etc/resolv.conf 2>/dev/null; then
              echo "nameserver 8.8.8.8" >> /etc/resolv.conf
              echo "nameserver 1.1.1.1" >> /etc/resolv.conf
              echo "DNS eklendi"
            fi
            # Check default route
            if ! ip route show default &>/dev/null; then
              echo "HATA: Default route yok — VPS ağ yapılandırması bozuk"
            fi
          else
            echo "Internet baglantisi OK"
          fi

          # 2. IP forwarding (critical for VPN traffic)
          echo "--- IP forwarding ---"
          echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-wireguard.conf
          echo "net.ipv6.conf.all.forwarding=1" >> /etc/sysctl.d/99-wireguard.conf
          sysctl -p /etc/sysctl.d/99-wireguard.conf 2>&1 || true
          # Verify
          FWD=$(cat /proc/sys/net/ipv4/ip_forward)
          echo "ip_forward=$FWD"
          if [ "$FWD" != "1" ]; then
            echo 1 > /proc/sys/net/ipv4/ip_forward
          fi

          # 3. NAT / Masquerade (ensure iptables rules exist)
          PRIMARY_IFACE=$(ip -o -4 route show to default | awk '{print $5}' | head -1)
          if [ -z "$PRIMARY_IFACE" ]; then PRIMARY_IFACE="eth0"; fi
          echo "Primary interface: $PRIMARY_IFACE"

          # Add masquerade if not already present
          if ! iptables -t nat -C POSTROUTING -o "$PRIMARY_IFACE" -j MASQUERADE 2>/dev/null; then
            iptables -t nat -A POSTROUTING -o "$PRIMARY_IFACE" -j MASQUERADE
            echo "NAT masquerade eklendi: $PRIMARY_IFACE"
          else
            echo "NAT masquerade zaten aktif"
          fi

          # Forward rules
          iptables -A FORWARD -i wg0 -j ACCEPT 2>/dev/null || true
          iptables -A FORWARD -o wg0 -j ACCEPT 2>/dev/null || true

          # 4. Firewall (UFW)
          if command -v ufw &>/dev/null; then
            ufw allow 51820/udp 2>/dev/null || true
            ufw allow OpenSSH 2>/dev/null || true
            sed -i 's/DEFAULT_FORWARD_POLICY="DROP"/DEFAULT_FORWARD_POLICY="ACCEPT"/' /etc/default/ufw 2>/dev/null || true
            # Ensure NAT rules in UFW before.rules
            if ! grep -q "POSTROUTING.*MASQUERADE" /etc/ufw/before.rules 2>/dev/null; then
              sed -i '/^# End required lines/a\\n# NAT for WireGuard\\n*nat\\n:POSTROUTING ACCEPT [0:0]\\n-A POSTROUTING -o '"$PRIMARY_IFACE"' -j MASQUERADE\\nCOMMIT' /etc/ufw/before.rules 2>/dev/null || true
            fi
            ufw --force enable 2>/dev/null || true
            ufw reload 2>/dev/null || true
            echo "UFW yapılandırıldı"
          else
            echo "UFW yok, iptables kullanılıyor"
          fi

          # 5. Make iptables rules persistent
          if command -v netfilter-persistent &>/dev/null; then
            netfilter-persistent save 2>/dev/null || true
          elif command -v iptables-save &>/dev/null; then
            iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
          fi

          if [ "$(cat /proc/sys/net/ipv4/ip_forward)" != "1" ]; then echo "IP forwarding açılamadı" >&2; exit 1; fi
          if ! iptables -t nat -C POSTROUTING -o "$PRIMARY_IFACE" -j MASQUERADE 2>/dev/null; then
            echo "NAT (MASQUERADE) kuralı eklenemedi: $PRIMARY_IFACE" >&2; exit 1
          fi
          echo "--- Tüm ayarlar tamamlandı ---"
        `;
        successMsg = 'Internet, IP forwarding, NAT ve firewall ayarlandı';
        failMsg = 'Ağ ayarları (forward / NAT) yapılamadı';
        break;
      case 'wireguard':
        cmd = `
          command -v wg >/dev/null 2>&1 || { echo "wg komutu yok (paket kurulumu başarısız)" >&2; exit 1; }
          # Detect primary network interface (not lo, wg, docker, veth)
          PRIMARY_IFACE=$(ip -o -4 route show to default | awk '{print $5}' | head -1)
          if [ -z "$PRIMARY_IFACE" ]; then PRIMARY_IFACE="eth0"; fi
          echo "Network interface: $PRIMARY_IFACE"

          # Kurulum yineleniyorsa (wg0.conf var): yedek alınır, sunucu anahtarı ve eşler (istemciler + Pi) KORUNUR —
          # anahtar yeniden üretilirse bütün istemcilerin yapılandırması geçersiz olur. Yalnız [Interface] yeniden yazılır.
          WGF=/etc/wireguard/wg0.conf
          WG_PEERS=""
          SERVER_PRIV=""
          if [ -f "$WGF" ] && grep -q '^[[:space:]]*PrivateKey' "$WGF"; then
            cp -p "$WGF" "$WGF.bak-$(date +%s)"
            ls -1t "$WGF".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f --
            SERVER_PRIV=$(grep -m1 '^[[:space:]]*PrivateKey' "$WGF" | cut -d'=' -f2- | tr -d ' ')
            WG_PEERS=$(awk -v mode=peers ${shq(WG_BLOCKS_AWK)} "$WGF")
            echo "Mevcut wg0.conf korunuyor (anahtar + $(printf '%s\\n' "$WG_PEERS" | grep -c '^[[:space:]]*\\[Peer\\]') eş)"
          fi
          [ -n "$SERVER_PRIV" ] || SERVER_PRIV=$(wg genkey)
          SERVER_PUB=$(echo "$SERVER_PRIV" | wg pubkey)
          [ -n "$SERVER_PUB" ] || { echo "Sunucu anahtarı üretilemedi" >&2; exit 1; }

          # Get public IP — try curl, wget, hostname fallback
          SERVER_IP=""
          if command -v curl &>/dev/null; then
            SERVER_IP=$(curl -s4 --max-time 5 ifconfig.me 2>/dev/null || curl -s4 --max-time 5 icanhazip.com 2>/dev/null)
          fi
          if [ -z "$SERVER_IP" ] && command -v wget &>/dev/null; then
            SERVER_IP=$(wget -qO- --timeout=5 ifconfig.me 2>/dev/null || wget -qO- --timeout=5 icanhazip.com 2>/dev/null)
          fi
          if [ -z "$SERVER_IP" ]; then
            SERVER_IP=$(hostname -I | awk '{print $1}')
          fi
          if [ -z "$SERVER_IP" ]; then echo "HATA: Server IP alinamadi"; exit 1; fi

          mkdir -p /etc/wireguard
          cat > /etc/wireguard/wg0.conf << WGEOF
[Interface]
Address = 10.66.66.1/24
ListenPort = 51820
PrivateKey = $SERVER_PRIV
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o $PRIMARY_IFACE -j MASQUERADE; iptables -A FORWARD -o wg0 -j ACCEPT
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o $PRIMARY_IFACE -j MASQUERADE; iptables -D FORWARD -o wg0 -j ACCEPT
WGEOF
          if [ -n "$WG_PEERS" ]; then printf '\\n%s\\n' "$WG_PEERS" >> /etc/wireguard/wg0.conf; fi

          chmod 600 /etc/wireguard/wg0.conf
          systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
          if ! systemctl restart wg-quick@wg0; then
            echo "wg-quick@wg0 başlatılamadı:" >&2
            journalctl -u wg-quick@wg0 -n 6 --no-pager 2>/dev/null | sed 's/^/  /' >&2
            exit 1
          fi
          echo "SERVER_PUB=$SERVER_PUB SERVER_IP=$SERVER_IP IFACE=$PRIMARY_IFACE"
        `;
        successMsg = 'WireGuard arayüzü oluşturuldu ve başlatıldı';
        failMsg = 'WireGuard başlatılamadı';
        break;
      case 'handshake':
        cmd = 'wg show wg0 2>&1 || echo "wg0 not found"';
        successMsg = 'WireGuard aktif, handshake doğrulandı';
        break;
      default:
        ssh.dispose();
        return { status: 'error', message: `Bilinmeyen adım: ${step}`, duration: '0s' };
    }

    // update/packages can take minutes on slow VPS
    const timeout = (step === 'update' || step === 'packages') ? 300000 : 120000;
    const result = await ssh.execCommand(cmd, { execOptions: { timeout } });
    ssh.dispose();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (step === 'handshake' && result.stdout.includes('wg0 not found')) {
      return { status: 'error', message: 'WireGuard arayüzü bulunamadı', duration: `${elapsed}s` };
    }
    // Komutun sonucu denetlenir (eskiden bakılmıyordu: apt kilitli ya da paket kurulamamışken adım "başarılı" görünüyor,
    // hata ancak son adımda çıkıyordu). VPS'in verdiği son satırlar mesajda.
    if (result.code !== 0) {
      const tail = (result.stderr.trim() || result.stdout.trim()).split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join(' · ').slice(-300);
      return { status: 'error', message: `${failMsg}${result.code !== null ? ` (çıkış kodu ${result.code})` : ''}${tail ? ` — ${tail}` : ''}`, duration: `${elapsed}s` };
    }

    return {
      status: 'success',
      message: successMsg + (result.stdout ? ` — ${result.stdout.trim().slice(0, 100)}` : ''),
      duration: `${elapsed}s`,
    };
  } catch (err: any) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    return { status: 'error', message: err.message || 'Komut çalıştırılamadı', duration: `${elapsed}s` };
  }
}

/**
 * Full WireGuard setup on VPS (legacy single-call method)
 */
export async function setupWireGuardVPS(
  ip: string, username: string, password?: string, privateKeyPath?: string
): Promise<boolean> {
  // SSH to VPS works from any platform
  const steps = ['connection', 'update', 'packages', 'maintenance', 'wireguard', 'handshake'];
  for (const step of steps) {
    const result = await executeSetupStep({ ip, username, password, privateKeyPath }, step);
    if (result.status === 'error') {
      console.error(`Setup step '${step}' failed:`, result.message);
      return false;
    }
  }
  return true;
}

/**
 * Add a WireGuard client peer on the VPS
 */
export async function addWireGuardClient(
  opts: VpsConnectOptions,
  clientName: string,
  clientIndex: number
): Promise<{ success: boolean; config: string; qrData: string; publicKey: string; ip: string } | null> {
  // SSH to VPS works from any platform — no isLinux check needed here
  let ssh: NodeSSH | null = null;
  try {
    ssh = await connectSSH(opts);

    // Verify WireGuard is installed and running
    const wgCheck = await ssh.execCommand('which wg && test -f /etc/wireguard/wg0.conf && echo "OK"');
    if (!wgCheck.stdout.includes('OK')) {
      ssh.dispose();
      throw new Error('WireGuard kurulu değil veya wg0.conf bulunamadı. Önce VPS kurulumunu tamamlayın.');
    }

    // Verify qrencode is installed, install if missing
    const qrCheck = await ssh.execCommand('which qrencode || (apt-get install -y -qq qrencode 2>&1 && which qrencode)');
    const hasQrencode = qrCheck.stdout.includes('qrencode');

    const clientIp = `10.66.66.${clientIndex + 2}/32`;

    // Generate client keys
    const genKeys = await ssh.execCommand('CLIENT_PRIV=$(wg genkey) && CLIENT_PUB=$(echo "$CLIENT_PRIV" | wg pubkey) && echo "$CLIENT_PRIV $CLIENT_PUB"');
    const parts = genKeys.stdout.trim().split(' ');
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      ssh.dispose();
      throw new Error('Client anahtar çifti oluşturulamadı. wg komutu başarısız.');
    }
    const [clientPriv, clientPub] = parts;

    // Get server public key from config
    const serverInfo = await ssh.execCommand("grep PrivateKey /etc/wireguard/wg0.conf | head -1 | cut -d'=' -f2- | tr -d ' '");
    const serverPriv = serverInfo.stdout.trim();
    if (!serverPriv) {
      ssh.dispose();
      throw new Error('Server private key okunamadı. wg0.conf bozuk olabilir.');
    }
    const serverPubResult = await ssh.execCommand(`echo "${serverPriv}" | wg pubkey`);
    const serverPub = serverPubResult.stdout.trim();

    // Get server public IP — try multiple methods (curl may not be installed)
    const ipCmd = `
      IP="";
      if command -v curl &>/dev/null; then
        IP=$(curl -s4 --max-time 5 ifconfig.me 2>/dev/null || curl -s4 --max-time 5 icanhazip.com 2>/dev/null)
      fi;
      if [ -z "$IP" ] && command -v wget &>/dev/null; then
        IP=$(wget -qO- --timeout=5 ifconfig.me 2>/dev/null || wget -qO- --timeout=5 icanhazip.com 2>/dev/null)
      fi;
      if [ -z "$IP" ]; then
        IP=$(hostname -I | awk '{print $1}')
      fi;
      echo "$IP"
    `;
    const serverIp = await ssh.execCommand(ipCmd);
    // Fallback: use the VPS IP from connection opts (we already know it)
    const serverAddr = serverIp.stdout.trim() || opts.ip;
    if (!serverAddr) {
      ssh.dispose();
      throw new Error('Server IP belirlenemedi');
    }

    // Add peer to running WireGuard interface
    await ssh.execCommand(`wg set wg0 peer ${clientPub} allowed-ips ${clientIp}`);

    // Persist peer to config file
    await ssh.execCommand(`cat >> /etc/wireguard/wg0.conf << 'PEEREOF'

# ${clientName}
[Peer]
PublicKey = ${clientPub}
AllowedIPs = ${clientIp}
PEEREOF`);

    // Build client config (Address must be /32 for point-to-point WireGuard)
    const clientConfig = `[Interface]
PrivateKey = ${clientPriv}
Address = ${clientIp}
DNS = 1.1.1.1, 8.8.8.8

[Peer]
PublicKey = ${serverPub}
Endpoint = ${serverAddr}:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25`;

    // Generate QR code as base64 (if qrencode available)
    let qrData = '';
    if (hasQrencode) {
      const qrResult = await ssh.execCommand(`echo '${clientConfig}' | qrencode -t PNG -o - | base64 -w0`);
      qrData = qrResult.stdout.trim() ? `data:image/png;base64,${qrResult.stdout.trim()}` : '';
    }

    ssh.dispose();

    return {
      success: true,
      config: clientConfig,
      qrData,
      publicKey: clientPub,
      ip: clientIp,
    };
  } catch (err: any) {
    console.error('Add client error:', err.message);
    throw err; // Re-throw so endpoint can return the actual error message
  } finally {
    try { ssh?.dispose(); } catch { /* */ }
  }
}

/**
 * Connect Pi5 to VPS as a WireGuard client (gateway peer)
 * Creates wg_vpsX interface on Pi5 that routes traffic to VPS
 */
export async function connectPi5ToVps(
  opts: VpsConnectOptions,
  vpsId: number
): Promise<{ success: boolean; interfaceName: string; pi5Ip: string; config: string }> {
  if (!isLinux) {
    throw new Error('Pi5 VPN tüneli sadece Pi5 (Linux) üzerinde kurulabilir');
  }

  const interfaceName = `wg_vps${vpsId}`;
  const pi5Ip = '10.66.66.2/32'; // Pi5 gateway always gets .2
  const confPath = `/etc/wireguard/${interfaceName}.conf`;

  let ssh: NodeSSH | null = null;
  try {
    ssh = await connectSSH(opts);

    // Verify WireGuard is running on VPS
    const wgCheck = await ssh.execCommand('test -f /etc/wireguard/wg0.conf && wg show wg0 2>/dev/null && echo "OK"');
    if (!wgCheck.stdout.includes('OK')) {
      ssh.dispose();
      throw new Error('VPS WireGuard aktif değil. Önce VPS kurulumunu tamamlayın.');
    }

    // Generate Pi5 client keys locally
    const { execSync } = require('child_process');
    const pi5Priv = execSync('wg genkey').toString().trim();
    const pi5Pub = execSync(`echo "${pi5Priv}" | wg pubkey`).toString().trim();

    // Get server public key
    const serverPrivResult = await ssh.execCommand("grep PrivateKey /etc/wireguard/wg0.conf | head -1 | cut -d'=' -f2- | tr -d ' '");
    const serverPub = (await ssh.execCommand(`echo "${serverPrivResult.stdout.trim()}" | wg pubkey`)).stdout.trim();

    // Check if Pi5 peer already exists on VPS (avoid duplicates)
    const existingPeers = await ssh.execCommand(`wg show wg0 allowed-ips 2>/dev/null`);
    const pi5Already = existingPeers.stdout.includes('10.66.66.2');

    if (!pi5Already) {
      // Add Pi5 as peer on VPS
      await ssh.execCommand(`wg set wg0 peer ${pi5Pub} allowed-ips ${pi5Ip}`);
      await ssh.execCommand(`cat >> /etc/wireguard/wg0.conf << 'PEEREOF'

# Pi5-Gateway
[Peer]
PublicKey = ${pi5Pub}
AllowedIPs = ${pi5Ip}
PEEREOF`);
    } else {
      // Update existing peer with new key
      const oldKey = (await ssh.execCommand(`wg show wg0 allowed-ips | grep '10.66.66.2' | awk '{print $1}'`)).stdout.trim();
      if (oldKey) {
        await ssh.execCommand(`wg set wg0 peer ${oldKey} remove 2>/dev/null || true`);
      }
      await ssh.execCommand(`wg set wg0 peer ${pi5Pub} allowed-ips ${pi5Ip}`);
      // Eski Pi eşi wg0.conf'tan adresiyle (10.66.66.2/32) silinir — ad eşleşmesiyle değil (yedekli, doğrulamalı).
      const rm = await removePeerFromConfig(ssh, { allowedIp: '10.66.66.2/32' });
      if (rm.result === 'failed') throw new Error(`VPS wg0.conf'taki eski Pi eşi silinemedi: ${rm.detail}`);
      await ssh.execCommand(`cat >> /etc/wireguard/wg0.conf << 'PEEREOF'

# Pi5-Gateway
[Peer]
PublicKey = ${pi5Pub}
AllowedIPs = ${pi5Ip}
PEEREOF`);
    }

    ssh.dispose();

    // Build Pi5 client config.
    // Table = off: wg-quick otomatik varsayılan-rota/fwmark kurallarını EKLEMEZ; böylece policy routing
    // (applyDomainRouting'in fwmark tabloları) ezilmez. AllowedIPs=0.0.0.0/0 kalır ki tünel internet
    // trafiğini de taşıyabilsin — hangi trafiğin tünele gireceğine bizim ip rule'larımız karar verir.
    // PostUp: tünelden dönen yanıtlar işaretsiz gelir, katı rp_filter onları düşürür → arayüzde gevşek (2).
    // `|| true`: sysctl başarısız olsa da tünel ayağa kalksın.
    const serverAddr = opts.ip;
    const pi5Config = `[Interface]
PrivateKey = ${pi5Priv}
Address = ${pi5Ip}
Table = off
PostUp = sysctl -q -w net.ipv4.conf.%i.rp_filter=2 || true

[Peer]
PublicKey = ${serverPub}
Endpoint = ${serverAddr}:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25`;

    // Write config on Pi5
    fs.writeFileSync(confPath, pi5Config, { mode: 0o600 });

    // Bring down old interface if exists, then bring up new
    // (boot'ta systemd unit'i başlattıysa önce unit'i durdur ki durumu tutarlı kalsın)
    const { exec } = require('child_process');
    const execP = require('util').promisify(exec);
    await execP(`systemctl stop wg-quick@${interfaceName} 2>/dev/null || true`, { timeout: 10000 });
    await execP(`wg-quick down ${interfaceName} 2>/dev/null || true`, { timeout: 10000 });
    await execP(`wg-quick up ${interfaceName}`, { timeout: 15000 });

    // Verify interface is up
    const verify = await execP(`wg show ${interfaceName} 2>/dev/null`, { timeout: 5000 }).catch(() => ({ stdout: '' }));
    if (!verify.stdout.includes('endpoint')) {
      throw new Error(`${interfaceName} arayüzü başlatılamadı`);
    }

    // Kalıcılık: reboot sonrası tünel systemd ile geri gelsin ("Tünel Kes" disable eder).
    await execP(`systemctl enable wg-quick@${interfaceName} 2>/dev/null || true`, { timeout: 10000 });

    return { success: true, interfaceName, pi5Ip, config: pi5Config };
  } catch (err: any) {
    console.error('Pi5 VPN connect error:', err.message);
    throw err;
  } finally {
    try { ssh?.dispose(); } catch { /* */ }
  }
}

/**
 * Disconnect Pi5 from a VPS (bring down wg interface)
 */
export async function disconnectPi5FromVps(vpsId: number): Promise<void> {
  if (!isLinux) return;
  const interfaceName = `wg_vps${vpsId}`;
  const { exec } = require('child_process');
  const execP = require('util').promisify(exec);
  // Kalıcılığı da kaldır: aksi halde reboot'ta kullanıcının kestiği tünel geri açılır.
  await execP(`systemctl disable --now wg-quick@${interfaceName} 2>/dev/null || true`, { timeout: 10000 });
  await execP(`wg-quick down ${interfaceName} 2>/dev/null || true`, { timeout: 10000 });
}

/**
 * Check if Pi5 is connected to a VPS
 */
export async function isPi5ConnectedToVps(vpsId: number): Promise<boolean> {
  if (!isLinux) return false;
  const interfaceName = `wg_vps${vpsId}`;
  try {
    const { exec } = require('child_process');
    const execP = require('util').promisify(exec);
    const result = await execP(`wg show ${interfaceName} 2>/dev/null`, { timeout: 5000 });
    return result.stdout.includes('endpoint');
  } catch {
    return false;
  }
}
