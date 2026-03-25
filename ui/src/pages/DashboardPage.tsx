import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut, X, AlertTriangle, Loader2 } from 'lucide-react';
import { useBotStatus } from '../hooks/useBotStatus';
import { useConfig } from '../hooks/useConfig';
import { wsClient } from '../lib/ws';
import { authApi } from '../lib/api';
import { Button } from '../components/ui/button';
import StatusBar from './dashboard/StatusBar';
import StatsCards from './dashboard/StatsCards';
import TradesFeed from './dashboard/TradesFeed';
import WalletPanel from './dashboard/WalletPanel';
import ConfigEditor from './dashboard/ConfigEditor';

function ResetModal({ onConfirm, onCancel, loading }: { onConfirm: () => void; onCancel: () => void; loading: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-sm shadow-xl">
        <div className="flex items-start justify-between p-5 pb-3">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="font-semibold text-foreground">Reset & Start Over?</span>
          </div>
          <button onClick={onCancel} disabled={loading} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 pb-5 space-y-4 text-sm text-muted-foreground">
          <p>
            This will <span className="text-destructive font-medium">permanently delete</span> all stored data:
          </p>
          <ul className="list-disc list-inside space-y-1 pl-1">
            <li>Password</li>
            <li>Wallet &amp; private key</li>
            <li>Bot configuration</li>
            <li>Target wallet settings</li>
          </ul>
          <p>The bot will be stopped. This cannot be undone.</p>
          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={onCancel} disabled={loading}>Cancel</Button>
            <Button variant="destructive" className="flex-1" onClick={onConfirm} disabled={loading}>
              {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : null}
              {loading ? 'Resetting…' : 'Reset everything'}
            </Button>
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

  const handleReset = async () => {
    setResetting(true);
    try {
      await authApi.wipe();
    } catch {
      // ignore — even if wipe fails partially, clear local state
    }
    localStorage.removeItem('token');
    sessionStorage.removeItem('_wizpwd');
    wsClient.disconnect();
    queryClient.clear();
    navigate('/auth', { replace: true });
  };

  return (
    <div className="min-h-screen bg-background">
      {showReset && (
        <ResetModal
          onConfirm={handleReset}
          onCancel={() => setShowReset(false)}
          loading={resetting}
        />
      )}

      {/* Header */}
      <header className="border-b border-border px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">🤖</span>
          <span className="font-semibold text-sm">Polymarket Copy Bot</span>
        </div>
        <div className="flex items-center gap-3">
          {cfg?.targetWallet && (
            <span className="text-xs text-muted-foreground font-mono">
              Copying: {cfg.targetWallet.slice(0, 8)}…{cfg.targetWallet.slice(-4)}
            </span>
          )}
          <button
            onClick={() => setShowReset(true)}
            className="text-muted-foreground hover:text-destructive transition-colors p-1 rounded"
            title="Reset & start over"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 space-y-4">
        {/* Status bar */}
        <StatusBar status={status} />

        {/* Stats */}
        <StatsCards stats={status?.stats} />

        {/* Main content: trades feed + sidebar */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Trades feed — takes 2/3 */}
          <div className="lg:col-span-2 space-y-4">
            <TradesFeed />
          </div>

          {/* Sidebar — wallet + config */}
          <div className="space-y-4">
            <WalletPanel walletAddress={status?.walletAddress ?? cfg?.walletAddress ?? ''} />
            <ConfigEditor />
          </div>
        </div>
      </main>
    </div>
  );
}
