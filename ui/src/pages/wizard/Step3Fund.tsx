import { useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { configApi, proxyApi } from '../../lib/api';
import { walletApi } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { truncateAddress, formatAge } from '../../lib/utils';

interface Props { onBack: () => void; onNext: () => void; }

export default function Step3Fund({ onBack, onNext }: Props) {
  const { data: cfg } = useQuery({ queryKey: ['config'], queryFn: () => configApi.get().then((r) => r.data) });
  const { data: balance, refetch: refetchBalance } = useQuery({
    queryKey: ['wallet-balance'],
    queryFn: () => walletApi.balance().then((r) => r.data),
    refetchInterval: 8000,
  });
  const { data: targetTrades } = useQuery({
    queryKey: ['target-trades-preview'],
    queryFn: () => proxyApi.targetTrades(8).then((r) => r.data),
    retry: false,
  });

  const address = cfg?.walletAddress ?? '';
  const hasMatic = parseFloat(balance?.maticBalance ?? '0') > 0.01;
  const hasUsdc = parseFloat(balance?.usdcBalance ?? '0') > 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Fund Your Wallet</CardTitle>
        <CardDescription>
          Send MATIC for gas fees and USDC.e for copy trading to your bot wallet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* QR + address */}
        {address && (
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="rounded-xl border border-border p-3 bg-white">
              <QRCodeSVG value={address} size={160} />
            </div>
            <div className="text-xs font-mono text-muted-foreground break-all text-center px-4">{address}</div>
          </div>
        )}

        {/* Balance status */}
        <div className="grid grid-cols-2 gap-3">
          <div className={`rounded-lg border p-3 flex items-center gap-2 ${hasMatic ? 'border-green-500/30 bg-green-500/10' : 'border-border'}`}>
            {hasMatic ? <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" /> : <div className="h-4 w-4 rounded-full border-2 border-muted-foreground shrink-0" />}
            <div>
              <p className="text-xs text-muted-foreground">MATIC</p>
              <p className="text-sm font-semibold">{balance?.maticBalance ?? '—'}</p>
            </div>
          </div>
          <div className={`rounded-lg border p-3 flex items-center gap-2 ${hasUsdc ? 'border-green-500/30 bg-green-500/10' : 'border-border'}`}>
            {hasUsdc ? <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" /> : <div className="h-4 w-4 rounded-full border-2 border-muted-foreground shrink-0" />}
            <div>
              <p className="text-xs text-muted-foreground">USDC.e</p>
              <p className="text-sm font-semibold">{balance?.usdcBalance ?? '—'}</p>
            </div>
          </div>
        </div>

        <Button variant="outline" size="sm" className="w-full" onClick={() => refetchBalance()}>
          <RefreshCw className="h-3 w-3 mr-1.5" /> Check Balance
        </Button>

        {/* Target wallet recent trades */}
        {targetTrades && targetTrades.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-2">Target wallet recent trades:</p>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {targetTrades.slice(0, 6).map((t, i) => (
                <div key={i} className="flex items-center justify-between text-xs bg-secondary/40 rounded-md px-2.5 py-1.5">
                  <div className="flex items-center gap-2">
                    <Badge variant={t.side?.toUpperCase() === 'BUY' ? 'success' : 'destructive'} className="text-[10px]">
                      {t.side?.toUpperCase()}
                    </Badge>
                    <span className="text-muted-foreground">{truncateAddress(t.conditionId ?? '', 8)}</span>
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span>${parseFloat(t.usdcSize ?? '0').toFixed(0)}</span>
                    <span>{formatAge(t.timestamp * 1000)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onBack}>Back</Button>
          <Button className="flex-1" onClick={onNext}>
            {hasMatic && hasUsdc ? 'Continue' : 'Skip for now'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
