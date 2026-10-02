// Web önizlemesi (yalnız geliştirme): uygulamayı telefona özgü modüllerin sahteleriyle (preview/, metro.config.js) web'e
// derler ve yerelde sunar. Tarayıcıda telefon boyutunda açın:
//   http://127.0.0.1:8099/                         ilk kurulum
//   http://127.0.0.1:8099/?paired=1&theme=dark      ana ekran (koyu)    &theme=light açık · &pi=down Pi'ye ulaşılamıyor
//   npm run preview            derle + sun          npm run preview -- --serve   yalnız sun (önceki derleme)
import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.preview');
const port = Number(process.env.PORT || 8099);
if (!process.argv.includes('--serve')) {
  execSync(`npx expo export --platform web --output-dir "${out}" --clear`, { cwd: root, stdio: 'inherit', env: { ...process.env, KLYRIX_PREVIEW: '1' } });
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = path.join(out, u);
  if (!f.startsWith(out) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(out, 'index.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`önizleme: http://127.0.0.1:${port}/`));
