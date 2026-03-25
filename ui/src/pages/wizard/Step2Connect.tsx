import { useState } from 'react';
import { configApi } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';

interface Props { onBack: () => void; onNext: () => void; }

export default function Step2Connect({ onBack, onNext }: Props) {
  const [targetWallet, setTargetWallet] = useState('');
  const [alchemyWsUrl, setAlchemyWsUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isEthAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v.trim());
  const isWss = (v: string) => v.trim().startsWith('wss://');

  // Derive HTTP RPC URL from the WSS URL (wss:// → https://)
  const deriveRpcUrl = (wss: string): string =>
    wss.trim().replace(/^wss:\/\//, 'https://');

  const handleNext = async () => {
    if (!isEthAddress(targetWallet)) { setError('Enter a valid Ethereum address (0x…).'); return; }
    if (!isWss(alchemyWsUrl)) { setError('Alchemy WSS URL must start with wss://'); return; }
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
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Connect to Polymarket</CardTitle>
        <CardDescription>Enter the wallet you want to copy trade and your Alchemy API key.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="target">Target Wallet Address</Label>
          <Input
            id="target"
            placeholder="0x..."
            value={targetWallet}
            onChange={(e) => setTargetWallet(e.target.value)}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">The wallet whose Polymarket trades you will copy.</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="alchemy">Alchemy WebSocket URL</Label>
          <Input
            id="alchemy"
            placeholder="wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY"
            value={alchemyWsUrl}
            onChange={(e) => setAlchemyWsUrl(e.target.value)}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Get a free key at{' '}
            <span className="text-primary">alchemy.com</span>{' '}
            → Create App → Network: Polygon Mainnet → copy the WebSocket URL.
          </p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onBack}>Back</Button>
          <Button className="flex-1" onClick={handleNext} disabled={loading}>
            {loading ? 'Saving…' : 'Next'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
