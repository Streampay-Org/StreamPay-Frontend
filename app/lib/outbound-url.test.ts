import {
  assertSafeOutboundUrl,
  isPrivateOrRestrictedIp,
  isPrivateOrRestrictedIpv4,
  isPrivateOrRestrictedIpv6,
  UnsafeUrlError,
} from "./outbound-url";

describe("outbound-url guard", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe("IP address validation", () => {
    it("identifies private IPv4 addresses", () => {
      expect(isPrivateOrRestrictedIpv4("169.254.169.254")).toBe(true); // metadata / link-local
      expect(isPrivateOrRestrictedIpv4("127.0.0.1")).toBe(true); // loopback
      expect(isPrivateOrRestrictedIpv4("10.0.0.1")).toBe(true); // RFC 1918
      expect(isPrivateOrRestrictedIpv4("172.16.0.5")).toBe(true); // RFC 1918
      expect(isPrivateOrRestrictedIpv4("172.31.255.255")).toBe(true); // RFC 1918
      expect(isPrivateOrRestrictedIpv4("192.168.1.1")).toBe(true); // RFC 1918
      expect(isPrivateOrRestrictedIpv4("100.64.0.1")).toBe(true); // CGNAT
      expect(isPrivateOrRestrictedIpv4("100.127.255.255")).toBe(true); // CGNAT
      expect(isPrivateOrRestrictedIpv4("0.0.0.0")).toBe(true); // Current net
      expect(isPrivateOrRestrictedIpv4("192.0.2.1")).toBe(true); // TEST-NET-1
      expect(isPrivateOrRestrictedIpv4("198.51.100.1")).toBe(true); // TEST-NET-2
      expect(isPrivateOrRestrictedIpv4("203.0.113.1")).toBe(true); // TEST-NET-3
      expect(isPrivateOrRestrictedIpv4("224.0.0.1")).toBe(true); // Multicast
      expect(isPrivateOrRestrictedIpv4("240.0.0.1")).toBe(true); // Reserved
      expect(isPrivateOrRestrictedIpv4("255.255.255.255")).toBe(true); // Broadcast

      // Public IP
      expect(isPrivateOrRestrictedIpv4("8.8.8.8")).toBe(false);
      expect(isPrivateOrRestrictedIpv4("1.1.1.1")).toBe(false);
      expect(isPrivateOrRestrictedIpv4("93.184.216.34")).toBe(false);
    });

    it("identifies private IPv6 addresses", () => {
      expect(isPrivateOrRestrictedIpv6("::1")).toBe(true); // Loopback
      expect(isPrivateOrRestrictedIpv6("::")).toBe(true); // Unspecified
      expect(isPrivateOrRestrictedIpv6("fe80::1")).toBe(true); // Link-local
      expect(isPrivateOrRestrictedIpv6("fc00::1")).toBe(true); // ULA
      expect(isPrivateOrRestrictedIpv6("fd12:3456:789a::1")).toBe(true); // ULA
      expect(isPrivateOrRestrictedIpv6("ff02::1")).toBe(true); // Multicast
      expect(isPrivateOrRestrictedIpv6("::ffff:127.0.0.1")).toBe(true); // IPv4-mapped loopback
      expect(isPrivateOrRestrictedIpv6("::ffff:10.0.0.1")).toBe(true); // IPv4-mapped private
      expect(isPrivateOrRestrictedIpv6("::ffff:169.254.169.254")).toBe(true); // IPv4-mapped link-local
      expect(isPrivateOrRestrictedIpv6("64:ff9b::10.0.0.1")).toBe(true); // IPv4/IPv6 translation private

      // Public IPv6
      expect(isPrivateOrRestrictedIpv6("2607:f8b0:4005:805::200e")).toBe(false);
    });

    it("identifies invalid IP strings as restricted", () => {
      expect(isPrivateOrRestrictedIp("not-an-ip")).toBe(true);
      expect(isPrivateOrRestrictedIpv4("999.999.999.999")).toBe(true);
      expect(isPrivateOrRestrictedIpv6("gggg::1")).toBe(true);
    });
  });

  describe("assertSafeOutboundUrl scenarios", () => {
    // Scenario 1: http://169.254.169.254/ -> Rejected
    it("Scenario 1: rejects metadata IP http://169.254.169.254/", async () => {
      process.env.NODE_ENV = "development";
      await expect(
        assertSafeOutboundUrl("http://169.254.169.254/"),
      ).rejects.toThrow(UnsafeUrlError);
    });

    // Scenario 2: http://127.0.0.1:8080, http://[::1]/, http://[::ffff:10.0.0.1]/ -> Rejected
    it("Scenario 2: rejects loopback and IPv4-mapped private hosts", async () => {
      process.env.NODE_ENV = "development";
      await expect(
        assertSafeOutboundUrl("http://127.0.0.1:8080/"),
      ).rejects.toThrow(UnsafeUrlError);

      await expect(
        assertSafeOutboundUrl("http://[::1]/"),
      ).rejects.toThrow(UnsafeUrlError);

      await expect(
        assertSafeOutboundUrl("http://[::ffff:10.0.0.1]/"),
      ).rejects.toThrow(UnsafeUrlError);
    });

    // Scenario 3: https://hooks.example.com resolving to 10.1.2.3 -> Rejected
    it("Scenario 3: rejects host resolving to a private IP", async () => {
      const mockDns = jest.fn().mockResolvedValue([
        { address: "10.1.2.3", family: 4 },
      ]);
      await expect(
        assertSafeOutboundUrl("https://hooks.example.com/", { dnsLookup: mockDns }),
      ).rejects.toThrow(UnsafeUrlError);
      expect(mockDns).toHaveBeenCalledWith("hooks.example.com", { all: true });
    });

    // Scenario 4: https://hooks.example.com resolving to a public IP -> Accepted, pinned address returned
    it("Scenario 4: accepts host resolving to public IP and returns pinned address", async () => {
      const mockDns = jest.fn().mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ]);
      const result = await assertSafeOutboundUrl("https://hooks.example.com/webhook", {
        dnsLookup: mockDns,
      });
      expect(result.pinnedAddress).toBe("93.184.216.34");
      expect(result.url.hostname).toBe("hooks.example.com");
    });

    // Scenario 5: https://user:pw@hooks.example.com -> Rejected
    it("Scenario 5: rejects credentials in URL", async () => {
      await expect(
        assertSafeOutboundUrl("https://user:pw@hooks.example.com/"),
      ).rejects.toThrow("URL must not contain credentials (userinfo).");
    });

    // Scenario 6: http:// in a production env -> Rejected
    it("Scenario 6: rejects http in production env", async () => {
      process.env.NODE_ENV = "production";
      await expect(
        assertSafeOutboundUrl("http://example.com/"),
      ).rejects.toThrow("HTTP is not allowed in production");
    });

    it("rejects non-allowlisted ports", async () => {
      await expect(
        assertSafeOutboundUrl("https://example.com:22/"),
      ).rejects.toThrow("Port '22' is not permitted");

      await expect(
        assertSafeOutboundUrl("https://example.com:80/"),
      ).rejects.toThrow("Port '80' is not permitted for outbound webhooks.");
    });

    it("allows port 8443 and default 443", async () => {
      const mockDns = jest.fn().mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ]);
      const res = await assertSafeOutboundUrl("https://example.com:8443/webhook", {
        dnsLookup: mockDns,
      });
      expect(res.pinnedAddress).toBe("93.184.216.34");
    });

    it("fails closed on DNS error or empty address list", async () => {
      const mockDnsFail = jest.fn().mockRejectedValue(new Error("ENOTFOUND"));
      await expect(
        assertSafeOutboundUrl("https://notfound.example.com/", { dnsLookup: mockDnsFail }),
      ).rejects.toThrow("DNS resolution failed");

      const mockDnsEmpty = jest.fn().mockResolvedValue([]);
      await expect(
        assertSafeOutboundUrl("https://empty.example.com/", { dnsLookup: mockDnsEmpty }),
      ).rejects.toThrow("DNS resolution returned no addresses");
    });

    it("rejects when multiple addresses returned and one is private", async () => {
      const mockDns = jest.fn().mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address: "192.168.1.5", family: 4 },
      ]);
      await expect(
        assertSafeOutboundUrl("https://dual.example.com/", { dnsLookup: mockDns }),
      ).rejects.toThrow("resolves to a private or restricted IP address");
    });

    it("rejects invalid inputs", async () => {
      await expect(assertSafeOutboundUrl("")).rejects.toThrow("non-empty string");
      await expect(assertSafeOutboundUrl("not-a-url")).rejects.toThrow("Invalid URL format");
      await expect(assertSafeOutboundUrl("ftp://example.com/")).rejects.toThrow("Unsupported protocol");
    });
  });
});
