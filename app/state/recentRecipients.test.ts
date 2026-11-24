/**
 * @jest-environment jsdom
 */
import { encodeStellarPublicKey } from "../lib/stellar-address";
import {
  addRecentRecipient,
  clearRecentRecipients,
  getRecentRecipients,
} from "./recentRecipients";

const STORAGE_KEY = "streampay_recent_recipients";

function makeValidAddress(seed: number): string {
  const raw = new Uint8Array(32).fill(seed);
  return encodeStellarPublicKey(raw);
}

const ADDR_1 = makeValidAddress(1);
const ADDR_2 = makeValidAddress(2);
const ADDR_3 = makeValidAddress(3);
const ADDR_4 = makeValidAddress(4);
const ADDR_5 = makeValidAddress(5);
const ADDR_6 = makeValidAddress(6);
const ADDR_7 = makeValidAddress(7);

beforeEach(() => {
  localStorage.clear();
  jest.restoreAllMocks();
});

describe("recentRecipients", () => {
  it("returns an empty array when nothing is stored (including non-test NODE_ENV)", () => {
    const originalEnv = process.env.NODE_ENV;
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      configurable: true,
    });
    try {
      expect(getRecentRecipients()).toEqual([]);
    } finally {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: originalEnv,
        configurable: true,
      });
    }
  });

  it("returns an empty array on corrupt JSON in localStorage", () => {
    localStorage.setItem(STORAGE_KEY, "{not valid json");
    expect(getRecentRecipients()).toEqual([]);
  });

  it("returns an empty array when stored JSON is not an array", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ address: ADDR_1, addedAt: 1 }));
    expect(getRecentRecipients()).toEqual([]);
  });

  it("filters out malformed entries and invalid Stellar public keys", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { address: ADDR_1, addedAt: 100 },
        { address: "GNOTAVALIDSTELLARKEY", addedAt: 200 },
        { address: "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZK7GQ", addedAt: 0 },
        { address: ADDR_2, addedAt: "not-a-number" },
        { address: ADDR_3, addedAt: null },
        { address: 12345, addedAt: 300 },
        null,
        "raw-string",
        { address: ADDR_4, addedAt: 400 },
      ])
    );

    expect(getRecentRecipients()).toEqual([
      { address: ADDR_1, addedAt: 100 },
      { address: ADDR_4, addedAt: 400 },
    ]);
  });

  it("stores valid Stellar public keys and ignores invalid ones", () => {
    addRecentRecipient("");
    addRecentRecipient("   ");
    addRecentRecipient("GABC123");
    addRecentRecipient("GBVZZ5QKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2ZQK");
    expect(getRecentRecipients()).toEqual([]);

    addRecentRecipient(`  ${ADDR_1}  `);
    const result = getRecentRecipients();
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe(ADDR_1);
    expect(typeof result[0].addedAt).toBe("number");
  });

  it("moves a duplicate address to the front without duplicating it", () => {
    addRecentRecipient(ADDR_1);
    addRecentRecipient(ADDR_2);
    addRecentRecipient(ADDR_1);

    const addresses = getRecentRecipients().map((r) => r.address);
    expect(addresses).toEqual([ADDR_1, ADDR_2]);
  });

  it("caps stored recipients at 6 and evicts the oldest when a 7th is added", () => {
    [ADDR_1, ADDR_2, ADDR_3, ADDR_4, ADDR_5, ADDR_6, ADDR_7].forEach(
      addRecentRecipient
    );

    const addresses = getRecentRecipients().map((r) => r.address);
    expect(addresses).toEqual([ADDR_7, ADDR_6, ADDR_5, ADDR_4, ADDR_3, ADDR_2]);
  });

  it("does not throw when localStorage.setItem throws (e.g. quota exceeded)", () => {
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });

    expect(() => addRecentRecipient(ADDR_1)).not.toThrow();
  });

  it("does not throw when localStorage.removeItem throws", () => {
    jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(() => clearRecentRecipients()).not.toThrow();
  });

  it("handles SSR safely when window is undefined", () => {
    const windowSpy = jest
      .spyOn(globalThis, "window", "get")
      .mockReturnValue(undefined as unknown as Window & typeof globalThis);

    try {
      expect(getRecentRecipients()).toEqual([]);
      expect(() => addRecentRecipient(ADDR_1)).not.toThrow();
      expect(() => clearRecentRecipients()).not.toThrow();
    } finally {
      windowSpy.mockRestore();
    }
  });
});
