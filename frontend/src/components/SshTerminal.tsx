import { useState, useRef, useEffect, useCallback } from 'react';
import { Terminal, Send, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { postApi } from '../hooks/useApi';
import { Panel } from './ui';

interface TerminalLine {
  type: 'input' | 'output' | 'error' | 'system';
  text: string;
}

const WELCOME_BANNER = `  Pi5 Secure Gateway — SSH Terminal
  Komut göndermek için aşağıdaki alana yazın.
  Geçmiş: ↑/↓  |  İptal: Ctrl+C  |  "help" yazarak komut listesini görün.`;

interface QuickCmd {
  cmd: string;
  desc: string;
}

interface QuickGroup {
  label: string;
  commands: QuickCmd[];
}

const QUICK_COMMANDS: QuickGroup[] = [
  {
    label: 'Sistem Bilgisi',
    commands: [
      { cmd: 'uptime', desc: 'Sistem çalışma süresi ve yük ortalaması' },
      { cmd: 'free -h', desc: 'Bellek (RAM) kullanımı' },
      { cmd: 'df -h', desc: 'Disk kullanımı ve bölümler' },
      { cmd: 'vcgencmd measure_temp', desc: 'CPU sıcaklığı' },
      { cmd: 'uname -a', desc: 'Kernel ve işletim sistemi bilgisi' },
      { cmd: 'cat /etc/os-release', desc: 'Linux dağıtım bilgisi' },
      { cmd: 'hostname', desc: 'Sunucu adı' },
    ],
  },
  {
    label: 'Ağ & Bağlantı',
    commands: [
      { cmd: 'ip addr show eth0', desc: 'LAN arayüzü IP adresi' },
      { cmd: 'ss -tulnp', desc: 'Açık portlar ve dinleyen servisler' },
      { cmd: 'wg show', desc: 'WireGuard tünel durumu ve handshake' },
      { cmd: 'nft list ruleset', desc: 'Tüm nftables güvenlik duvarı kuralları' },
    ],
  },
  {
    label: 'DNS & Pi-hole',
    commands: [
      { cmd: 'pihole status', desc: 'Pi-hole çalışma durumu' },
      { cmd: 'pihole -q google.com', desc: 'Domain engelli mi kontrol et' },
      { cmd: 'dig @127.0.0.1 -p 5335 google.com', desc: 'Unbound DNS çözümleme testi' },
    ],
  },
  {
    label: 'Güvenlik',
    commands: [
      { cmd: 'fail2ban-client status', desc: 'Fail2Ban jail durumları' },
      { cmd: 'fail2ban-client status sshd', desc: 'SSH jail detayı ve banlı IP\'ler' },
      { cmd: 'systemctl status pihole-FTL', desc: 'Pi-hole FTL servis durumu' },
    ],
  },
  {
    label: 'Dosya & Dizin',
    commands: [
      { cmd: 'ls', desc: 'Mevcut dizin içeriği' },
      { cmd: 'pwd', desc: 'Mevcut çalışma dizini' },
      { cmd: 'date', desc: 'Sistem tarih ve saati' },
      { cmd: 'whoami', desc: 'Aktif kullanıcı' },
    ],
  },
];

export function SshTerminal() {
  const [lines, setLines] = useState<TerminalLine[]>([
    { type: 'system', text: WELCOME_BANNER }
  ]);
  const [input, setInput] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [executing, setExecuting] = useState(false);
  const [showQuickCmds, setShowQuickCmds] = useState(true);
  const [expandedGroup, setExpandedGroup] = useState<string | null>('Sistem Bilgisi');
  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => { scrollToBottom(); }, [lines, scrollToBottom]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const addLine = (type: TerminalLine['type'], text: string) => {
    setLines(prev => [...prev, { type, text }]);
  };

  const runCommand = async (cmd: string) => {
    if (!cmd.trim()) return;
    addLine('input', `$ ${cmd}`);
    setCommandHistory(prev => [cmd, ...prev.filter(c => c !== cmd)].slice(0, 50));
    setHistoryIndex(-1);
    setInput('');
    setExecuting(true);

    if (cmd.trim() === 'clear') {
      setLines([{ type: 'system', text: 'Terminal temizlendi.' }]);
      setExecuting(false);
      return;
    }

    try {
      const result = await postApi('/terminal/execute', { command: cmd });
      const output = result.output || 'Komut çalıştırıldı.';
      if (typeof output === 'string') {
        output.split('\n').forEach((line: string) => addLine('output', line));
      }
    } catch (e: unknown) {
      addLine('error', e instanceof Error ? e.message : 'Komut çalıştırılamadı.');
    }
    setExecuting(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runCommand(input);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const idx = Math.min(historyIndex + 1, commandHistory.length - 1);
        setHistoryIndex(idx);
        setInput(commandHistory[idx]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const idx = historyIndex - 1;
        setHistoryIndex(idx);
        setInput(commandHistory[idx]);
      } else {
        setHistoryIndex(-1);
        setInput('');
      }
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      addLine('input', `$ ${input}^C`);
      setInput('');
      setExecuting(false);
    }
  };

  return (
    <div className="fade-in">
      <div className="terminal-layout">
        {/* Quick commands sidebar */}
        <div className={`terminal-sidebar ${showQuickCmds ? '' : 'terminal-sidebar-hidden'}`}>
          <div className="terminal-sidebar-header">
            <strong>Hazır Komutlar</strong>
            <button className="icon-btn icon-btn-sm" onClick={() => setShowQuickCmds(!showQuickCmds)}>
              {showQuickCmds ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          </div>
          {showQuickCmds && QUICK_COMMANDS.map(group => (
            <div key={group.label} className="terminal-cmd-group">
              <button className="terminal-cmd-group-header"
                onClick={() => setExpandedGroup(expandedGroup === group.label ? null : group.label)}>
                {expandedGroup === group.label ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>{group.label}</span>
              </button>
              {expandedGroup === group.label && (
                <div className="terminal-cmd-list">
                  {group.commands.map(c => (
                    <button key={c.cmd} className="terminal-cmd-btn" onClick={() => runCommand(c.cmd)}
                      disabled={executing} title={c.desc}>
                      <code>{c.cmd}</code>
                      <span>{c.desc}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Terminal area */}
        <div className="terminal-main">
          <Panel
            title="SSH Terminal"
            icon={<Terminal size={20} style={{ marginRight: 8 }} />}
            subtitle="Raspberry Pi 5 uzak komut satırı"
            actions={
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn-outline btn-sm"
                  onClick={() => setShowQuickCmds(!showQuickCmds)}>
                  {showQuickCmds ? 'Komutları Gizle' : 'Komutları Göster'}
                </button>
                <button className="btn-outline btn-sm"
                  onClick={() => setLines([{ type: 'system', text: 'Terminal temizlendi.' }])}>
                  <Trash2 size={13} /> Temizle
                </button>
              </div>
            }
          >
            <div
              ref={terminalRef}
              onClick={() => inputRef.current?.focus()}
              className="terminal-output"
            >
              {lines.map((line, i) => (
                <div key={i} className={`terminal-line terminal-line-${line.type}`}>
                  {line.text}
                </div>
              ))}
              {executing && <div className="terminal-line terminal-line-executing">Çalıştırılıyor...</div>}
            </div>

            <div className="terminal-input-bar">
              <span className="terminal-prompt">$</span>
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Komut girin... (help ile komut listesi)"
                disabled={executing}
                className="terminal-input"
              />
              <button className="btn-primary btn-sm" onClick={() => runCommand(input)}
                disabled={executing || !input.trim()}>
                <Send size={13} />
              </button>
            </div>

            {commandHistory.length > 0 && (
              <div className="terminal-history">
                <span className="text-muted" style={{ fontSize: 11 }}>Son:</span>
                {commandHistory.slice(0, 8).map((cmd, i) => (
                  <button key={i} className="terminal-history-btn" onClick={() => setInput(cmd)}>
                    {cmd.length > 25 ? cmd.slice(0, 25) + '…' : cmd}
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
