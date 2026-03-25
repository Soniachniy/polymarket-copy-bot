import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useBalance } from '../../hooks/useBalance';
import { walletApi } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
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
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Your Wallet</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {walletAddress && (
          <div className="flex flex-col items-center gap-2">
            <div className="rounded-lg border border-border p-2 bg-white">
              <QRCodeSVG value={walletAddress} size={100} />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-mono text-muted-foreground">{truncateAddress(walletAddress, 10)}</span>
              <button onClick={() => copy(walletAddress)} className="text-muted-foreground hover:text-foreground">
                <Copy className="h-3 w-3" />
              </button>
              {copied && <span className="text-xs text-green-400">Copied!</span>}
            </div>
          </div>
        )}

        {/* Balances */}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border border-border bg-secondary/30 p-2.5 text-center">
            <p className="text-xs text-muted-foreground">MATIC</p>
            <p className="text-sm font-semibold">{balance?.maticBalance ?? '—'}</p>
          </div>
          <div className="rounded-md border border-border bg-secondary/30 p-2.5 text-center">
            <p className="text-xs text-muted-foreground">USDC.e</p>
            <p className="text-sm font-semibold">{balance?.usdcBalance ?? '—'}</p>
          </div>
        </div>

        <Button variant="outline" size="sm" className="w-full" onClick={() => refetch()}>
          <RefreshCw className="h-3 w-3 mr-1.5" /> Refresh
        </Button>

        {/* Export private key */}
        {!showExport && !exportedKey && (
          <Button variant="ghost" size="sm" className="w-full text-muted-foreground text-xs" onClick={() => setShowExport(true)}>
            Export private key
          </Button>
        )}

        {showExport && !exportedKey && (
          <div className="space-y-2">
            <Input
              type="password"
              placeholder="Enter password to export"
              value={exportPwd}
              onChange={(e) => setExportPwd(e.target.value)}
              className="h-8 text-sm"
              onKeyDown={(e) => e.key === 'Enter' && handleExport()}
            />
            {exportErr && <p className="text-xs text-destructive">{exportErr}</p>}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="flex-1" onClick={() => setShowExport(false)}>Cancel</Button>
              <Button size="sm" className="flex-1" onClick={handleExport}>Reveal</Button>
            </div>
          </div>
        )}

        {exportedKey && (
          <div className="space-y-2">
            <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2 text-xs text-yellow-400">
              ⚠️ Never share your private key.
            </div>
            <div className="flex gap-1.5">
              <Input
                value={showKey ? exportedKey : '••••••••••••••••••••••••••••••••'}
                readOnly
                className="font-mono text-xs h-8 flex-1"
              />
              <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => setShowKey(!showKey)}>
                {showKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </Button>
              <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => copy(exportedKey)}>
                <Copy className="h-3 w-3" />
              </Button>
            </div>
            <Button variant="ghost" size="sm" className="w-full text-xs text-muted-foreground" onClick={() => setExportedKey('')}>
              Hide
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
