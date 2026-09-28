// Giriş ekranı ile panelin ortak arka planı: iki renk halkası + ağ çizgileri (Pi merkezde, cihazlar çevrede). Salt süs:
// ekran okuyucuya kapalı, dokunma almaz. 'login' hareketlidir (akan ışık + merkezde nabız). 'panel' hareketsizdir: panelde
// onlarca cam kart (backdrop-filter: blur) var; arkalarında hareket olursa tarayıcı bulanıklığı her karede yeniden
// hesaplar (telefonda ısınma / takılma). Girişte tek kart olduğu için orada sorun yok.
export function NetworkBackdrop({ variant = 'login' }: { variant?: 'login' | 'panel' }) {
  return (
    <div className={`net-bg net-bg-${variant}`} aria-hidden="true">
      <svg viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice">
        <line x1="120" y1="140" x2="360" y2="260" /><line x1="360" y1="260" x2="600" y2="400" />
        <line x1="600" y1="400" x2="880" y2="250" /><line x1="880" y1="250" x2="1080" y2="360" />
        <line x1="600" y1="400" x2="820" y2="620" /><line x1="600" y1="400" x2="330" y2="600" />
        <line x1="330" y1="600" x2="140" y2="520" /><line x1="820" y1="620" x2="1060" y2="660" />
        <line x1="880" y1="250" x2="960" y2="90" /><line x1="360" y1="260" x2="300" y2="80" />
        {variant === 'login' && (
          <>
            <line className="net-flow" x1="120" y1="140" x2="600" y2="400" />
            <line className="net-flow net-flow-b" x1="600" y1="400" x2="1080" y2="360" />
            <line className="net-flow net-flow-b" x1="140" y1="520" x2="600" y2="400" />
            <line className="net-flow" x1="600" y1="400" x2="1060" y2="660" />
          </>
        )}
        <circle cx="120" cy="140" r="3" /><circle cx="360" cy="260" r="3.5" /><circle cx="880" cy="250" r="3.5" />
        <circle cx="1080" cy="360" r="3" /><circle cx="820" cy="620" r="3" /><circle cx="330" cy="600" r="3" />
        <circle cx="140" cy="520" r="2.5" /><circle cx="1060" cy="660" r="2.5" /><circle cx="960" cy="90" r="2.5" />
        <circle cx="300" cy="80" r="2.5" />
        <circle className="net-hub" cx="600" cy="400" r="6" />
      </svg>
    </div>
  );
}
