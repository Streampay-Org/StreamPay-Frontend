import * as fc from "fast-check";
import {
  getTokenClient,
  getTokenClientForStream,
  _clearTokenClientCacheForTesting,
  SorobanSep41TokenClient,
} from "./sep41-token-client";
import { isStreamPayError } from "./errors/mapper";
import { resetConfigCache } from "./config";

const vi = {
  fn: (impl?: any) => jest.fn(impl),
  spyOn: (obj: any, prop: string) => jest.spyOn(obj, prop),
  clearAllMocks: () => jest.clearAllMocks(),
  stubGlobal: (name: string, value: any) => {
    (global as any)[name] = value;
  },
};

describe("SEP-41 Token Client", () => {
  let originalFetch: any;
  let originalNodeEnv: string | undefined;
  let originalJwtSecret: string | undefined;

  beforeAll(() => {
    originalFetch = (globalThis as any).fetch;
    originalNodeEnv = process.env.NODE_ENV;
    originalJwtSecret = process.env.JWT_SECRET;
  });

  function setEnv(env: "test" | "production") {
    process.env.NODE_ENV = env;
    if (env === "production") {
      process.env.JWT_SECRET = "production-secret-must-be-at-least-32-characters-long";
    } else {
      process.env.JWT_SECRET = originalJwtSecret || "streampay-dev-secret-do-not-use-in-prod";
    }
    resetConfigCache();
  }

  beforeEach(() => {
    _clearTokenClientCacheForTesting();
    delete (globalThis as any).__STREAMPAY_SEP41_TOKEN_CLIENT__;
    vi.clearAllMocks();
    setEnv("test");
  });

  afterAll(() => {
    (globalThis as any).fetch = originalFetch;
    process.env.NODE_ENV = originalNodeEnv;
    process.env.JWT_SECRET = originalJwtSecret;
    resetConfigCache();
  });

  describe("MockSep41TokenClient", () => {
    it("should successfully execute transfer, refund, and escrowBalance", async () => {
      setEnv("test");
      const token = "XLM";
      const client = getTokenClient(token);

      const transferRes = await client.transfer("GABC", 100n, "stream-1");
      expect(transferRes.success).toBe(true);
      expect(transferRes.txHash).toMatch(/^mock-transfer-stream-1-/);
      expect(transferRes.token).toBe(token);
      expect(transferRes.amount).toBe(100n);

      const refundRes = await client.refund("GXYZ", 50n, "stream-1");
      expect(refundRes.success).toBe(true);
      expect(refundRes.txHash).toMatch(/^mock-refund-stream-1-/);
      expect(refundRes.token).toBe(token);
      expect(refundRes.amount).toBe(50n);

      const balanceRes = await client.escrowBalance("stream-1");
      expect(balanceRes.balance).toBe(0n);
      expect(balanceRes.token).toBe(token);
    });
  });

  describe("SorobanSep41TokenClient (Production)", () => {
    const token = "USDC:" + "G" + "A".repeat(55);

    it("should successfully execute transfer via simulated Soroban RPC", async () => {
      const mockTxHash = "tx-hash-123456";
      const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            result: {
              hash: mockTxHash,
              status: "PENDING",
            },
          }),
        };
      });
      vi.stubGlobal("fetch", mockFetch);

      setEnv("production");
      const client = new SorobanSep41TokenClient(token);
      const res = await client.transfer("GABC", 100n, "stream-1");
      expect(res.success).toBe(true);
      expect(res.txHash).toBe(mockTxHash);
      expect(res.amount).toBe(100n);
      expect(res.token).toBe(token);

      // Verify fetch details
      expect(mockFetch).toHaveBeenCalled();
      const [calledUrl, calledInit] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe("https://soroban-testnet.stellar.org");
      const body = JSON.parse(calledInit.body);
      expect(body.method).toBe("sendTransaction");
      const decodedTx = Buffer.from(body.params.transaction, "base64").toString();
      expect(decodedTx).toBe(`transfer:${token}:GABC:100:stream-1`);
    });

    it("should successfully execute refund via simulated Soroban RPC", async () => {
      const mockTxHash = "tx-hash-refund";
      const mockFetch = vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            result: {
              hash: mockTxHash,
            },
          }),
        };
      });
      vi.stubGlobal("fetch", mockFetch);

      setEnv("production");
      const client = new SorobanSep41TokenClient(token);
      const res = await client.refund("GXYZ", 50n, "stream-1");
      expect(res.success).toBe(true);
      expect(res.txHash).toBe(mockTxHash);
      expect(res.amount).toBe(50n);

      const [calledUrl, calledInit] = mockFetch.mock.calls[0];
      const body = JSON.parse(calledInit.body);
      expect(body.method).toBe("sendTransaction");
      const decodedTx = Buffer.from(body.params.transaction, "base64").toString();
      expect(decodedTx).toBe(`refund:${token}:GXYZ:50:stream-1`);
    });

    it("should query escrowBalance correctly", async () => {
      const mockFetch = vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            result: {
              balance: "250",
            },
          }),
        };
      });
      vi.stubGlobal("fetch", mockFetch);

      setEnv("production");
      const client = new SorobanSep41TokenClient(token);
      const res = await client.escrowBalance("stream-1");
      expect(res.balance).toBe(250n);
      expect(res.token).toBe(token);

      const [calledUrl, calledInit] = mockFetch.mock.calls[0];
      const body = JSON.parse(calledInit.body);
      expect(body.method).toBe("simulateTransaction");
      const decodedTx = Buffer.from(body.params.transaction, "base64").toString();
      expect(decodedTx).toBe(`balance:${token}:stream-1`);
    });

    it("should query escrowBalance fallback result format correctly", async () => {
      const mockFetch = vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            result: {
              results: [{ xdr: "dummy-xdr", value: 450 }],
            },
          }),
        };
      });
      vi.stubGlobal("fetch", mockFetch);

      setEnv("production");
      const client = new SorobanSep41TokenClient(token);
      const res = await client.escrowBalance("stream-1");
      expect(res.balance).toBe(450n);
    });

    it("should map fetch RPC error to standard TRANSACTION_FAILED StreamPayError", async () => {
      const mockFetch = vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message: "Invalid request",
            },
          }),
        };
      });
      vi.stubGlobal("fetch", mockFetch);

      setEnv("production");
      const client = new SorobanSep41TokenClient(token);

      try {
        await client.transfer("GABC", 100n, "stream-1");
        fail("Should have thrown a StreamPayError");
      } catch (err) {
        expect(isStreamPayError(err)).toBe(true);
        expect((err as any).code).toBe("TRANSACTION_FAILED");
        expect((err as any).detail).toContain("Soroban RPC error");
      }
    });

    it("should handle fetch network failures and surface as TRANSACTION_FAILED", async () => {
      const mockFetch = vi.fn(async () => {
        throw new Error("Network timeout");
      });
      vi.stubGlobal("fetch", mockFetch);

      setEnv("production");
      const client = new SorobanSep41TokenClient(token);
      try {
        await client.escrowBalance("stream-1");
        fail("Should have thrown");
      } catch (err) {
        expect(isStreamPayError(err)).toBe(true);
        expect((err as any).code).toBe("TRANSACTION_FAILED");
      }
    });
  });

  describe("Adapter Boundary and Factory selection", () => {
    it("returns MockSep41TokenClient in test/development NODE_ENV by default", () => {
      setEnv("test");
      const client = getTokenClient("XLM");
      expect(client.constructor.name).toBe("MockSep41TokenClient");
    });

    it("returns SorobanSep41TokenClient in production NODE_ENV", () => {
      setEnv("production");
      const client = getTokenClient("XLM");
      expect(client.constructor.name).toBe("SorobanSep41TokenClient");
    });

    it("returns overridden global client if __STREAMPAY_SEP41_TOKEN_CLIENT__ is present", () => {
      const dummyClient: any = { tokenAddress: "dummy", asset: {} };
      (globalThis as any).__STREAMPAY_SEP41_TOKEN_CLIENT__ = dummyClient;

      setEnv("test");
      const client = getTokenClient("XLM");
      expect(client).toBe(dummyClient);
    });

    it("constructs client from stream record in getTokenClientForStream", () => {
      setEnv("test");
      const stream = { token: "USDC:" + "G" + "A".repeat(55) };
      const client = getTokenClientForStream(stream);
      expect(client.tokenAddress).toBe(stream.token);
    });
  });

  describe("Per-Stream Isolation Invariant (Property-based)", () => {
    const alphabetArb = fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
    const codeCharArb = fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    const issuerArb = fc.array(alphabetArb, { minLength: 55, maxLength: 55 }).map((arr) => "G" + arr.join(""));
    const codeArb = fc.array(codeCharArb, { minLength: 3, maxLength: 4 }).map((arr) => arr.join(""));
    const tokenArb = fc.oneof(
      fc.constant("XLM"),
      fc.tuple(codeArb, issuerArb).map(([code, issuer]) => `${code}:${issuer}`)
    );

    it("ensures different tokens never share escrow/balance cache", () => {
      fc.assert(
        fc.property(tokenArb, tokenArb, (tokenA, tokenB) => {
          if (tokenA === tokenB) return true;

          setEnv("production");
          _clearTokenClientCacheForTesting();

          const clientA = getTokenClient(tokenA);
          const clientB = getTokenClient(tokenB);

          // They must be distinct instances
          if (clientA === clientB) return false;

          // Their addresses must be correctly set
          if (clientA.tokenAddress !== tokenA) return false;
          if (clientB.tokenAddress !== tokenB) return false;

          return true;
        }),
        { numRuns: 100 }
      );
    });
  });
});
