#!/usr/bin/env python3
"""Klyrix Gate — ağda yanıt veren DHCP sunucularını bulur (Faz 2: Pi-hole DHCP'si açılmadan / kapatılmadan önce).

Kullanım (root; yalnız python3 standart kütüphanesi):
  python3 dhcp-probe.py --iface eth0 [--timeout 5]

Arayüzün gerçek MAC'iyle yayın bir DHCPDISCOVER gönderir (ham Ethernet çerçevesi: kaynak 0.0.0.0:68 → hedef
255.255.255.255:67) ve süre dolana kadar aynı xid'li yanıtları (UDP 67 → 68) dinler. DHCPREQUEST HİÇ gönderilmez:
teklif kabul edilmediği için hiçbir sunucu kira ayırmaz, arayüzün adresi değişmez.
Çıktı (tek satır JSON):  {"servers":[{"server":"192.168.1.1","yiaddr":"192.168.1.57","router":"192.168.1.1"}]}
Yanıt yoksa servers boştur ve çıkış kodu yine 0'dır. Çalıştırılamazsa (root değil, arayüz yok/kapalı) hata stderr'e
yazılır, çıkış kodu 2.
"""
import argparse
import json
import os
import select
import socket
import struct
import sys
import time

ETH_P_IP = 0x0800
ETH_P_8021Q = 0x8100
MAGIC = b'\x63\x82\x53\x63'
BROADCAST_MAC = b'\xff' * 6
# İlk DISCOVER'dan sonra yeniden gönderim anları (sn). Aynı xid ile tekrar, gerçek istemci gibi: dnsmasq teklif
# etmeden önce adresi ping'le denetler ve ilk DISCOVER'ı yanıtsız bırakabilir; tekrar gelen istek yanıtlanır.
RESEND_AT = (1.5, 3.5)


def fail(msg):
    sys.stderr.write(msg + '\n')
    sys.exit(2)


def iface_mac(iface):
    try:
        with open('/sys/class/net/%s/address' % iface) as f:
            text = f.read().strip()
        mac = bytes(int(x, 16) for x in text.split(':'))
    except (OSError, ValueError):
        fail('arayüz bulunamadı ya da MAC adresi okunamadı: %s' % iface)
    if len(mac) != 6 or mac == b'\0' * 6:
        fail('arayüzün Ethernet MAC adresi yok: %s' % iface)
    return mac


def checksum(data):
    if len(data) % 2:
        data += b'\0'
    s = sum(struct.unpack('!%dH' % (len(data) // 2), data))
    while s >> 16:
        s = (s & 0xffff) + (s >> 16)
    return (~s) & 0xffff


def build_discover(mac, xid, secs):
    # BOOTP başlığı: op=1 (istek), htype=1 (Ethernet), hlen=6, flags=0x8000 (yanıtı yayınla: henüz adresimiz yok).
    bootp = struct.pack('!BBBBIHH4s4s4s4s16s64s128s',
                        1, 1, 6, 0, xid, min(secs, 0xffff), 0x8000,
                        b'\0' * 4, b'\0' * 4, b'\0' * 4, b'\0' * 4,
                        mac + b'\0' * 10, b'\0' * 64, b'\0' * 128)
    # Seçenekler: 53=1 (DHCPDISCOVER), 55 = istenen parametreler (maske, yönlendirici, DNS, sunucu kimliği), 255 son.
    options = MAGIC + bytes([53, 1, 1, 55, 4, 1, 3, 6, 54, 255])
    payload = bootp + options
    if len(payload) < 300:  # bazı sunucular 300 bayttan kısa BOOTP iletisini yok sayar
        payload += b'\0' * (300 - len(payload))
    src, dst = b'\0' * 4, b'\xff' * 4
    udp_len = 8 + len(payload)
    udp_hdr = struct.pack('!HHHH', 68, 67, udp_len, 0)
    pseudo = src + dst + struct.pack('!BBH', 0, socket.IPPROTO_UDP, udp_len)
    csum = checksum(pseudo + udp_hdr + payload) or 0xffff
    udp = struct.pack('!HHHH', 68, 67, udp_len, csum) + payload
    ip = struct.pack('!BBHHHBBH4s4s', 0x45, 0, 20 + len(udp), int.from_bytes(os.urandom(2), 'big'), 0, 64,
                     socket.IPPROTO_UDP, 0, src, dst)
    ip = ip[:10] + struct.pack('!H', checksum(ip)) + ip[12:]
    return BROADCAST_MAC + mac + struct.pack('!H', ETH_P_IP) + ip + udp


def parse_options(data):
    opts = {}
    i = 0
    while i < len(data):
        code = data[i]
        if code == 0:  # dolgu
            i += 1
            continue
        if code == 255 or i + 1 >= len(data):
            break
        length = data[i + 1]
        opts.setdefault(code, data[i + 2:i + 2 + length])
        i += 2 + length
    return opts


def ip4(b):
    # Seçenek birden çok adres taşıyabilir (ör. 3: iki yönlendirici = 8 bayt): ilk adres alınır.
    return socket.inet_ntoa(bytes(b[:4])) if b is not None and len(b) >= 4 else None


def parse_reply(frame, xid):
    """Bizim xid'imize gelen DHCP yanıtıysa {'server','yiaddr','router'} döner, değilse None."""
    if len(frame) < 14:
        return None
    off = 12
    ethertype = struct.unpack('!H', frame[off:off + 2])[0]
    if ethertype == ETH_P_8021Q and len(frame) >= 18:  # VLAN etiketi (çoğunlukla çekirdek zaten ayıklar)
        off += 4
        ethertype = struct.unpack('!H', frame[off:off + 2])[0]
    if ethertype != ETH_P_IP:
        return None
    ip = off + 2
    if len(frame) < ip + 20 or frame[ip] >> 4 != 4 or frame[ip + 9] != socket.IPPROTO_UDP:
        return None
    if struct.unpack('!H', frame[ip + 6:ip + 8])[0] & 0x3fff:  # parçalanmış paket (MF ya da ofset) atlanır
        return None
    src_ip = frame[ip + 12:ip + 16]
    udp = ip + (frame[ip] & 0x0f) * 4
    if len(frame) < udp + 8:
        return None
    sport, dport = struct.unpack('!HH', frame[udp:udp + 4])
    if sport != 67 or dport != 68:
        return None
    bootp = frame[udp + 8:]
    if len(bootp) < 240 or bootp[0] != 2 or bootp[236:240] != MAGIC:
        return None
    if struct.unpack('!I', bootp[4:8])[0] != xid:
        return None
    opts = parse_options(bootp[240:])
    server = opts.get(54)
    router = opts.get(3)
    return {
        'server': ip4(server) if server and len(server) >= 4 else ip4(src_ip),
        'yiaddr': ip4(bootp[16:20]),
        'router': ip4(router) if router and len(router) >= 4 else None,
    }


def main():
    ap = argparse.ArgumentParser(description='DHCP sunucusu taraması (yalnız DHCPDISCOVER; kira alınmaz)')
    ap.add_argument('--iface', required=True)
    ap.add_argument('--timeout', type=float, default=5.0)
    args = ap.parse_args()
    if os.geteuid() != 0:
        fail('root olarak çalıştırın (ham soket gerekir)')
    timeout = max(1.0, min(args.timeout, 30.0))
    mac = iface_mac(args.iface)
    try:
        sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(ETH_P_IP))
        sock.bind((args.iface, ETH_P_IP))
    except OSError as e:
        fail('ham soket açılamadı (%s): %s' % (args.iface, e))
    xid = int.from_bytes(os.urandom(4), 'big')
    started = time.monotonic()
    deadline = started + timeout
    resend = [started + t for t in RESEND_AT if t < timeout]
    servers = []
    seen = set()
    try:
        sock.send(build_discover(mac, xid, 0))
    except OSError as e:
        fail('DHCPDISCOVER gönderilemedi (%s): %s' % (args.iface, e))
    while True:
        now = time.monotonic()
        if now >= deadline:
            break
        if resend and now >= resend[0]:
            resend.pop(0)
            try:
                sock.send(build_discover(mac, xid, int(now - started)))
            except OSError:
                pass  # ilk gönderim başarılıydı; tekrarın hatası taramayı bozmaz
            continue
        wait = deadline - now
        if resend:
            wait = min(wait, max(0.0, resend[0] - now))
        ready, _, _ = select.select([sock], [], [], wait)
        if not ready:
            continue
        try:
            frame = sock.recv(65535)
        except OSError:
            continue
        try:
            reply = parse_reply(frame, xid)
        except (ValueError, OSError, struct.error, IndexError):
            continue  # bozuk / beklenmedik bir çerçeve taramanın tamamını düşürmesin
        if reply and reply['server'] and reply['server'] not in seen:
            seen.add(reply['server'])
            servers.append(reply)
    sock.close()
    print(json.dumps({'servers': servers}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
