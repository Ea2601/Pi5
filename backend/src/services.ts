import { exec } from 'child_process';
import util from 'util';
import { isLinux, systemctlAction } from './system';

const execAsync = util.promisify(exec);

export const systemServices = {
    async installPihole() {
        if (isLinux) {
            // Real headless Pi-hole installation
            const piholeBash = `
                curl -sSL https://install.pi-hole.net > /tmp/pihole_install.sh
                chmod +x /tmp/pihole_install.sh
                sudo PIHOLE_SKIP_OS_CHECK=true bash /tmp/pihole_install.sh --unattended
            `;
            return execAsync(piholeBash, { timeout: 300000 }); // 5 min timeout
        }
        // Mock
        const piholeBash = `
            echo 'Installing Pi-Hole headlessly...'
        `;
        return execAsync(piholeBash);
    },

    async installZapret(testDomain: string) {
        if (isLinux) {
            const zapretBash = `
                git clone --depth=1 https://github.com/bol-van/zapret.git /tmp/zapret 2>/dev/null || true
                cd /tmp/zapret && sudo ./install_easy.sh
            `;
            return execAsync(zapretBash, { timeout: 120000 });
        }
        // Mock
        const zapretBash = `
            echo 'Cloning Zapret engine...'
            echo 'Running blockcheck for domain: ${testDomain}'
            echo 'Applied Zapret DPI bypass rules.'
        `;
        return execAsync(zapretBash);
    },

    async configureNftables() {
        if (isLinux) {
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
            // Write config and apply
            const fs = await import('fs');
            fs.writeFileSync('/tmp/nftables.conf', nftablesConfig);
            await execAsync('sudo cp /tmp/nftables.conf /etc/nftables.conf');
            await execAsync('sudo systemctl restart nftables');
            return { stdout: 'nftables configuration applied successfully.', stderr: '' };
        }
        // Mock
        return { stdout: 'Mocked nftables config generated and ready for deployment.', stderr: '' };
    },

    async toggleService(name: string, enable: boolean) {
        if (isLinux) {
            const action = enable ? 'start' : 'stop';
            const result = await systemctlAction(action, name);
            return result;
        }
        return `Mock: ${enable ? 'started' : 'stopped'} ${name}`;
    },

    async restartService(name: string) {
        if (isLinux) {
            return await systemctlAction('restart', name);
        }
        return `Mock: restarted ${name}`;
    },
};
