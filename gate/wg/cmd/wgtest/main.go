// wgtest: wgbridge'in Linux'ta uçtan uca denemesi (yalnız geliştirme; .aar'a girmez). Pi'ye eşleşir, kullanıcı alanı
// tüneli kurar (root / VPN yok), yerel vekilden paneli ve API'yi açar, güvenlik denetimlerini ve yeniden el sıkışmayı sınar.
// Kullanım: PI=172.31.77.10 CODE=ABCD-EFGH wgtest   (ya da PASSWORD=...)   [STEP=toggle → Ev VPN'i kapat/aç sonrası ölçüm]
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strings"
	"time"

	"klyrixgate/wg/wgbridge"
)

var failed = 0

func check(name string, ok bool, detail string) {
	if ok {
		fmt.Printf("  OK   %s %s\n", name, detail)
	} else {
		failed++
		fmt.Printf("  FAIL %s %s\n", name, detail)
	}
}

func must(err error, what string) {
	if err != nil {
		fmt.Printf("  FAIL %s: %v\n", what, err)
		os.Exit(1)
	}
}

func main() {
	pi := os.Getenv("PI")
	priv, err := wgbridge.GeneratePrivateKey()
	must(err, "anahtar")
	pub, err := wgbridge.PublicKey(priv)
	must(err, "genel anahtar")
	check("anahtar çifti", len(pub) == 44, pub)

	body := map[string]any{"name": "Go köprü testi", "platform": "android", "publicKey": pub, "enableTunnel": true}
	if c := os.Getenv("CODE"); c != "" {
		body["code"] = c
	} else {
		body["password"] = os.Getenv("PASSWORD")
	}
	b, _ := json.Marshal(body)
	res, err := http.Post("http://"+pi+"/api/app/pair", "application/json", bytes.NewReader(b))
	must(err, "eşleşme isteği")
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	check("eşleşme 200", res.StatusCode == 200, string(raw[:min(len(raw), 160)]))
	var pr struct {
		Device struct{ ID int }
		Tunnel struct {
			Address, ServerPublicKey, Gate string
			Port                           int
			Lan                            []string
		}
	}
	must(json.Unmarshal(raw, &pr), "eşleşme yanıtı")

	start := time.Now()
	must(wgbridge.Start(priv, pr.Tunnel.Address, pr.Tunnel.ServerPublicKey, fmt.Sprintf("%s:%d", pi, pr.Tunnel.Port)), "tünel")
	var ms int
	for i := 0; i < 20; i++ {
		if ms, err = wgbridge.Probe(1000); err == nil {
			break
		}
	}
	check("tünel kuruldu, kapıya TCP", err == nil, fmt.Sprintf("(%d ms, toplam %d ms)", ms, time.Since(start).Milliseconds()))
	check("son el sıkışma", wgbridge.LastHandshake() > 0, "")

	first, err := wgbridge.ProxyStart()
	must(err, "vekil")
	u, _ := url.Parse(first)
	base := "http://" + u.Host
	jar, _ := cookiejar.New(nil)
	cl := &http.Client{Jar: jar, Timeout: 15 * time.Second}

	// Sırsız / yanlış Host'lu istek reddedilir
	r0, err := http.Get(base + "/api/auth/status")
	must(err, "sırsız istek")
	check("sırsız istek 403", r0.StatusCode == 403, "")
	r0.Body.Close()
	req, _ := http.NewRequest("GET", base+"/api/auth/status", nil)
	req.Host = "evil.example:" + u.Port()
	r1, err := http.DefaultClient.Do(req)
	must(err, "yanlış Host")
	check("yanlış Host 403", r1.StatusCode == 403, "")
	r1.Body.Close()
	bad, _ := http.Get(base + "/?k=yanlis")
	check("yanlış sır 403", bad.StatusCode == 403, "")
	bad.Body.Close()

	// İlk adres (sırla) → çerez → panel
	p, err := cl.Get(first)
	must(err, "panel")
	page, _ := io.ReadAll(p.Body)
	p.Body.Close()
	check("panel sayfası 200", p.StatusCode == 200 && bytes.Contains(page, []byte(`<div id="root">`)), p.Request.URL.String())
	check("sır adresten silindi", !strings.Contains(p.Request.URL.RawQuery, "k="), p.Request.URL.String())
	a, err := cl.Get(base + "/api/auth/status")
	must(err, "giriş durumu")
	ab, _ := io.ReadAll(a.Body)
	a.Body.Close()
	check("panel oturumu: authenticated + app", strings.Contains(string(ab), `"authenticated":true`) && strings.Contains(string(ab), `"app":true`), string(ab))
	h, err := cl.Get(base + "/api/system/health")
	must(err, "API")
	h.Body.Close()
	check("API 200 (şifresiz)", h.StatusCode == 200, "")
	// Uygulamanın yerel ekranları: çerezsiz, sır başlıkta
	hreq, _ := http.NewRequest("GET", base+"/api/app", nil)
	hreq.Header.Set("X-Klyrix-Key", u.Query().Get("k"))
	hr, err := http.DefaultClient.Do(hreq)
	must(err, "başlıkla istek")
	hb, _ := io.ReadAll(hr.Body)
	hr.Body.Close()
	check("sır başlıkta (çerezsiz) 200", hr.StatusCode == 200 && strings.Contains(string(hb), `"devices"`), "")
	hreq2, _ := http.NewRequest("GET", base+"/api/app", nil)
	hreq2.Header.Set("X-Klyrix-Key", "yanlis")
	hr2, err := http.DefaultClient.Do(hreq2)
	must(err, "yanlış başlık")
	hr2.Body.Close()
	check("yanlış başlık 403", hr2.StatusCode == 403, "")
	// Yazma isteği: Origin vekilin kendisi (WebView'daki gibi) → Pi'nin CSRF denetiminden geçer
	wreq, _ := http.NewRequest("POST", base+"/api/app/pair/cancel", strings.NewReader("{}"))
	wreq.Header.Set("Content-Type", "application/json")
	wreq.Header.Set("Origin", base)
	w, err := cl.Do(wreq)
	must(err, "yazma isteği")
	wb, _ := io.ReadAll(w.Body)
	w.Body.Close()
	check("yazma isteği (Origin = vekil) 200", w.StatusCode == 200, string(wb))

	if os.Getenv("STEP") == "toggle" {
		fmt.Println("  .. Ev VPN'i kapatılıp açılması bekleniyor (TOGGLED dosyası)")
		for i := 0; i < 120; i++ {
			if _, err := os.Stat("/tmp/TOGGLED"); err == nil {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		t0 := time.Now()
		ok := false
		for i := 0; i < 40; i++ {
			rr, err := cl.Get(base + "/api/auth/status")
			if err == nil {
				rr.Body.Close()
				if rr.StatusCode == 200 {
					ok = true
					break
				}
			}
			time.Sleep(500 * time.Millisecond)
		}
		check("Ev VPN'i kapat/aç sonrası 10 sn içinde yeniden bağlandı", ok && time.Since(t0) < 10*time.Second, fmt.Sprintf("(%d ms)", time.Since(t0).Milliseconds()))
	}

	// Kendini kaldır
	dreq, _ := http.NewRequest("DELETE", fmt.Sprintf("%s/api/app/devices/%d", base, pr.Device.ID), nil)
	dreq.Header.Set("Origin", base)
	d, err := cl.Do(dreq)
	must(err, "kaldırma")
	db, _ := io.ReadAll(d.Body)
	d.Body.Close()
	check("telefon kendini kaldırdı", d.StatusCode == 200, string(db))
	time.Sleep(3 * time.Second)
	_ = wgbridge.Rehandshake()
	_, err = wgbridge.Probe(3000)
	check("kaldırıldıktan sonra kapıya ulaşılamaz", err != nil, "")
	wgbridge.ProxyStop()
	wgbridge.Stop()
	check("tünel kapandı", !wgbridge.Running(), "")
	fmt.Printf("\nSONUÇ: %d kaldı\n", failed)
	if failed > 0 {
		os.Exit(1)
	}
}
