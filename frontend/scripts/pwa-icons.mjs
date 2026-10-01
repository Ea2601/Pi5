// PWA / ana ekran ikonları — logonun ikonundan üretilir (public/klyrix-gate-icon-512.svg: kenar çubuğundaki lockup'ın ikonuyla
// aynı çizim: degrade zemin, üst parlama, ince kenar, işaret). Logo değişince yeniden çalıştırıp çıktıları commit edin; derleme
// sırasında üretilmez (Pi'de ek paket gerekmesin).
//   cd <boş bir klasör> && npm i @resvg/resvg-js && node <depo>/frontend/scripts/pwa-icons.mjs
// Çıktılar (public/icons/, manifest.json ve index.html kullanır):
//   klyrix-gate-192.png, klyrix-gate-512.png  "any": logonun ikonu birebir (köşeler saydam)
//   klyrix-gate-maskable-512.png              Android uyarlanabilir ikon: kenarsız zemin, işaret güvenli alanda
//   apple-touch-icon.png (180)                iOS: köşeleri kendisi yuvarlar, saydamı siyaha boyar → kenarsız, opak zemin
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(here, '../public');
const out = path.join(pub, 'icons');
const require = createRequire(path.join(process.cwd(), 'noop.js')); // resvg çalışılan klasörden (geçici kurulum)
const { Resvg } = require('@resvg/resvg-js');

const src = fs.readFileSync(path.join(pub, 'klyrix-gate-icon-512.svg'), 'utf8');
const defs = /<defs>[\s\S]*?<\/defs>/.exec(src)?.[0];
const mark = /<g transform="translate\(256\.0,256\.0\) scale\(4\.0\)">([\s\S]*?)<\/g>/.exec(src)?.[1];
if (!defs || !mark) throw new Error('klyrix-gate-icon-512.svg beklenen biçimde değil (degrade / işaret grubu bulunamadı)');
// Opak zemin: koyu temanın arka planı (index.css --bg-color) — logo panelde bunun üstünde görünür
const BG = '#0a0e14';

// Kenarsız kare: zemin + degrade + üst parlama; işaret ortada `scale` ile (512 tuvalde — logoda 4.0)
const fullBleed = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${defs}
<rect width="512" height="512" fill="${BG}"/><rect width="512" height="512" fill="url(#bg)"/>
<rect width="512" height="256" fill="url(#shine)"/>
<g transform="translate(256,256) scale(${scale})">${mark}</g></svg>`;

const png = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
const files = {
  'klyrix-gate-192.png': png(src, 192),
  'klyrix-gate-512.png': png(src, 512),
  // Güvenli alan: merkezden %40 yarıçap (~205 px). İşaretin en uzak köşesi 4.0 ölçekte ~190 px (sınırda) → 3.4 ile ~162 px
  'klyrix-gate-maskable-512.png': png(fullBleed(3.4), 512),
  'apple-touch-icon.png': png(fullBleed(4.0), 180),
};
fs.mkdirSync(out, { recursive: true });
for (const [name, buf] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, name), buf);
  console.log(`${name}  ${buf.length} B`);
}
