import { NodeSSH } from 'node-ssh';
import * as fs from 'fs';
import * as path from 'path';

const configDir = path.resolve(__dirname, '../../core');

/**
 * Automates WireGuard Setup on the VPS
 */
export async function setupWireGuardVPS(ip: string, username: string, privateKeyPath: string) {
  const ssh = new NodeSSH();
  
  try {
    console.log(`Connecting to ${username}@${ip}...`);
    await ssh.connect({
      host: ip,
      username: username,
      privateKeyPath: privateKeyPath,
    });
    
    console.log('Connected! Downloading and initiating WireGuard installer script...');
    
    // We use a popular wireguard installer script
    const installScript = `
      curl -O https://raw.githubusercontent.com/angristan/wireguard-install/master/wireguard-install.sh
      chmod +x wireguard-install.sh
      AUTO_INSTALL=y ./wireguard-install.sh
    `;
    
    const result = await ssh.execCommand(installScript);
    console.log('Installer Result:', result.stdout);
    if (result.stderr) {
       console.error('Installer Errors:', result.stderr);
    }
    
    // Attempt to pull the generated client config
    const fetchConf = await ssh.execCommand('cat /root/wg0-client.conf'); // usually the name
    if (fetchConf.stdout) {
      fs.writeFileSync(path.join(configDir, 'vps-wg.conf'), fetchConf.stdout);
      console.log('WireGuard configuration successfully saved to core directory.');
    } else {
      console.error('Could not find WireGuard client configuration.');
    }
    
    ssh.dispose();
    return true;

  } catch (err: any) {
    console.error('SSH Connection or Execution Error:', err.message);
    ssh.dispose();
    return false;
  }
}
