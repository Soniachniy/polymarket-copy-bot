import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Zap, ArrowLeft } from 'lucide-react';
import { configApi, proxyApi, botApi } from '../../lib/api';

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

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="font-mono text-[10px] font-medium text-[#6e6e6e] tracking-widest">{label}</label>
      {children}
      {hint && <p className="font-mono text-[11px] text-[#6e6e6e]">{hint}</p>}
    </div>
  );
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
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="font-sans text-[32px] font-semibold text-white">Configure Trading</h1>
        <p className="font-mono text-[13px] text-[#6e6e6e] max-w-[560px]">
          Set your risk limits and execution preferences. These can be changed any time from the dashboard.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-5">
        <FieldRow label="POSITION MULTIPLIER" hint={`Copy ${(settings.positionMultiplier * 100).toFixed(0)}% of each target trade`}>
          <div className="flex items-center bg-black border border-[#BFFF00] h-11 px-3.5 gap-2">
            <input
              type="number" step="0.01" min="0.01" max="1"
              value={settings.positionMultiplier}
              onChange={(e) => set('positionMultiplier', parseFloat(e.target.value))}
              className="flex-1 bg-transparent font-mono text-[13px] text-white outline-none"
            />
            <span className="font-mono text-[11px] text-[#6e6e6e] shrink-0">× multiplier</span>
          </div>
        </FieldRow>

        <FieldRow label="SLIPPAGE TOLERANCE" hint={`${(settings.slippageTolerance * 100).toFixed(1)}% max slippage`}>
          <div className="flex items-center bg-black border border-[#1A1A1A] h-11 px-3.5 gap-2 focus-within:border-[#BFFF00] transition-colors">
            <input
              type="number" step="0.005" min="0.005" max="0.1"
              value={settings.slippageTolerance}
              onChange={(e) => set('slippageTolerance', parseFloat(e.target.value))}
              className="flex-1 bg-transparent font-mono text-[13px] text-white outline-none"
            />
            <span className="font-mono text-[11px] text-[#6e6e6e] shrink-0">% slippage</span>
          </div>
        </FieldRow>

        <FieldRow label="MAX TRADE SIZE">
          <div className="flex items-center bg-black border border-[#1A1A1A] h-11 px-3.5 gap-2 focus-within:border-[#BFFF00] transition-colors">
            <input
              type="number" step="1" min="1"
              value={settings.maxTradeSize}
              onChange={(e) => set('maxTradeSize', parseFloat(e.target.value))}
              className="flex-1 bg-transparent font-mono text-[13px] text-white outline-none"
            />
            <span className="font-mono text-[11px] text-[#6e6e6e] shrink-0">USDC</span>
          </div>
        </FieldRow>

        <FieldRow label="MIN TRADE SIZE">
          <div className="flex items-center bg-black border border-[#1A1A1A] h-11 px-3.5 gap-2 focus-within:border-[#BFFF00] transition-colors">
            <input
              type="number" step="0.5" min="0.5"
              value={settings.minTradeSize}
              onChange={(e) => set('minTradeSize', parseFloat(e.target.value))}
              className="flex-1 bg-transparent font-mono text-[13px] text-white outline-none"
            />
            <span className="font-mono text-[11px] text-[#6e6e6e] shrink-0">USDC</span>
          </div>
        </FieldRow>

        <FieldRow label="ORDER TYPE">
          <div className="flex gap-2">
            {(['FOK', 'FAK', 'LIMIT'] as const).map((t) => (
              <button
                key={t}
                onClick={() => set('orderType', t)}
                className={`flex-1 h-11 font-mono text-[12px] font-semibold transition-colors ${
                  settings.orderType === t
                    ? 'bg-[#BFFF00] text-black'
                    : 'bg-black border border-[#1A1A1A] text-[#6e6e6e] hover:border-[#404040]'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </FieldRow>

        <FieldRow label="SESSION CAP" hint="0 = no cap (unlimited)">
          <div className="flex items-center bg-black border border-[#1A1A1A] h-11 px-3.5 gap-2 focus-within:border-[#BFFF00] transition-colors">
            <input
              type="number" step="10" min="0"
              value={settings.maxSessionNotional}
              onChange={(e) => set('maxSessionNotional', parseFloat(e.target.value))}
              className="flex-1 bg-transparent font-mono text-[13px] text-white outline-none"
            />
            <span className="font-mono text-[11px] text-[#6e6e6e] shrink-0">USDC</span>
          </div>
        </FieldRow>
      </div>

      {error && <p className="font-mono text-xs text-[#FF4444]">{error}</p>}

      <div className="flex gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-2 justify-center h-12 px-8 bg-black border border-[#1A1A1A] font-mono text-[13px] font-medium text-[#6e6e6e] hover:border-[#404040] transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          BACK
        </button>
        <button
          onClick={handleStart}
          disabled={loading}
          className="flex items-center gap-2 h-12 px-10 bg-[#BFFF00] font-mono text-[13px] font-semibold text-black hover:bg-[#d4ff33] transition-colors disabled:opacity-60"
        >
          <Zap className="w-3.5 h-3.5" />
          {loading ? 'STARTING…' : 'START BOT'}
        </button>
      </div>
    </div>
  );
}
