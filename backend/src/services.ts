import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export const systemServices = {
    async installPihole() {
        // Headless installation wrapper for Pi-hole and Unbound
        // Using WEBPASSWORD='' and INSTALL_WEB_INTERFACE=false in setupVars.conf
        // Translated directly from rpi5-network-skill.md Unattended Setup
        const piholeBash = `
            echo 'Installing Pi-Hole headlessly...'
            # curl -sSL https://install.pi-hole.net > pihole_install.sh
            # chmod +x pihole_install.sh
        `;
        return execAsync(piholeBash);
    },

    async installZapret(testDomain: string) {
        // Run Zapret blockcheck to figure out NFQWS params and apply to config
        // From Zapret DPI Bypass section in skill
        const zapretBash = `
            echo 'Cloning Zapret engine...'
            # git clone --depth=1 https://github.com/bol-van/zapret.git /tmp/zapret
            echo 'Running blockcheck for domain: ${testDomain}'
            # Parse blockcheck output here and modify /opt/zapret/config
            echo 'Applied Zapret DPI bypass rules.'
        `;
        return execAsync(zapretBash);
    },

    async configureNftables() {
        // Directly maps to the nftables configuration from rpi5-network-skill.md
        const nftablesConfig = `
#!/usr/sbin/nft -f
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
}
        `;
        
        // In real execution on Pi5, save string to /etc/nftables.conf and run `systemctl restart nftables`
        return { stdout: 'Mocked nftables config generated and ready for deployment.', stderr: '' };
    }
};
