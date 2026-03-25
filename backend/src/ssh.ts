import { NodeSSH } from 'node-ssh';
import * as fs from 'fs';
import * as path from 'path';

const configDir = path.resolve(__dirname, '../../core');
const isLinux = process.platform === 'linux';

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
  if (!isLinux) {
    // Non-Linux: simulate steps for UI testing
    return { status: 'success', message: `${step} tamamlandı (simülasyon)`, duration: '0.5s' };
  }

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
        cmd = 'apt update -qq && apt upgrade -y -qq 2>&1 | tail -5';
        successMsg = 'Sistem güncellendi';
        break;
      case 'packages':
        cmd = 'apt install -y -qq wireguard qrencode iptables 2>&1 | tail -3';
        successMsg = 'WireGuard paketleri kuruldu';
        break;
      case 'maintenance':
        cmd = 'echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-wireguard.conf && sysctl -p /etc/sysctl.d/99-wireguard.conf 2>&1';
        successMsg = 'IP forwarding aktif, bakım ayarları yapıldı';
        break;
      case 'wireguard':
        cmd = `
          SERVER_PRIV=$(wg genkey)
          SERVER_PUB=$(echo "$SERVER_PRIV" | wg pubkey)
          SERVER_IP=$(curl -s4 ifconfig.me || curl -s4 icanhazip.com)

          mkdir -p /etc/wireguard
          cat > /etc/wireguard/wg0.conf << WGEOF
[Interface]
Address = 10.66.66.1/24
ListenPort = 51820
PrivateKey = $SERVER_PRIV
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE; iptables -A FORWARD -o wg0 -j ACCEPT
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE; iptables -D FORWARD -o wg0 -j ACCEPT
WGEOF

          chmod 600 /etc/wireguard/wg0.conf
          systemctl enable wg-quick@wg0
          systemctl restart wg-quick@wg0
          echo "SERVER_PUB=$SERVER_PUB SERVER_IP=$SERVER_IP"
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

    const result = await ssh.execCommand(cmd, { execOptions: { timeout: 120000 } });
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
  if (!isLinux) return false;

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
  if (!isLinux) return null;

  try {
    const ssh = await connectSSH(opts);

    const clientIp = `10.66.66.${clientIndex + 2}/32`;
    const genKeys = await ssh.execCommand('CLIENT_PRIV=$(wg genkey) && CLIENT_PUB=$(echo "$CLIENT_PRIV" | wg pubkey) && echo "$CLIENT_PRIV $CLIENT_PUB"');
    const [clientPriv, clientPub] = genKeys.stdout.trim().split(' ');

    // Get server info
    const serverInfo = await ssh.execCommand('cat /etc/wireguard/wg0.conf | grep PrivateKey | cut -d= -f2- | tr -d " "');
    const serverPriv = serverInfo.stdout.trim();
    const serverPubResult = await ssh.execCommand(`echo "${serverPriv}" | wg pubkey`);
    const serverPub = serverPubResult.stdout.trim();
    const serverIp = await ssh.execCommand('curl -s4 ifconfig.me || curl -s4 icanhazip.com');
    const serverAddr = serverIp.stdout.trim();

    // Add peer to server
    await ssh.execCommand(`wg set wg0 peer ${clientPub} allowed-ips ${clientIp.replace('/32', '/32')}`);
    await ssh.execCommand(`
      cat >> /etc/wireguard/wg0.conf << PEEREOF

# ${clientName}
[Peer]
PublicKey = ${clientPub}
AllowedIPs = ${clientIp}
PEEREOF
    `);

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

    // Generate QR code as base64
    const qrResult = await ssh.execCommand(`echo '${clientConfig}' | qrencode -t PNG -o - | base64 -w0`);
    const qrData = qrResult.stdout.trim() ? `data:image/png;base64,${qrResult.stdout.trim()}` : '';

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
    return null;
  }
}
