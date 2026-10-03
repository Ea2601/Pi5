// Package wgbridge: Klyrix/Gate uygulamasının WireGuard köprüsü (gomobile bind → Android .aar; ileride iOS xcframework).
// WireGuard telefonda VPN olarak değil, uygulamanın içinde kullanıcı alanında çalışır (wireguard-go + gVisor netstack): yalnız
// uygulamanın kendi trafiği tünelden geçer; telefonun ağ ayarına, VPN iznine dokunulmaz. Pi tarafı: backend/src/gateApp.ts.
//  - Tek anda tek tünel: her Pi'nin uygulama kapısı aynı adreste (10.77.77.1:8097).
//  - Panel 127.0.0.1'deki ters vekilden açılır; vekil isteği tünelden kapıya iletir. Vekil yalnız Host 127.0.0.1:<port> ve
//    açılışa özel sırla çalışır: ilk istek ?k=<sır> ile gelir, sır HttpOnly çereze yazılır (uygulamanın yerel ekranları sırrı
//    X-Klyrix-Key başlığıyla verir); sırsız ya da başka Host'lu istek 403 — telefondaki diğer uygulamalar ve tarayıcıdaki
//    sayfalar (DNS rebinding dahil) vekili kullanamaz. Sır Pi'ye gitmez; Host başlığı olduğu gibi gider (panelin Origin ==
//    Host denetimi).
//  - Kapıya 3 sn'de bağlanılamazsa el sıkışma hemen yenilenir (eş çıkarılıp yeniden eklenir) ve bir kez daha denenir: Pi'de
//    Ev VPN'i yeniden açıldığında istemci WireGuard'ın 15 sn kuralını beklemez.
package wgbridge

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/curve25519"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

const (
	gateIP     = "10.77.77.1"
	gateAddr   = gateIP + ":8097"
	mtu        = 1280 // mobil ağlarda parçalanmasın (IPv6 alt sınırı)
	keepalive  = 25
	cookieName = "klyrix_gate"
	keyHeader  = "X-Klyrix-Key" // uygulamanın yerel ekranları (WebView çerezi olmadan) aynı sırla
)

var errNotRunning = errors.New("tünel kapalı")

type tunnel struct {
	dev      *device.Device
	tnet     *netstack.Net
	peerHex  string // Pi'nin (sunucunun) genel anahtarı, onaltılık
	endpoint string // çözülmüş ip:port
}

var (
	mu  sync.Mutex
	cur *tunnel
)

// GeneratePrivateKey: yeni WireGuard gizli anahtarı (base64). Telefondan hiç çıkmaz; Pi'ye yalnız genel anahtar gider.
func GeneratePrivateKey() (string, error) {
	var k [32]byte
	if _, err := rand.Read(k[:]); err != nil {
		return "", err
	}
	k[0] &= 248
	k[31] = (k[31] & 127) | 64
	return base64.StdEncoding.EncodeToString(k[:]), nil
}

// PublicKey: gizli anahtarın genel anahtarı (base64)
func PublicKey(privateKey string) (string, error) {
	priv, err := decodeKey(privateKey)
	if err != nil {
		return "", err
	}
	pub, err := curve25519.X25519(priv, curve25519.Basepoint)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(pub), nil
}

func decodeKey(k string) ([]byte, error) {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(k))
	if err != nil || len(b) != 32 {
		return nil, errors.New("geçersiz anahtar")
	}
	return b, nil
}

func keyHex(k string) (string, error) {
	b, err := decodeKey(k)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// "ad:port" → "ip:port" (yalnız IPv4: Pi'nin dış adresi ve DDNS kaydı IPv4)
func resolve(endpoint string) (string, error) {
	host, port, err := net.SplitHostPort(strings.TrimSpace(endpoint))
	if err != nil {
		return "", fmt.Errorf("geçersiz uç adres: %w", err)
	}
	p, err := strconv.ParseUint(port, 10, 16)
	if err != nil || p == 0 {
		return "", errors.New("geçersiz port")
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		return netip.AddrPortFrom(ip.Unmap(), uint16(p)).String(), nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip4", host)
	if err != nil || len(ips) == 0 {
		return "", fmt.Errorf("%s çözülemedi", host)
	}
	return netip.AddrPortFrom(ips[0].Unmap(), uint16(p)).String(), nil
}

func peerConf(peerHex, endpoint string) string {
	return fmt.Sprintf("public_key=%s\nendpoint=%s\nreplace_allowed_ips=true\nallowed_ip=%s/32\npersistent_keepalive_interval=%d\n",
		peerHex, endpoint, gateIP, keepalive)
}

// Start: tüneli kurar (varsa öncekini kapatır). address: telefonun tünel adresi (ör. 10.77.77.254), endpoint: "ad:port".
func Start(privateKey, address, serverPublicKey, endpoint string) error {
	priv, err := keyHex(privateKey)
	if err != nil {
		return err
	}
	peer, err := keyHex(serverPublicKey)
	if err != nil {
		return err
	}
	addr, err := netip.ParseAddr(address)
	if err != nil || !addr.Is4() {
		return errors.New("geçersiz tünel adresi")
	}
	ep, err := resolve(endpoint)
	if err != nil {
		return err
	}
	mu.Lock()
	defer mu.Unlock()
	stopLocked()
	tdev, tnet, err := netstack.CreateNetTUN([]netip.Addr{addr}, nil, mtu)
	if err != nil {
		return err
	}
	dev := device.NewDevice(tdev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "wg: "))
	if err := dev.IpcSet("private_key=" + priv + "\n" + peerConf(peer, ep)); err != nil {
		dev.Close()
		return err
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return err
	}
	cur = &tunnel{dev: dev, tnet: tnet, peerHex: peer, endpoint: ep}
	return nil
}

// Stop: tüneli kapatır (vekil açık kalır; tünel yokken 502 döner)
func Stop() {
	mu.Lock()
	defer mu.Unlock()
	stopLocked()
}

func stopLocked() {
	if cur != nil {
		cur.dev.Close()
		cur = nil
	}
}

// Running: tünel açık mı
func Running() bool {
	mu.Lock()
	defer mu.Unlock()
	return cur != nil
}

// SetEndpoint: uç adresi değiştirir (ör. evden çıkınca ev ağı adresinden DDNS adına) ve el sıkışmayı yeniler
func SetEndpoint(endpoint string) error {
	ep, err := resolve(endpoint)
	if err != nil {
		return err
	}
	mu.Lock()
	defer mu.Unlock()
	if cur == nil {
		return errNotRunning
	}
	cur.endpoint = ep
	return rehandshakeLocked()
}

// Rehandshake: eşi çıkarıp yeniden ekler — oturum sıfırlanır, kalıcı canlı tutma yeni eşte hemen el sıkışma başlatır
func Rehandshake() error {
	mu.Lock()
	defer mu.Unlock()
	if cur == nil {
		return errNotRunning
	}
	return rehandshakeLocked()
}

func rehandshakeLocked() error {
	if err := cur.dev.IpcSet("public_key=" + cur.peerHex + "\nremove=true\n"); err != nil {
		return err
	}
	return cur.dev.IpcSet(peerConf(cur.peerHex, cur.endpoint))
}

// Probe: tünelden kapıya TCP bağlantısı (ms). Hata: Pi'ye ulaşılamıyor.
func Probe(timeoutMs int) (int, error) {
	mu.Lock()
	t := cur
	mu.Unlock()
	if t == nil {
		return 0, errNotRunning
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	start := time.Now()
	c, err := t.tnet.DialContext(ctx, "tcp", gateAddr)
	if err != nil {
		return 0, err
	}
	c.Close()
	return int(time.Since(start).Milliseconds()), nil
}

// LastHandshake: son el sıkışmanın zamanı (unix sn; 0 = hiç)
func LastHandshake() int64 {
	mu.Lock()
	t := cur
	mu.Unlock()
	if t == nil {
		return 0
	}
	s, err := t.dev.IpcGet()
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(s, "\n") {
		if v, ok := strings.CutPrefix(line, "last_handshake_time_sec="); ok {
			n, _ := strconv.ParseInt(v, 10, 64)
			return n
		}
	}
	return 0
}

// ── yerel ters vekil ────────────────────────────────────────────────────────

var (
	pmu      sync.Mutex
	proxySrv *http.Server
	proxyURL string
	lastHeal atomic.Int64
)

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func same(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

// El sıkışmayı yenile (en çok 3 sn'de bir: aynı anda düşen istekler oturumu art arda sıfırlamasın)
func healThrottled() {
	now := time.Now().UnixMilli()
	last := lastHeal.Load()
	if now-last < 3000 || !lastHeal.CompareAndSwap(last, now) {
		return
	}
	_ = Rehandshake()
}

func dialOnce(ctx context.Context, d time.Duration) (net.Conn, error) {
	mu.Lock()
	t := cur
	mu.Unlock()
	if t == nil {
		return nil, errNotRunning
	}
	c, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	return t.tnet.DialContext(c, "tcp", gateAddr)
}

// Kapıya bağlantı: 3 sn'de kurulamazsa (ör. Pi'de Ev VPN'i yeniden başladı, oturum geçersiz — yanıt hiç gelmez) el sıkışma
// yenilenir ve bir kez daha denenir. Tünelden bağlantı normalde onlarca ms'de kurulur.
func dialGate(ctx context.Context) (net.Conn, error) {
	c, err := dialOnce(ctx, 3*time.Second)
	if err == nil || ctx.Err() != nil || errors.Is(err, errNotRunning) {
		return c, err
	}
	healThrottled()
	return dialOnce(ctx, 6*time.Second)
}

// İstekteki vekil çerezini çıkarır: Pi'ye yalnız panelin kendi çerezleri gider
func stripCookie(r *http.Request) {
	cs := r.Cookies()
	r.Header.Del("Cookie")
	for _, c := range cs {
		if c.Name != cookieName {
			r.AddCookie(c)
		}
	}
}

// ProxyStart: vekili başlatır (açıksa aynısı); WebView'ın ilk açacağı adresi döner: http://127.0.0.1:<port>/?k=<sır>
func ProxyStart() (string, error) {
	pmu.Lock()
	defer pmu.Unlock()
	if proxySrv != nil {
		return proxyURL, nil
	}
	secret, err := randomHex(32)
	if err != nil {
		return "", err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	host := fmt.Sprintf("127.0.0.1:%d", ln.Addr().(*net.TCPAddr).Port)
	target, _ := url.Parse("http://" + gateAddr)
	rp := httputil.NewSingleHostReverseProxy(target)
	director := rp.Director
	rp.Director = func(r *http.Request) {
		director(r)
		r.Header["X-Forwarded-For"] = nil // kimlik tünel adresinden; vekil adresi eklenmesin
	}
	// Kapıya her istekte yeni bağlantı: Pi'de Ev VPN'i yeniden başlayınca eski bağlantı ölür ama istemci bunu yanıt hiç
	// gelmediğinde anlar — havuzdaki ölü bağlantıyı kullanan istek takılı kalırdı. Yeni bağlantı tünelde bir gidiş-dönüş.
	rp.Transport = &http.Transport{
		DialContext:           func(ctx context.Context, _, _ string) (net.Conn, error) { return dialGate(ctx) },
		DisableKeepAlives:     true,
		ResponseHeaderTimeout: 310 * time.Second, // uzun panel işlemleri (Pi'de 300 sn)
	}
	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, `{"error":"Pi'ye ulaşılamıyor — bağlantı yeniden kuruluyor"}`)
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != host {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if k := r.URL.Query().Get("k"); k != "" {
			if !same(k, secret) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			http.SetCookie(w, &http.Cookie{Name: cookieName, Value: secret, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
			q := r.URL.Query()
			q.Del("k")
			u := *r.URL
			u.RawQuery = q.Encode()
			http.Redirect(w, r, u.RequestURI(), http.StatusFound)
			return
		}
		ok := false
		if h := r.Header.Get(keyHeader); h != "" {
			ok = same(h, secret)
		} else if c, err := r.Cookie(cookieName); err == nil {
			ok = same(c.Value, secret)
		}
		if !ok {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		// Pi'ye sır gitmez: yalnız panelin kendi çerezleri ve başlıkları
		r.Header.Del(keyHeader)
		stripCookie(r)
		rp.ServeHTTP(w, r)
	})
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	proxySrv = srv
	proxyURL = "http://" + host + "/?k=" + secret
	return proxyURL, nil
}

// ProxyStop: vekili kapatır (sır geçersiz olur; yeniden başlatınca yeni port ve sır)
func ProxyStop() {
	pmu.Lock()
	defer pmu.Unlock()
	if proxySrv != nil {
		_ = proxySrv.Close()
		proxySrv = nil
		proxyURL = ""
	}
}
