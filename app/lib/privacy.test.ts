import { redact } from "./privacy";

describe("privacy", () => {
  it("redacts sensitive keys", () => {
    const data = {
      publicKey: "G123456789",
      signature: "some-sig",
      email: "test@example.org",
      amount: "100",
      nested: {
        secret: "top-secret"
      }
    };
    const redacted = redact(data);
    expect(redacted.publicKey).toBe("[REDACTED]");
    expect(redacted.signature).toBe("[REDACTED]");
    expect(redacted.email).toBe("[REDACTED]");
    expect(redacted.amount).toBe("100");
    expect(redacted.nested.secret).toBe("[REDACTED]");
  });

  it("keeps arrays as arrays and redacts their entries", () => {
    const redacted = redact([{ token: "x", amount: 1 }]);
    expect(Array.isArray(redacted)).toBe(true);
    expect(redacted).toHaveLength(1);
    expect(redacted[0].token).toBe("[REDACTED]");
    expect(redacted[0].amount).toBe(1);
  });

  it("redacts nested arrays", () => {
    const redacted = redact({
      batches: [[{ secretKey: "a" }, { amount: 2 }], [{ accessToken: "b" }]],
    });
    expect(Array.isArray(redacted.batches)).toBe(true);
    expect(Array.isArray(redacted.batches[0])).toBe(true);
    expect(redacted.batches[0][0].secretKey).toBe("[REDACTED]");
    expect(redacted.batches[0][1].amount).toBe(2);
    expect(redacted.batches[1][0].accessToken).toBe("[REDACTED]");
  });

  it.each([
    ["secretKey"],
    ["secret_key"],
    ["secret-key"],
    ["accessToken"],
    ["access_token"],
    ["refreshToken"],
    ["authorization"],
    ["Authorization"],
    ["apiKey"],
    ["api_key"],
    ["x-api-key"],
    ["privateKey"],
    ["private_key"],
    ["publicKey"],
    ["signature"],
    ["password"],
    ["userEmail"],
  ])("redacts %s", (key) => {
    const redacted = redact({ [key]: "sensitive-value", amount: "10" });
    expect(redacted[key]).toBe("[REDACTED]");
    expect(redacted.amount).toBe("10");
  });

  it("documents the substring behaviour for token-bearing keys", () => {
    const redacted = redact({
      token: "XLM",
      tokenSymbol: "XLM",
      tokenAddress: "C...",
      amount: "100",
    });
    // Substring matching: anything containing "token" is redacted.
    expect(redacted.token).toBe("[REDACTED]");
    expect(redacted.tokenSymbol).toBe("[REDACTED]");
    expect(redacted.tokenAddress).toBe("[REDACTED]");
    expect(redacted.amount).toBe("100");
  });

  it("never mutates the input", () => {
    const data = {
      publicKey: "G123",
      nested: { secret: "s", values: [1, 2, 3] },
      list: [{ token: "x" }],
    };
    const snapshot = JSON.parse(JSON.stringify(data));

    redact(data);

    expect(data).toEqual(snapshot);
  });

  it("returns primitives, null and undefined unchanged", () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(42)).toBe(42);
    expect(redact("plain")).toBe("plain");
    expect(redact(true)).toBe(true);
    expect(redact([])).toEqual([]);
    expect(redact({ empty: null, missing: undefined })).toEqual({
      empty: null,
      missing: undefined,
    });
  });

  it("leaves non-plain objects intact", () => {
    const when = new Date("2026-01-01T00:00:00.000Z");
    const buffer = Buffer.from("secret-bytes");

    const redacted = redact({ when, buffer });

    expect(redacted.when).toBe(when);
    expect(redacted.buffer).toBe(buffer);
  });

  it("replaces circular references with [CIRCULAR]", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    cyclic.child = { back: cyclic };

    const redacted = redact(cyclic);

    expect(redacted.name).toBe("root");
    expect(redacted.self).toBe("[CIRCULAR]");
    expect(redacted.child.back).toBe("[CIRCULAR]");
  });
});
