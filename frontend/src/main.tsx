import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Yazı tipleri panelle birlikte paketlenir (Pi'den sunulur): Google Fonts'a bağımlıyken internetsiz ağda (ör. kurulum
// Wi-Fi'ı) tarayıcı o isteği bekleyip panelin stillerini uygulamıyordu — sayfa yalnız yazı olarak görünüyordu.
// Ağırlık dosyaları tüm alt kümeleri unicode-range ile tanımlar; tarayıcı yalnız gerekeni (latin, latin-ext: Türkçe) indirir.
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './index.css'
import App from './App.tsx'
import { getStoredTheme, applyThemeClass } from './theme'
import { installAuthInterceptor } from './auth'

// Oturumsuz API yanıtını (401 + X-Pi5-Auth) her fetch'te yakala → giriş ekranı (bkz. auth.ts)
installAuthInterceptor()

// Render öncesi kayıtlı temayı uygula — açık temada dark-flash olmasın
const storedTheme = getStoredTheme()
if (storedTheme) applyThemeClass(storedTheme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
