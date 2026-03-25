import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { proxyApi } from '../../lib/api';
import { useTrades } from '../../hooks/useTrades';
import { TargetTradeRow, CopiedTradeRow } from './TradeRow';

export default function TradesFeed() {
  const { targetTrades: liveTrades, copiedTrades } = useTrades();

  const { data: historicalTargetTrades, refetch } = useQuery({
    queryKey: ['target-trades-feed'],
    queryFn: () => proxyApi.targetTrades(20).then((r) => r.data),
    refetchInterval: 30_000,
    retry: false,
  });

  const targetTrades = liveTrades.length > 0 ? liveTrades : (historicalTargetTrades ?? []);

  return (
    <div className="flex flex-1 divide-x divide-[#1A1A1A] overflow-hidden">
      {/* Target trades */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-[#1A1A1A] shrink-0">
          <div className="w-1.5 h-1.5 bg-[#3B82F6] animate-pulse" />
          <h3 className="font-sans text-[14px] font-semibold text-white flex-1">Target Trades</h3>
          <button onClick={() => refetch()} className="text-[#6e6e6e] hover:text-white transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {targetTrades.length === 0 ? (
            <p className="font-mono text-[11px] text-[#6e6e6e] text-center py-10">Waiting for trades…</p>
          ) : (
            targetTrades.map((t, i) => <TargetTradeRow key={i} trade={t} />)
          )}
        </div>
      </div>

      {/* Copied trades */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-[#1A1A1A] shrink-0">
          <div className="w-1.5 h-1.5 bg-[#BFFF00] animate-pulse" />
          <h3 className="font-sans text-[14px] font-semibold text-white flex-1">Copied Trades</h3>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {copiedTrades.length === 0 ? (
            <p className="font-mono text-[11px] text-[#6e6e6e] text-center py-10">No trades copied yet.</p>
          ) : (
            copiedTrades.map((r) => <CopiedTradeRow key={r.id} record={r} />)
          )}
        </div>
      </div>
    </div>
  );
}
