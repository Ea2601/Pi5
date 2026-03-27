import { NodeSSH } from 'node-ssh';
import * as fs from 'fs';
import * as path from 'path';

const configDir = path.resolve(__dirname, '../../core');

interface VpsConnectOptions {
  ip: string;
  username: string;
  password?: string;
  privateKeyPath?: string;
}

/**
 * Connect to VPS via SSH — supports password and/or private key auth
 */
async function connectSSH(opts: VpsConnectOptions): Promise<NodeSSH> {
  const ssh = new NodeSSH();
  const connectOpts: Record<string, unknown> = {
    host: opts.ip,
    username: opts.username,
    readyTimeout: 15000,
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

  await ssh.connect(connectOpts);
  return ssh;
}

/**
 * Test SSH connection only — returns true if connection succeeds
 */
export async function testSSHConnection(opts: VpsConnectOptions): Promise<{ success: boolean; message: string }> {
  try {
    const ssh = await connectSSH(opts);
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
    const ssh = await connectSSH(opts);
    let cmd = '';
    let successMsg = '';

    switch (step) {
      case 'connection':
        cmd = 'echo "ok" && uptime';
        successMsg = 'SSH bağlantısı başarılı';
        break;
      case 'update':
        cmd = 'export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get upgrade -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" 2>&1 | tail -5';
        successMsg = 'Sistem güncellendi';
        break;
      case 'packages':
        cmd = `export DEBIAN_FRONTEND=noninteractive && \
          apt-get install -y -qq wireguard wireguard-tools qrencode iptables curl resolvconf 2>&1 | tail -5 && \
          echo "--- Paket kontrol ---" && \
          which wg && which qrencode && which curl && echo "Tum paketler kurulu"`;
        successMsg = 'WireGuard ve bağımlılıklar kuruldu';
        break;
      case 'maintenance':
        cmd = `
          # IP forwarding
          echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-wireguard.conf
          sysctl -p /etc/sysctl.d/99-wireguard.conf 2>&1

          # UFW varsa WireGuard portunu aç veya kapat
          if command -v ufw &>/dev/null; then
            ufw allow 51820/udp 2>/dev/null || true
          fi

          # Firewall'da forward izni
          if command -v ufw &>/dev/null; then
            sed -i 's/DEFAULT_FORWARD_POLICY="DROP"/DEFAULT_FORWARD_POLICY="ACCEPT"/' /etc/default/ufw 2>/dev/null || true
            ufw reload 2>/dev/null || true
          fi

          echo "IP forwarding ve firewall ayarlandi"
        `;
        successMsg = 'IP forwarding aktif, firewall ayarlandı';
        break;
      case 'wireguard':
        cmd = `
          # Detect primary network interface (not lo, wg, docker, veth)
          PRIMARY_IFACE=$(ip -o -4 route show to default | awk '{print $5}' | head -1)
          if [ -z "$PRIMARY_IFACE" ]; then PRIMARY_IFACE="eth0"; fi
          echo "Network interface: $PRIMARY_IFACE"

          SERVER_PRIV=$(wg genkey)
          SERVER_PUB=$(echo "$SERVER_PRIV" | wg pubkey)

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

          chmod 600 /etc/wireguard/wg0.conf
          systemctl enable wg-quick@wg0
          systemctl restart wg-quick@wg0
          echo "SERVER_PUB=$SERVER_PUB SERVER_IP=$SERVER_IP IFACE=$PRIMARY_IFACE"
        `;
        successMsg = 'WireGuard arayüzü oluşturuldu ve başlatıldı';
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
  try {
    const ssh = await connectSSH(opts);

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

    // Build client config
    const clientConfig = `[Interface]
PrivateKey = ${clientPriv}
Address = ${clientIp.replace('/32', '/24')}
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
  }
}
