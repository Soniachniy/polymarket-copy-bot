import { Badge } from '../../components/ui/badge';
import { truncateAddress, formatAge } from '../../lib/utils';
import type { TargetTrade, CopiedTradeRecord } from '../../lib/api';

export function TargetTradeRow({ trade }: { trade: TargetTrade }) {
  const isBuy = trade.side?.toUpperCase() === 'BUY';
  const size = parseFloat(trade.usdcSize ?? '0').toFixed(0);
  const price = parseFloat(trade.price ?? '0').toFixed(3);
  return (
    <div className="flex items-center justify-between text-xs px-3 py-2 rounded-md bg-secondary/30 hover:bg-secondary/50 transition-colors">
      <div className="flex items-center gap-2 min-w-0">
        <Badge variant={isBuy ? 'success' : 'destructive'} className="text-[10px] shrink-0">{isBuy ? 'BUY' : 'SELL'}</Badge>
        <span className="text-muted-foreground truncate">{truncateAddress(trade.conditionId ?? '', 8)}</span>
      </div>
      <div className="flex items-center gap-3 shrink-0 text-muted-foreground">
        <span>${size}</span>
        <span>@{price}</span>
        <span>{formatAge(trade.timestamp * 1000)}</span>
      </div>
    </div>
  );
}

export function CopiedTradeRow({ record }: { record: CopiedTradeRecord }) {
  const variantMap = { success: 'success', failed: 'destructive', skipped: 'warning' } as const;
  const variant = variantMap[record.result] ?? 'outline';
  const isBuy = record.sourceTrade.side?.toUpperCase() === 'BUY';
  return (
    <div className="flex items-center justify-between text-xs px-3 py-2 rounded-md bg-secondary/30 hover:bg-secondary/50 transition-colors">
      <div className="flex items-center gap-2 min-w-0">
        <Badge variant={variant} className="text-[10px] shrink-0 capitalize">{record.result}</Badge>
        <Badge variant={isBuy ? 'success' : 'destructive'} className="text-[10px] shrink-0">{isBuy ? 'BUY' : 'SELL'}</Badge>
        <span className="text-muted-foreground truncate">{truncateAddress(record.sourceTrade.market ?? '', 8)}</span>
      </div>
      <div className="flex items-center gap-3 shrink-0 text-muted-foreground">
        {record.copyNotional != null && <span>${record.copyNotional.toFixed(0)}</span>}
        <span>{formatAge(new Date(record.executedAt).getTime())}</span>
      </div>
    </div>
  );
}
