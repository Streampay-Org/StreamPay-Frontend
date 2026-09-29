import { randomUUID, createHash, verify } from "crypto";
import { MAINNET_PROFILE, TESTNET_PROFILE } from "./config/stellar";
import {
  decodeStellarPublicKey,
  isValidStellarPublicKey,
} from "./stellar-address";

// The Strkey base32 + CRC-16 helpers live in ./stellar-address so that
// client components can validate addresses without pulling in Node's crypto.
// They are re-exported here to preserve the existing public surface.
export { isValidStellarPublicKey, encodeStellarPublicKey } from "./stellar-address";

const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK === "mainnet"
    ? MAINNET_PROFILE.passphrase
    : TESTNET_PROFILE.passphrase;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_PREFIX = "StreamPay wallet authentication challenge";
const ED25519_SPki_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type WalletLinkChallenge = {
  publicKey: string;
  nonce: string;
  message: string;
  expiresAt: number;
  used: boolean;
};

export class WalletLinkError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const pendingChallenges = new Map<string, WalletLinkChallenge>();

function buildChallengeMessage(publicKey: string, nonce: string, expiresAtIso: string): string {
  return [
    CHALLENGE_PREFIX,
    `Network: ${NETWORK_PASSPHRASE}`,
    `Public key: ${publicKey}`,
    `Nonce: ${nonce}`,
    `Expires at: ${expiresAtIso}`,
  ].join("\n");
}

function cleanupExpiredChallenges(): void {
  const now = Date.now();
  for (const [nonce, challenge] of pendingChallenges.entries()) {
    if (challenge.expiresAt <= now) {
      pendingChallenges.delete(nonce);
    }
  }
}

export function issueWalletLinkChallenge(publicKey: string): {
  publicKey: string;
  nonce: string;
  message: string;
  expiresAt: string;
} {
  if (!isValidStellarPublicKey(publicKey)) {
    throw new WalletLinkError("VALIDATION_ERROR", "Invalid Stellar public key", 422);
  }

  cleanupExpiredChallenges();

  const nonce = randomUUID();
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  const expiresAtIso = new Date(expiresAt).toISOString();
  const message = buildChallengeMessage(publicKey, nonce, expiresAtIso);

  pendingChallenges.set(nonce, {
    publicKey,
    nonce,
    message,
    expiresAt,
    used: false,
  });

  return { publicKey, nonce, message, expiresAt: expiresAtIso };
}

export function resetWalletLinkChallenges(): void {
  pendingChallenges.clear();
}

export function verifyWalletLinkChallenge(input: {
  publicKey: string;
  nonce: string;
  message: string;
  signature: string;
}): void {
  cleanupExpiredChallenges();

  const { publicKey, nonce, message, signature } = input;
  if (!publicKey || !nonce || !message || !signature) {
    throw new WalletLinkError("VALIDATION_ERROR", "Missing required challenge fields", 422);
  }

  const challenge = pendingChallenges.get(nonce);
  if (!challenge) {
    throw new WalletLinkError("INVALID_CHALLENGE", "Challenge not found or expired", 401);
  }

  if (challenge.used) {
    throw new WalletLinkError("CHALLENGE_REPLAYED", "Challenge has already been used", 401);
  }

  if (challenge.publicKey !== publicKey || challenge.message !== message) {
    throw new WalletLinkError("INVALID_CHALLENGE", "Challenge data does not match", 401);
  }

  const publicKeyBytes = decodeStellarPublicKey(publicKey);
  if (!publicKeyBytes) {
    throw new WalletLinkError("VALIDATION_ERROR", "Invalid Stellar public key", 422);
  }

  const signatureBytes = Buffer.from(signature, "base64");
  if (signatureBytes.length !== 64) {
    throw new WalletLinkError("INVALID_SIGNATURE", "Signature must be a 64-byte Ed25519 signature", 401);
  }

  const publicKeyDer = Buffer.concat([ED25519_SPki_PREFIX, Buffer.from(publicKeyBytes)]);
  const verified = verify(
    "ed25519",
    Buffer.from(message, "utf-8"),
    { key: publicKeyDer, format: "der", type: "spki" },
    signatureBytes
  );

  if (!verified) {
    throw new WalletLinkError("INVALID_SIGNATURE", "Signature verification failed", 401);
  }

  challenge.used = true;
}
