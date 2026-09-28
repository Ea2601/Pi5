import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Derleme kimliği = derlenen git commit'i. Arayüze __APP_BUILD__ olarak gömülür, dist/build.json'a da yazılır: açık sayfa
// build.json'u yoklar, kimlik değiştiyse Pi'de YENİ arayüz sunuluyordur (LiveVersionNotice). version.json kullanılmaz:
// güncellemenin başında (git reset) değişir, arayüz ise dakikalar sonra derlenir. Aynı commit yeniden derlenirse kimlik
// değişmez (boşuna yenileme yok). git yoksa 'dev' → izleme kapalı.
const BUILD_ID = (() => {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev' } catch { return 'dev' }
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
  },
})
