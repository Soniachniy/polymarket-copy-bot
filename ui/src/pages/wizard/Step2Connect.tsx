import { useState } from 'react';
import { Info, ArrowLeft, ArrowRight } from 'lucide-react';
import { configApi } from '../../lib/api';

interface Props { onBack: () => void; onNext: () => void; }

export default function Step2Connect({ onBack, onNext }: Props) {
  const [targetWallet, setTargetWallet] = useState('');
  const [alchemyWsUrl, setAlchemyWsUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isEthAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v.trim());
  const isWss = (v: string) => v.trim().startsWith('wss://');
  const deriveRpcUrl = (wss: string) => wss.trim().replace(/^wss:\/\//, 'https://');

  const handleNext = async () => {
    if (!isEthAddress(targetWallet)) { setError('Enter a valid Ethereum address (0x…40 hex chars).'); return; }
    if (!isWss(alchemyWsUrl)) { setError('Alchemy URL must start with wss://'); return; }
    setLoading(true);
    setError('');
    try {
      await configApi.update({
        targetWallet: targetWallet.trim().toLowerCase(),
        alchemyWsUrl: alchemyWsUrl.trim(),
        rpcUrl: deriveRpcUrl(alchemyWsUrl),
        useAlchemy: true,
      });
      onNext();
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Failed to save settings.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="font-sans text-[32px] font-semibold text-white">Connect to Polymarket</h1>
        <p className="font-mono text-[13px] text-[#6e6e6e] max-w-[560px]">
          Enter the wallet address you want to copy-trade and your Alchemy WebSocket URL for real-time monitoring.
        </p>
      </div>

      <div className="bg-[#111111] border border-[#1A1A1A] p-8 space-y-6">
        {/* Target wallet */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <label className="font-mono text-[10px] font-medium text-[#6e6e6e] tracking-widest">TARGET WALLET ADDRESS</label>
            <span className="font-mono text-[9px] font-bold text-[#FF4444]">REQUIRED</span>
          </div>
          <div className="flex items-center bg-black border border-[#1A1A1A] h-11 px-3.5 gap-2 focus-within:border-[#BFFF00] transition-colors">
            <span className="font-mono text-[13px] text-[#BFFF00] shrink-0">0x</span>
            <input
              placeholder="40-character hex address"
              value={targetWallet.startsWith('0x') ? targetWallet.slice(2) : targetWallet}
              onChange={(e) => setTargetWallet('0x' + e.target.value.replace(/^0x/, ''))}
              className="flex-1 bg-transparent font-mono text-[13px] text-white placeholder:text-[#404040] outline-none"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Info className="w-3 h-3 text-[#3B82F6] shrink-0" />
            <p className="font-mono text-[11px] text-[#3B82F6]">The wallet you want to mirror trades from</p>
          </div>
        </div>

        {/* Alchemy WSS */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <label className="font-mono text-[10px] font-medium text-[#6e6e6e] tracking-widest">ALCHEMY WEBSOCKET URL</label>
            <span className="font-mono text-[9px] font-bold text-[#FF4444]">REQUIRED</span>
          </div>
          <div className="flex items-center bg-black border border-[#1A1A1A] h-11 px-3.5 gap-2 focus-within:border-[#BFFF00] transition-colors">
            <span className="font-mono text-[13px] text-[#BFFF00] shrink-0">wss://</span>
            <input
              placeholder="polygon-mainnet.g.alchemy.com/v2/YOUR_KEY"
              value={alchemyWsUrl.replace(/^wss:\/\//, '')}
              onChange={(e) => setAlchemyWsUrl('wss://' + e.target.value.replace(/^wss:\/\//, ''))}
              className="flex-1 bg-transparent font-mono text-[13px] text-white placeholder:text-[#404040] outline-none"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Info className="w-3 h-3 text-[#3B82F6] shrink-0" />
            <p className="font-mono text-[11px] text-[#3B82F6]">HTTP RPC derived automatically from this URL</p>
          </div>
        </div>

        {error && <p className="font-mono text-xs text-[#FF4444]">{error}</p>}
      </div>

      <div className="flex gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-2 justify-center h-12 px-8 bg-black border border-[#1A1A1A] font-mono text-[13px] font-medium text-[#6e6e6e] hover:border-[#404040] transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          BACK
        </button>
        <button
          onClick={handleNext}
          disabled={loading}
          className="flex items-center gap-2 h-12 px-8 bg-[#BFFF00] font-mono text-[13px] font-semibold text-black hover:bg-[#d4ff33] transition-colors disabled:opacity-60"
        >
          {loading ? 'SAVING…' : 'CONTINUE'}
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
