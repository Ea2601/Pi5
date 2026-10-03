//go:build tools

// gomobile bind modülde golang.org/x/mobile/bind'i ister; hiçbir paket onu içe aktarmadığı için go mod tidy silmesin.
package tools

import _ "golang.org/x/mobile/bind"
