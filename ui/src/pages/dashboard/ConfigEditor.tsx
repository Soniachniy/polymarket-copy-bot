import { useState, useEffect } from 'react';
import { Save, ChevronDown, ChevronUp } from 'lucide-react';
import { useConfig, useUpdateConfig } from '../../hooks/useConfig';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';

export default function ConfigEditor() {
  const { data: cfg } = useConfig();
  const { mutate: update, isPending, isSuccess } = useUpdateConfig();
  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState({
    positionMultiplier: 0.1,
    maxTradeSize: 100,
    minTradeSize: 1,
    slippageTolerance: 0.02,
    orderType: 'FOK' as 'FOK' | 'FAK' | 'LIMIT',
    maxSessionNotional: 0,
    maxPerMarketNotional: 0,
  });

  useEffect(() => {
    if (cfg) {
      setForm({
        positionMultiplier: cfg.positionMultiplier,
        maxTradeSize: cfg.maxTradeSize,
        minTradeSize: cfg.minTradeSize,
        slippageTolerance: cfg.slippageTolerance,
        orderType: cfg.orderType,
        maxSessionNotional: cfg.maxSessionNotional,
        maxPerMarketNotional: cfg.maxPerMarketNotional,
      });
    }
  }, [cfg]);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSave = () => update(form);

  return (
    <Card>
      <CardHeader className="pb-2">
        <button
          className="flex items-center justify-between w-full text-left"
          onClick={() => setExpanded(!expanded)}
        >
          <CardTitle className="text-sm font-semibold">Trading Config</CardTitle>
          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </button>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Position Multiplier</Label>
              <Input
                type="number" step="0.01" min="0.01" max="1"
                value={form.positionMultiplier}
                onChange={(e) => set('positionMultiplier', parseFloat(e.target.value))}
                className="h-8 text-sm"
              />
              <p className="text-xs text-muted-foreground">Copy {(form.positionMultiplier * 100).toFixed(0)}% per trade</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Max Trade (USDC)</Label>
              <Input
                type="number" step="1" min="1"
                value={form.maxTradeSize}
                onChange={(e) => set('maxTradeSize', parseFloat(e.target.value))}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Min Trade (USDC)</Label>
              <Input
                type="number" step="0.5" min="0.5"
                value={form.minTradeSize}
                onChange={(e) => set('minTradeSize', parseFloat(e.target.value))}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Slippage</Label>
              <Input
                type="number" step="0.005" min="0.005" max="0.1"
                value={form.slippageTolerance}
                onChange={(e) => set('slippageTolerance', parseFloat(e.target.value))}
                className="h-8 text-sm"
              />
              <p className="text-xs text-muted-foreground">{(form.slippageTolerance * 100).toFixed(1)}%</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Order Type</Label>
              <select
                className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={form.orderType}
                onChange={(e) => set('orderType', e.target.value as typeof form.orderType)}
              >
                <option value="FOK">FOK</option>
                <option value="FAK">FAK</option>
                <option value="LIMIT">LIMIT</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Session Cap (0=off)</Label>
              <Input
                type="number" step="10" min="0"
                value={form.maxSessionNotional}
                onChange={(e) => set('maxSessionNotional', parseFloat(e.target.value))}
                className="h-8 text-sm"
              />
            </div>
          </div>

          <Button size="sm" className="w-full gap-2" onClick={handleSave} disabled={isPending}>
            <Save className="h-3.5 w-3.5" />
            {isPending ? 'Saving…' : isSuccess ? 'Saved!' : 'Save Changes'}
          </Button>
        </CardContent>
      )}
    </Card>
  );
}
