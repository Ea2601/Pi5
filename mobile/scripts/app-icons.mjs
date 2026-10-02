// Uygulama simgeleri — panelin logosundan üretilir (frontend/public/klyrix-gate-icon-512.svg; panelin PWA ikonlarıyla aynı
// çizim: degrade zemin, üst parlama, işaret — frontend/scripts/pwa-icons.mjs). Logo değişince yeniden çalıştırıp çıktıları
// commit edin; derleme sırasında üretilmez.
//   cd <boş bir klasör> && npm i @resvg/resvg-js && node <depo>/mobile/scripts/app-icons.mjs
// Çıktılar (mobile/assets/, app.json kullanır):
//   icon.png (1024)                iOS / varsayılan: kenarsız opak kare (iOS köşeleri kendisi yuvarlar, saydamı siyaha boyar)
//   adaptive-foreground.png (1024) Android uyarlanabilir simge ön planı: yalnız işaret, saydam, güvenli alanda
//   adaptive-background.png (1024) Android arka planı: zemin + degrade + parlama (işaretsiz)
//   adaptive-monochrome.png (1024) Android 13+ temalı simge: yalnız işaret (beyaz, saydam)
//   splash-icon.png (1024)         açılış ekranı: logonun ikonu birebir (yuvarlak köşeli, köşeler saydam)
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../assets');
const require = createRequire(path.join(process.cwd(), 'noop.js')); // resvg çalışılan klasörden (geçici kurulum)
const { Resvg } = require('@resvg/resvg-js');

const src = fs.readFileSync(path.resolve(here, '../../frontend/public/klyrix-gate-icon-512.svg'), 'utf8');
const defs = /<defs>[\s\S]*?<\/defs>/.exec(src)?.[0];
const mark = /<g transform="translate\(256\.0,256\.0\) scale\(4\.0\)">([\s\S]*?)<\/g>/.exec(src)?.[1];
if (!defs || !mark) throw new Error('klyrix-gate-icon-512.svg beklenen biçimde değil (degrade / işaret grubu bulunamadı)');
const BG = '#0a0e14'; // panelin koyu zemini (index.css --bg-color)

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${defs}${body}</svg>`;
const ground = `<rect width="512" height="512" fill="${BG}"/><rect width="512" height="512" fill="url(#bg)"/><rect width="512" height="256" fill="url(#shine)"/>`;
const markAt = (scale) => `<g transform="translate(256,256) scale(${scale})">${mark}</g>`;
// Android güvenli alanı: 108 dp tuvalde 66 dp çaplı daire (yarıçap ~%30.5 → 512'de ~156 px). İşaretin en uzak köşesi 4.0
// ölçekte ~190 px → 3.2 ile ~152 px (içeride).
const ANDROID_SCALE = 3.2;

const png = (s, size) => new Resvg(s, { fitTo: { mode: 'width', value: size } }).render().asPng();
const files = {
  'icon.png': png(svg(ground + markAt(4.0)), 1024),
  'adaptive-foreground.png': png(svg(markAt(ANDROID_SCALE)), 1024),
  'adaptive-background.png': png(svg(ground), 1024),
  'adaptive-monochrome.png': png(svg(markAt(ANDROID_SCALE)), 1024),
  'splash-icon.png': png(src, 1024),
};
fs.mkdirSync(out, { recursive: true });
for (const [name, buf] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, name), buf);
  console.log(`${name}  ${buf.length} B`);
}
