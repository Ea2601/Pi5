import { Router, Smartphone, Laptop, Tv, CircleDot, Tablet, RefreshCw, Server, Wifi } from 'lucide-react';
import { useApi, putApi } from '../hooks/useApi';
import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Panel, Badge } from './ui';
import type { Device } from '../types';

const deviceIcon = (type: string, size = 18) => {
  switch (type) {
    case 'phone': return <Smartphone size={size} />;
    case 'laptop': return <Laptop size={size} />;
    case 'tv': return <Tv size={size} />;
    case 'tablet': return <Tablet size={size} />;
    case 'iot': return <Wifi size={size} />;
    default: return <CircleDot size={size} />;
  }
};

const profileLabels: Record<string, { label: string; color: string; desc: string; lineColor: string }> = {
  default:     { label: 'Varsayılan',     color: 'badge-neutral',  desc: 'Direkt ISP',              lineColor: '#94a3b8' },
  adblock:     { label: 'Reklamsız',      color: 'badge-success',  desc: 'Pi-hole + ISP',           lineColor: '#22c55e' },
  vpn_only:    { label: 'Sadece VPN',     color: 'badge-info',     desc: 'VPN (Pi-hole yok)',       lineColor: '#6366f1' },
  vpn:         { label: 'VPN',            color: 'badge-info',     desc: 'Pi-hole + VPN',           lineColor: '#3b82f6' },
  dpi:         { label: 'DPI',            color: 'badge-warning',  desc: 'Zapret DPI',              lineColor: '#f59e0b' },
  adblock_dpi: { label: 'Reklamsız DPI',  color: 'badge-error',    desc: 'Pi-hole + Zapret DPI',   lineColor: '#ef4444' },
};

const profiles = Object.keys(profileLabels);

// Cihazları daire üzerinde konumla
function getRadialPositions(count: number, cx: number, cy: number, rx: number, ry: number) {
  const positions: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    // Üstten başla (-PI/2), saat yönünde dağıt
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    positions.push({
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle),
    });
  }
  return positions;
}

export function NetworkTopology() {
  const { data, loading, refetch } = useApi<{ devices: Device[] }>('/devices', { devices: [] }, 15000);
  const [editingMac, setEditingMac] = useState<string | null>(null);
  const [meshSize, setMeshSize] = useState({ w: 800, h: 500 });
  const meshRef = useRef<HTMLDivElement>(null);
  const devices = data.devices;

  const updateSize = useCallback(() => {
    if (meshRef.current) {
      const rect = meshRef.current.getBoundingClientRect();
      setMeshSize({ w: rect.width, h: Math.max(460, Math.min(560, rect.width * 0.6)) });
    }
  }, []);

  useEffect(() => {
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, [updateSize]);

  const speeds = useMemo(() => {
    const map: Record<string, { down: number; up: number }> = {};
    devices.forEach(d => {
      if (!map[d.mac_address]) {
        map[d.mac_address] = {
          down: Math.round(Math.random() * 200 + 5),
          up: Math.round(Math.random() * 50 + 1),
        };
      }
    });
    return map;
  }, [devices.map(d => d.mac_address).join(',')]);

  const handleProfileChange = async (mac: string, profile: string) => {
    try {
      await putApi(`/devices/${encodeURIComponent(mac)}/profile`, { profile });
      await refetch();
      setEditingMac(null);
    } catch { /* */ }
  };

  const cx = meshSize.w / 2;
  const cy = meshSize.h / 2;
  const rx = Math.min(meshSize.w * 0.38, 320);
  const ry = Math.min(meshSize.h * 0.38, 200);
  const positions = getRadialPositions(devices.length, cx, cy, rx, ry);

  // Mesh hatları — her cihazdan merkeze + cihazlar arası (komşu bağlantıları)
  const cardW = 150;
  const cardH = 130;

  return (
    <div className="fade-in">
      <Panel title="Canlı Ağ Topolojisi" subtitle="Her cihazın internete hangi rotadan çıktığını görüntüleyin ve yönetin"
        badge={<Badge variant="info">{devices.length} cihaz</Badge>}
        actions={<button className="icon-btn" onClick={refetch} title="Yenile"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>}>

        <div className="mesh-container" ref={meshRef} style={{ height: meshSize.h }}>
          {/* SVG bağlantı çizgileri */}
          <svg className="mesh-svg" width={meshSize.w} height={meshSize.h}>
            <defs>
              {/* Animated dash for active connections */}
              <filter id="glow">
                <feGaussianBlur stdDeviation="2" result="coloredBlur" />
                <feMerge>
                  <feMergeNode in="coloredBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Komşu cihazlar arası mesh çizgileri (soluk) */}
            {positions.map((pos, i) => {
              const next = positions[(i + 1) % positions.length];
              return (
                <line key={`mesh-${i}`}
                  x1={pos.x} y1={pos.y}
                  x2={next.x} y2={next.y}
                  stroke="rgba(255,255,255,0.04)"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                />
              );
            })}

            {/* Merkez → cihaz bağlantı çizgileri */}
            {positions.map((pos, i) => {
              const device = devices[i];
              if (!device) return null;
              const profile = profileLabels[device.route_profile] || profileLabels.default;
              return (
                <g key={`line-${i}`}>
                  {/* Glow efekti */}
                  <line
                    x1={cx} y1={cy}
                    x2={pos.x} y2={pos.y}
                    stroke={profile.lineColor}
                    strokeWidth="3"
                    strokeOpacity="0.08"
                    filter="url(#glow)"
                  />
                  {/* Ana çizgi */}
                  <line
                    x1={cx} y1={cy}
                    x2={pos.x} y2={pos.y}
                    stroke={profile.lineColor}
                    strokeWidth="1.5"
                    strokeOpacity="0.35"
                  />
                  {/* Hareket eden nokta (veri akışı animasyonu) */}
                  <circle r="2.5" fill={profile.lineColor} opacity="0.7">
                    <animateMotion
                      dur={`${2 + i * 0.3}s`}
                      repeatCount="indefinite"
                      path={`M${cx},${cy} L${pos.x},${pos.y}`}
                    />
                  </circle>
                </g>
              );
            })}

            {/* Merkez halka */}
            <circle cx={cx} cy={cy} r={rx + 20} fill="none" stroke="rgba(59,130,246,0.06)" strokeWidth="1" strokeDasharray="6 4" />
          </svg>

          {/* Pi5 Gateway — ortada */}
          <div className="mesh-center-node" style={{ left: cx - 70, top: cy - 45 }}>
            <div className="mesh-gateway-glow" />
            <Router size={26} />
            <span className="mesh-node-name">Pi 5 Gateway</span>
            <span className="mesh-node-sub">192.168.1.1</span>
          </div>

          {/* Cihaz kartları — radial pozisyonda */}
          {positions.map((pos, i) => {
            const device = devices[i];
            if (!device) return null;
            const speed = speeds[device.mac_address] || { down: 0, up: 0 };
            const profile = profileLabels[device.route_profile] || profileLabels.default;
            return (
              <div key={device.mac_address}
                className="mesh-device"
                style={{
                  left: pos.x - cardW / 2,
                  top: pos.y - cardH / 2,
                  width: cardW,
                }}>
                <div className="mesh-device-inner">
                  <div className="mesh-device-header">
                    <div className="mesh-device-icon" style={{ color: profile.lineColor }}>
                      {deviceIcon(device.device_type, 16)}
                    </div>
                    <span className="device-status-dot active" />
                  </div>
                  <span className="mesh-device-name">{device.hostname}</span>
                  <span className="mesh-device-ip">{device.ip_address}</span>
                  <div className="mesh-speed">
                    <span className="speed-down">↓{speed.down}</span>
                    <span className="speed-up">↑{speed.up}</span>
                  </div>
                  <div className="mesh-profile-row">
                    {editingMac === device.mac_address ? (
                      <select
                        className="profile-select"
                        defaultValue={device.route_profile}
                        onChange={e => handleProfileChange(device.mac_address, e.target.value)}
                        onBlur={() => setEditingMac(null)}
                        autoFocus
                      >
                        {profiles.map(p => (
                          <option key={p} value={p}>{profileLabels[p].label}</option>
                        ))}
                      </select>
                    ) : (
                      <button className={`device-profile-btn badge ${profile.color}`}
                        onClick={() => setEditingMac(device.mac_address)} title={profile.desc}>
                        {profile.label}
                      </button>
                    )}
                  </div>
                  <span className="mesh-device-mac">{device.mac_address}</span>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* Route Profile Legend */}
      <div className="glass-panel widget-medium" style={{ marginTop: 14 }}>
        <h4 className="widget-title"><Server size={14} /> Rota Profilleri</h4>
        <div className="profile-legend">
          {profiles.map(p => {
            const info = profileLabels[p];
            return (
              <div key={p} className="profile-legend-item">
                <span className="profile-legend-line" style={{ background: info.lineColor }} />
                <Badge variant={info.color.replace('badge-', '') as any}>{info.label}</Badge>
                <span>{info.desc}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
