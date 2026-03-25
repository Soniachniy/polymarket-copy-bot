import { TrendingUp, CircleCheck, CircleX, DollarSign } from 'lucide-react';
import { formatUsdc } from '../../lib/utils';
import type { BotStatusPayload } from '../../lib/api';

interface Props { stats: BotStatusPayload['stats'] | undefined; }

export default function StatsCards({ stats }: Props) {
  const s = stats ?? { tradesDetected: 0, tradesCopied: 0, tradesFailed: 0, totalVolume: 0 };

  const cards = [
    { label: 'DETECTED', value: s.tradesDetected, icon: TrendingUp, color: 'text-[#3B82F6]', sub: 'Target trades found' },
    { label: 'COPIED', value: s.tradesCopied, icon: CircleCheck, color: 'text-[#BFFF00]', sub: 'Successfully executed', highlight: true },
    { label: 'FAILED', value: s.tradesFailed, icon: CircleX, color: 'text-[#FF4444]', sub: 'Failed or skipped' },
    { label: 'VOLUME', value: formatUsdc(s.totalVolume), icon: DollarSign, color: 'text-[#F59E0B]', sub: 'Total notional copied' },
  ];

  return (
    <div className="grid grid-cols-4 border-b border-[#1A1A1A] divide-x divide-[#1A1A1A]">
      {cards.map((c) => (
        <div key={c.label} className="px-6 py-5 space-y-1.5 bg-black">
          <p className="font-mono text-[10px] font-medium text-[#6e6e6e] tracking-widest">{c.label}</p>
          <div className="flex items-center gap-2">
            <p className={`font-sans text-[32px] font-semibold ${c.highlight ? 'text-[#BFFF00]' : 'text-white'}`}>{c.value}</p>
            <c.icon className={`w-4.5 h-4.5 ${c.color}`} style={{ width: 18, height: 18 }} />
          </div>
          <p className="font-mono text-[11px] text-[#6e6e6e]">{c.sub}</p>
        </div>
      ))}
    </div>
  );
}
