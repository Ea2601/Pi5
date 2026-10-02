// Lisans doğrulama açık anahtarları (G3.2, license.ts): kid → Ed25519 açık anahtarı (SPKI PEM). Token'ın payload'ındaki
// kid hangi anahtarla doğrulanacağını seçer; anahtar döndürme yeni kid eklenip eskisi sonraki sürümde çıkarılarak yapılır.
// Burada yalnız AÇIK anahtar durur. Özel anahtar ve imzalama aracı depo dışındadır (%USERPROFILE%\.klyrix\license-tool;
// keygen.mjs / sign.mjs / verify.mjs) ve bu depoya hiçbir zaman girmez (.gitignore: *.pem, *.key, license-tool/).
//  - dev2026: GELİŞTİRME / TEST anahtarı. Bugün hiçbir özellik lisansa bağlı değil (license.ts FEATURE_PLAN), bu anahtarla
//    üretilen token hiçbir şeyi açmaz. Üretim anahtarı Final fazında (katman ataması) eklenecek ve dev2026 o sürümde
//    buradan çıkarılacak. Unutulursa da güvenli: 'dev' ile başlayan kid'ler, FEATURE_PLAN'da community dışı bir katman
//    olduğu anda verifyToken'da reddedilir (license.ts devKeysAllowed).
export const LICENSE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  dev2026: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA3gZZjyZW4D6WWuiIZki6IATdN+ipleLGkjdLrFPgr4M=
-----END PUBLIC KEY-----
`,
});
