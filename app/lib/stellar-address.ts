/**
 * stellar-address.ts
 *
 * Client-safe Stellar address helpers.
 *
 * This module deliberately has **no Node-only imports** (no `crypto`, no
 * `Buffer`) so it can be bundled into client components as well as imported
 * from API route handlers. `wallet-link.ts` re-exports
 * `isValidStellarPublicKey` / `encodeStellarPublicKey` from here for
 * back-compatibility, so there is a single implementation of the base32 +
 * CRC-16 XMODEM check used across the app.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Strkey version byte for an ed25519 public key (6 << 3). */
const ED25519_VERSION_BYTE = 6 << 3;

export function crc16Xmodem(data: Uint8Array): number {
  let crc = 0x0000;

  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
    }
  }

  return crc;
}

export function base32Encode(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let result = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return result;
}

export function base32Decode(input: string): Uint8Array | null {
  const normalized = input.replace(/=+$/, "").toUpperCase();
  let value = 0;
  let bits = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      return null;
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  if (bits >= 5 || (value & ((1 << bits) - 1)) !== 0) {
    return null;
  }

  return Uint8Array.from(bytes);
}

/**
 * Decode a Stellar ed25519 public key (Strkey) into its 32 raw bytes.
 * Returns `null` when the input is not a well-formed, checksum-valid key.
 */
export function decodeStellarPublicKey(publicKey: string): Uint8Array | null {
  if (typeof publicKey !== "string" || publicKey.length !== 56 || !publicKey.startsWith("G")) {
    return null;
  }

  const decoded = base32Decode(publicKey);
  if (!decoded || decoded.length !== 35) {
    return null;
  }

  const version = decoded[0];
  if (version !== ED25519_VERSION_BYTE) {
    return null;
  }

  const payload = decoded.subarray(0, 33);
  const checksum = decoded[33] | (decoded[34] << 8);
  if (crc16Xmodem(payload) !== checksum) {
    return null;
  }

  return decoded.subarray(1, 33);
}

/** True when `publicKey` is a valid Stellar ed25519 public key (Strkey). */
export function isValidStellarPublicKey(publicKey: string): boolean {
  return decodeStellarPublicKey(publicKey) !== null;
}

/** Encode 32 raw ed25519 bytes as a Stellar `G…` Strkey. */
export function encodeStellarPublicKey(rawPublicKey: Uint8Array): string {
  if (rawPublicKey.length !== 32) {
    throw new Error("Invalid raw public key length");
  }

  const payload = new Uint8Array(35);
  payload[0] = ED25519_VERSION_BYTE;
  payload.set(rawPublicKey, 1);
  const checksum = crc16Xmodem(payload.subarray(0, 33));
  payload[33] = checksum & 0xff;
  payload[34] = (checksum >>> 8) & 0xff;

  return base32Encode(payload);
}
