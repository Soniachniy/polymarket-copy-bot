import { useQuery } from '@tanstack/react-query';
import { proxyApi } from '../../lib/api';
import { useTrades } from '../../hooks/useTrades';
import { TargetTradeRow, CopiedTradeRow } from './TradeRow';

export default function TradesFeed() {
  const { targetTrades: liveTrades, copiedTrades } = useTrades();

  // Also show historical target trades from REST if no live ones yet
  const { data: historicalTargetTrades } = useQuery({
    queryKey: ['target-trades-feed'],
    queryFn: () => proxyApi.targetTrades(20).then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  });

  const targetTrades = liveTrades.length > 0 ? liveTrades : (historicalTargetTrades ?? []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Target wallet trades */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold">Target Trades</h3>
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-xs text-muted-foreground">live</span>
          </div>
        </div>
        <div className="p-2 space-y-1.5 max-h-72 overflow-y-auto">
          {targetTrades.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">Waiting for trades…</p>
          ) : (
            targetTrades.map((t, i) => <TargetTradeRow key={i} trade={t} />)
          )}
        </div>
      </div>

      {/* Copied trades */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold">Copied Trades</h3>
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
            <span className="text-xs text-muted-foreground">live</span>
          </div>
        </div>
        <div className="p-2 space-y-1.5 max-h-72 overflow-y-auto">
          {copiedTrades.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">No trades copied yet.</p>
          ) : (
            copiedTrades.map((r) => <CopiedTradeRow key={r.id} record={r} />)
          )}
        </div>
      </div>
    </div>
  );
}
