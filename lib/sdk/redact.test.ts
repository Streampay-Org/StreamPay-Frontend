import {
  redactDiagnosticBody,
  isSensitiveKey,
  isSensitiveValue,
  REDACTED,
  MAX_STRING_LENGTH,
} from "./redact";

describe("isSensitiveKey", () => {
  it("matches credential key tokens case-insensitively", () => {
    for (const key of [
      "token",
      "accessToken",
      "access_token",
      "secret",
      "secretKey",
      "clientSecret",
      "password",
      "passphrase",
      "privateKey",
      "signature",
      "seed",
      "mnemonic",
      "credential",
      "authorization",
      "bearer",
      "jwt",
      "hmac",
      "apiKey",
      "api_key",
      "api-key",
      "apikey",
      "accessKey",
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it("does not over-match ordinary keys", () => {
    for (const key of [
      "publicKey",
      "monkey",
      "keyboard",
      "recipient",
      "rate",
      "schedule",
      "amount",
      "label",
      "email",
      "data",
    ]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});

describe("isSensitiveValue", () => {
  // Valid StrKey: "S" + 55 base32 chars (uppercase letters and digits 2-7).
  const validSeed = `S${"A".repeat(55)}`;

  it("detects Stellar secret seeds under any key", () => {
    expect(isSensitiveValue(validSeed)).toBe(true);
  });

  it("detects PEM private key blocks", () => {
    expect(isSensitiveValue("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toBe(true);
    expect(isSensitiveValue("-----BEGIN EC PRIVATE KEY-----\nabc")).toBe(true);
  });

  it("rejects public wallet addresses and ordinary strings", () => {
    expect(isSensitiveValue("GABC12345")).toBe(false);
    expect(isSensitiveValue("XLM")).toBe(false);
    expect(isSensitiveValue("plain text")).toBe(false);
  });
});

describe("redactDiagnosticBody", () => {
  it("passes through non-sensitive primitives unchanged", () => {
    expect(redactDiagnosticBody(null)).toBe(null);
    expect(redactDiagnosticBody(undefined)).toBe(undefined);
    expect(redactDiagnosticBody(42)).toBe(42);
    expect(redactDiagnosticBody(true)).toBe(true);
    expect(redactDiagnosticBody("hello")).toBe("hello");
  });

  it("preserves non-sensitive payloads unchanged", () => {
    const payload = { recipient: "GABC", rate: "10", schedule: "week", amount: 100 };
    expect(redactDiagnosticBody(payload)).toEqual(payload);
  });

  it("redacts sensitive top-level fields", () => {
    const result = redactDiagnosticBody({
      recipient: "GABC",
      token: "partner-token",
      secret: "s3cr3t",
      password: "hunter2",
    }) as Record<string, unknown>;

    expect(result.recipient).toBe("GABC");
    expect(result.token).toBe(REDACTED);
    expect(result.secret).toBe(REDACTED);
    expect(result.password).toBe(REDACTED);
  });

  it("redacts sensitive fields inside nested objects and arrays", () => {
    const result = redactDiagnosticBody({
      error: {
        code: "VALIDATION_ERROR",
        details: {
          fieldErrors: { email: "invalid" },
          request: {
            privateKey: "S…",
            recipient: "GABC",
          },
        },
      },
      items: [{ authorization: "Bearer abc" }, { amount: 1 }],
    }) as Record<string, unknown>;

    const details = (result.error as Record<string, unknown>).details as Record<string, unknown>;
    const request = details.request as Record<string, unknown>;
    expect(request.privateKey).toBe(REDACTED);
    expect(request.recipient).toBe("GABC");

    const items = result.items as Record<string, unknown>[];
    expect(items[0].authorization).toBe(REDACTED);
    expect(items[1].amount).toBe(1);
  });

  it("redacts Stellar secret seeds even under non-sensitive keys", () => {
    const seed = `S${"A".repeat(55)}`;
    const result = redactDiagnosticBody({ keypair: { value: seed } }) as Record<string, unknown>;
    expect((result.keypair as Record<string, unknown>).value).toBe(REDACTED);
  });

  it("does not mutate its input", () => {
    const payload = { token: "abc", nested: { recipient: "GABC" } };
    const snapshot = JSON.stringify(payload);
    redactDiagnosticBody(payload);
    expect(JSON.stringify(payload)).toBe(snapshot);
  });

  it("is deterministic for identical input", () => {
    const payload = { a: 1, token: "x", nested: { secret: "y", keep: ["z"] } };
    expect(redactDiagnosticBody(payload)).toEqual(redactDiagnosticBody(payload));
  });

  it("handles empty containers and boundary inputs without throwing", () => {
    expect(redactDiagnosticBody({})).toEqual({});
    expect(redactDiagnosticBody([])).toEqual([]);
    expect(redactDiagnosticBody({ a: {} })).toEqual({ a: {} });
    expect(redactDiagnosticBody({ a: null, b: undefined })).toEqual({ a: null, b: undefined });
  });

  it("terminates on cyclic references and redacts them", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;

    const result = redactDiagnosticBody(cyclic) as Record<string, unknown>;
    expect(result.name).toBe("loop");
    expect(result.self).toBe(REDACTED);
  });

  it("handles repeated (non-cyclic) references fully", () => {
    const shared = { token: "abc" };
    const result = redactDiagnosticBody({ a: shared, b: shared }) as Record<string, unknown>;
    expect((result.a as Record<string, unknown>).token).toBe(REDACTED);
    expect((result.b as Record<string, unknown>).token).toBe(REDACTED);
  });

  it("truncates oversized strings to bound diagnostic size", () => {
    const long = "x".repeat(MAX_STRING_LENGTH + 500);
    const result = redactDiagnosticBody({ message: long }) as Record<string, unknown>;
    expect((result.message as string).length).toBeLessThanOrEqual(MAX_STRING_LENGTH + 20);
    expect((result.message as string)).not.toHaveLength(long.length);
  });

  it("handles deep nesting without recursion blowup", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 100; i++) {
      deep = { next: deep };
    }
    expect(() => redactDiagnosticBody(deep)).not.toThrow();
  });

  it("fails closed on pathological objects", () => {
    const hostile = {
      get token() {
        throw new Error("boom");
      },
    };
    const result = redactDiagnosticBody(hostile);
    expect(result).toBe(REDACTED);
  });
});
