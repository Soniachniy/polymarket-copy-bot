import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Play, Square, Loader2, X, AlertTriangle } from 'lucide-react';
import { botApi } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { formatUptime } from '../../lib/utils';
import type { BotStatusPayload } from '../../lib/api';

interface Props { status: BotStatusPayload | undefined; }

function ApprovalModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-md shadow-xl">
        <div className="flex items-start justify-between p-5 pb-3">
          <div className="flex items-center gap-2 text-yellow-400">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <span className="font-semibold text-foreground">USDC Approval Required</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 pb-5 space-y-3 text-sm text-muted-foreground">
          <p>
            Your wallet needs to approve USDC spending before the bot can place orders on Polymarket.
            This is a one-time on-chain transaction that costs a small amount of MATIC for gas.
          </p>
          <p className="font-medium text-foreground">What you need to do:</p>
          <ol className="list-decimal list-inside space-y-1.5 pl-1">
            <li>Make sure your wallet has <span className="text-foreground font-medium">MATIC</span> for gas fees (~0.01 MATIC is enough)</li>
            <li>Go to <span className="text-foreground font-medium">polymarket.com</span> and connect your wallet</li>
            <li>Deposit any amount of USDC — this triggers the approval transaction automatically</li>
            <li>Once approved, come back here and start the bot</li>
          </ol>
          <div className="rounded-lg bg-yellow-400/10 border border-yellow-400/20 p-3 text-xs">
            <span className="font-medium text-yellow-400">Tip:</span> The bot also needs USDC in your wallet to copy trades.
            Fund it via the Wallet panel on the right.
          </div>
          <Button className="w-full mt-1" onClick={onClose}>Got it</Button>
        </div>
      </div>
    </div>
  );
}

function isApprovalError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('allowance') || lower.includes('approval') || lower.includes('approve') || lower.includes('not enough balance');
}

export default function StatusBar({ status }: Props) {
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
      if (isApprovalError(msg)) {
        setShowApproval(true);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {showApproval && <ApprovalModal onClose={() => setShowApproval(false)} />}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <div className={`h-2.5 w-2.5 rounded-full ${isRunning ? 'bg-green-400 animate-pulse' : isTransitioning ? 'bg-yellow-400 animate-pulse' : 'bg-muted-foreground'}`} />
          <span className="font-semibold text-sm">
            {isRunning ? 'Running' : isTransitioning ? (status?.status === 'starting' ? 'Starting…' : 'Stopping…') : 'Stopped'}
          </span>
          {isRunning && status?.startedAt && (
            <Badge variant="outline" className="text-xs text-muted-foreground">
              ⏱ {formatUptime(status.startedAt)}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          {showPwd && !isRunning && (
            <div className="flex items-center gap-2">
              <Input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-8 w-32 text-sm"
                onKeyDown={(e) => e.key === 'Enter' && handleStart()}
                autoFocus
              />
              {error && (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-destructive max-w-[160px] truncate">{error}</span>
                  {isApprovalError(error) && (
                    <button
                      onClick={() => setShowApproval(true)}
                      className="text-xs text-yellow-400 underline whitespace-nowrap"
                    >
                      Learn more
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {isRunning ? (
            <Button size="sm" variant="destructive" onClick={handleStop} disabled={loading || isTransitioning}>
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
              <span className="ml-1.5">Stop</span>
            </Button>
          ) : (
            <Button size="sm" onClick={handleStart} disabled={loading || isTransitioning}>
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              <span className="ml-1.5">Start</span>
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
