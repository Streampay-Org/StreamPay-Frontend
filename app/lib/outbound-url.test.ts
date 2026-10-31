/** @jest-environment node */
import { assertSafeOutboundUrl } from "./outbound-url";
const publicDns = jest.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
beforeEach(() => publicDns.mockClear());
test.each(["https://127.0.0.1", "https://10.0.0.1", "https://169.254.169.254",
  "https://[::1]", "https://[::ffff:10.0.0.1]", "https://[fd00::1]", "https://224.0.0.1",
  "https://user:pass@example.com", "https://example.com:1234", "file:///etc/passwd",
])("rejects unsafe destination %s without public DNS", async raw => {
  await expect(assertSafeOutboundUrl(raw, { resolve: publicDns })).rejects.toThrow();
});
it("rejects a domain if any DNS result is private", async () => {
  await expect(assertSafeOutboundUrl("https://example.com", {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }],
  })).rejects.toThrow();
});
it("returns a pinned public address", async () => {
  const target = await assertSafeOutboundUrl("https://example.com/hook", { resolve: publicDns });
  expect(target.address).toBe("93.184.216.34");
  expect(target.url.hostname).toBe("example.com");
  expect(target.family).toBe(4);
});
it("fails closed on DNS failure", async () => {
  await expect(assertSafeOutboundUrl("https://example.com", {
    resolve: async () => { throw new Error("DNS unavailable"); },
  })).rejects.toThrow();
});
it("never permits HTTP in production", async () => {
  jest.replaceProperty(process, "env", { ...process.env, NODE_ENV: "production" });
  try { await expect(assertSafeOutboundUrl("http://example.com", { allowHttp: true, resolve: publicDns })).rejects.toThrow(); }
  finally { jest.restoreAllMocks(); }
});
