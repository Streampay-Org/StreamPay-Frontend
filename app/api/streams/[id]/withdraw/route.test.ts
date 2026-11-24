/** @jest-environment node */
import { db } from "@/app/lib/db";
import { signToken } from "@/app/lib/auth";
import { _resetOrgDbForTesting, orgDb } from "@/app/lib/org-db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import type { Stream } from "@/app/types/openapi";
import { POST as withdraw } from "./route";

const RECIPIENT = "GRECIPIENT7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";
const SENDER = "GSENDER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";
const SETTLER = "GSETTLER5IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS";
const PAUSER = "GPAUSER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7G";

let keyCounter = 0;

function createStream(overrides: Partial<Stream> = {}): Stream {
  const now = Date.now();
  return {
    id: "stream-test",
    recipient: RECIPIENT,
    rate: "1 XLM / month",
    schedule: "month",
    status: "ended",
    nextAction: "withdraw",
    token: "XLM",
    totalAmount: "1000",
    vestedAmount: "1000",
    releasedAmount: "0",
    createdAt: new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(now).toISOString(),
    ...overrides,
  };
}

type RequestOptions = {
  caller?: string | null;
  callerHeader?: string | null;
  useJwt?: boolean;
  amount?: string;
  rawBody?: string;
  key?: string;
  id?: string;
};

function makeRequest(options: RequestOptions = {}): Request {
  const id = options.id ?? "stream-test";
  const headers = new Headers();
  headers.set("Idempotency-Key", options.key ?? `withdraw-test-${++keyCounter}`);

  const caller = options.caller === undefined ? RECIPIENT : options.caller;
  if (caller) {
    if (options.useJwt) {
      headers.set("Authorization", `Bearer ${signToken(caller)}`);
    } else {
      headers.set("Actor-Wallet-Address", caller);
    }
  }

  if (options.callerHeader) {
    headers.set("Actor-Wallet-Address", options.callerHeader);
  }

  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers.set("Content-Type", "application/json");
  } else if (options.amount !== undefined) {
    body = JSON.stringify({ amount: options.amount });
    headers.set("Content-Type", "application/json");
  }

  return new Request(`http://localhost/api/streams/${id}/withdraw`, {
    method: "POST",
    headers,
    body,
  });
}

async function callWithdraw(options: RequestOptions = {}) {
  resetRateLimitStore();
  const id = options.id ?? "stream-test";
  return withdraw(makeRequest(options), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  keyCounter = 0;
  db.streams.clear();
  db.idempotency.clear();
  _resetOrgDbForTesting();
  resetRateLimitStore();
});

afterAll(() => {
  db.streams.clear();
  db.idempotency.clear();
  _resetOrgDbForTesting();
});

describe("POST /api/streams/[id]/withdraw authorization and amounts", () => {
  it("returns 401 UNAUTHORIZED with no caller and does not evaluate finality", async () => {
    db.streams.set(
      "stream-test",
      createStream({ settlementTxHash: "tx-should-not-be-read" }),
    );
    const originalFetch = global.fetch;
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const response = await callWithdraw({ caller: null });
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("returns 403 RECIPIENT_AUTH_REQUIRED when the caller is the sender", async () => {
    db.streams.set("stream-test", createStream());

    const response = await callWithdraw({ caller: SENDER, useJwt: true });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("RECIPIENT_AUTH_REQUIRED");
  });

  it("prefers the JWT over a spoofed Actor-Wallet-Address header", async () => {
    db.streams.set("stream-test", createStream());

    const response = await callWithdraw({
      caller: SENDER,
      callerHeader: RECIPIENT,
      useJwt: true,
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("RECIPIENT_AUTH_REQUIRED");
  });

  it("lets the recipient withdraw the full withdrawable balance when amount is omitted", async () => {
    db.streams.set("stream-test", createStream());

    const response = await callWithdraw({ caller: RECIPIENT, useJwt: true });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.releasedAmount).toBe("1000");
    expect(db.streams.get("stream-test")?.releasedAmount).toBe("1000");
  });

  it("returns 422 OVER_WITHDRAW when amount exceeds the withdrawable balance", async () => {
    db.streams.set("stream-test", createStream());

    const response = await callWithdraw({ caller: RECIPIENT, amount: "1001" });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("OVER_WITHDRAW");
    expect(db.streams.get("stream-test")?.releasedAmount).toBe("0");
  });

  it("returns 422 ZERO_AMOUNT when amount is zero", async () => {
    db.streams.set("stream-test", createStream());

    const response = await callWithdraw({ caller: RECIPIENT, amount: "0" });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("ZERO_AMOUNT");
  });

  it("returns 422 VALIDATION_ERROR for malformed, negative, decimal and overflowing amounts", async () => {
    db.streams.set("stream-test", createStream());
    const malformedAmounts = [
      "18 XLM",
      "1.5",
      "-1",
      (1n << 127n).toString(),
    ];

    for (const amount of malformedAmounts) {
      const response = await callWithdraw({ caller: RECIPIENT, amount });
      const body = await response.json();

      expect(response.status).toBe(422);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    }

    const malformedJson = await callWithdraw({
      caller: RECIPIENT,
      rawBody: "{not-json",
    });
    const malformedJsonBody = await malformedJson.json();

    expect(malformedJson.status).toBe(422);
    expect(malformedJsonBody.error.code).toBe("VALIDATION_ERROR");
    expect(db.streams.get("stream-test")?.releasedAmount).toBe("0");
  });

  it("lets an org member with withdraw permission withdraw", async () => {
    db.streams.set("stream-test", createStream());
    orgDb.streamOwnership.set("stream-test", "org-acme");

    const response = await callWithdraw({ caller: SETTLER, amount: "250" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.releasedAmount).toBe("250");
  });

  it("returns the org policy 403 when a member lacks withdraw permission", async () => {
    db.streams.set("stream-test", createStream());
    orgDb.streamOwnership.set("stream-test", "org-acme");

    const response = await callWithdraw({ caller: PAUSER });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("ROLE_INSUFFICIENT");
  });

  it("returns 409 INVALID_STREAM_STATE for a cancelled stream before parsing amount", async () => {
    db.streams.set(
      "stream-test",
      createStream({ status: "cancelled", nextAction: undefined }),
    );

    const response = await callWithdraw({
      caller: RECIPIENT,
      amount: "18 XLM",
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("INVALID_STREAM_STATE");
  });

  it("replays for the same caller but rejects a different caller using the same key", async () => {
    db.streams.set("stream-test", createStream());

    const first = await callWithdraw({ caller: RECIPIENT, key: "replay-key" });
    expect(first.status).toBe(200);

    const replay = await callWithdraw({ caller: RECIPIENT, key: "replay-key" });
    const replayBody = await replay.json();

    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replay")).toBe("true");
    expect(replayBody.data.releasedAmount).toBe("1000");

    const otherCaller = await callWithdraw({ caller: SENDER, key: "replay-key" });
    const otherCallerBody = await otherCaller.json();

    expect(otherCaller.status).toBe(403);
    expect(otherCallerBody.error.code).toBe("RECIPIENT_AUTH_REQUIRED");
  });
});
