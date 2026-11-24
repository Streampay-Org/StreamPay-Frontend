/**
 * @jest-environment jsdom
 */
import {
  defaultProviders,
  getMRUWalletId,
  getSortedProviders,
  setMRUWalletId,
  type WalletProvider,
} from "./walletPrefs";

const MRU_KEY = "streampay_mru_wallet";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("walletPrefs state module", () => {
  describe("getMRUWalletId", () => {
    it("returns null when localStorage is empty", () => {
      expect(localStorage.getItem(MRU_KEY)).toBeNull();
      expect(getMRUWalletId()).toBeNull();
    });

    it("returns the previously stored id", () => {
      setMRUWalletId("xbull");
      expect(getMRUWalletId()).toBe("xbull");
    });

    it("normalizes an empty-string storage entry to null", () => {
      localStorage.setItem(MRU_KEY, "");
      expect(getMRUWalletId()).toBeNull();
    });

    it("survives a round-trip: set → get returns the same id", () => {
      for (const provider of defaultProviders) {
        setMRUWalletId(provider.id);
        expect(getMRUWalletId()).toBe(provider.id);
      }
    });
  });

  describe("setMRUWalletId", () => {
    it("writes the given id to localStorage under the canonical key", () => {
      setMRUWalletId("freighter");
      expect(localStorage.getItem(MRU_KEY)).toBe("freighter");
    });

    it("overwrites a previously stored MRU id", () => {
      setMRUWalletId("freighter");
      setMRUWalletId("albedo");
      expect(localStorage.getItem(MRU_KEY)).toBe("albedo");
    });
  });

  describe("getSortedProviders", () => {
    it("returns the default provider order when no MRU is set", () => {
      const order = getSortedProviders().map((p) => p.id);
      expect(order).toEqual(["freighter", "xbull", "albedo", "rabet"]);
    });

    it("never mutates the input and handles every reorder branch correctly", () => {
      // No-MRU path: empty storage -> declared order, fresh array.
      const noMru = getSortedProviders();
      expect(noMru).not.toBe(defaultProviders);
      expect(noMru).toEqual(defaultProviders);

      // Already-at-head: no reorder, fresh array.
      setMRUWalletId("freighter");
      const atHead = getSortedProviders();
      expect(atHead).not.toBe(defaultProviders);
      expect(atHead).toEqual(defaultProviders);

      // Stale id (not in the list): declared order, fresh array.
      setMRUWalletId("ledger-deprecated");
      const stale = getSortedProviders();
      expect(stale).not.toBe(defaultProviders);
      expect(stale).toEqual(defaultProviders);

      // Real reorder: MRU provider at index 0.
      setMRUWalletId("albedo");
      const reordered = getSortedProviders();
      expect(reordered).not.toBe(defaultProviders);
      expect(reordered.map((p) => p.id)).toEqual([
        "albedo",
        "freighter",
        "xbull",
        "rabet",
      ]);

      // defaultProviders itself remains untouched after all of the above.
      expect(defaultProviders.map((p) => p.id)).toEqual([
        "freighter",
        "xbull",
        "albedo",
        "rabet",
      ]);
    });

    it("sorts a custom providers list using the MRU id", () => {
      const custom: WalletProvider[] = [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
        { id: "gamma", name: "Gamma" },
      ];
      setMRUWalletId("gamma");
      const order = getSortedProviders(custom).map((p) => p.id);
      expect(order).toEqual(["gamma", "alpha", "beta"]);
    });

    it("returns an empty array when given an empty provider list", () => {
      setMRUWalletId("freighter");
      expect(getSortedProviders([])).toEqual([]);
    });
  });

  describe("MRU lifecycle", () => {
    it("reflects the most recent selection on the next read", () => {
      setMRUWalletId("freighter");
      setMRUWalletId("rabet");
      setMRUWalletId("albedo");
      expect(getMRUWalletId()).toBe("albedo");

      // getSortedProviders reflects the latest write immediately.
      expect(getSortedProviders().map((p) => p.id)).toEqual([
        "albedo",
        "freighter",
        "xbull",
        "rabet",
      ]);
    });
  });

  describe("defaultProviders", () => {
    it("exports a non-empty list with unique ids", () => {
      expect(defaultProviders.length).toBeGreaterThan(0);
      const ids = defaultProviders.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
