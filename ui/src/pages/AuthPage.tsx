import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Lock, Eye, EyeOff } from 'lucide-react';
import { authApi, configApi } from '../lib/api';
import { wsClient } from '../lib/ws';

export default function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'setup'>('login');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const switchMode = (next: 'login' | 'setup') => {
    setMode(next);
    setError('');
    setPassword('');
    setConfirm('');
  };

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (mode === 'setup' && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setLoading(true);
    try {
      if (mode === 'setup') await authApi.setup(password);
      const res = await authApi.login(password);
      localStorage.setItem('token', res.data.token);
      sessionStorage.setItem('_wizpwd', password);
      wsClient.connect();
      try {
        const cfg = await configApi.get();
        navigate(cfg.data.setupComplete ? '/dashboard' : '/wizard');
      } catch {
        navigate('/wizard');
      }
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="w-full max-w-[480px] bg-[#111111] border border-[#1A1A1A]">
        {/* Logo */}
        <div className="flex flex-col items-center gap-2 px-10 pt-10 pb-8">
          <div className="flex items-center gap-2.5">
            <Bot className="w-6 h-6 text-[#BFFF00]" />
            <span className="font-sans font-semibold text-[15px] text-white tracking-[3px]">
              POLYMARKET COPY BOT
            </span>
          </div>
          <p className="font-mono text-xs text-[#6e6e6e]">
            Automated copy trading on prediction markets
          </p>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[#1A1A1A]">
          <button
            onClick={() => switchMode('login')}
            className={`flex-1 py-3.5 font-mono text-xs font-medium tracking-wider transition-colors ${
              mode === 'login'
                ? 'text-[#BFFF00] border-b-2 border-[#BFFF00] -mb-px'
                : 'text-[#6e6e6e]'
            }`}
          >
            LOGIN
          </button>
          <button
            onClick={() => switchMode('setup')}
            className={`flex-1 py-3.5 font-mono text-xs font-medium tracking-wider transition-colors ${
              mode === 'setup'
                ? 'text-[#BFFF00] border-b-2 border-[#BFFF00] -mb-px'
                : 'text-[#6e6e6e]'
            }`}
          >
            REGISTER
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handle} className="px-10 py-8 space-y-5">
          {/* Password */}
          <div className="space-y-1.5">
            <label className="font-mono text-[10px] font-medium text-[#6e6e6e] tracking-widest">
              PASSWORD
            </label>
            <div className="flex items-center bg-black border border-[#1A1A1A] h-11 px-3.5 gap-2">
              <input
                type={showPw ? 'text' : 'password'}
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                className="flex-1 bg-transparent font-mono text-[13px] text-white placeholder:text-[#404040] outline-none"
              />
              <button type="button" onClick={() => setShowPw(!showPw)} className="text-[#404040] hover:text-[#6e6e6e]">
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Confirm (register only) */}
          {mode === 'setup' && (
            <div className="space-y-1.5">
              <label className="font-mono text-[10px] font-medium text-[#6e6e6e] tracking-widest">
                CONFIRM PASSWORD
              </label>
              <div className="flex items-center bg-black border border-[#1A1A1A] h-11 px-3.5 gap-2">
                <input
                  type={showConfirm ? 'text' : 'password'}
                  placeholder="Repeat your password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="flex-1 bg-transparent font-mono text-[13px] text-white placeholder:text-[#404040] outline-none"
                />
                <button type="button" onClick={() => setShowConfirm(!showConfirm)} className="text-[#404040] hover:text-[#6e6e6e]">
                  {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="font-mono text-xs text-[#FF4444]">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-12 bg-[#BFFF00] flex items-center justify-center gap-2 font-mono text-[13px] font-semibold text-black hover:bg-[#d4ff33] transition-colors disabled:opacity-60"
          >
            <Lock className="w-3.5 h-3.5" />
            {loading ? 'PLEASE WAIT…' : mode === 'setup' ? 'CREATE PASSWORD' : 'UNLOCK BOT'}
          </button>
        </form>

        {/* Footer */}
        <div className="border-t border-[#1A1A1A] px-10 py-4 flex justify-center">
          <span className="font-mono text-[11px] text-[#404040]">
            Polygon Mainnet · Chain ID 137
          </span>
        </div>
      </div>
    </div>
  );
}
