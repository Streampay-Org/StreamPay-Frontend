
import { explorerAccountUrl, explorerTxUrl } from "./explorer";
import { encodeStellarPublicKey } from "./stellar-address";
import type { StellarNetwork } from "./config/stellar";

// Generate a valid Stellar public key for account URL tests.
const validAccount = encodeStellarPublicKey(new Uint8Array(32).fill(1));

// A 64-character hexadecimal string representing a transaction hash.
const validHash = "a".repeat(64);

describe("explorerAccountUrl", () => {
  it("builds the correct mainnet account URL", () => {
    expect(explorerAccountUrl(validAccount, "mainnet")).toBe(
      `https://stellar.expert/explorer/public/account/${validAccount}`,
    );
  });

  it("builds the correct testnet account URL", () => {
    expect(explorerAccountUrl(validAccount, "testnet")).toBe(
      `https://stellar.expert/explorer/testnet/account/${validAccount}`,
    );
  });

  it("returns null for an invalid Stellar public key", () => {
    expect(explorerAccountUrl("invalid-address", "mainnet")).toBeNull();
  });

  it("returns null for a muxed account address", () => {
    expect(explorerAccountUrl(`M${validAccount.slice(1)}`, "mainnet")).toBeNull();
  });

  it("returns null for an unsupported network", () => {
    expect(
      explorerAccountUrl(validAccount, "future" as StellarNetwork),
    ).toBeNull();
  });
});

describe("explorerTxUrl", () => {
  it("builds the correct mainnet transaction URL", () => {
    expect(explorerTxUrl(validHash, "mainnet")).toBe(
      `https://stellar.expert/explorer/public/tx/${validHash}`,
    );
  });

  it("builds the correct testnet transaction URL", () => {
    expect(explorerTxUrl(validHash, "testnet")).toBe(
      `https://stellar.expert/explorer/testnet/tx/${validHash}`,
    );
  });

  it("returns null for a hash with an invalid length", () => {
    expect(explorerTxUrl("abc123", "mainnet")).toBeNull();
  });

  it("returns null for a hash containing non-hexadecimal characters", () => {
    const invalidHash = `${"a".repeat(63)}g`;

    expect(explorerTxUrl(invalidHash, "mainnet")).toBeNull();
  });

  it("returns null for an unsupported network", () => {
    expect(
      explorerTxUrl(validHash, "future" as StellarNetwork),
    ).toBeNull();
  });
});
