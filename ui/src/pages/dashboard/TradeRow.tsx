import { truncateAddress, formatAge } from '../../lib/utils';
import type { TargetTrade, CopiedTradeRecord } from '../../lib/api';

export function TargetTradeRow({ trade }: { trade: TargetTrade }) {
  const isBuy = trade.side?.toUpperCase() === 'BUY';
  const size = parseFloat(trade.usdcSize ?? '0').toFixed(0);
  const price = parseFloat(trade.price ?? '0').toFixed(3);

  return (
    <div className="bg-[#111111] border border-[#1A1A1A] px-3.5 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className={`font-mono text-[9px] font-bold px-2 py-0.5 shrink-0 ${
          isBuy ? 'bg-[#BFFF00] text-black' : 'border border-[#FF4444] text-[#FF4444]'
        }`}>
          {isBuy ? 'BUY' : 'SELL'}
        </span>
        <span className="flex-1 font-mono text-[11px] text-white truncate">
          {truncateAddress(trade.conditionId ?? '', 8)}
        </span>
        <span className="font-mono text-[10px] text-[#6e6e6e] shrink-0">{formatAge(trade.timestamp * 1000)}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-[11px] text-[#999999]">@ {price}¢</span>
        <span className={`font-mono text-[11px] font-semibold ${isBuy ? 'text-[#BFFF00]' : 'text-[#999999]'}`}>
          ${size}
        </span>
        <span className="flex-1 font-mono text-[10px] text-[#404040] truncate">{truncateAddress(trade.transactionHash ?? '', 6)}</span>
      </div>
    </div>
  );
}

export function CopiedTradeRow({ record }: { record: CopiedTradeRecord }) {
  const isBuy = record.sourceTrade.side?.toUpperCase() === 'BUY';
  const badgeStyle = {
    success: 'bg-[#BFFF00] text-black',
    failed: 'border border-[#FF4444] text-[#FF4444]',
    skipped: 'bg-[#F59E0B] text-black',
  }[record.result] ?? 'border border-[#1A1A1A] text-[#6e6e6e]';

  return (
    <div className="bg-[#111111] border border-[#1A1A1A] px-3.5 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className={`font-mono text-[9px] font-bold px-2 py-0.5 shrink-0 capitalize ${badgeStyle}`}>
          {record.result.toUpperCase()}
        </span>
        <span className="flex-1 font-mono text-[11px] text-white truncate">
          {truncateAddress(record.sourceTrade.market ?? record.sourceTrade.conditionId ?? '', 8)}
        </span>
        <span className="font-mono text-[10px] text-[#6e6e6e] shrink-0">
          {formatAge(new Date(record.executedAt).getTime())}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className={`font-mono text-[9px] font-bold px-2 py-0.5 ${
          isBuy ? 'bg-[#BFFF00]/20 text-[#BFFF00]' : 'text-[#FF4444]'
        }`}>
          {isBuy ? 'BUY' : 'SELL'}
        </span>
        {record.copyNotional != null && (
          <span className={`font-mono text-[11px] font-semibold ${record.result === 'success' ? 'text-[#BFFF00]' : 'text-[#999999]'}`}>
            Copied ${record.copyNotional.toFixed(0)}
          </span>
        )}
        {record.result === 'skipped' || record.result === 'failed' ? (
          <span className="font-mono text-[10px] text-[#F59E0B] truncate">{record.reason}</span>
        ) : null}
      </div>
    </div>
  );
}
