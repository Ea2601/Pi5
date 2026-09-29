import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import {
  isLinux, systemctlAction, detectInterfaces, MANAGED_SERVICE_UNITS, isManagedService, TOGGLEABLE_SERVICES,
  listWireguardTunnels, runResult, FTL_SYSTEMCTL_TIMEOUT, getLanIdentity, readNetModeState, HOME_BRIDGE,
  wanActive, wanIfaces,
} from './system';
import { shq, isValidDomain } from './util';

const execAsync = util.promisify(exec);

// WireGuard "yeniden başlat": ayakta ya da açılışta etkin her wg_vps tünelini systemd üzerinden yeniden kurar
// (panel bağlantısı wg-quick'i doğrudan çalıştırdığı için önce birim + arayüz indirilir; ssh.ts connect ile aynı sıra).
async function restartWireguardTunnels(): Promise<string> {
  const targets = (await listWireguardTunnels()).filter(t => t.up || t.state.bootEnabled);
  if (!targets.length) throw new Error('Yeniden başlatılacak WireGuard tüneli yok (VPS sayfasından bağlanın)');
  const errors: string[] = [];
  for (const t of targets) {
    if (!/^wg_vps\d+$/.test(t.iface)) continue;
    await runResult(`systemctl stop ${t.unit}`, 20000);
    await runResult(`wg-quick down ${t.iface}`, 15000);
    try {
      await systemctlAction('start', t.unit);
    } catch (e: any) {
      const up = (await runResult(`wg-quick up ${t.iface}`, 15000)).code === 0;
      errors.push(`${t.iface}: ${e.message}${up ? ' (wg-quick ile açıldı)' : ''}`);
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
  return `${targets.length} tünel yeniden başlatıldı`;
}

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

    async configureNftables(ifaces?: { lan?: string; wan?: string }, customInputRules?: string[]) {
        if (!isLinux) throw new Error('nftables yapılandırması sadece Pi5 üzerinde çalışır');
        // Arayüz rollerini DB config'ten al; geçersiz/var olmayan arayüzde otomatik algılamaya düş
        // (böylece hem eth0=WAN hem wlan0=WAN topolojileri doğru çalışır).
        const detected = await detectInterfaces();
        const exists = (n?: string) => !!n && fs.existsSync(`/sys/class/net/${n}`);
        const ns = readNetModeState();
        // İnternet kartı modu (WAN router, R3): iki kart net-mode durumundan gelir (ev ağı eth0 / br0; internet kart +
        // VLAN + PPPoE). DB'deki eski iki kartlı tohumlar (lan=eth0, wan=wlan0) yok sayılır.
        const wanMode = wanActive(ns) && ns.wanLan;
        // Tek bacaklı ağ geçidi (lan = wan: istemciler ve modem aynı arayüzde) canlıdan tespit edildiyse DB'deki eski
        // iki kartlı tohumlar (lan=eth0, wan=wlan0) yok sayılır — aksi halde NAT yanlış arayüze yazılır.
        const oneArm = !wanMode && detected.lan === detected.wan;
        const wan = !oneArm && exists(ifaces?.wan) ? ifaces!.wan! : detected.wan;
        const lan = !oneArm && exists(ifaces?.lan) ? ifaces!.lan! : detected.lan;
        // Tek bacakta kurallar yalnız o anki varsayılan rotanın kartına yazılmaz: aynı LAN'daki tüm kartlar (ikinci bacak,
        // DB tohumları) dahil edilir — kablo o an takılı değilken Uygula'ya basılırsa kablo geri gelince istemciler
        // düşmesin (/etc/nftables.conf her açılışta yüklenir). Sabit adres modunda ev Wi-Fi köprüsü (br0) ve kart da
        // eklenir: ev Wi-Fi'ı açılınca / kapanınca (ya da köprü açılışta kurulamayıp eth0'a dönülünce) istemci trafiği
        // arayüz değiştirir, kurallar yeniden uygulanmadan da eşleşsin.
        const netModeIfs = ns && (ns.stage === 'trial' || ns.stage === 'static') ? [ns.iface, HOME_BRIDGE].filter(Boolean) : [];
        const lanIfs = wanMode
            ? [...new Set(netModeIfs)]
            : oneArm
            ? [...new Set([detected.wan, ...((await getLanIdentity())?.secondary || []).map(s => s.iface),
                ...[ifaces?.lan, ifaces?.wan].filter((n): n is string => exists(n)), ...netModeIfs])]
            : [lan];
        const wanIfs = wanMode ? wanIfaces(ns) : oneArm ? lanIfs : [wan];
        const nftIfs = (xs: string[]) => (xs.length === 1 ? `"${xs[0]}"` : `{ ${xs.map(x => `"${x}"`).join(', ')} }`);
        // Port yönlendirme (yalnız internet kartı modunda): DNAT'lanan yeni bağlantılar ev ağına iletilir.
        const dnatLine = wanMode ? `\n        iifname ${nftIfs(wanIfs)} oifname ${nftIfs(lanIfs)} ct status dnat accept` : '';

        // Özel kullanıcı kuralları (index.ts'te doğrulanmış nft satırları olarak gelir).
        const customLines = (customInputRules && customInputRules.length)
            ? '\n        # Özel kullanıcı kuralları\n        ' + customInputRules.join('\n        ')
            : '';

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
        udp dport 67 accept
        udp dport 123 accept
        udp dport 51820 accept${customLines}
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
        iifname ${nftIfs(lanIfs)} accept
        iifname ${nftIfs(wanIfs)} oifname ${nftIfs(lanIfs)} ct state related,established accept${dnatLine}
    }
}
table ip pi5_nat {}
delete table ip pi5_nat
table ip pi5_nat {
    chain postrouting {
        type nat hook postrouting priority 100;
        # WAN çıkışı + VPS tünel çıkışı (Pi5-tarafı SNAT: LAN kaynaklı paketler tünelden doğru dönebilsin)
        oifname ${nftIfs(wanIfs)} masquerade
        oifname "wg_vps*" masquerade
    }
}

# Kalıcılık: domain-routing/device-block/zapret gibi ek tablolar boot'ta yüklensin
include "/etc/nftables.d/*.conf"`;
        fs.mkdirSync('/etc/nftables.d', { recursive: true });
        // Sondaki satır sonu şart: nft 1.1 (trixie) son satırdaki include'u "unexpected end of file" ile reddediyordu.
        fs.writeFileSync('/etc/nftables.conf', nftablesConfig + '\n');
        await execAsync('nft -f /etc/nftables.conf');
        await execAsync('systemctl enable nftables 2>/dev/null || true');
        return { stdout: `nftables yapılandırıldı (WAN=${wanIfs.join('+')}, LAN=${lanIfs.join('+')}${oneArm ? ', tek bacak' : wanMode ? ', internet kartı' : ''}).`, stderr: '' };
    },

    // Kalıcı aç/kapa (enable --now / disable --now): eskiden yalnız start/stop — kapatılan servis açılışta geri geliyordu.
    // Başlatmadan önce reset-failed: başlatma sınırına takılmış birim aksi halde 60 sn başlatılamaz.
    async toggleService(name: string, enable: boolean) {
        if (!isLinux) throw new Error('Servis kontrolü sadece Pi5 üzerinde çalışır');
        if (!isManagedService(name) || !TOGGLEABLE_SERVICES.includes(name)) {
            throw new Error(name === 'wireguard' ? 'WireGuard tünelleri VPS sayfasından (Bağla/Kes) yönetilir' : `Geçersiz servis: ${name}`);
        }
        const unit = MANAGED_SERVICE_UNITS[name]!;
        const timeout = name === 'pihole' ? FTL_SYSTEMCTL_TIMEOUT : undefined;
        if (!enable) return await systemctlAction('disable-now', unit, timeout);
        await systemctlAction('reset-failed', unit).catch(() => { /* failed değilse ya da birim yoksa */ });
        return await systemctlAction('enable-now', unit, timeout);
    },

    async restartService(name: string) {
        if (!isLinux) throw new Error('Servis kontrolü sadece Pi5 üzerinde çalışır');
        if (!isManagedService(name)) throw new Error(`Geçersiz servis: ${name}`);
        if (name === 'wireguard') return await restartWireguardTunnels();
        const unit = MANAGED_SERVICE_UNITS[name]!;
        await systemctlAction('reset-failed', unit).catch(() => { /* failed değilse ya da birim yoksa */ });
        return await systemctlAction('restart', unit, name === 'pihole' ? FTL_SYSTEMCTL_TIMEOUT : undefined);
    },
};
