import { useState, useEffect } from 'react';
import { Settings, ChevronDown, ChevronUp, Save } from 'lucide-react';
import { useConfig, useUpdateConfig } from '../../hooks/useConfig';

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
    if (cfg) setForm({
      positionMultiplier: cfg.positionMultiplier,
      maxTradeSize: cfg.maxTradeSize,
      minTradeSize: cfg.minTradeSize,
      slippageTolerance: cfg.slippageTolerance,
      orderType: cfg.orderType,
      maxSessionNotional: cfg.maxSessionNotional,
      maxPerMarketNotional: cfg.maxPerMarketNotional,
    });
  }, [cfg]);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const inputCls = "w-full bg-black border border-[#1A1A1A] h-9 px-3 font-mono text-[12px] text-white outline-none focus:border-[#BFFF00] transition-colors";

  return (
    <div className="border-b border-[#1A1A1A]">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-[#1A1A1A]/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Settings className="w-3.5 h-3.5 text-[#6e6e6e]" />
          <span className="font-sans text-[14px] font-semibold text-white">Settings</span>
        </div>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-[#6e6e6e]" /> : <ChevronDown className="w-3.5 h-3.5 text-[#6e6e6e]" />}
      </button>

      {!expanded && (
        <div className="px-5 pb-4 space-y-1.5">
          {[
            { label: 'Position Multiplier', value: `${(form.positionMultiplier * 100).toFixed(0)}%` },
            { label: 'Max Trade Size', value: `$${form.maxTradeSize}` },
            { label: 'Order Type', value: form.orderType, highlight: true },
          ].map((r) => (
            <div key={r.label} className="flex items-center justify-between">
              <span className="font-mono text-[11px] text-[#999999]">{r.label}</span>
              <span className={`font-mono text-[11px] font-semibold ${r.highlight ? 'text-[#BFFF00]' : 'text-white'}`}>{r.value}</span>
            </div>
          ))}
          <button
            onClick={() => setExpanded(true)}
            className="flex items-center justify-center gap-1.5 w-full h-8 mt-2 bg-black border border-[#1A1A1A] font-mono text-[11px] font-medium text-[#6e6e6e] hover:border-[#404040] transition-colors"
          >
            <Settings className="w-3 h-3" />
            EDIT SETTINGS
          </button>
        </div>
      )}

      {expanded && (
        <div className="px-5 pb-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="font-mono text-[9px] font-medium text-[#6e6e6e] tracking-widest">MULTIPLIER</label>
              <input
                type="number" step="0.01" min="0.01" max="1"
                value={form.positionMultiplier}
                onChange={(e) => set('positionMultiplier', parseFloat(e.target.value))}
                className={inputCls}
              />
              <p className="font-mono text-[10px] text-[#6e6e6e]">
                {(form.positionMultiplier * 100).toFixed(0)}% per trade
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="font-mono text-[9px] font-medium text-[#6e6e6e] tracking-widest">MAX TRADE (USDC)</label>
              <input
                type="number" step="1" min="1"
                value={form.maxTradeSize}
                onChange={(e) => set('maxTradeSize', parseFloat(e.target.value))}
                className={inputCls}
              />
            </div>
            <div className="space-y-1.5">
              <label className="font-mono text-[9px] font-medium text-[#6e6e6e] tracking-widest">MIN TRADE (USDC)</label>
              <input
                type="number" step="0.5" min="0.5"
                value={form.minTradeSize}
                onChange={(e) => set('minTradeSize', parseFloat(e.target.value))}
                className={inputCls}
              />
            </div>
            <div className="space-y-1.5">
              <label className="font-mono text-[9px] font-medium text-[#6e6e6e] tracking-widest">SLIPPAGE</label>
              <input
                type="number" step="0.005" min="0.005" max="0.1"
                value={form.slippageTolerance}
                onChange={(e) => set('slippageTolerance', parseFloat(e.target.value))}
                className={inputCls}
              />
              <p className="font-mono text-[10px] text-[#6e6e6e]">{(form.slippageTolerance * 100).toFixed(1)}%</p>
            </div>
          </div>

          {/* Order type toggle */}
          <div className="space-y-1.5">
            <label className="font-mono text-[9px] font-medium text-[#6e6e6e] tracking-widest">ORDER TYPE</label>
            <div className="flex gap-2">
              {(['FOK', 'FAK', 'LIMIT'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => set('orderType', t)}
                  className={`flex-1 h-9 font-mono text-[11px] font-semibold transition-colors ${
                    form.orderType === t ? 'bg-[#BFFF00] text-black' : 'bg-black border border-[#1A1A1A] text-[#6e6e6e] hover:border-[#404040]'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Session cap */}
          <div className="space-y-1.5">
            <label className="font-mono text-[9px] font-medium text-[#6e6e6e] tracking-widest">SESSION CAP (0 = off)</label>
            <input
              type="number" step="10" min="0"
              value={form.maxSessionNotional}
              onChange={(e) => set('maxSessionNotional', parseFloat(e.target.value))}
              className={inputCls}
            />
          </div>

          <button
            onClick={() => update(form)}
            disabled={isPending}
            className="flex items-center justify-center gap-2 w-full h-10 bg-[#BFFF00] font-mono text-[12px] font-semibold text-black hover:bg-[#d4ff33] transition-colors disabled:opacity-60"
          >
            <Save className="w-3.5 h-3.5" />
            {isPending ? 'SAVING…' : isSuccess ? 'SAVED!' : 'SAVE CHANGES'}
          </button>
        </div>
      )}
    </div>
  );
}
