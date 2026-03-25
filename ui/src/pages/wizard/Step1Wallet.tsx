import { useState } from 'react';
import { Copy, Eye, EyeOff, RefreshCw, Upload } from 'lucide-react';
import { walletApi } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';

interface Props { onNext: () => void; }

export default function Step1Wallet({ onNext }: Props) {
  const [mode, setMode] = useState<'choose' | 'generated' | 'import'>('choose');
  const [generated, setGenerated] = useState<{ address: string; privateKey: string; mnemonic: string | null } | null>(null);
  const [importKey, setImportKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);

  const getPassword = (): string => {
    return sessionStorage.getItem('_wizpwd') ?? '';
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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (mode === 'generated' && generated) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Your New Wallet</CardTitle>
          <CardDescription>
            Save your private key now — it will never be shown again.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-400">
            ⚠️ Never share your private key. Anyone with it has full control of your funds.
          </div>

          <div className="space-y-1.5">
            <Label>Wallet Address</Label>
            <div className="flex gap-2">
              <Input value={generated.address} readOnly className="font-mono text-xs" />
              <Button size="icon" variant="outline" onClick={() => copyToClipboard(generated.address)}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Private Key</Label>
            <div className="flex gap-2">
              <Input
                value={showKey ? generated.privateKey : '••••••••••••••••••••••••••••••••'}
                readOnly
                className="font-mono text-xs"
              />
              <Button size="icon" variant="outline" onClick={() => setShowKey(!showKey)}>
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <Button size="icon" variant="outline" onClick={() => copyToClipboard(generated.privateKey)}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            {copied && <p className="text-xs text-green-400">Copied!</p>}
          </div>

          {generated.mnemonic && (
            <div className="space-y-1.5">
              <Label>Recovery Phrase (12 words)</Label>
              <div className="rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed">
                {generated.mnemonic}
              </div>
            </div>
          )}

          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-semibold text-foreground">To import into MetaMask:</p>
            <ol className="list-decimal ml-4 space-y-0.5">
              <li>Open MetaMask → click your account icon → Import Account</li>
              <li>Paste your Private Key and click Import</li>
            </ol>
          </div>

          <Button className="w-full" onClick={onNext}>
            I saved my key — Continue
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (mode === 'import') {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Import Existing Wallet</CardTitle>
          <CardDescription>Paste your private key (0x…). It will be encrypted and stored securely.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Private Key</Label>
            <Input
              type="password"
              placeholder="0x..."
              value={importKey}
              onChange={(e) => setImportKey(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setMode('choose')}>Back</Button>
            <Button className="flex-1" onClick={handleImport} disabled={loading}>
              {loading ? 'Importing…' : 'Import Wallet'}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Set Up Your Wallet</CardTitle>
        <CardDescription>
          This wallet will execute copy trades on your behalf. It needs to be funded with MATIC (gas) and USDC.e.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button className="w-full h-12 text-base" onClick={handleGenerate} disabled={loading}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {loading ? 'Generating…' : 'Generate New Wallet'}
        </Button>
        <Button variant="outline" className="w-full h-12 text-base" onClick={() => setMode('import')}>
          <Upload className="mr-2 h-4 w-4" />
          Import Existing Wallet
        </Button>
      </CardContent>
    </Card>
  );
}
