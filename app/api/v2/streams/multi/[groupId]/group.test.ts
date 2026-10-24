/** @jest-environment node */
import { GET } from "./route";
import { POST as startGroup } from "./start/route";
import { POST as pauseGroup } from "./pause/route";
import { POST as stopGroup } from "./stop/route";
import { POST as stopStream } from "@/app/api/streams/[id]/stop/route";
import { getStore, resetDb } from "@/app/lib/db";
import type { MultiGroupLeg } from "./group";

jest.mock("@/app/lib/logger", () => ({
  getCorrelationContext: () => undefined,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("@/app/lib/org-policy", () => ({ checkStreamOrgPolicy: jest.fn() }));
jest.mock("@/app/lib/audit-log", () => ({ recordPrivilegedStreamAuditEvent: jest.fn() }));

const GROUP_ID = "stream-multi-test-group";
const IDS = ["leg-a", "leg-b", "leg-c"];
const AUTH = "Bearer test-token";

function seedGroup(statuses: MultiGroupLeg["status"][] = ["draft", "draft", "draft"]) {
  const { streamRepository } = getStore();
  IDS.forEach((id, index) => {
    const status = statuses[index];
    const leg: MultiGroupLeg = {
      id,
      recipient: `recipient-${index + 1}@example.com`,
      rate: "1 XLM / month",
      schedule: "2026-01-01 -> 2026-02-01",
      status,
      nextAction: status === "draft" ? "start" : status === "active" ? "pause" : status === "paused" ? "stop" : "withdraw",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      token: "XLM",
      totalAmount: "10.0000000",
      multiGroupId: GROUP_ID,
      multiName: "Test fan-out",
      multiRank: index + 1,
      multiLegCount: IDS.length,
      multiPercentage: "33.3333",
      multiStartAt: "2026-01-01T00:00:00.000Z",
      multiEndAt: "2026-02-01T00:00:00.000Z",
    };
    streamRepository.streams.set(id, leg);
  });
}

function request(path: string, idempotencyKey?: string) {
  const headers: Record<string, string> = { authorization: AUTH };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return new Request(`http://localhost${path}`, { method: "POST", headers });
}

function context(groupId = GROUP_ID) {
  return { params: Promise.resolve({ groupId }) };
}

beforeEach(() => resetDb());

describe("multi-recipient group resource", () => {
  it("reads a sorted manifest with current leg and aggregate statuses", async () => {
    seedGroup(["draft", "active", "paused"]);
    const response = await GET(
      new Request("http://localhost/api/v2/streams/multi/stream-multi-test-group", {
        headers: { authorization: AUTH },
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: GROUP_ID,
      status: "mixed",
      recipient_count: 3,
      links: { self: `/api/v2/streams/multi/${GROUP_ID}` },
      recipients: [
        { rank: 1, stream_id: "leg-a", status: "draft" },
        { rank: 2, stream_id: "leg-b", status: "active" },
        { rank: 3, stream_id: "leg-c", status: "paused" },
      ],
    });
  });

  it("returns 401 without bearer authorization and 404 for an unknown group", async () => {
    const unauthorized = await GET(
      new Request("http://localhost/api/v2/streams/multi/unknown"),
      context("unknown"),
    );
    expect(unauthorized.status).toBe(401);

    const missing = await GET(
      new Request("http://localhost/api/v2/streams/multi/unknown", {
        headers: { authorization: AUTH },
      }),
      context("unknown"),
    );
    expect(missing.status).toBe(404);
  });

  it("starts all draft legs and returns the common status", async () => {
    seedGroup();
    const response = await startGroup(request(`/api/v2/streams/multi/${GROUP_ID}/start`), context());

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("active");
    expect(IDS.map((id) => getStore().streamRepository.streams.get(id)?.status)).toEqual([
      "active", "active", "active",
    ]);
  });

  it("rejects a group pause atomically and identifies each illegal leg", async () => {
    seedGroup(["active", "active", "ended"]);
    const response = await pauseGroup(request(`/api/v2/streams/multi/${GROUP_ID}/pause`), context());
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.details).toEqual([
      expect.objectContaining({ id: "leg-c", status: "ended", code: "ILLEGAL_TRANSITION" }),
    ]);
    expect(IDS.map((id) => getStore().streamRepository.streams.get(id)?.status)).toEqual([
      "active", "active", "ended",
    ]);
    expect(getStore().streamHistory.query({ streamId: "leg-a", limit: 10 }).data).toHaveLength(0);
  });

  it("replays group pause idempotently without adding history", async () => {
    seedGroup(["active", "active", "active"]);
    const first = await pauseGroup(
      request(`/api/v2/streams/multi/${GROUP_ID}/pause`, "pause-key"),
      context(),
    );
    const firstBody = await first.json();
    const historyCount = IDS.reduce(
      (sum, id) => sum + getStore().streamHistory.query({ streamId: id, limit: 10 }).data.length,
      0,
    );
    const replay = await pauseGroup(
      request(`/api/v2/streams/multi/${GROUP_ID}/pause`, "pause-key"),
      context(),
    );

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(IDS.reduce(
      (sum, id) => sum + getStore().streamHistory.query({ streamId: id, limit: 10 }).data.length,
      0,
    )).toBe(historyCount);
    expect(firstBody.status).toBe("paused");
  });

  it("stops all eligible legs and rejects action requests without bearer auth", async () => {
    seedGroup(["active", "active", "active"]);
    const unauthorized = await stopGroup(
      new Request(`http://localhost/api/v2/streams/multi/${GROUP_ID}/stop`, { method: "POST" }),
      context(),
    );
    expect(unauthorized.status).toBe(401);

    const response = await stopGroup(request(`/api/v2/streams/multi/${GROUP_ID}/stop`), context());
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("ended");
    expect(IDS.map((id) => getStore().streamRepository.streams.get(id)?.nextAction)).toEqual([
      "withdraw", "withdraw", "withdraw",
    ]);
  });

  it("serializes a single-leg stop with a concurrent group pause", async () => {
    seedGroup(["active", "active", "active"]);
    const singleStop = stopStream(
      request("/api/streams/leg-a/stop"),
      { params: Promise.resolve({ id: "leg-a" }) },
    );
    const groupPause = pauseGroup(
      request(`/api/v2/streams/multi/${GROUP_ID}/pause`),
      context(),
    );
    const [singleResponse, groupResponse] = await Promise.all([singleStop, groupPause]);

    expect(singleResponse.status).toBe(200);
    expect(groupResponse.status).toBe(422);
    expect(getStore().streamRepository.streams.get("leg-a")?.status).toBe("ended");
    expect(["active", "ended"]).toContain(getStore().streamRepository.streams.get("leg-b")?.status);
    expect(["active", "ended"]).toContain(getStore().streamRepository.streams.get("leg-c")?.status);
  });

  it("returns 404 for actions on an unknown group", async () => {
    const response = await startGroup(request("/api/v2/streams/multi/unknown/start"), context("unknown"));
    expect(response.status).toBe(404);
  });
});