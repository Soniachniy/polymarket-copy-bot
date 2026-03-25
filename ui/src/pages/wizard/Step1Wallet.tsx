import { useState } from 'react';
import { Sparkles, Key, Copy, Eye, EyeOff, ArrowRight } from 'lucide-react';
import { walletApi } from '../../lib/api';

interface Props { onNext: () => void; }

export default function Step1Wallet({ onNext }: Props) {
  const [mode, setMode] = useState<'choose' | 'generated' | 'import'>('choose');
  const [generated, setGenerated] = useState<{ address: string; privateKey: string; mnemonic: string | null } | null>(null);
  const [importKey, setImportKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const getPassword = () => sessionStorage.getItem('_wizpwd') ?? '';

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleGenerate = async () => {
    const pwd = getPassword();
    if (!pwd) { setError('Session expired — please log out and log in again.'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await walletApi.generate(pwd);
      setGenerated(res.data);
      setMode('generated');
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Failed to generate wallet.');
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    if (!importKey.trim()) { setError('Private key required.'); return; }
    const pwd = getPassword();
    if (!pwd) { setError('Session expired — please log out and log in again.'); return; }
    setLoading(true);
    setError('');
    try {
      await walletApi.import(importKey.trim(), pwd);
      onNext();
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Invalid private key.');
    } finally {
      setLoading(false);
    }
  };

  if (mode === 'generated' && generated) {
    return (
      <div className="space-y-8">
        <div className="space-y-2">
          <h1 className="font-sans text-[32px] font-semibold text-white leading-tight">Wallet Setup</h1>
          <p className="font-mono text-[13px] text-[#6e6e6e] max-w-lg">
            Save your private key now — it will never be shown again.
          </p>
        </div>

        <div className="bg-[#111111] border border-[#1A1A1A] p-6 space-y-5">
          <h2 className="font-sans text-[15px] font-semibold text-white">Your New Wallet</h2>

          <div className="space-y-1.5">
            <label className="font-mono text-[10px] font-medium text-[#6e6e6e] tracking-widest">WALLET ADDRESS</label>
            <div className="flex items-center bg-black border border-[#1A1A1A] h-10 px-3.5 gap-2">
              <span className="flex-1 font-mono text-[11px] text-[#BFFF00] truncate">{generated.address}</span>
              <button onClick={() => copyText(generated.address, 'addr')} className="text-[#6e6e6e] hover:text-white shrink-0">
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
            {copied === 'addr' && <p className="font-mono text-[10px] text-[#BFFF00]">Copied!</p>}
          </div>

          <div className="space-y-1.5">
            <label className="font-mono text-[10px] font-medium text-[#FF4444] tracking-widest">
              PRIVATE KEY — SAVE THIS NOW
            </label>
            <div className="flex items-center bg-black border border-[#FF4444] h-10 px-3.5 gap-2">
              <span className="flex-1 font-mono text-[11px] text-[#999999] truncate">
                {showKey ? generated.privateKey : '0x' + '•'.repeat(62)}
              </span>
              <button onClick={() => setShowKey(!showKey)} className="text-[#6e6e6e] hover:text-white shrink-0">
                {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
              <button onClick={() => copyText(generated.privateKey, 'pk')} className="text-[#6e6e6e] hover:text-white shrink-0">
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
            {copied === 'pk' && <p className="font-mono text-[10px] text-[#BFFF00]">Copied!</p>}
          </div>

          {generated.mnemonic && (
            <div className="space-y-1.5">
              <label className="font-mono text-[10px] font-medium text-[#6e6e6e] tracking-widest">RECOVERY PHRASE</label>
              <div className="bg-black border border-[#1A1A1A] p-3 font-mono text-[11px] text-[#999999] leading-relaxed">
                {generated.mnemonic}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={onNext}
          className="flex items-center gap-2 h-12 px-8 bg-[#BFFF00] font-mono text-[13px] font-semibold text-black hover:bg-[#d4ff33] transition-colors"
        >
          I SAVED MY KEY — CONTINUE
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  if (mode === 'import') {
    return (
      <div className="space-y-8">
        <div className="space-y-2">
          <h1 className="font-sans text-[32px] font-semibold text-white">Wallet Setup</h1>
          <p className="font-mono text-[13px] text-[#6e6e6e] max-w-lg">
            Paste your private key (0x + 64 hex chars). It will be encrypted with AES-256-GCM.
          </p>
        </div>

        <div className="bg-[#111111] border border-[#1A1A1A] p-6 space-y-5">
          <div className="space-y-1.5">
            <label className="font-mono text-[10px] font-medium text-[#6e6e6e] tracking-widest">PRIVATE KEY</label>
            <div className="flex items-center bg-black border border-[#1A1A1A] h-11 px-3.5">
              <input
                type="password"
                placeholder="0x..."
                value={importKey}
                onChange={(e) => setImportKey(e.target.value)}
                className="flex-1 bg-transparent font-mono text-[13px] text-white placeholder:text-[#404040] outline-none"
              />
            </div>
          </div>
          {error && <p className="font-mono text-xs text-[#FF4444]">{error}</p>}
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => setMode('choose')}
            className="flex items-center justify-center h-12 px-8 bg-black border border-[#1A1A1A] font-mono text-[13px] font-medium text-[#6e6e6e] hover:border-[#404040] transition-colors"
          >
            BACK
          </button>
          <button
            onClick={handleImport}
            disabled={loading}
            className="flex items-center gap-2 h-12 px-8 bg-[#BFFF00] font-mono text-[13px] font-semibold text-black hover:bg-[#d4ff33] transition-colors disabled:opacity-60"
          >
            {loading ? 'IMPORTING…' : 'IMPORT WALLET'}
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="font-sans text-[32px] font-semibold text-white">Wallet Setup</h1>
        <p className="font-mono text-[13px] text-[#6e6e6e] max-w-lg">
          Create a new wallet or import an existing private key. Your key is encrypted locally.
        </p>
      </div>

      {error && <p className="font-mono text-xs text-[#FF4444]">{error}</p>}

      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={handleGenerate}
          disabled={loading}
          className="text-left bg-[#111111] border-2 border-[#BFFF00] p-6 space-y-3 hover:bg-[#1a1a0a] transition-colors disabled:opacity-60"
        >
          <Sparkles className="w-6 h-6 text-[#BFFF00]" />
          <div>
            <p className="font-sans text-[16px] font-semibold text-white">
              {loading ? 'Generating…' : 'Generate New Wallet'}
            </p>
            <p className="font-mono text-[12px] text-[#999999] mt-1 leading-relaxed">
              Create a fresh Ethereum wallet. You'll receive a private key and recovery phrase.
            </p>
          </div>
          <span className="inline-flex items-center px-2.5 py-1 bg-[#BFFF00] font-mono text-[9px] font-bold text-black tracking-wider">
            RECOMMENDED
          </span>
        </button>

        <button
          onClick={() => setMode('import')}
          className="text-left bg-[#111111] border border-[#1A1A1A] p-6 space-y-3 hover:border-[#404040] transition-colors"
        >
          <Key className="w-6 h-6 text-[#6e6e6e]" />
          <div>
            <p className="font-sans text-[16px] font-semibold text-white">Import Existing Wallet</p>
            <p className="font-mono text-[12px] text-[#999999] mt-1 leading-relaxed">
              Paste your private key (0x + 64 hex chars). It will be encrypted with AES-256-GCM.
            </p>
          </div>
        </button>
      </div>
    </div>
  );
}
