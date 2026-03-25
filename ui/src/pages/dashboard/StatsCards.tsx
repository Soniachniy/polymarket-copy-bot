import { TrendingUp, Copy, XCircle, DollarSign } from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { formatUsdc } from '../../lib/utils';
import type { BotStatusPayload } from '../../lib/api';

interface Props { stats: BotStatusPayload['stats'] | undefined; }

export default function StatsCards({ stats }: Props) {
  const s = stats ?? { tradesDetected: 0, tradesCopied: 0, tradesFailed: 0, totalVolume: 0 };

  const cards = [
    { label: 'Detected', value: s.tradesDetected, icon: TrendingUp, color: 'text-blue-400' },
    { label: 'Copied', value: s.tradesCopied, icon: Copy, color: 'text-green-400' },
    { label: 'Failed', value: s.tradesFailed, icon: XCircle, color: 'text-red-400' },
    { label: 'Volume', value: formatUsdc(s.totalVolume), icon: DollarSign, color: 'text-yellow-400' },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="p-4 flex items-center gap-3">
            <c.icon className={`h-5 w-5 shrink-0 ${c.color}`} />
            <div>
              <p className="text-xs text-muted-foreground">{c.label}</p>
              <p className="text-lg font-semibold">{c.value}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
