/**
 * @jest-environment node
 */
import crypto from "crypto";
import { checkStreamPreviewRateLimit } from "@/app/lib/stream-preview-rate-limit";
import { RATE_LIMITS } from "@/app/lib/rate-limit-config";
import {
  InMemoryRateLimitStore,
  setRateLimitStore,
  resetRateLimitStore,
} from "@/app/lib/rate-limit-store";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";
import { REQUEST_ID_HEADER } from "@/lib/requestId";

jest.mock("@/app/lib/rate-limit-metrics", () => ({
  recordRequest: jest.fn(),
  recordThrottle: jest.fn(),
  recordEviction: jest.fn(),
}));

const mockRecordRequest = recordRequest as jest.Mock;
const mockRecordThrottle = recordThrottle as jest.Mock;

const PATH = "/api/streams/preview";
const KEY_A = "preview-test-key-a";
const KEY_B = "preview-test-key-b";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function makeRequest(apiKey?: string): Request {
  return new Request(`http://localhost${PATH}`, {
    method: "POST",
    headers: apiKey ? { "X-API-Key": apiKey } : {},
  });
}

const { limit, windowMs } = RATE_LIMITS.write;

let store: InMemoryRateLimitStore;
let originalKeys: string | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-15T12:00:00Z"));

  originalKeys = process.env.STREAMPAY_API_KEYS;
  process.env.STREAMPAY_API_KEYS = `${sha256(KEY_A)},${sha256(KEY_B)}`;

  store = new InMemoryRateLimitStore();
  setRateLimitStore(store);

  mockRecordRequest.mockClear();
  mockRecordThrottle.mockClear();
});

afterEach(() => {
  store.destroy();
  resetRateLimitStore();
  jest.useRealTimers();

  if (originalKeys === undefined) {
    delete process.env.STREAMPAY_API_KEYS;
  } else {
    process.env.STREAMPAY_API_KEYS = originalKeys;
  }
});

async function exhaust(apiKey: string): Promise<void> {
  for (let i = 0; i < limit; i++) {
    const res = await checkStreamPreviewRateLimit(makeRequest(apiKey));
    expect(res).toBeNull();
  }
}

describe("checkStreamPreviewRateLimit", () => {
  it("returns null and records the request when under the limit", async () => {
    const res = await checkStreamPreviewRateLimit(makeRequest(KEY_A));

    expect(res).toBeNull();
    expect(mockRecordRequest).toHaveBeenCalledTimes(1);
    expect(mockRecordRequest).toHaveBeenCalledWith(PATH);
    expect(mockRecordThrottle).not.toHaveBeenCalled();
  });

  it("allows a request that has no identity headers", async () => {
    const res = await checkStreamPreviewRateLimit(makeRequest());

    expect(res).toBeNull();
    expect(mockRecordRequest).toHaveBeenCalledWith(PATH);
  });

  it("returns a 429 with Retry-After and the error code once the write limit is exhausted", async () => {
    await exhaust(KEY_A);
    mockRecordRequest.mockClear();

    const res = await checkStreamPreviewRateLimit(makeRequest(KEY_A));

    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);

    const expectedRetryAfter = Math.max(
      1,
      Math.ceil((1 - 0) / (limit / windowMs) / 1000),
    );
    const retryAfter = res!.headers.get("Retry-After");
    expect(retryAfter).toBe(String(expectedRetryAfter));
    expect(Number.isInteger(Number(retryAfter))).toBe(true);
    expect(Number(retryAfter)).toBeGreaterThan(0);

    const body = await res!.json();
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(body.error.message).toBeTruthy();
    expect(body.error.request_id).toBeTruthy();
    expect(res!.headers.get(REQUEST_ID_HEADER)).toBe(body.error.request_id);

    expect(mockRecordRequest).not.toHaveBeenCalled();
  });

  it("records the throttle with the path, limit type and identity", async () => {
    await exhaust(KEY_A);

    await checkStreamPreviewRateLimit(makeRequest(KEY_A));

    expect(mockRecordThrottle).toHaveBeenCalledTimes(1);
    expect(mockRecordThrottle).toHaveBeenCalledWith(
      PATH,
      "write",
      "api_key",
      sha256(KEY_A).slice(0, 4),
    );
  });

  it("does not affect a different identity", async () => {
    await exhaust(KEY_A);
    const denied = await checkStreamPreviewRateLimit(makeRequest(KEY_A));
    expect(denied!.status).toBe(429);

    const other = await checkStreamPreviewRateLimit(makeRequest(KEY_B));
    expect(other).toBeNull();
  });

  it("allows the original identity again after the window passes", async () => {
    await exhaust(KEY_A);
    const denied = await checkStreamPreviewRateLimit(makeRequest(KEY_A));
    expect(denied!.status).toBe(429);

    jest.advanceTimersByTime(windowMs + 1000);

    const res = await checkStreamPreviewRateLimit(makeRequest(KEY_A));
    expect(res).toBeNull();
  });
});
