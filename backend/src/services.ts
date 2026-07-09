import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import { isLinux, systemctlAction, detectInterfaces } from './system';
import { shq, isValidDomain } from './util';

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
        if (!isValidDomain(domain)) throw new Error('Geçersiz domain');
        // First install if not present, then run blockcheck for the domain (domain shell-quoted)
        const zapretBash = `
            if [ ! -d /opt/zapret ]; then
                git clone --depth=1 https://github.com/bol-van/zapret.git /opt/zapret 2>/dev/null
                cd /opt/zapret && sudo ./install_easy.sh
            fi
            cd /opt/zapret && sudo ./blockcheck.sh --domain=${shq(domain)} 2>&1 | tail -50
        `;
        return execAsync(zapretBash, { timeout: 120000 });
    },

    async configureNftables(ifaces?: { lan?: string; wan?: string }) {
        if (!isLinux) throw new Error('nftables yapılandırması sadece Pi5 üzerinde çalışır');
        // Arayüz rollerini DB config'ten al; geçersiz/var olmayan arayüzde otomatik algılamaya düş
        // (böylece hem eth0=WAN hem wlan0=WAN topolojileri doğru çalışır).
        const detected = await detectInterfaces();
        const exists = (n?: string) => !!n && fs.existsSync(`/sys/class/net/${n}`);
        const wan = exists(ifaces?.wan) ? ifaces!.wan! : detected.wan;
        const lan = exists(ifaces?.lan) ? ifaces!.lan! : detected.lan;

        // ÖNEMLI: `flush ruleset` KULLANILMAZ — yalnızca kendi tablolarımızı idempotent yönetiriz.
        // Böylece zapret NFQUEUE, domain_routing ve pi5_block tabloları korunur.
        // Boş-tanımla → sil → yeniden-tanımla deseni her yüklemede (boot/reload) idempotent çalışır.
        const nftablesConfig = `#!/usr/sbin/nft -f
table inet pi5_filter {}
delete table inet pi5_filter
table inet pi5_filter {
    chain input {
        type filter hook input priority 0; policy drop;
        iif lo accept
        ct state established,related accept
        ip protocol icmp accept
        ip6 nexthdr ipv6-icmp accept
        tcp dport 22 accept
        tcp dport 53 accept
        udp dport 53 accept
        tcp dport 80 accept
        udp dport 51820 accept
    }
    chain forward {
        type filter hook forward priority 0; policy drop;
        ct state established,related accept
        # PMTU kara deliğini önlemek için tünel yolunda MSS clamp
        tcp flags syn tcp option maxseg size set rt mtu
        iifname "wg0" accept
        oifname "wg0" accept
        iifname "wg_vps*" accept
        oifname "wg_vps*" accept
        iifname "${lan}" accept
        iifname "${wan}" oifname "${lan}" ct state related,established accept
    }
}
table ip pi5_nat {}
delete table ip pi5_nat
table ip pi5_nat {
    chain postrouting {
        type nat hook postrouting priority 100;
        # WAN çıkışı + VPS tünel çıkışı (Pi5-tarafı SNAT: LAN kaynaklı paketler tünelden doğru dönebilsin)
        oifname "${wan}" masquerade
        oifname "wg_vps*" masquerade
    }
}

# Kalıcılık: domain-routing/device-block/zapret gibi ek tablolar boot'ta yüklensin
include "/etc/nftables.d/*.conf"`;
        fs.mkdirSync('/etc/nftables.d', { recursive: true });
        fs.writeFileSync('/etc/nftables.conf', nftablesConfig);
        await execAsync('nft -f /etc/nftables.conf');
        await execAsync('systemctl enable nftables 2>/dev/null || true');
        return { stdout: `nftables yapılandırıldı (WAN=${wan}, LAN=${lan}).`, stderr: '' };
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
