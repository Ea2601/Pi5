import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Panelle aynı yazı tipleri ve tema değişkenleri (Pi'den sunulur; internetsiz de çalışır).
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '../index.css';
import './kiosk.css';
import { Kiosk } from './Kiosk';

createRoot(document.getElementById('kiosk-root')!).render(
  <StrictMode>
    <Kiosk />
  </StrictMode>,
);
