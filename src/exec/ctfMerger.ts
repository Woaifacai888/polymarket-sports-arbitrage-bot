import type { Config } from '../config/types.js';
import { getLogger } from '../util/logger.js';

const log = () => getLogger();

/** Polygon mainnet addresses used by Polymarket. */
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as const;
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' as const;
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as const;
const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

const CTF_ABI = [
  {
    type: 'function',
    name: 'mergePositions',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'partition', type: 'uint256[]' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

const NEG_RISK_ADAPTER_ABI = [
  {
    type: 'function',
    name: 'mergePositions',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_conditionId', type: 'bytes32' },
      { name: '_amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/**
 * On-chain YES+NO pair merging for live mode.
 *
 * Merging a matched pair of outcome tokens burns them and returns exactly
 * $1 of USDC per pair — no order book crossed, no taker fee, capital back
 * immediately instead of at settlement. Neg-risk markets must merge through
 * the NegRiskAdapter; standard markets merge directly on the CTF.
 *
 * NOTE: tokens must be held by the signing EOA (the bot trades with an EOA
 * signer, so fills settle there). Requires POL for gas.
 */
export class CtfMerger {
  private clients: {
    wallet: import('viem').WalletClient;
    public: import('viem').PublicClient;
    account: import('viem').Account;
  } | null = null;

  constructor(private readonly config: Config) {}

  private async init() {
    if (this.clients) return this.clients;

    const { createWalletClient, createPublicClient, http } = await import('viem');
    const { polygon, polygonAmoy } = await import('viem/chains');
    const { privateKeyToAccount } = await import('viem/accounts');

    if (!this.config.privateKey) {
      throw new Error('PRIVATE_KEY required for on-chain merges');
    }

    const account = privateKeyToAccount(this.config.privateKey as `0x${string}`);
    const chain = this.config.chain.toLowerCase() === 'amoy' ? polygonAmoy : polygon;

    this.clients = {
      wallet: createWalletClient({ account, chain, transport: http() }),
      public: createPublicClient({ chain, transport: http() }) as import('viem').PublicClient,
      account,
    };
    return this.clients;
  }

  /**
   * Merge `shares` matched YES/NO pairs of the given market back into USDC.
   * Returns true when the transaction confirmed successfully.
   */
  async mergePositions(conditionId: string, negRisk: boolean, shares: number): Promise<boolean> {
    // Outcome tokens and USDC both use 6 decimals; merge whole pairs only.
    const amount = BigInt(Math.floor(shares)) * 1_000_000n;
    if (amount <= 0n) return false;

    const { wallet, public: publicClient, account } = await this.init();
    const chain = wallet.chain;

    const hash = negRisk
      ? await wallet.writeContract({
          address: NEG_RISK_ADAPTER,
          abi: NEG_RISK_ADAPTER_ABI,
          functionName: 'mergePositions',
          args: [conditionId as `0x${string}`, amount],
          account,
          chain,
        })
      : await wallet.writeContract({
          address: CTF_ADDRESS,
          abi: CTF_ABI,
          functionName: 'mergePositions',
          args: [USDC_ADDRESS, ZERO_BYTES32, conditionId as `0x${string}`, [1n, 2n], amount],
          account,
          chain,
        });

    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    const ok = receipt.status === 'success';
    log()[ok ? 'info' : 'error']({ hash, conditionId, negRisk, shares }, 'CTF merge transaction');
    return ok;
  }
}
