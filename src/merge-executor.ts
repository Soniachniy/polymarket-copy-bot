import { ethers } from 'ethers';

const CTF_REDEEM_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
];

const NEGRISK_ADAPTER_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] calldata indexSets, uint256 amount)',
];

export interface MergeResult {
  txHash: string;
  conditionId: string;
  amount: number;
  gasUsed?: string;
}

export class MergeExecutor {
  private wallet: ethers.Wallet;
  private provider: ethers.providers.JsonRpcProvider;
  private readonly ctfAddress: string;
  private readonly negRiskAdapterAddress: string;
  private readonly usdcAddress: string;
  private readonly MIN_PRIORITY_FEE_GWEI = parseFloat(process.env.MIN_PRIORITY_FEE_GWEI || '30');
  private readonly MIN_MAX_FEE_GWEI = parseFloat(process.env.MIN_MAX_FEE_GWEI || '60');

  constructor(options: {
    privateKey: string;
    rpcUrl: string;
    contracts: {
      ctf: string;
      usdc: string;
      negRiskAdapter: string;
    };
  }) {
    this.provider = new ethers.providers.JsonRpcProvider(options.rpcUrl);
    this.wallet = new ethers.Wallet(options.privateKey, this.provider);
    this.ctfAddress = options.contracts.ctf;
    this.negRiskAdapterAddress = options.contracts.negRiskAdapter;
    this.usdcAddress = options.contracts.usdc;
  }

  /**
   * Merge equal YES + NO shares back to USDC via CTF.redeemPositions.
   * For binary markets, indexSets = [1, 2] (YES=index 0, NO=index 1).
   */
  async merge(params: {
    conditionId: string;
    amount: number;
    negRisk: boolean;
  }): Promise<MergeResult> {
    const { conditionId, amount, negRisk } = params;

    console.log(`🔄 Merging ${amount} shares for condition ${conditionId.slice(0, 14)}...`);
    console.log(`   NegRisk: ${negRisk}`);

    const gasOverrides = await this.getGasOverrides();

    if (negRisk) {
      return this.mergeNegRisk(conditionId, amount, gasOverrides);
    }

    return this.mergeStandard(conditionId, amount, gasOverrides);
  }

  private async mergeStandard(
    conditionId: string,
    amount: number,
    gasOverrides: ethers.providers.TransactionRequest
  ): Promise<MergeResult> {
    const ctf = new ethers.Contract(this.ctfAddress, CTF_REDEEM_ABI, this.wallet);

    // Binary market: indexSets [1, 2] correspond to YES (outcome 0) and NO (outcome 1)
    const indexSets = [1, 2];
    const parentCollectionId = ethers.constants.HashZero;

    // Amount is in USDC decimals (6) since each share redeems for $1 USDC
    const amountBN = ethers.utils.parseUnits(amount.toFixed(6), 6);

    const tx = await ctf.redeemPositions(
      this.usdcAddress,
      parentCollectionId,
      conditionId,
      indexSets,
      { ...gasOverrides }
    );

    console.log(`   Tx: ${tx.hash}`);
    const receipt = await tx.wait();

    console.log(`   ✅ Merge complete (gas used: ${receipt.gasUsed.toString()})`);

    return {
      txHash: tx.hash,
      conditionId,
      amount,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  private async mergeNegRisk(
    conditionId: string,
    amount: number,
    gasOverrides: ethers.providers.TransactionRequest
  ): Promise<MergeResult> {
    const adapter = new ethers.Contract(this.negRiskAdapterAddress, NEGRISK_ADAPTER_ABI, this.wallet);

    const indexSets = [1, 2];
    const amountBN = ethers.utils.parseUnits(amount.toFixed(6), 6);

    const tx = await adapter.redeemPositions(
      conditionId,
      indexSets,
      amountBN,
      { ...gasOverrides }
    );

    console.log(`   Tx: ${tx.hash}`);
    const receipt = await tx.wait();

    console.log(`   ✅ NegRisk merge complete (gas used: ${receipt.gasUsed.toString()})`);

    return {
      txHash: tx.hash,
      conditionId,
      amount,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  private async getGasOverrides(): Promise<ethers.providers.TransactionRequest> {
    const feeData = await this.provider.getFeeData();
    const minPriority = ethers.utils.parseUnits(this.MIN_PRIORITY_FEE_GWEI.toString(), 'gwei');
    const minMaxFee = ethers.utils.parseUnits(this.MIN_MAX_FEE_GWEI.toString(), 'gwei');

    let maxPriority = feeData.maxPriorityFeePerGas || feeData.gasPrice || minPriority;
    let maxFee = feeData.maxFeePerGas || feeData.gasPrice || minMaxFee;

    const latestBlock = await this.provider.getBlock('latest');
    const baseFee = latestBlock?.baseFeePerGas;
    if (baseFee) {
      const targetMaxFee = baseFee.mul(2).add(maxPriority);
      if (maxFee.lt(targetMaxFee)) {
        maxFee = targetMaxFee;
      }
    }

    if (maxPriority.lt(minPriority)) maxPriority = minPriority;
    if (maxFee.lt(minMaxFee)) maxFee = minMaxFee;
    if (maxFee.lt(maxPriority)) maxFee = maxPriority;

    return {
      maxPriorityFeePerGas: maxPriority,
      maxFeePerGas: maxFee,
    };
  }
}
