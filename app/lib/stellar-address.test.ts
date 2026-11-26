import {
  base32Decode,
  base32Encode,
  crc16Xmodem,
  decodeMuxedAddress,
  decodeStellarPublicKey,
  encodeMuxedAddress,
  encodeStellarPublicKey,
  isMuxedAddress,
  isValidStellarDestination,
  isValidStellarPublicKey,
  parseStellarDestination,
} from "./stellar-address";

const ACCOUNT = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const MUXED_ZERO =
  "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ";
const MUXED_HIGH_BIT =
  "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK";
const MUXED_UINT64_MAX =
  "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJV7777777777775ZO4";

function withInvalidVersion(address: string): string {
  const decoded = base32Decode(address);
  if (!decoded) throw new Error("Invalid test vector");
  decoded[0] = 0x61;
  const checksum = crc16Xmodem(decoded.subarray(0, 41));
  decoded[41] = checksum & 0xff;
  decoded[42] = (checksum >>> 8) & 0xff;
  return base32Encode(decoded);
}

describe("Stellar address helpers", () => {
  it("keeps G account validation separate from M destination validation", () => {
    expect(isValidStellarPublicKey(ACCOUNT)).toBe(true);
    expect(isValidStellarPublicKey(MUXED_ZERO)).toBe(false);
    expect(isMuxedAddress(ACCOUNT)).toBe(false);
    expect(isValidStellarDestination(ACCOUNT)).toBe(true);
    expect(isValidStellarDestination(MUXED_ZERO)).toBe(true);
  });

  it("decodes the SEP-23 zero ID vector", () => {
    expect(decodeMuxedAddress(MUXED_ZERO)).toEqual({
      account: ACCOUNT,
      id: 0n,
      rawKey: decodeStellarPublicKey(ACCOUNT),
    });
  });

  it("decodes the SEP-23 vector with the high ID bit set", () => {
    expect(decodeMuxedAddress(MUXED_HIGH_BIT)).toMatchObject({
      account: ACCOUNT,
      id: 1n << 63n,
    });
  });

  it("encodes and decodes the maximum unsigned 64-bit ID losslessly", () => {
    const maxId = (1n << 64n) - 1n;
    expect(encodeMuxedAddress(ACCOUNT, maxId)).toBe(MUXED_UINT64_MAX);
    expect(decodeMuxedAddress(MUXED_UINT64_MAX)).toMatchObject({
      account: ACCOUNT,
      id: maxId,
    });
  });

  it("round-trips an M address and its underlying key", () => {
    const decoded = decodeMuxedAddress(MUXED_ZERO);
    expect(decoded).not.toBeNull();
    expect(encodeMuxedAddress(decoded!.account, decoded!.id)).toBe(MUXED_ZERO);
    expect(decoded!.rawKey).toEqual(decodeStellarPublicKey(ACCOUNT));
    expect(encodeStellarPublicKey(decoded!.rawKey)).toBe(ACCOUNT);
  });

  it("parses G and M destinations with distinct result shapes", () => {
    expect(parseStellarDestination(ACCOUNT)).toEqual({
      kind: "account",
      address: ACCOUNT,
    });
    expect(parseStellarDestination(MUXED_ZERO)).toEqual({
      kind: "muxed",
      address: MUXED_ZERO,
      account: ACCOUNT,
      memoId: 0n,
    });
  });

  it.each([
    ["bad checksum", `${MUXED_ZERO.slice(0, -1)}A`],
    ["wrong length", MUXED_ZERO.slice(0, -1)],
    ["wrong version", withInvalidVersion(MUXED_ZERO)],
    ["lowercase", MUXED_ZERO.toLowerCase()],
    ["mixed case", `m${MUXED_ZERO.slice(1)}`],
    ["trailing data", `${MUXED_ZERO}A`],
    ["surrounding whitespace", ` ${MUXED_ZERO} `],
  ])("rejects a muxed address with %s", (_description, value) => {
    expect(decodeMuxedAddress(value)).toBeNull();
    expect(isMuxedAddress(value)).toBe(false);
    expect(parseStellarDestination(value)).toBeNull();
  });

  it("rejects IDs outside uint64 and invalid account keys when encoding", () => {
    expect(() => encodeMuxedAddress(ACCOUNT, -1n)).toThrow(RangeError);
    expect(() => encodeMuxedAddress(ACCOUNT, 1n << 64n)).toThrow(RangeError);
    expect(() => encodeMuxedAddress(MUXED_ZERO, 0n)).toThrow(
      "Invalid Stellar ed25519 public key",
    );
  });
});

describe("base32, CRC-16 and public key validation", () => {
  it("crc16Xmodem matches the standard check value", () => {
    const bytes = new TextEncoder().encode("123456789");
    expect(crc16Xmodem(bytes)).toBe(0x31c3);
  });

  it("base32Encode and base32Decode round-trip arbitrary byte arrays", () => {
    const samples = [
      Uint8Array.from([0, 1, 2, 3, 4]),
      Uint8Array.from([255, 254, 253, 252, 251, 250, 249, 248, 247, 246]),
      Uint8Array.from({ length: 35 }, (_, i) => (i * 37 + 11) % 256),
    ];
    for (const bytes of samples) {
      const decoded = base32Decode(base32Encode(bytes));
      expect(decoded).not.toBeNull();
      expect(Array.from(decoded!)).toEqual(Array.from(bytes));
    }
  });

  it("base32Decode returns null for an invalid character", () => {
    expect(base32Decode(`${ACCOUNT.slice(0, 10)}0${ACCOUNT.slice(11)}`)).toBeNull();
  });

  it("encodeStellarPublicKey and decodeStellarPublicKey round-trip 32 bytes", () => {
    const original = decodeStellarPublicKey(ACCOUNT);
    expect(original).not.toBeNull();
    expect(original!.length).toBe(32);

    const encoded = encodeStellarPublicKey(original!);
    expect(encoded).toBe(ACCOUNT);

    const custom = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) % 256);
    const roundTrip = decodeStellarPublicKey(encodeStellarPublicKey(custom));
    expect(Array.from(roundTrip!)).toEqual(Array.from(custom));
  });

  it("accepts a known-valid public key", () => {
    expect(isValidStellarPublicKey(ACCOUNT)).toBe(true);
    expect(decodeStellarPublicKey(ACCOUNT)).not.toBeNull();
  });

  it.each([
    ["a flipped checksum character", `${ACCOUNT.slice(0, -1)}A`],
    ["a 55-character key", ACCOUNT.slice(0, -1)],
    ["a 57-character key", `${ACCOUNT}A`],
    ["lowercase input", ACCOUNT.toLowerCase()],
    ["invalid base32 character 0", `${ACCOUNT.slice(0, 10)}0${ACCOUNT.slice(11)}`],
    ["invalid base32 character 1", `${ACCOUNT.slice(0, 10)}1${ACCOUNT.slice(11)}`],
    ["invalid base32 character 8", `${ACCOUNT.slice(0, 10)}8${ACCOUNT.slice(11)}`],
    ["invalid base32 character 9", `${ACCOUNT.slice(0, 10)}9${ACCOUNT.slice(11)}`],
    ["an S prefix", `S${ACCOUNT.slice(1)}`],
    ["an M prefix", `M${ACCOUNT.slice(1)}`],
    ["an empty string", ""],
  ])("isValidStellarPublicKey rejects %s", (_description, value) => {
    expect(isValidStellarPublicKey(value)).toBe(false);
    expect(decodeStellarPublicKey(value)).toBeNull();
  });

  it("encodeStellarPublicKey throws for 31- and 33-byte input", () => {
    expect(() => encodeStellarPublicKey(new Uint8Array(31))).toThrow();
    expect(() => encodeStellarPublicKey(new Uint8Array(33))).toThrow();
  });
});
