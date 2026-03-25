import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Square, Play, Loader2, AlertTriangle, X } from 'lucide-react';
import { botApi } from '../../lib/api';
import type { BotStatusPayload } from '../../lib/api';

interface Props { status: BotStatusPayload | undefined; compact?: boolean; }

function ApprovalModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="bg-[#111111] border border-[#1A1A1A] w-full max-w-md">
        <div className="flex items-start justify-between p-5 pb-4 border-b border-[#1A1A1A]">
          <div className="flex items-center gap-2 text-[#F59E0B]">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="font-sans font-semibold text-white">USDC Approval Required</span>
          </div>
          <button onClick={onClose} className="text-[#6e6e6e] hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <p className="font-mono text-[12px] text-[#999999]">
            Your wallet needs to approve USDC spending before the bot can place orders. This is a one-time on-chain transaction that costs a small amount of MATIC for gas.
          </p>
          <ol className="space-y-1.5 pl-3">
            {[
              'Ensure your wallet has MATIC for gas (~0.01 MATIC)',
              'Go to polymarket.com and connect your wallet',
              'Deposit any amount of USDC to trigger approval',
              'Come back here and start the bot',
            ].map((s, i) => (
              <li key={i} className="font-mono text-[11px] text-[#999999] flex gap-2">
                <span className="text-[#BFFF00] shrink-0">{i + 1}.</span>
                {s}
              </li>
            ))}
          </ol>
          <button onClick={onClose} className="w-full h-10 bg-[#BFFF00] font-mono text-[12px] font-semibold text-black hover:bg-[#d4ff33] transition-colors mt-2">
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function isApprovalError(msg: string) {
  const l = msg.toLowerCase();
  return l.includes('allowance') || l.includes('approval') || l.includes('approve') || l.includes('not enough balance');
}

export default function StatusBar({ status, compact }: Props) {
  const qc = useQueryClient();
  const [showPwd, setShowPwd] = useState(false);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showApproval, setShowApproval] = useState(false);

  const isRunning = status?.status === 'running';
  const isTransitioning = status?.status === 'starting' || status?.status === 'stopping';

  const handleStop = async () => {
    setLoading(true);
    try {
      await botApi.stop();
      qc.invalidateQueries({ queryKey: ['bot-status'] });
    } finally {
      setLoading(false);
    }
  };

  const handleStart = async () => {
    if (!password) { setShowPwd(true); return; }
    setLoading(true);
    setError('');
    try {
      await botApi.start(password);
      setShowPwd(false);
      setPassword('');
      qc.invalidateQueries({ queryKey: ['bot-status'] });
    } catch (err: any) {
      const msg: string = err?.response?.data?.error ?? 'Failed to start';
      setError(msg);
      if (isApprovalError(msg)) setShowApproval(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {showApproval && <ApprovalModal onClose={() => setShowApproval(false)} />}

      <div className="flex items-center gap-3">
        {showPwd && !isRunning && (
          <div className="flex items-center gap-2">
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleStart()}
              autoFocus
              className="h-8 w-32 bg-black border border-[#1A1A1A] px-2.5 font-mono text-[12px] text-white placeholder:text-[#404040] outline-none focus:border-[#BFFF00] transition-colors"
            />
            {error && (
              <span className="font-mono text-[10px] text-[#FF4444] max-w-[120px] truncate">{error}</span>
            )}
          </div>
        )}

        {isRunning ? (
          <button
            onClick={handleStop}
            disabled={loading || isTransitioning}
            className="flex items-center gap-1.5 h-8 px-3.5 bg-black border border-[#FF4444] font-mono text-[12px] font-medium text-[#FF4444] hover:bg-[#FF4444]/10 transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
            STOP
          </button>
        ) : (
          <button
            onClick={handleStart}
            disabled={loading || isTransitioning}
            className="flex items-center gap-1.5 h-8 px-3.5 bg-[#BFFF00] font-mono text-[12px] font-semibold text-black hover:bg-[#d4ff33] transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            {isTransitioning ? (status?.status === 'starting' ? 'STARTING…' : 'STOPPING…') : 'START'}
          </button>
        )}
      </div>
    </>
  );
}
