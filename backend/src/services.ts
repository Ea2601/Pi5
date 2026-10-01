import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import {
  isLinux, systemctlAction, detectInterfaces, MANAGED_SERVICE_UNITS, isManagedService, TOGGLEABLE_SERVICES,
  listWireguardTunnels, runResult, FTL_SYSTEMCTL_TIMEOUT, getLanIdentity, readNetModeState, HOME_BRIDGE,
  wanActive, uplinkIfaces, sameNetActive,
} from './system';
import { shq, isValidDomain } from './util';

const execAsync = util.promisify(exec);

// Güvenlik duvarı yapılandırması (uygulanmadan): Deploy Et, önizleme ve "kuralları yeniden uygula" aynı metni kullanır.
export interface NftLine { rule: string; label: string; kind: 'system' | 'custom' | 'service' }
export interface NftBuild {
  config: string; mode: 'wan' | 'sameNet' | 'oneArm' | 'twoCard'; lanIfs: string[]; wanIfs: string[];
  input: NftLine[]; forward: NftLine[]; nat: NftLine[];
}
const NFT_CONF = '/etc/nftables.conf';
let nftTmpSeq = 0;

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

    async buildNftables(ifaces?: { lan?: string; wan?: string }, customInputRules?: string[]): Promise<NftBuild> {
        if (!isLinux) throw new Error('nftables yapılandırması sadece Pi5 üzerinde çalışır');
        // Arayüz rollerini DB config'ten al; geçersiz/var olmayan arayüzde otomatik algılamaya düş
        // (böylece hem eth0=WAN hem wlan0=WAN topolojileri doğru çalışır).
        const detected = await detectInterfaces();
        const exists = (n?: string) => !!n && fs.existsSync(`/sys/class/net/${n}`);
        const ns = readNetModeState();
        // İnternet kartı modu (WAN router, R3): iki kart net-mode durumundan gelir (ev ağı eth0 / br0; internet kart +
        // VLAN + PPPoE). DB'deki eski iki kartlı tohumlar (lan=eth0, wan=wlan0) yok sayılır.
        const wanMode = wanActive(ns) && ns.wanLan;
        // Wi-Fi köprüsü (aynı ağ, R4 C): ev tarafı kartı ve üst Wi-Fi net-mode durumundan; iki yön iletilir (aynı ağ),
        // istemci trafiği maskelenmez (modem cihazları kendi adresleriyle görür). DB tohumları yok sayılır.
        const sameNet = !wanMode && !!ns && sameNetActive(ns) ? { lan: ns.repLan, up: ns.repPort } : null;
        // Tek bacaklı ağ geçidi (lan = wan: istemciler ve modem aynı arayüzde) canlıdan tespit edildiyse DB'deki eski
        // iki kartlı tohumlar (lan=eth0, wan=wlan0) yok sayılır — aksi halde NAT yanlış arayüze yazılır.
        const oneArm = !wanMode && !sameNet && detected.lan === detected.wan;
        const wan = !oneArm && exists(ifaces?.wan) ? ifaces!.wan! : detected.wan;
        const lan = !oneArm && exists(ifaces?.lan) ? ifaces!.lan! : detected.lan;
        // Tek bacakta kurallar yalnız o anki varsayılan rotanın kartına yazılmaz: aynı LAN'daki tüm kartlar (ikinci bacak,
        // DB tohumları) dahil edilir — kablo o an takılı değilken Uygula'ya basılırsa kablo geri gelince istemciler
        // düşmesin (/etc/nftables.conf her açılışta yüklenir). Sabit adres modunda ev Wi-Fi köprüsü (br0) ve kart da
        // eklenir: ev Wi-Fi'ı açılınca / kapanınca (ya da köprü açılışta kurulamayıp eth0'a dönülünce) istemci trafiği
        // arayüz değiştirir, kurallar yeniden uygulanmadan da eşleşsin.
        const netModeIfs = ns && (ns.stage === 'trial' || ns.stage === 'static') ? [ns.iface, HOME_BRIDGE].filter(Boolean) : [];
        const lanIfs = sameNet
            ? [sameNet.lan]
            : wanMode
            ? [...new Set(netModeIfs)]
            : oneArm
            ? [...new Set([detected.wan, ...((await getLanIdentity())?.secondary || []).map(s => s.iface),
                ...[ifaces?.lan, ifaces?.wan].filter((n): n is string => exists(n)), ...netModeIfs])]
            : [lan];
        // İnternet kartı modunda ana hat + yedek hat (maskeleme, port yönlendirme iletimi); tek kollu modda yedek hattın
        // maskelemesi ve güvenlik duvarı kendi tablolarında (pi5_bak), buraya girmez.
        const wanIfs = sameNet ? [sameNet.up] : wanMode ? uplinkIfaces(ns) : oneArm ? lanIfs : [wan];
        const nftIfs = (xs: string[]) => (xs.length === 1 ? `"${xs[0]}"` : `{ ${xs.map(x => `"${x}"`).join(', ')} }`);

        // Input: özel kullanıcı kuralları (index.ts / firewall.ts'te doğrulanmış nft satırları) Pi'nin kendisinden ve açık
        // bağlantıların yanıtlarından hemen SONRA, sabit izinlerden ÖNCE — "engelle" kuralı gerçekten engeller (eskiden
        // sabit izinlerin arkasındaydı: 22/53/80'i kapatan kurala hiç sıra gelmiyordu). Kuralı ekleyen cihazın panele erişimini
        // kesecek kural index.ts'te reddedilir.
        const input: NftLine[] = [
            { rule: 'iif lo accept', label: "Pi'nin kendisi (panel arka ucu, HDMI ekran)", kind: 'system' },
            { rule: 'ct state established,related accept', label: 'Açık bağlantıların yanıtları', kind: 'system' },
            ...(customInputRules || []).map(rule => ({ rule, label: 'Özel kural', kind: 'custom' as const })),
            { rule: 'ip protocol icmp accept', label: 'Ping (ICMP)', kind: 'system' },
            { rule: 'ip6 nexthdr ipv6-icmp accept', label: 'IPv6 ICMP (komşu keşfi)', kind: 'system' },
            { rule: 'tcp dport 22 accept', label: 'SSH', kind: 'service' },
            { rule: 'tcp dport 53 accept', label: 'DNS (Pi-hole)', kind: 'service' },
            { rule: 'udp dport 53 accept', label: 'DNS (Pi-hole)', kind: 'service' },
            { rule: 'tcp dport 80 accept', label: 'Panel (nginx)', kind: 'service' },
            { rule: 'udp dport 67 accept', label: 'DHCP (Pi DHCP sunucusu)', kind: 'service' },
            { rule: 'udp dport 123 accept', label: 'Saat (NTP)', kind: 'service' },
            // mDNS yalnız özel ağ kaynaklarından: Klyrix cihazları birbirini bulur (mesh.ts keşif), klyrix.local çözülür.
            // İnternet kartı (WAN) modunda üst ağ da özel adres olabilir (modem arkası): mDNS yalnız ev ağı kartlarından.
            { rule: `${wanMode ? `iifname ${nftIfs(lanIfs)} ` : ''}ip saddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } udp dport 5353 accept`, label: 'mDNS (Klyrix cihaz keşfi, ağda görünme)', kind: 'service' },
            { rule: 'udp dport 51820 accept', label: "WireGuard (Ev VPN'i)", kind: 'service' },
        ];
        const forward: NftLine[] = [
            { rule: 'ct state established,related accept', label: 'Açık bağlantıların yanıtları', kind: 'system' },
            { rule: 'tcp flags syn tcp option maxseg size set rt mtu', label: 'Tünel yolunda MSS kısma (PMTU kara deliği önlenir)', kind: 'system' },
            { rule: 'iifname "wg0" accept', label: 'wg0 (eski kurulumlar)', kind: 'system' },
            { rule: 'oifname "wg0" accept', label: 'wg0 (eski kurulumlar)', kind: 'system' },
            { rule: 'iifname "wg_vps*" accept', label: 'VPS tünellerinden', kind: 'system' },
            { rule: 'oifname "wg_vps*" accept', label: 'VPS tünellerine', kind: 'system' },
            { rule: `iifname ${nftIfs(lanIfs)} accept`, label: 'Ev ağından her yere', kind: 'system' },
            { rule: `iifname ${nftIfs(wanIfs)} oifname ${nftIfs(lanIfs)} ct state related,established accept`, label: 'İnternetten ev ağına yalnız yanıtlar', kind: 'system' },
            // Port yönlendirme (yalnız internet kartı modunda): DNAT'lanan yeni bağlantılar ev ağına iletilir.
            ...(wanMode ? [{ rule: `iifname ${nftIfs(wanIfs)} oifname ${nftIfs(lanIfs)} ct status dnat accept`, label: 'Port yönlendirmeleri', kind: 'system' as const }] : []),
            // Wi-Fi köprüsü: üst ağdaki cihazlar (ve modemin port yönlendirmeleri) ev tarafındaki cihazlara yeni bağlantı açabilir.
            ...(sameNet ? [{ rule: `iifname ${nftIfs(wanIfs)} oifname ${nftIfs(lanIfs)} accept`, label: 'Wi-Fi köprüsü: üst ağdan ev tarafına', kind: 'system' as const }] : []),
        ];
        const nat: NftLine[] = [
            ...(sameNet ? [] : [{ rule: `oifname ${nftIfs(wanIfs)} masquerade`, label: 'İnternet çıkışında adres çevirisi', kind: 'system' as const }]),
            { rule: 'oifname "wg_vps*" masquerade', label: 'VPS tünel çıkışında adres çevirisi', kind: 'system' },
        ];
        const body = (xs: NftLine[]) => xs.map(l => `        ${l.rule}`).join('\n');

        // ÖNEMLI: `flush ruleset` KULLANILMAZ — yalnızca kendi tablolarımızı idempotent yönetiriz.
        // Böylece zapret NFQUEUE, domain_routing ve pi5_block tabloları korunur.
        // Boş-tanımla → sil → yeniden-tanımla deseni her yüklemede (boot/reload) idempotent çalışır.
        const nftablesConfig = `#!/usr/sbin/nft -f
table inet pi5_filter {}
delete table inet pi5_filter
table inet pi5_filter {
    chain input {
        type filter hook input priority 0; policy drop;
${body(input)}
    }
    chain forward {
        type filter hook forward priority 0; policy drop;
${body(forward)}
    }
}
table ip pi5_nat {}
delete table ip pi5_nat
table ip pi5_nat {
    chain postrouting {
        type nat hook postrouting priority 100;
        # WAN çıkışı + VPS tünel çıkışı (Pi5-tarafı SNAT: LAN kaynaklı paketler tünelden doğru dönebilsin)
${body(nat)}
    }
}

# Kalıcılık: domain-routing/device-block/zapret gibi ek tablolar boot'ta yüklensin
include "/etc/nftables.d/*.conf"
`; // Sondaki satır sonu şart: nft 1.1 (trixie) son satırdaki include'u "unexpected end of file" ile reddediyordu.
        const mode = wanMode ? 'wan' : sameNet ? 'sameNet' : oneArm ? 'oneArm' : 'twoCard';
        return { config: nftablesConfig, mode, lanIfs, wanIfs, input, forward, nat };
    },

    // Doğrulamalı uygulama: yapılandırma geçici dosyada `nft -c` ile sınanır, yüklenir, ANCAK SONRA /etc/nftables.conf olur.
    // Sınama ya da yükleme başarısızsa diskteki dosya ve yüklü kurallar değişmez (eskiden dosya önce yazılıyordu: bozuk
    // yapılandırma açılışta yüklenmeye çalışılırdı). `nft -f` tek işlemdir: yarım kural kalmaz.
    async configureNftables(ifaces?: { lan?: string; wan?: string }, customInputRules?: string[]) {
        const b = await this.buildNftables(ifaces, customInputRules);
        fs.mkdirSync('/etc/nftables.d', { recursive: true });
        const tmp = `${NFT_CONF}.pi5-new.${process.pid}.${++nftTmpSeq}`;
        fs.writeFileSync(tmp, b.config);
        try {
            const chk = await runResult(`nft -c -f ${tmp}`, 20000);
            if (chk.code !== 0) throw new Error(`Güvenlik duvarı kuralları sınamadan geçmedi — hiçbir şey değişmedi: ${(chk.stderr || chk.stdout).trim().slice(0, 400)}`);
            const load = await runResult(`nft -f ${tmp}`, 20000);
            if (load.code !== 0) throw new Error(`Güvenlik duvarı kuralları yüklenemedi — önceki kurallar geçerli: ${(load.stderr || load.stdout).trim().slice(0, 400)}`);
            fs.renameSync(tmp, NFT_CONF);
        } finally {
            try { fs.unlinkSync(tmp); } catch { /* taşındı */ }
        }
        await execAsync('systemctl enable nftables 2>/dev/null || true');
        const mode = b.mode === 'oneArm' ? ', tek bacak' : b.mode === 'wan' ? ', internet kartı' : b.mode === 'sameNet' ? ', Wi-Fi köprüsü (aynı ağ)' : '';
        return { stdout: `nftables yapılandırıldı (WAN=${b.wanIfs.join('+')}, LAN=${b.lanIfs.join('+')}${mode}).`, stderr: '' };
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
