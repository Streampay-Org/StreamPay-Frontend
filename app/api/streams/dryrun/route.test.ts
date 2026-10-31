/** @jest-environment node */

import { POST } from "./route";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { resetDb } from "@/app/lib/db";

const RECIPIENT = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

function makeRequest(body: unknown, ip = "192.0.2.190"): Request {
  return new Request("http://localhost/api/streams/dryrun", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetDb();
  resetRateLimitStore();
});

describe("POST /api/streams/dryrun", () => {
  it("maps legacy intervalSeconds 86400 to the day schedule", async () => {
    const response = await POST(
      makeRequest({
        recipient: RECIPIENT,
        sender: RECIPIENT,
        asset: "XLM",
        amountPerInterval: 2.5,
        intervalSeconds: 86_400,
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.valid).toBe(true);
    expect(body.data.preview_stream.schedule.interval).toBe("day");
    expect(body.data.preview_stream.amount).toBe("2.5");
  });

  it("rejects intervals that do not exactly match a supported schedule", async () => {
    const response = await POST(
      makeRequest({
        recipient: RECIPIENT,
        asset: "XLM",
        amountPerInterval: 1,
        intervalSeconds: 90,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("UNSUPPORTED_INTERVAL");
  });

  it("includes deprecation and sunset headers", async () => {
    const response = await POST(
      makeRequest({
        recipient: RECIPIENT,
        asset: "XLM",
        amountPerInterval: 1,
        intervalSeconds: 86_400,
      }),
    );

    expect(response.headers.get("Deprecation")).toBe("@1792368000");
    expect(response.headers.get("Sunset")).toBeTruthy();
  });

  it("keeps deprecation headers on malformed legacy JSON", async () => {
    const response = await POST(
      new Request("http://localhost/api/streams/dryrun", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "192.0.2.192" },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Deprecation")).toBe("@1792368000");
    expect(response.headers.get("Sunset")).toBeTruthy();
  });

  it("uses the preview write rate-limit tier", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 12; i++) {
      last = await POST(
        makeRequest(
          {
            recipient: RECIPIENT,
            asset: "XLM",
            amountPerInterval: 1,
            intervalSeconds: 86_400,
          },
          "192.0.2.191",
        ),
      );
      if (last.status === 429) break;
    }

    expect(last?.status).toBe(429);
  });
});
