import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { configApi, proxyApi, botApi } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';

interface Props { onBack: () => void; }

interface Settings {
  positionMultiplier: number;
  maxTradeSize: number;
  minTradeSize: number;
  slippageTolerance: number;
  orderType: 'FOK' | 'FAK' | 'LIMIT';
  maxSessionNotional: number;
}

function calcMedian(sizes: number[]): number {
  if (sizes.length === 0) return 50;
  const sorted = [...sizes].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 50;
}

export default function Step4Configure({ onBack }: Props) {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<Settings>({
    positionMultiplier: 0.1,
    maxTradeSize: 100,
    minTradeSize: 1,
    slippageTolerance: 0.02,
    orderType: 'FOK',
    maxSessionNotional: 0,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const { data: targetTrades } = useQuery({
    queryKey: ['target-trades-config'],
    queryFn: () => proxyApi.targetTrades(20).then((r) => r.data),
    retry: false,
  });

  // Calculate smart defaults from target wallet history
  useEffect(() => {
    if (!targetTrades || targetTrades.length === 0) return;
    const sizes = targetTrades.map((t) => parseFloat(t.usdcSize ?? '0')).filter((s) => s > 0);
    const median = calcMedian(sizes);
    const suggested = Math.round(median * 1.5);
    setSettings((s) => ({ ...s, maxTradeSize: Math.max(10, Math.min(suggested, 500)) }));
  }, [targetTrades]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setSettings((s) => ({ ...s, [k]: v }));

  const handleStart = async () => {
    const password = sessionStorage.getItem('_wizpwd') ?? '';
    if (!password) { setError('Session expired — please log out and log in again.'); return; }
    setLoading(true);
    setError('');
    try {
      await configApi.update({ ...settings, setupComplete: true });
      await botApi.start(password);
      navigate('/dashboard');
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Failed to start bot.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Configure Copy Settings</CardTitle>
        <CardDescription>
          These defaults are calculated from the target wallet's recent trade history. You can adjust them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Position Multiplier</Label>
            <Input
              type="number" step="0.01" min="0.01" max="1"
              value={settings.positionMultiplier}
              onChange={(e) => set('positionMultiplier', parseFloat(e.target.value))}
            />
            <p className="text-xs text-muted-foreground">Copy {(settings.positionMultiplier * 100).toFixed(0)}% of each trade</p>
          </div>
          <div className="space-y-1.5">
            <Label>Max Trade Size (USDC)</Label>
            <Input
              type="number" step="1" min="1"
              value={settings.maxTradeSize}
              onChange={(e) => set('maxTradeSize', parseFloat(e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Min Trade Size (USDC)</Label>
            <Input
              type="number" step="0.5" min="0.5"
              value={settings.minTradeSize}
              onChange={(e) => set('minTradeSize', parseFloat(e.target.value))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Slippage Tolerance</Label>
            <Input
              type="number" step="0.005" min="0.005" max="0.1"
              value={settings.slippageTolerance}
              onChange={(e) => set('slippageTolerance', parseFloat(e.target.value))}
            />
            <p className="text-xs text-muted-foreground">{(settings.slippageTolerance * 100).toFixed(1)}%</p>
          </div>
          <div className="space-y-1.5">
            <Label>Order Type</Label>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={settings.orderType}
              onChange={(e) => set('orderType', e.target.value as Settings['orderType'])}
            >
              <option value="FOK">FOK (fill-or-kill)</option>
              <option value="FAK">FAK (fill-and-kill)</option>
              <option value="LIMIT">LIMIT (GTC)</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Session Cap (USDC, 0=off)</Label>
            <Input
              type="number" step="10" min="0"
              value={settings.maxSessionNotional}
              onChange={(e) => set('maxSessionNotional', parseFloat(e.target.value))}
            />
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onBack}>Back</Button>
          <Button className="flex-1 gap-2" onClick={handleStart} disabled={loading}>
            <Play className="h-4 w-4" />
            {loading ? 'Starting…' : 'Start Bot'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
