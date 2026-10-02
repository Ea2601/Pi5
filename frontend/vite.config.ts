import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Derleme kimliği = derlenen git commit'i. Arayüze __APP_BUILD__ olarak gömülür, dist/build.json'a da yazılır: açık sayfa
// build.json'u yoklar, kimlik değiştiyse Pi'de YENİ arayüz sunuluyordur (LiveVersionNotice). version.json kullanılmaz:
// güncellemenin başında (git reset) değişir, arayüz ise dakikalar sonra derlenir. Aynı commit yeniden derlenirse kimlik
// değişmez (boşuna yenileme yok). git yoksa 'dev' → izleme kapalı. Tam sha'nın ilk 7 hanesi (--short değil): git'in kısa
// sha uzunluğu depodaki nesne sayısına göre değişir; GitHub'ın hazır paketi (sığ klon) ile Pi'deki derleme aynı commit'e
// aynı kimliği vermeli (scripts/prebuilt.sh build.json'u bununla denetler).
const BUILD_ID = (() => {
  try { return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().slice(0, 7) || 'dev' } catch { return 'dev' }
})()
const APP_VERSION = (() => {
  try { return String(JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8')).version || '') } catch { return '' }
})()

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'pi5-build-json',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ id: BUILD_ID, version: APP_VERSION }) })
      },
    },
  ],
  define: {
    __APP_BUILD__: JSON.stringify(BUILD_ID),
    // Kenar çubuğundaki sürüm rozeti (eskiden brand.ts'te elle yazılmış "v2.7" kalmıştı)
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        // Host tarayıcının adresi olarak kalmalı: backend yazma isteklerinde Origin ile Host'u karşılaştırır (CSRF).
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1000,
    // İki sayfa: panel (index.html) ve HDMI ekranı (kiosk.html — panelin yazı tiplerini, temasını ve bileşenlerini paylaşır;
    // Pi'deki kiosk tarayıcısı http://localhost/kiosk.html açar).
    rolldownOptions: {
      input: { main: 'index.html', kiosk: 'kiosk.html' },
    },
  },
})
