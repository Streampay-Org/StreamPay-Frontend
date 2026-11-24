/** @jest-environment node */

/**
 * End-to-end check for the regression in issue #1749: a stream created through
 * the real `POST /api/streams` handler must be loadable by the detail page's
 * loader (previously every such id rendered the Next.js 404 page).
 */
import { POST } from "@/app/api/streams/route";
import { resetDb } from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { _resetAllowlistForTesting, addAllowedToken } from "@/app/lib/token-allowlist";
import { DEFAULT_STREAM_TENANT_ID, loadStreamForViewer } from "@/app/lib/stream-view";

jest.mock("@/src/middleware/accessLog", () => ({
  logAccessEvent: jest.fn(),
}));

const VALID_RECIPIENT = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

beforeEach(() => {
  resetDb();
  resetRateLimitStore();
  _resetAllowlistForTesting();
  addAllowedToken("XLM");
});

afterEach(() => {
  resetRateLimitStore();
});

async function createStreamViaApi(): Promise<string> {
  const res = await POST(
    new Request("http://localhost/api/streams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: VALID_RECIPIENT, rate: "50", schedule: "month" }),
    }),
  );
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.data.id as string;
}

describe("detail loader with streams created through POST /api/streams", () => {
  it("loads the created stream for the default tenant", async () => {
    const id = await createStreamViaApi();

    const stream = loadStreamForViewer(id, { tenant: DEFAULT_STREAM_TENANT_ID });

    expect(stream).not.toBeNull();
    expect(stream?.id).toBe(id);
    expect(stream?.recipient).toBe(VALID_RECIPIENT);
  });

  it("loads it when the viewer carries no tenant at all", async () => {
    const id = await createStreamViaApi();

    expect(loadStreamForViewer(id)?.id).toBe(id);
  });

  it("does not expose it to a different tenant", async () => {
    const id = await createStreamViaApi();

    expect(loadStreamForViewer(id, { tenant: "some-other-tenant" })).toBeNull();
  });
});
