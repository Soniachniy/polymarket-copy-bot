import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { botApi } from '../lib/api';
import { Progress } from '../components/ui/progress';
import Step1Wallet from './wizard/Step1Wallet';
import Step2Connect from './wizard/Step2Connect';
import Step3Fund from './wizard/Step3Fund';
import Step4Configure from './wizard/Step4Configure';

const STEPS = ['Wallet', 'Connect', 'Fund', 'Configure'];

export default function WizardPage() {
  const [step, setStep] = useState(0);
  const navigate = useNavigate();

  const { data: status } = useQuery({
    queryKey: ['bot-status'],
    queryFn: () => botApi.status().then((r) => r.data),
    retry: false,
  });

  useEffect(() => {
    if (status?.setupComplete) {
      navigate('/dashboard', { replace: true });
    }
  }, [status, navigate]);
  const progress = ((step + 1) / STEPS.length) * 100;

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="text-3xl mb-2">🤖</div>
          <h1 className="text-xl font-semibold text-foreground">Setup your Copy Bot</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Step {step + 1} of {STEPS.length} — {STEPS[step]}
          </p>
        </div>

        {/* Step progress dots */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {STEPS.map((label, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className={`h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold border transition-colors ${
                i < step ? 'bg-primary border-primary text-primary-foreground' :
                i === step ? 'border-primary text-primary' :
                'border-border text-muted-foreground'
              }`}>
                {i < step ? '✓' : i + 1}
              </div>
              {i < STEPS.length - 1 && (
                <div className={`h-px w-8 transition-colors ${i < step ? 'bg-primary' : 'bg-border'}`} />
              )}
            </div>
          ))}
        </div>

        <Progress value={progress} className="mb-8 h-1" />

        {/* Step content */}
        {step === 0 && <Step1Wallet onNext={() => setStep(1)} />}
        {step === 1 && <Step2Connect onBack={() => setStep(0)} onNext={() => setStep(2)} />}
        {step === 2 && <Step3Fund onBack={() => setStep(1)} onNext={() => setStep(3)} />}
        {step === 3 && <Step4Configure onBack={() => setStep(2)} />}
      </div>
    </div>
  );
}
