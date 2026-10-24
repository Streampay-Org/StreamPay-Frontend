import {
  getOnboardingProgress,
  isChecklistHidden,
  setChecklistHidden,
  safeGetItem,
  STORAGE_KEYS,
  type StorageReader,
} from "./onboardingProgress";

describe("onboardingProgress", () => {
  let mockStorage: Record<string, string>;
  let storage: StorageReader;

  beforeEach(() => {
    mockStorage = {};
    storage = {
      getItem: (key: string) => mockStorage[key] ?? null,
      setItem: (key: string, val: string) => {
        mockStorage[key] = val;
      },
    } as any;
  });

  describe("safeGetItem", () => {
    it("returns null when storage is null or undefined", () => {
      expect(safeGetItem(null, "any_key")).toBeNull();
      expect(safeGetItem(undefined, "any_key")).toBeNull();
    });

    it("returns null when storage throws", () => {
      const throwingStorage = {
        getItem: () => {
          throw new Error("QuotaExceededError");
        },
      };
      expect(safeGetItem(throwingStorage, "key")).toBeNull();
    });

    it("returns stored value when present", () => {
      mockStorage["test"] = "value";
      expect(safeGetItem(storage, "test")).toBe("value");
    });
  });

  describe("getOnboardingProgress", () => {
    it("Scenario 1: Empty storage returns 0 of 4 done; all links are present", () => {
      const result = getOnboardingProgress(storage);

      expect(result.completed).toBe(0);
      expect(result.total).toBe(4);
      expect(result.items).toHaveLength(4);

      // Verify all items are not_started
      for (const item of result.items) {
        expect(item.status).toBe("not_started");
        expect(item.statusText).toBe("To do");
        expect(item.explanation).toBeTruthy();
        expect(item.href).toBeTruthy();
        expect(item.linkText).toBeTruthy();
      }

      const hrefs = result.items.map((i) => i.href);
      expect(hrefs).toContain("/contacts");
      expect(hrefs).toContain("/templates");
      expect(hrefs).toContain("/streams/new");
    });

    it("Scenario 2: One contact saved marks the 'Save a contact' item as done", () => {
      mockStorage[STORAGE_KEYS.CONTACTS] = JSON.stringify([
        { id: "1", label: "Alice", address: "GXXX" },
      ]);

      const result = getOnboardingProgress(storage);
      expect(result.completed).toBe(1);

      const contactItem = result.items.find((i) => i.id === "save-contact");
      expect(contactItem?.status).toBe("completed");
      expect(contactItem?.statusText).toBe("Completed");
    });

    it("handles invalid or empty contacts json gracefully", () => {
      mockStorage[STORAGE_KEYS.CONTACTS] = "invalid json";
      let result = getOnboardingProgress(storage);
      let contactItem = result.items.find((i) => i.id === "save-contact");
      expect(contactItem?.status).toBe("not_started");

      mockStorage[STORAGE_KEYS.CONTACTS] = JSON.stringify([]);
      result = getOnboardingProgress(storage);
      contactItem = result.items.find((i) => i.id === "save-contact");
      expect(contactItem?.status).toBe("not_started");
    });

    it("Scenario 3: Wizard draft present marks the 'Create a stream' item as 'In progress'", () => {
      mockStorage[STORAGE_KEYS.WIZARD_DRAFT] = JSON.stringify({
        recipient: "GBVZZ...",
        amount: "100",
        token: "XLM",
        gasOnRecipient: false,
        savedAt: Date.now(),
      });

      const result = getOnboardingProgress(storage);
      expect(result.completed).toBe(0);

      const streamItem = result.items.find((i) => i.id === "create-stream");
      expect(streamItem?.status).toBe("in_progress");
      expect(streamItem?.statusText).toBe("In progress");
      expect(streamItem?.linkText).toBe("Resume stream");
    });

    it("recognizes wallet connected via MRU or session state", () => {
      mockStorage[STORAGE_KEYS.WALLET_MRU] = "freighter";
      let result = getOnboardingProgress(storage);
      let walletItem = result.items.find((i) => i.id === "connect-wallet");
      expect(walletItem?.status).toBe("completed");
      expect(result.completed).toBe(1);

      delete mockStorage[STORAGE_KEYS.WALLET_MRU];
      mockStorage[STORAGE_KEYS.WALLET_SESSION] = "session-token-abc";
      result = getOnboardingProgress(storage);
      walletItem = result.items.find((i) => i.id === "connect-wallet");
      expect(walletItem?.status).toBe("completed");
    });

    it("recognizes browse templates visited flag", () => {
      mockStorage[STORAGE_KEYS.TEMPLATES_VISITED] = "true";
      const result = getOnboardingProgress(storage);
      const templatesItem = result.items.find((i) => i.id === "browse-templates");
      expect(templatesItem?.status).toBe("completed");
      expect(result.completed).toBe(1);
    });

    it("Scenario 6: All done when wallet, contact, template, and stream are complete", () => {
      mockStorage[STORAGE_KEYS.WALLET_MRU] = "freighter";
      mockStorage[STORAGE_KEYS.CONTACTS] = JSON.stringify([{ id: "1" }]);
      mockStorage[STORAGE_KEYS.TEMPLATES_VISITED] = "true";
      mockStorage[STORAGE_KEYS.STREAM_CREATED] = "true";

      const result = getOnboardingProgress(storage);
      expect(result.completed).toBe(4);
      expect(result.total).toBe(4);
      expect(result.items.every((i) => i.status === "completed")).toBe(true);
    });

    it("recognizes stream completed from recent recipients list", () => {
      mockStorage[STORAGE_KEYS.RECENT_RECIPIENTS] = JSON.stringify([
        { address: "GABC...", addedAt: Date.now() },
      ]);

      const result = getOnboardingProgress(storage);
      const streamItem = result.items.find((i) => i.id === "create-stream");
      expect(streamItem?.status).toBe("completed");
      expect(result.completed).toBe(1);
    });

    it("Scenario 7: Storage throws - renders 0 of 4 with no crash", () => {
      const throwingStorage = {
        getItem: () => {
          throw new Error("Private browsing blocked storage");
        },
      };

      const result = getOnboardingProgress(throwingStorage as any);
      expect(result.completed).toBe(0);
      expect(result.total).toBe(4);
      expect(result.items.every((i) => i.status === "not_started")).toBe(true);
    });

    it("works with undefined storage (server-side safety)", () => {
      const result = getOnboardingProgress(undefined);
      expect(result.completed).toBe(0);
      expect(result.total).toBe(4);
      expect(result.items.every((i) => i.status === "not_started")).toBe(true);
    });
  });

  describe("isChecklistHidden and setChecklistHidden", () => {
    it("returns false by default", () => {
      expect(isChecklistHidden(storage)).toBe(false);
    });

    it("persists hide checklist preference", () => {
      setChecklistHidden(storage as any, true);
      expect(isChecklistHidden(storage)).toBe(true);

      setChecklistHidden(storage as any, false);
      expect(isChecklistHidden(storage)).toBe(false);
    });

    it("handles throwing storage gracefully when setting hidden", () => {
      const throwingStorage = {
        getItem: () => null,
        setItem: () => {
          throw new Error("Quota exceeded");
        },
      };
      expect(() => setChecklistHidden(throwingStorage as any, true)).not.toThrow();
    });
  });
});
