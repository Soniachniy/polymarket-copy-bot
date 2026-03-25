import { useQuery } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, RefreshCw, Lightbulb, ArrowLeft, ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { configApi, proxyApi, walletApi } from '../../lib/api';
import { truncateAddress, formatAge } from '../../lib/utils';

interface Props { onBack: () => void; onNext: () => void; }

export default function Step3Fund({ onBack, onNext }: Props) {
  const [copied, setCopied] = useState(false);
  const { data: cfg } = useQuery({ queryKey: ['config'], queryFn: () => configApi.get().then((r) => r.data) });
  const { data: balance, refetch } = useQuery({
    queryKey: ['wallet-balance'],
    queryFn: () => walletApi.balance().then((r) => r.data),
    refetchInterval: 8000,
  });
  const { data: targetTrades } = useQuery({
    queryKey: ['target-trades-preview'],
    queryFn: () => proxyApi.targetTrades(6).then((r) => r.data),
    retry: false,
  });

  const address = cfg?.walletAddress ?? '';
  const hasMatic = parseFloat(balance?.maticBalance ?? '0') > 0.01;
  const hasUsdc = parseFloat(balance?.usdcBalance ?? '0') > 1;

  const copyAddr = () => {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="font-sans text-[32px] font-semibold text-white">Fund Your Wallet</h1>
        <p className="font-mono text-[13px] text-[#6e6e6e] max-w-[560px]">
          Deposit MATIC for gas fees and USDC.e as trading capital. Your bot is ready to trade once funded.
        </p>
      </div>

      <div className="grid grid-cols-[auto_1fr] gap-4">
        {/* QR Card */}
        <div className="bg-[#111111] border border-[#1A1A1A] p-6 flex flex-col gap-5">
          <p className="font-sans text-[15px] font-semibold text-white">Bot Wallet</p>
          {address ? (
            <>
              <div className="bg-[#1A1A1A] p-3 flex items-center justify-center">
                <QRCodeSVG value={address} size={120} bgColor="#1A1A1A" fgColor="#BFFF00" />
              </div>
              <div className="flex items-center bg-black border border-[#1A1A1A] h-9 px-2.5 gap-2">
                <span className="flex-1 font-mono text-[11px] text-[#BFFF00] truncate">{truncateAddress(address, 10)}</span>
                <button onClick={copyAddr} className="text-[#6e6e6e] hover:text-white">
                  <Copy className="w-3 h-3" />
                </button>
              </div>
              {copied && <p className="font-mono text-[10px] text-[#BFFF00] -mt-3">Copied!</p>}
            </>
          ) : (
            <div className="w-32 h-32 bg-[#1A1A1A] animate-pulse" />
          )}
        </div>

        {/* Balances */}
        <div className="bg-[#111111] border border-[#1A1A1A] p-6 flex flex-col gap-4">
          <p className="font-sans text-[15px] font-semibold text-white">Balances</p>
          <div className="grid grid-cols-2 gap-3">
            <div className={`bg-black border p-4 space-y-1.5 ${hasMatic ? 'border-[#BFFF00]' : 'border-[#1A1A1A]'}`}>
              <p className="font-mono text-[10px] font-medium text-[#6e6e6e] tracking-widest">MATIC</p>
              <p className="font-sans text-[24px] font-semibold text-white">{balance?.maticBalance ?? '—'}</p>
              <p className="font-mono text-[11px] text-[#6e6e6e]">Gas fees</p>
            </div>
            <div className={`bg-black border p-4 space-y-1.5 ${hasUsdc ? 'border-[#BFFF00]' : 'border-[#1A1A1A]'}`}>
              <p className="font-mono text-[10px] font-medium text-[#6e6e6e] tracking-widest">USDC.e</p>
              <p className="font-sans text-[24px] font-semibold text-[#BFFF00]">{balance?.usdcBalance ?? '—'}</p>
              <p className="font-mono text-[11px] text-[#6e6e6e]">Trading capital</p>
            </div>
          </div>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 justify-center h-9 bg-black border border-[#1A1A1A] font-mono text-[11px] font-medium text-[#6e6e6e] hover:border-[#404040] transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            REFRESH
          </button>
        </div>
      </div>

      {/* Skip tip */}
      <div className="flex items-start gap-3 bg-black border border-[#1A1A1A] p-4">
        <Lightbulb className="w-4 h-4 text-[#F59E0B] shrink-0 mt-0.5" />
        <p className="font-mono text-[11px] text-[#F59E0B] leading-relaxed">
          You can skip this step and fund later. The bot won't execute trades until it has sufficient USDC.e balance.
        </p>
      </div>

      {/* Target trades preview */}
      {targetTrades && targetTrades.length > 0 && (
        <div className="bg-[#111111] border border-[#1A1A1A] p-5 space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 bg-[#BFFF00] animate-pulse" />
            <p className="font-sans text-[13px] font-semibold text-white">Recent Target Trades</p>
          </div>
          <div className="space-y-2">
            {targetTrades.slice(0, 4).map((t, i) => {
              const isBuy = t.side?.toUpperCase() === 'BUY';
              return (
                <div key={i} className="flex items-center gap-3 bg-black border border-[#1A1A1A] px-3 py-2.5">
                  <span className={`font-mono text-[9px] font-bold px-2 py-0.5 shrink-0 ${
                    isBuy ? 'bg-[#BFFF00] text-black' : 'border border-[#FF4444] text-[#FF4444]'
                  }`}>{isBuy ? 'BUY' : 'SELL'}</span>
                  <span className="flex-1 font-mono text-[11px] text-white truncate">
                    {truncateAddress(t.conditionId ?? '', 8)}
                  </span>
                  <span className={`font-mono text-[11px] font-semibold ${isBuy ? 'text-[#BFFF00]' : 'text-[#999999]'}`}>
                    ${parseFloat(t.usdcSize ?? '0').toFixed(0)}
                  </span>
                  <span className="font-mono text-[10px] text-[#6e6e6e] shrink-0">{formatAge(t.timestamp * 1000)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-2 justify-center h-12 px-8 bg-black border border-[#1A1A1A] font-mono text-[13px] font-medium text-[#6e6e6e] hover:border-[#404040] transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          BACK
        </button>
        <button
          onClick={onNext}
          className="flex items-center gap-2 h-12 px-8 bg-[#BFFF00] font-mono text-[13px] font-semibold text-black hover:bg-[#d4ff33] transition-colors"
        >
          {hasMatic && hasUsdc ? 'CONTINUE' : 'SKIP FOR NOW'}
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
