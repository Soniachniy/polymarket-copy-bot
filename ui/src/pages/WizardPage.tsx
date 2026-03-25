import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { botApi } from '../lib/api';
import Step1Wallet from './wizard/Step1Wallet';
import Step2Connect from './wizard/Step2Connect';
import Step3Fund from './wizard/Step3Fund';
import Step4Configure from './wizard/Step4Configure';

const STEPS = [
  { label: 'Wallet Setup', sub: 'Generate or import wallet' },
  { label: 'Connect', sub: 'Target wallet & RPC' },
  { label: 'Fund Wallet', sub: 'Deposit MATIC & USDC.e' },
  { label: 'Configure', sub: 'Trading parameters' },
];

function StepSidebar({ current }: { current: number }) {
  return (
    <aside className="w-80 min-h-full bg-[#0A0A0A] border-r border-[#1A1A1A] flex flex-col gap-10 px-8 py-12 shrink-0">
      {/* Logo */}
      <div className="flex items-center gap-2.5">
        <Bot className="w-5 h-5 text-[#BFFF00]" />
        <span className="font-sans font-semibold text-[13px] text-white tracking-[3px]">COPY BOT</span>
      </div>

      {/* Steps */}
      <div className="flex flex-col gap-1">
        {STEPS.map((s, i) => {
          const isActive = i === current;
          const isDone = i < current;
          return (
            <div
              key={i}
              className={`flex items-center gap-3.5 py-2.5 pl-0 pr-2 transition-colors ${
                isActive ? 'border-l-2 border-[#BFFF00] pl-3' : 'pl-3.5'
              }`}
            >
              {/* Number circle */}
              <div className={`w-6 h-6 flex items-center justify-center shrink-0 text-[11px] font-mono font-semibold ${
                isActive ? 'bg-[#BFFF00] text-black' :
                isDone ? 'bg-[#BFFF00] text-black' :
                'bg-[#1A1A1A] text-[#6e6e6e]'
              }`}>
                {isDone ? '✓' : i + 1}
              </div>
              {/* Labels */}
              <div>
                <p className={`font-sans text-[13px] font-semibold ${isActive ? 'text-white' : isDone ? 'text-[#6e6e6e]' : 'text-[#404040]'}`}>
                  {s.label}
                </p>
                <p className={`font-mono text-[11px] ${isActive ? 'text-[#6e6e6e]' : 'text-[#404040]'}`}>{s.sub}</p>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

export default function WizardPage() {
  const [step, setStep] = useState(0);
  const navigate = useNavigate();

  const { data: status } = useQuery({
    queryKey: ['bot-status'],
    queryFn: () => botApi.status().then((r) => r.data),
    retry: false,
  });

  useEffect(() => {
    if (status?.setupComplete) navigate('/dashboard', { replace: true });
  }, [status, navigate]);

  return (
    <div className="min-h-screen bg-black flex">
      <StepSidebar current={step} />

      <main className="flex-1 flex flex-col justify-center px-20 py-16 max-w-2xl">
        {step === 0 && <Step1Wallet onNext={() => setStep(1)} />}
        {step === 1 && <Step2Connect onBack={() => setStep(0)} onNext={() => setStep(2)} />}
        {step === 2 && <Step3Fund onBack={() => setStep(1)} onNext={() => setStep(3)} />}
        {step === 3 && <Step4Configure onBack={() => setStep(2)} />}
      </main>
    </div>
  );
}
