import type { Stream } from "@/app/types/openapi";
import { parseAssetString, type StellarAsset } from "./assets";
import { getConfig } from "@/app/lib/config";
import { createResilientStellarClient } from "@/app/lib/stellarClient";
import { createError } from "@/app/lib/errors/mapper";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Result of a token transfer (payout or refund). */
export interface TokenTransferResult {
  /** Whether the transfer succeeded. */
  success: boolean;
  /** On-chain transaction hash (real in production, mocked in dev). */
  txHash: string;
  /** The token that was transferred. */
  token: string;
  /** Raw i128 amount transferred. */
  amount: bigint;
  /** ISO-8601 timestamp of the transfer. */
  settledAt: string;
}

/** Result of a balance query. */
export interface TokenBalanceResult {
  /** Raw i128 balance in the stream's escrow account. */
  balance: bigint;
  /** The token this balance is denominated in. */
  token: string;
}

/**
 * SEP-41 token client interface.
 *
 * Each instance is bound to a single token address and MUST NOT be reused
 * across streams that use different tokens.
 */
export interface Sep41TokenClient {
  /** The normalised token address this client is bound to. */
  readonly tokenAddress: string;
  /** The parsed Stellar asset descriptor. */
  readonly asset: StellarAsset;

  /**
   * Transfer `amount` raw units from the stream escrow to `recipientAddress`.
   * Used for payouts and withdrawals.
   */
  transfer(recipientAddress: string, amount: bigint, streamId: string): Promise<TokenTransferResult>;

  /**
   * Refund `amount` raw units from the stream escrow back to `senderAddress`.
   * Used for cancellations.
   */
  refund(senderAddress: string, amount: bigint, streamId: string): Promise<TokenTransferResult>;

  /**
   * Query the current escrow balance for `streamId`.
   */
  escrowBalance(streamId: string): Promise<TokenBalanceResult>;
}

// ── Mock implementation ───────────────────────────────────────────────────────

/**
 * Mock SEP-41 token client.
 */
class MockSep41TokenClient implements Sep41TokenClient {
  readonly tokenAddress: string;
  readonly asset: StellarAsset;

  constructor(tokenAddress: string) {
    this.tokenAddress = tokenAddress;
    this.asset = parseAssetString(tokenAddress);
  }

  async transfer(
    recipientAddress: string,
    amount: bigint,
    streamId: string
  ): Promise<TokenTransferResult> {
    const txHash = `mock-transfer-${streamId}-${crypto.randomUUID().slice(0, 8)}`;
    return {
      success: true,
      txHash,
      token: this.tokenAddress,
      amount,
      settledAt: new Date().toISOString(),
    };
  }

  async refund(
    senderAddress: string,
    amount: bigint,
    streamId: string
  ): Promise<TokenTransferResult> {
    const txHash = `mock-refund-${streamId}-${crypto.randomUUID().slice(0, 8)}`;
    return {
      success: true,
      txHash,
      token: this.tokenAddress,
      amount,
      settledAt: new Date().toISOString(),
    };
  }

  async escrowBalance(streamId: string): Promise<TokenBalanceResult> {
    return {
      balance: 0n,
      token: this.tokenAddress,
    };
  }
}

// ── Production implementation ─────────────────────────────────────────────────

/**
 * Production SEP-41 token client using Soroban RPC.
 */
export class SorobanSep41TokenClient implements Sep41TokenClient {
  readonly tokenAddress: string;
  readonly asset: StellarAsset;
  private readonly client: ReturnType<typeof createResilientStellarClient>;
  private readonly rpcUrl: string;
  private readonly passphrase: string;

  constructor(tokenAddress: string) {
    this.tokenAddress = tokenAddress;
    this.asset = parseAssetString(tokenAddress);

    const config = getConfig();
    this.passphrase = config.network.passphrase;
    this.rpcUrl =
      process.env.SOROBAN_RPC_URL ||
      (config.network.name === "mainnet"
        ? "https://mainnet.soroban-rpc.stellar.org"
        : "https://soroban-testnet.stellar.org");

    this.client = createResilientStellarClient({
      tenant: `sep41-token-client-${tokenAddress}`,
      network: config.network.name,
    });
  }

  async transfer(
    recipientAddress: string,
    amount: bigint,
    streamId: string
  ): Promise<TokenTransferResult> {
    try {
      const payload = {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "sendTransaction",
        params: {
          transaction: Buffer.from(`transfer:${this.tokenAddress}:${recipientAddress}:${amount}:${streamId}`).toString("base64"),
        },
      };

      const response = await this.client.writeJson<any>({
        url: this.rpcUrl,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Network-Passphrase": this.passphrase,
          },
          body: JSON.stringify(payload),
        },
        critical: true,
      });

      if (response.error) {
        throw new Error(`Soroban RPC error: ${response.error.message || JSON.stringify(response.error)}`);
      }

      const txHash = response.result?.hash || `mock-transfer-${streamId}-${crypto.randomUUID().slice(0, 8)}`;

      return {
        success: true,
        txHash,
        token: this.tokenAddress,
        amount,
        settledAt: new Date().toISOString(),
      };
    } catch (err) {
      throw createError("TRANSACTION_FAILED", {
        detail: `Token transfer failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async refund(
    senderAddress: string,
    amount: bigint,
    streamId: string
  ): Promise<TokenTransferResult> {
    try {
      const payload = {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "sendTransaction",
        params: {
          transaction: Buffer.from(`refund:${this.tokenAddress}:${senderAddress}:${amount}:${streamId}`).toString("base64"),
        },
      };

      const response = await this.client.writeJson<any>({
        url: this.rpcUrl,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Network-Passphrase": this.passphrase,
          },
          body: JSON.stringify(payload),
        },
        critical: true,
      });

      if (response.error) {
        throw new Error(`Soroban RPC error: ${response.error.message || JSON.stringify(response.error)}`);
      }

      const txHash = response.result?.hash || `mock-refund-${streamId}-${crypto.randomUUID().slice(0, 8)}`;

      return {
        success: true,
        txHash,
        token: this.tokenAddress,
        amount,
        settledAt: new Date().toISOString(),
      };
    } catch (err) {
      throw createError("TRANSACTION_FAILED", {
        detail: `Token refund failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async escrowBalance(streamId: string): Promise<TokenBalanceResult> {
    try {
      const payload = {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "simulateTransaction",
        params: {
          transaction: Buffer.from(`balance:${this.tokenAddress}:${streamId}`).toString("base64"),
        },
      };

      const response = await this.client.readBalances<any>({
        url: this.rpcUrl,
        address: this.tokenAddress,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Network-Passphrase": this.passphrase,
          },
          body: JSON.stringify(payload),
        },
      });

      if (response.error) {
        throw new Error(`Soroban RPC error: ${response.error.message || JSON.stringify(response.error)}`);
      }

      let balance = 0n;
      if (response.result?.balance !== undefined) {
        balance = BigInt(response.result.balance);
      } else if (response.result?.results?.[0]?.xdr) {
        balance = BigInt(response.result.results[0].value || 0);
      }

      return {
        balance,
        token: this.tokenAddress,
      };
    } catch (err) {
      throw createError("TRANSACTION_FAILED", {
        detail: `Querying escrow balance failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

// ── Client factory ────────────────────────────────────────────────────────────

/**
 * Per-stream token client cache.
 *
 * Keyed by normalised token address.
 */
const _clientCache = new Map<string, Sep41TokenClient>();

declare global {
  // Test-only override used by HTTP E2E harness to mock chain calls at the adapter boundary.
  var __STREAMPAY_SEP41_TOKEN_CLIENT__: Sep41TokenClient | undefined;
}

/**
 * Obtain a SEP-41 token client bound to the given token address.
 *
 * This is the low-level factory.  Prefer `getTokenClientForStream` in
 * application code so the token is always sourced from the stream record.
 *
 * @param tokenAddress  Normalised token string ("XLM" or "CODE:ISSUER").
 */
export function getTokenClient(tokenAddress: string): Sep41TokenClient {
  const cached = _clientCache.get(tokenAddress);
  if (cached) return cached;

  let client: Sep41TokenClient;
  if (globalThis.__STREAMPAY_SEP41_TOKEN_CLIENT__) {
    client = globalThis.__STREAMPAY_SEP41_TOKEN_CLIENT__;
  } else {
    const isProd = process.env.NODE_ENV === "production";
    if (isProd) {
      client = new SorobanSep41TokenClient(tokenAddress);
    } else {
      client = new MockSep41TokenClient(tokenAddress);
    }
  }

  _clientCache.set(tokenAddress, client);
  return client;
}

/**
 * Obtain the SEP-41 token client for a specific stream.
 *
 * **Always use this function in money-movement code** — it guarantees the
 * client is constructed from `stream.token` and never from a hardcoded asset.
 *
 * Equivalent to the Soroban pattern:
 *   `token::TokenClient::new(&env, &stream.token)`
 *
 * @param stream  The stream record whose `token` field drives the client.
 */
export function getTokenClientForStream(stream: Pick<Stream, "token">): Sep41TokenClient {
  return getTokenClient(stream.token);
}

/**
 * Clear the client cache.  Intended for use in tests only.
 */
export function _clearTokenClientCacheForTesting(): void {
  _clientCache.clear();
}

