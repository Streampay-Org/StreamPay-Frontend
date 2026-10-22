import { toV2Stream, dbStreamToV1, ProjectionError, type StreamV1, type StreamV2 } from "./api-version";

const baseV1: StreamV1 = {
  id: "stream_001",
  recipient: "GABC123",
  rate: "120 XLM/month",
  status: "active",
  actions: ["pause", "stop"],
  createdAt: "2024-01-15T10:00:00.000Z",
};

describe("toV2Stream()", () => {
  it("maps v1 fields to v2 shape correctly", () => {
    const v2 = toV2Stream(baseV1);

    expect(v2.id).toBe(baseV1.id);
    expect(v2.recipient).toBe(baseV1.recipient);
    expect(v2.rate).toBe(baseV1.rate);
    expect(v2.status).toBe(baseV1.status);
  });

  it("renames 'actions' → 'allowed_actions'", () => {
    const v2 = toV2Stream(baseV1);
    expect(v2.allowed_actions).toEqual(["pause", "stop", "settle"]);
  });

  it("renames 'createdAt' → 'created_at'", () => {
    const v2 = toV2Stream(baseV1);
    expect(v2.created_at).toBe("2024-01-15T10:00:00.000Z");
  });

  it("sets settlement to null by default", () => {
    const v2 = toV2Stream(baseV1);
    expect(v2.settlement).toBeNull();
  });

  it("preserves all four status values", () => {
    const statuses: StreamV1["status"][] = ["draft", "active", "paused", "ended"];
    for (const status of statuses) {
      const v2 = toV2Stream({ ...baseV1, status });
      expect(v2.status).toBe(status);
    }
  });

  it("ignores v1 actions and derives allowed_actions from the state machine", () => {
    const v2 = toV2Stream({ ...baseV1, status: "cancelled", actions: ["start"] });
    expect(v2.allowed_actions).toEqual([]);
  });

  it("returns a plain object matching the StreamV2 interface", () => {
    const v2: StreamV2 = toV2Stream(baseV1);
    const keys = Object.keys(v2);
    expect(keys).toContain("allowed_actions");
    expect(keys).toContain("created_at");
    expect(keys).toContain("id");
    expect(keys).toContain("recipient");
    expect(keys).toContain("status");
  });
});


describe("toV2Stream() full status projection", () => {
  it("passes withdrawn through with no allowed actions", () => {
    const v2 = toV2Stream({ ...baseV1, status: "withdrawn" });
    expect(v2.status).toBe("withdrawn");
    expect(v2.allowed_actions).toEqual([]);
  });

  it("passes cancelled through (never coerced to draft)", () => {
    const v2 = toV2Stream({ ...baseV1, status: "cancelled", nextAction: "start" });
    expect(v2.status).toBe("cancelled");
    expect(v2.allowed_actions).toEqual([]);
    expect(v2.next_action).toBe("start");
  });

  it("paused allows start, stop and settle", () => {
    const v2 = toV2Stream({ ...baseV1, status: "paused" });
    expect(v2.allowed_actions).toEqual(expect.arrayContaining(["start", "stop", "settle"]));
  });

  it("ended allows withdraw", () => {
    expect(toV2Stream({ ...baseV1, status: "ended" }).allowed_actions).toEqual(["withdraw"]);
  });

  it("projects settlement when settlementTxHash is present", () => {
    const v2 = toV2Stream({
      ...baseV1,
      status: "ended",
      settlementTxHash: "abc",
      releasedAmount: "500",
      totalAmount: "1000",
      token: "USDC:GISSUER",
      updatedAt: "2024-02-01T00:00:00.000Z",
    });
    expect(v2.settlement).toEqual({
      tx_hash: "abc",
      settled_at: "2024-02-01T00:00:00.000Z",
      amount: "500",
      currency: "USDC:GISSUER",
    });
  });

  it("falls back to totalAmount, createdAt and XLM for settlement", () => {
    const v2 = toV2Stream({ ...baseV1, status: "ended", settlementTxHash: "abc", totalAmount: "1000" });
    expect(v2.settlement).toEqual({
      tx_hash: "abc",
      settled_at: baseV1.createdAt,
      amount: "1000",
      currency: "XLM",
    });
  });

  it("uses a zero amount when no amount is known", () => {
    const v2 = toV2Stream({ ...baseV1, status: "ended", settlementTxHash: "abc" });
    expect(v2.settlement?.amount).toBe("0");
  });

  it("leaves settlement null for draft", () => {
    expect(toV2Stream({ ...baseV1, status: "draft" }).settlement).toBeNull();
  });

  it("defaults next_action to null", () => {
    expect(toV2Stream(baseV1).next_action).toBeNull();
  });

  it("throws ProjectionError for an unknown status", () => {
    expect(() => toV2Stream({ ...baseV1, status: "weird" })).toThrow(ProjectionError);
    try {
      toV2Stream({ ...baseV1, status: "weird" });
    } catch (err) {
      expect((err as ProjectionError).code).toBe("PROJECTION_ERROR");
    }
  });
});

describe("dbStreamToV1()", () => {
  it("maps nextAction to actions, or [] when absent", () => {
    const base = {
      id: "s",
      recipient: "G",
      rate: "1",
      schedule: "month",
      status: "draft",
      createdAt: "c",
      updatedAt: "u",
      token: "XLM",
    } as any;
    expect(dbStreamToV1({ ...base, nextAction: "start" }).actions).toEqual(["start"]);
    expect(dbStreamToV1(base).actions).toEqual([]);
  });
});
