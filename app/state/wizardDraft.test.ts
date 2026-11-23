/**
 * @jest-environment jsdom
 */

import {
  WIZARD_DRAFT_KEY,
  clearWizardDraft,
  getWizardDraft,
  isWizardDraftEmpty,
  saveWizardDraft,
} from "./wizardDraft";

describe("wizardDraft state helpers", () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.restoreAllMocks();
  });

  it("saves and retrieves a non-empty draft", () => {
    saveWizardDraft({
      recipient: "GD72X2Y3B6V7XW5P",
      amount: "100",
      token: "USDC",
      gasOnRecipient: true,
    });

    const draft = getWizardDraft();
    expect(draft).not.toBeNull();
    expect(draft?.recipient).toBe("GD72X2Y3B6V7XW5P");
    expect(draft?.amount).toBe("100");
    expect(draft?.token).toBe("USDC");
    expect(draft?.gasOnRecipient).toBe(true);
    expect(draft?.savedAt).toBeGreaterThan(0);
  });

  it("does not recreate the key when clearWizardDraft is followed by an empty state update", () => {
    saveWizardDraft({
      recipient: "GD72X2Y3B6V7XW5P",
      amount: "450",
      token: "USDC",
      gasOnRecipient: true,
    });
    expect(window.localStorage.getItem(WIZARD_DRAFT_KEY)).not.toBeNull();

    clearWizardDraft();
    expect(window.localStorage.getItem(WIZARD_DRAFT_KEY)).toBeNull();

    // Simulate autosave running after form fields are reset to pristine defaults
    saveWizardDraft({
      recipient: "",
      amount: "",
      token: "XLM",
      gasOnRecipient: false,
    });

    expect(window.localStorage.getItem(WIZARD_DRAFT_KEY)).toBeNull();
    expect(getWizardDraft()).toBeNull();
  });

  it("detects empty vs non-empty drafts via isWizardDraftEmpty", () => {
    expect(
      isWizardDraftEmpty({
        recipient: "",
        amount: "",
        token: "XLM",
        gasOnRecipient: false,
      }),
    ).toBe(true);

    expect(
      isWizardDraftEmpty({
        recipient: "GABC",
        amount: "",
        token: "XLM",
        gasOnRecipient: false,
      }),
    ).toBe(false);

    expect(
      isWizardDraftEmpty({
        recipient: "",
        amount: "",
        token: "USDC",
        gasOnRecipient: false,
      }),
    ).toBe(false);
  });

  it("handles unavailable/throwing localStorage without throwing", () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(() =>
      saveWizardDraft({
        recipient: "GABC",
        amount: "10",
        token: "XLM",
        gasOnRecipient: false,
      }),
    ).not.toThrow();
    expect(() => clearWizardDraft()).not.toThrow();
    expect(getWizardDraft()).toBeNull();
  });
});
