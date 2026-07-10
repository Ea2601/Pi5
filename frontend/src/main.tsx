import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { getStoredTheme, applyThemeClass } from './theme'

// Render öncesi kayıtlı temayı uygula — açık temada dark-flash olmasın
const storedTheme = getStoredTheme()
if (storedTheme) applyThemeClass(storedTheme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
