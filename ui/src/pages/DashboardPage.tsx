import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, LogOut, Copy, Square, Loader2, AlertTriangle, X } from 'lucide-react';
import { useBotStatus } from '../hooks/useBotStatus';
import { useConfig } from '../hooks/useConfig';
import { wsClient } from '../lib/ws';
import { authApi, botApi } from '../lib/api';
import { useQueryClient as useQC } from '@tanstack/react-query';
import StatsCards from './dashboard/StatsCards';
import TradesFeed from './dashboard/TradesFeed';
import WalletPanel from './dashboard/WalletPanel';
import ConfigEditor from './dashboard/ConfigEditor';
import StatusBar from './dashboard/StatusBar';
import { formatUptime } from '../lib/utils';

function ResetModal({ onConfirm, onCancel, loading }: { onConfirm: () => void; onCancel: () => void; loading: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="bg-[#111111] border border-[#1A1A1A] w-full max-w-sm">
        <div className="flex items-start justify-between p-5 pb-4 border-b border-[#1A1A1A]">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-[#FF4444] shrink-0" />
            <span className="font-sans font-semibold text-white">Reset & Start Over?</span>
          </div>
          <button onClick={onCancel} disabled={loading} className="text-[#6e6e6e] hover:text-white transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="font-mono text-[12px] text-[#999999]">
            This will <span className="text-[#FF4444] font-semibold">permanently delete</span> all stored data:
          </p>
          <ul className="space-y-1 pl-3">
            {['Password', 'Wallet & private key', 'Bot configuration', 'Target wallet settings'].map((item) => (
              <li key={item} className="font-mono text-[11px] text-[#6e6e6e] flex items-center gap-2">
                <span className="w-1 h-1 bg-[#404040] shrink-0" />
                {item}
              </li>
            ))}
          </ul>
          <p className="font-mono text-[11px] text-[#6e6e6e]">The bot will be stopped. This cannot be undone.</p>
          <div className="flex gap-2 pt-1">
            <button
              onClick={onCancel}
              disabled={loading}
              className="flex-1 h-10 bg-black border border-[#1A1A1A] font-mono text-[12px] font-medium text-[#6e6e6e] hover:border-[#404040] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={loading}
              className="flex-1 h-10 bg-[#FF4444] font-mono text-[12px] font-semibold text-white hover:bg-red-600 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="h-3 w-3 animate-spin" />}
              {loading ? 'Resetting…' : 'Reset everything'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { data: status } = useBotStatus();
  const { data: cfg } = useConfig();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showReset, setShowReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [addrCopied, setAddrCopied] = useState(false);

  const isRunning = status?.status === 'running';

  const handleReset = async () => {
    setResetting(true);
    try { await authApi.wipe(); } catch {}
    localStorage.removeItem('token');
    sessionStorage.removeItem('_wizpwd');
    wsClient.disconnect();
    queryClient.clear();
    navigate('/auth', { replace: true });
  };

  const copyTarget = () => {
    if (!cfg?.targetWallet) return;
    navigator.clipboard.writeText(cfg.targetWallet);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-black flex flex-col">
      {showReset && (
        <ResetModal onConfirm={handleReset} onCancel={() => setShowReset(false)} loading={resetting} />
      )}

      {/* Header */}
      <header className="border-b border-[#1A1A1A] h-14 flex items-center gap-4 px-8 shrink-0">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <Bot className="w-4.5 h-4.5 text-[#BFFF00]" style={{ width: 18, height: 18 }} />
          <span className="font-sans font-semibold text-[13px] text-white tracking-[3px]">COPY BOT</span>
        </div>

        <div className="w-px h-5 bg-[#1A1A1A]" />

        {/* Target address */}
        {cfg?.targetWallet && (
          <>
            <span className="font-mono text-[10px] font-medium text-[#6e6e6e] tracking-widest">TARGET</span>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[12px] text-[#BFFF00]">
                {cfg.targetWallet.slice(0, 6)}…{cfg.targetWallet.slice(-4)}
              </span>
              <button onClick={copyTarget} className="text-[#6e6e6e] hover:text-white transition-colors">
                <Copy className="w-3 h-3" />
              </button>
              {addrCopied && <span className="font-mono text-[10px] text-[#BFFF00]">Copied!</span>}
            </div>
          </>
        )}

        <div className="flex-1" />

        {/* Status */}
        <div className={`w-1.5 h-1.5 shrink-0 ${isRunning ? 'bg-[#BFFF00] animate-pulse' : 'bg-[#404040]'}`} />
        <span className={`font-mono text-[11px] font-medium ${isRunning ? 'text-[#BFFF00]' : 'text-[#6e6e6e]'}`}>
          {status?.status?.toUpperCase() ?? 'STOPPED'}
        </span>
        {isRunning && status?.startedAt && (
          <span className="font-mono text-[11px] text-[#6e6e6e]">{formatUptime(status.startedAt)}</span>
        )}

        <div className="w-px h-5 bg-[#1A1A1A]" />

        {/* Controls */}
        <StatusBar status={status} compact />

        <div className="w-px h-5 bg-[#1A1A1A]" />

        <button
          onClick={() => setShowReset(true)}
          className="text-[#6e6e6e] hover:text-[#FF4444] transition-colors p-1"
          title="Reset & start over"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </header>

      {/* Stats */}
      <StatsCards stats={status?.stats} />

      {/* Main body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Trades feed (2/3) */}
        <div className="flex-1 flex border-r border-[#1A1A1A] overflow-hidden">
          <TradesFeed />
        </div>

        {/* Right sidebar (fixed width) */}
        <div className="w-80 flex flex-col gap-0 overflow-y-auto shrink-0">
          <WalletPanel walletAddress={status?.walletAddress ?? cfg?.walletAddress ?? ''} />
          <ConfigEditor />
        </div>
      </div>
    </div>
  );
}
