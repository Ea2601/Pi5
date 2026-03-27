import { exec } from 'child_process';
import util from 'util';
import { isLinux, systemctlAction } from './system';

const execAsync = util.promisify(exec);

// DB name → actual systemd service name
const SERVICE_NAME_MAP: Record<string, string> = {
  pihole: 'pihole-FTL',
  unbound: 'unbound',
  zapret: 'zapret',
  wireguard: 'wg-quick@wg0',
  fail2ban: 'fail2ban',
  nftables: 'nftables',
};

export const systemServices = {
    async installPihole() {
        if (!isLinux) throw new Error('Pi-hole kurulumu sadece Pi5 üzerinde çalışır');
        const piholeBash = `
            curl -sSL https://install.pi-hole.net > /tmp/pihole_install.sh
            chmod +x /tmp/pihole_install.sh
            sudo PIHOLE_SKIP_OS_CHECK=true bash /tmp/pihole_install.sh --unattended
        `;
        return execAsync(piholeBash, { timeout: 300000 });
    },

    async installZapret(testDomain: string) {
        if (!isLinux) throw new Error('Zapret kurulumu sadece Pi5 üzerinde çalışır');
        const domain = testDomain || 'discord.com';
        // First install if not present, then run blockcheck for the domain
        const zapretBash = `
            if [ ! -d /opt/zapret ]; then
                git clone --depth=1 https://github.com/bol-van/zapret.git /opt/zapret 2>/dev/null
                cd /opt/zapret && sudo ./install_easy.sh
            fi
            cd /opt/zapret && sudo ./blockcheck.sh --domain=${domain} 2>&1 | tail -50
        `;
        return execAsync(zapretBash, { timeout: 120000 });
    },

    async configureNftables() {
        if (!isLinux) throw new Error('nftables yapılandırması sadece Pi5 üzerinde çalışır');
        const nftablesConfig = `#!/usr/sbin/nft -f
flush ruleset

table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;
        iif lo accept
        ct state established,related accept
        tcp dport 22 accept
        tcp dport 53 accept
        udp dport 53 accept
        tcp dport 80 accept
        udp dport 51820 accept
        tcp dport 3000 accept
        drop
    }
    chain forward {
        type filter hook forward priority 0; policy drop;
        iifname "wg0" accept
        oifname "wg0" accept
        iifname "eth0" oifname "wlan0" accept
        iifname "wlan0" oifname "eth0" ct state related,established accept
    }
}
table ip nat {
    chain postrouting {
        type nat hook postrouting priority 100;
        oifname "wlan0" masquerade
    }
}`;
        const fs = await import('fs');
        fs.writeFileSync('/tmp/nftables.conf', nftablesConfig);
        await execAsync('sudo cp /tmp/nftables.conf /etc/nftables.conf');
        await execAsync('sudo systemctl restart nftables');
        return { stdout: 'nftables yapılandırması uygulandı.', stderr: '' };
    },

    async toggleService(name: string, enable: boolean) {
        if (!isLinux) throw new Error('Servis kontrolü sadece Pi5 üzerinde çalışır');
        const action = enable ? 'start' : 'stop';
        const svcName = SERVICE_NAME_MAP[name] || name;
        return await systemctlAction(action, svcName);
    },

    async restartService(name: string) {
        if (!isLinux) throw new Error('Servis kontrolü sadece Pi5 üzerinde çalışır');
        const svcName = SERVICE_NAME_MAP[name] || name;
        return await systemctlAction('restart', svcName);
    },
};
