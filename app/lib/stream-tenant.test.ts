import { DEFAULT_STREAM_TENANT_ID, TENANT_COOKIE_NAME } from "@/app/lib/stream-tenant";
import { resolveRequestTenant } from "@/app/lib/stream-visibility";

function requestWithHeaders(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/streams", { headers });
}

describe("resolveRequestTenant", () => {
  it("pins DEFAULT_STREAM_TENANT_ID and TENANT_COOKIE_NAME constants", () => {
    expect(DEFAULT_STREAM_TENANT_ID).toBe("default-tenant");
    expect(TENANT_COOKIE_NAME).toBe("sp_tenant_id");
  });

  describe("precedence", () => {
    it("prefers x-tenant-id over x-streampay-tenant-id and cookie", () => {
      const request = requestWithHeaders({
        "x-tenant-id": "tenant-primary",
        "x-streampay-tenant-id": "tenant-secondary",
        cookie: `${TENANT_COOKIE_NAME}=tenant-cookie`,
      });

      expect(resolveRequestTenant(request)).toBe("tenant-primary");
    });

    it("prefers x-streampay-tenant-id over cookie when x-tenant-id is absent", () => {
      const request = requestWithHeaders({
        "x-streampay-tenant-id": "tenant-secondary",
        cookie: `${TENANT_COOKIE_NAME}=tenant-cookie`,
      });

      expect(resolveRequestTenant(request)).toBe("tenant-secondary");
    });

    it("uses the tenant cookie when tenant headers are absent", () => {
      const request = requestWithHeaders({
        cookie: `${TENANT_COOKIE_NAME}=tenant-cookie`,
      });

      expect(resolveRequestTenant(request)).toBe("tenant-cookie");
    });

    it("falls back to DEFAULT_STREAM_TENANT_ID when no tenant header or cookie is present", () => {
      expect(resolveRequestTenant(requestWithHeaders())).toBe(DEFAULT_STREAM_TENANT_ID);
    });

    it("ignores empty and whitespace-only header values", () => {
      const fallsToSecondary = requestWithHeaders({
        "x-tenant-id": "   ",
        "x-streampay-tenant-id": "tenant-secondary",
        cookie: `${TENANT_COOKIE_NAME}=tenant-cookie`,
      });
      expect(resolveRequestTenant(fallsToSecondary)).toBe("tenant-secondary");

      const fallsToCookie = requestWithHeaders({
        "x-tenant-id": "",
        "x-streampay-tenant-id": "  \t ",
        cookie: `${TENANT_COOKIE_NAME}=tenant-cookie`,
      });
      expect(resolveRequestTenant(fallsToCookie)).toBe("tenant-cookie");

      const fallsToDefault = requestWithHeaders({
        "x-tenant-id": "",
        "x-streampay-tenant-id": "   ",
      });
      expect(resolveRequestTenant(fallsToDefault)).toBe(DEFAULT_STREAM_TENANT_ID);
    });
  });

  describe("cookie parsing", () => {
    it("extracts the tenant cookie when multiple cookies are present", () => {
      const request = requestWithHeaders({
        cookie: `session=abc123; ${TENANT_COOKIE_NAME}=acme; theme=dark`,
      });

      expect(resolveRequestTenant(request)).toBe("acme");
    });

    it("preserves '=' characters inside the cookie value", () => {
      const request = requestWithHeaders({
        cookie: `${TENANT_COOKIE_NAME}=org=acme=1`,
      });

      expect(resolveRequestTenant(request)).toBe("org=acme=1");
    });

    it("decodes percent-encoded cookie values", () => {
      const request = requestWithHeaders({
        cookie: `${TENANT_COOKIE_NAME}=acme%20corp`,
      });

      expect(resolveRequestTenant(request)).toBe("acme corp");
    });

    it("falls back to default when the tenant cookie value is empty or whitespace-only", () => {
      expect(
        resolveRequestTenant(requestWithHeaders({ cookie: `${TENANT_COOKIE_NAME}=` })),
      ).toBe(DEFAULT_STREAM_TENANT_ID);

      expect(
        resolveRequestTenant(requestWithHeaders({ cookie: `${TENANT_COOKIE_NAME}=   ` })),
      ).toBe(DEFAULT_STREAM_TENANT_ID);
    });

    it("ignores cookies whose name merely ends with TENANT_COOKIE_NAME", () => {
      const request = requestWithHeaders({
        cookie: `other_${TENANT_COOKIE_NAME}=wrong-tenant`,
      });

      expect(resolveRequestTenant(request)).toBe(DEFAULT_STREAM_TENANT_ID);
    });

    it("does not throw on malformed percent-encoding and yields the default tenant", () => {
      const request = requestWithHeaders({
        cookie: `${TENANT_COOKIE_NAME}=%E0%A4%A`,
      });

      expect(() => resolveRequestTenant(request)).not.toThrow();
      expect(resolveRequestTenant(request)).toBe(DEFAULT_STREAM_TENANT_ID);
    });
  });
});
