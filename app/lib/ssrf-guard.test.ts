/** @jest-environment node */
import { isSafePublicHttpUrl } from "./ssrf-guard";
test.each([
  "http://127.0.0.1", "http://10.0.0.1", "http://169.254.169.254",
  "https://localhost.", "https://metadata.google.internal.", "http://[::1]",
  "http://[::ffff:10.0.0.1]", "http://[::ffff:7f00:1]", "http://[ff02::1]",
  "http://224.0.0.1", "http://100.64.0.1", "http://198.18.0.1",
  "https://user:password@example.com", "file:///etc/passwd",
])("rejects unsafe literal or hostname %s", value => {
  expect(isSafePublicHttpUrl(value)).toBe(false);
});
it("accepts a syntactically public HTTPS destination without claiming DNS safety", () => {
  expect(isSafePublicHttpUrl("https://example.com/hook")).toBe(true);
});
