import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi, configApi } from '../lib/api';
import { wsClient } from '../lib/ws';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

export default function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'setup'>('login');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
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
      if (mode === 'setup') {
        await authApi.setup(password);
      }
      const res = await authApi.login(password);
      localStorage.setItem('token', res.data.token);
      sessionStorage.setItem('_wizpwd', password);
      wsClient.connect();

      try {
        const cfg = await configApi.get();
        if (cfg.data.setupComplete) {
          navigate('/dashboard');
        } else {
          navigate('/wizard');
        }
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
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="text-4xl mb-2">🤖</div>
          <CardTitle className="text-xl">Polymarket Copy Bot</CardTitle>
          <CardDescription>
            {mode === 'setup'
              ? 'Create a password to protect access to your bot.'
              : 'Enter your password to continue.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handle} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
            </div>
            {mode === 'setup' && (
              <div className="space-y-1.5">
                <Label htmlFor="confirm">Confirm Password</Label>
                <Input
                  id="confirm"
                  type="password"
                  placeholder="••••••••"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Please wait…' : mode === 'setup' ? 'Create Password' : 'Login'}
            </Button>
          </form>
          <p className="text-center text-sm text-muted-foreground mt-4">
            {mode === 'login' ? (
              <>
                First time?{' '}
                <button
                  type="button"
                  className="underline hover:text-foreground transition-colors"
                  onClick={() => switchMode('setup')}
                >
                  Create a password
                </button>
              </>
            ) : (
              <>
                Already set up?{' '}
                <button
                  type="button"
                  className="underline hover:text-foreground transition-colors"
                  onClick={() => switchMode('login')}
                >
                  Login
                </button>
              </>
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
