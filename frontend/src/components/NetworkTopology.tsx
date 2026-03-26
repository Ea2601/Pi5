import { Router, Smartphone, Laptop, Tv, CircleDot, Tablet, RefreshCw, Server, Wifi } from 'lucide-react';
import { useApi } from '../hooks/useApi';
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

interface VpsServer { id: number; ip: string; location: string }

interface ProfileInfo {
  label: string;
  color: string;
  desc: string;
  lineColor: string;
}

function getProfileInfo(exitNode: string, dpi: number, vpsList: VpsServer[]): ProfileInfo {
  const vps = exitNode !== 'isp' ? vpsList.find(v => String(v.id) === exitNode) : null;
  if (vps) {
    return dpi
      ? { label: `VPS ${vps.location} + DPI`, color: 'badge-error', desc: `VPN ${vps.location} + DPI Bypass`, lineColor: '#a855f7' }
      : { label: `VPS ${vps.location}`, color: 'badge-info', desc: `VPN ${vps.location}`, lineColor: '#3b82f6' };
  }
  // exitNode not found as VPS but not 'isp' — generic VPS
  if (exitNode !== 'isp') {
    return dpi
      ? { label: 'VPS + DPI', color: 'badge-error', desc: 'VPN + DPI Bypass', lineColor: '#a855f7' }
      : { label: 'VPS', color: 'badge-info', desc: 'VPN tüneli', lineColor: '#3b82f6' };
  }
  return dpi
    ? { label: 'ISP + DPI', color: 'badge-warning', desc: 'ISP + DPI Bypass', lineColor: '#f59e0b' }
    : { label: 'ISP', color: 'badge-neutral', desc: 'Direkt ISP', lineColor: '#94a3b8' };
}

// Cihazları daire üzerinde konumla
function getRadialPositions(count: number, cx: number, cy: number, rx: number, ry: number) {
  const positions: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
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
  const { data: vpsData } = useApi<{ servers: VpsServer[] }>('/vps/list', { servers: [] });
  const [meshSize, setMeshSize] = useState({ w: 800, h: 500 });
  const meshRef = useRef<HTMLDivElement>(null);
  const devices = data.devices;
  const vpsList = vpsData.servers;

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

  const cx = meshSize.w / 2;
  const cy = meshSize.h / 2;
  const rx = Math.min(meshSize.w * 0.38, 320);
  const ry = Math.min(meshSize.h * 0.38, 200);
  const positions = getRadialPositions(devices.length, cx, cy, rx, ry);

  const cardW = 150;
  const cardH = 130;

  // Build legend items from current unique combos + static base
  const legendItems = useMemo(() => {
    const items: ProfileInfo[] = [
      getProfileInfo('isp', 0, vpsList),
      getProfileInfo('isp', 1, vpsList),
    ];
    vpsList.forEach(v => {
      items.push(getProfileInfo(String(v.id), 0, vpsList));
      items.push(getProfileInfo(String(v.id), 1, vpsList));
    });
    return items;
  }, [vpsList]);

  return (
    <div className="fade-in">
      <Panel title="Canlı Ağ Topolojisi" subtitle="Her cihazın internete hangi rotadan çıktığını görüntüleyin ve yönetin"
        badge={<Badge variant="info">{devices.length} cihaz</Badge>}
        actions={<button className="icon-btn" onClick={refetch} title="Yenile"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>}>

        <div className="mesh-container" ref={meshRef} style={{ height: meshSize.h }}>
          {/* SVG bağlantı çizgileri */}
          <svg className="mesh-svg" width={meshSize.w} height={meshSize.h}>
            <defs>
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
              const profile = getProfileInfo('isp', 0, vpsList);
              return (
                <g key={`line-${i}`}>
                  <line
                    x1={cx} y1={cy}
                    x2={pos.x} y2={pos.y}
                    stroke={profile.lineColor}
                    strokeWidth="3"
                    strokeOpacity="0.08"
                    filter="url(#glow)"
                  />
                  <line
                    x1={cx} y1={cy}
                    x2={pos.x} y2={pos.y}
                    stroke={profile.lineColor}
                    strokeWidth="1.5"
                    strokeOpacity="0.35"
                  />
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
            const profile = getProfileInfo('isp', 0, vpsList);
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
                    <span className={`device-profile-btn badge ${profile.color}`}>
                      {profile.label}
                    </span>
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
          {legendItems.map((info, idx) => (
            <div key={idx} className="profile-legend-item">
              <span className="profile-legend-line" style={{ background: info.lineColor }} />
              <Badge variant={info.color.replace('badge-', '') as any}>{info.label}</Badge>
              <span>{info.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
