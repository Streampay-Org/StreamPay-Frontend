/**
 * @jest-environment jsdom
 */
import {
  ADMIN_CREDENTIAL_STORAGE_KEY,
  buildAdminAuthHeaders,
  readAdminCredential,
  writeAdminCredential,
} from "./admin-credential";

describe("admin credential storage", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("round-trips a credential through sessionStorage", () => {
    writeAdminCredential("token-abc");
    expect(window.sessionStorage.getItem(ADMIN_CREDENTIAL_STORAGE_KEY)).toBe("token-abc");
    expect(readAdminCredential()).toBe("token-abc");
  });

  it("removes the credential when cleared", () => {
    writeAdminCredential("token-abc");
    writeAdminCredential("");
    expect(window.sessionStorage.getItem(ADMIN_CREDENTIAL_STORAGE_KEY)).toBeNull();
    expect(readAdminCredential()).toBe("");
  });

  it("sends wallet addresses as Actor-Wallet-Address", () => {
    const wallet = `G${"A".repeat(55)}`;
    expect(buildAdminAuthHeaders(wallet)).toEqual({ "Actor-Wallet-Address": wallet });
  });

  it("sends JWTs as bearer tokens", () => {
    expect(buildAdminAuthHeaders("header.payload.signature")).toEqual({
      Authorization: "Bearer header.payload.signature",
    });
  });

  it("sends no auth headers when the credential is empty", () => {
    expect(buildAdminAuthHeaders("   ")).toEqual({});
  });
});
