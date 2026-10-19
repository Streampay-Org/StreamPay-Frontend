/** @jest-environment node */
import { signToken } from "@/app/lib/auth";
import {
  DEFAULT_TENANT,
  normaliseTenant,
  resolveRequestTenant,
  resolveRequestTenantOrDefault,
} from "@/app/lib/tenant";

const WALLET = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/streams", { headers });
}

describe("resolveRequestTenant", () => {
  it("returns null when the request has no tenant context", () => {
    expect(resolveRequestTenant(request())).toBeNull();
  });

  it("returns a trimmed x-tenant-id header", () => {
    expect(resolveRequestTenant(request({ "x-tenant-id": "  acme  " }))).toBe("acme");
  });

  it("treats a whitespace-only header as absent", () => {
    expect(resolveRequestTenant(request({ "x-tenant-id": "   " }))).toBeNull();
  });

  it("prefers a verified JWT tenant claim over the header", () => {
    const token = signToken(WALLET, { tenantId: "jwt-tenant" });
    const resolved = resolveRequestTenant(
      request({ authorization: `Bearer ${token}`, "x-tenant-id": "header-tenant" }),
    );
    expect(resolved).toBe("jwt-tenant");
  });

  it("accepts snake_case tenant claims", () => {
    const token = signToken(WALLET, { tenant_id: "snake-tenant" });
    expect(
      resolveRequestTenant(request({ authorization: `Bearer ${token}` })),
    ).toBe("snake-tenant");
  });

  it("falls back to the header when the bearer token is invalid", () => {
    expect(
      resolveRequestTenant(
        request({ authorization: "Bearer not-a-token", "x-tenant-id": "header-tenant" }),
      ),
    ).toBe("header-tenant");
  });

  it("falls back to the default tenant only through the OrDefault helper", () => {
    expect(resolveRequestTenant(request())).toBeNull();
    expect(resolveRequestTenantOrDefault(request())).toBe(DEFAULT_TENANT);
  });
});

describe("normaliseTenant", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["   ", null],
    [" acme ", "acme"],
  ])("normalises %p to %p", (input, expected) => {
    expect(normaliseTenant(input)).toBe(expected);
  });
});
