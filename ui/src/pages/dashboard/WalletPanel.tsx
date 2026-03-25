import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useBalance } from '../../hooks/useBalance';
import { walletApi } from '../../lib/api';
import { truncateAddress } from '../../lib/utils';

interface Props { walletAddress: string; }

export default function WalletPanel({ walletAddress }: Props) {
  const { data: balance, refetch } = useBalance(!!walletAddress);
  const [showExport, setShowExport] = useState(false);
  const [exportPwd, setExportPwd] = useState('');
  const [exportedKey, setExportedKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exportErr, setExportErr] = useState('');

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExport = async () => {
    setExportErr('');
    try {
      const res = await walletApi.export(exportPwd);
      setExportedKey(res.data.privateKey);
      setExportPwd('');
    } catch (err: any) {
      setExportErr(err?.response?.data?.error ?? 'Incorrect password.');
    }
  };

  return (
    <div className="border-b border-[#1A1A1A] p-5 space-y-4">
      <p className="font-sans text-[14px] font-semibold text-white">Wallet</p>

      {walletAddress && (
        <div className="flex items-center gap-4">
          {/* QR */}
          <div className="bg-[#1A1A1A] p-2 shrink-0">
            <QRCodeSVG value={walletAddress} size={64} bgColor="#1A1A1A" fgColor="#BFFF00" />
          </div>
          {/* Address */}
          <div className="space-y-1 min-w-0">
            <p className="font-mono text-[9px] font-medium text-[#6e6e6e] tracking-widest">BOT ADDRESS</p>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] text-[#BFFF00] truncate">{truncateAddress(walletAddress, 10)}</span>
              <button onClick={() => copy(walletAddress)} className="text-[#6e6e6e] hover:text-white shrink-0">
                <Copy className="w-3 h-3" />
              </button>
            </div>
            {copied && <p className="font-mono text-[10px] text-[#BFFF00]">Copied!</p>}
          </div>
        </div>
      )}

      {/* Balances */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-black border border-[#1A1A1A] p-3 space-y-1">
          <p className="font-mono text-[9px] font-medium text-[#6e6e6e] tracking-widest">MATIC</p>
          <p className="font-sans text-[18px] font-semibold text-white">{balance?.maticBalance ?? '—'}</p>
        </div>
        <div className="bg-black border border-[#1A1A1A] p-3 space-y-1">
          <p className="font-mono text-[9px] font-medium text-[#6e6e6e] tracking-widest">USDC.e</p>
          <p className="font-sans text-[18px] font-semibold text-[#BFFF00]">{balance?.usdcBalance ?? '—'}</p>
        </div>
      </div>

      <button
        onClick={() => refetch()}
        className="flex items-center justify-center gap-1.5 w-full h-9 bg-black border border-[#1A1A1A] font-mono text-[11px] font-medium text-[#6e6e6e] hover:border-[#404040] transition-colors"
      >
        <RefreshCw className="w-3 h-3" />
        REFRESH
      </button>

      {/* Export */}
      {!showExport && !exportedKey && (
        <button
          onClick={() => setShowExport(true)}
          className="w-full font-mono text-[11px] text-[#404040] hover:text-[#6e6e6e] transition-colors text-center py-1"
        >
          Export private key
        </button>
      )}

      {showExport && !exportedKey && (
        <div className="space-y-2">
          <input
            type="password"
            placeholder="Enter password to export"
            value={exportPwd}
            onChange={(e) => setExportPwd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleExport()}
            className="w-full h-9 bg-black border border-[#1A1A1A] px-3 font-mono text-[12px] text-white placeholder:text-[#404040] outline-none focus:border-[#BFFF00] transition-colors"
          />
          {exportErr && <p className="font-mono text-[11px] text-[#FF4444]">{exportErr}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => setShowExport(false)}
              className="flex-1 h-9 bg-black border border-[#1A1A1A] font-mono text-[11px] text-[#6e6e6e] hover:border-[#404040] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleExport}
              className="flex-1 h-9 bg-[#BFFF00] font-mono text-[11px] font-semibold text-black hover:bg-[#d4ff33] transition-colors"
            >
              Reveal
            </button>
          </div>
        </div>
      )}

      {exportedKey && (
        <div className="space-y-2">
          <div className="bg-black border border-[#F59E0B]/30 p-2.5 font-mono text-[11px] text-[#F59E0B]">
            ⚠ Never share your private key.
          </div>
          <div className="flex gap-1.5">
            <div className="flex-1 bg-black border border-[#1A1A1A] h-9 px-2.5 flex items-center overflow-hidden">
              <span className="font-mono text-[10px] text-[#999999] truncate">
                {showKey ? exportedKey : '•'.repeat(32)}
              </span>
            </div>
            <button onClick={() => setShowKey(!showKey)} className="w-9 h-9 bg-black border border-[#1A1A1A] flex items-center justify-center text-[#6e6e6e] hover:text-white">
              {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
            <button onClick={() => copy(exportedKey)} className="w-9 h-9 bg-black border border-[#1A1A1A] flex items-center justify-center text-[#6e6e6e] hover:text-white">
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
          <button onClick={() => setExportedKey('')} className="w-full font-mono text-[11px] text-[#404040] hover:text-[#6e6e6e] transition-colors text-center py-1">
            Hide
          </button>
        </div>
      )}
    </div>
  );
}
