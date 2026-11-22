import {
  _resetOrgDbForTesting,
  getActiveApprovalsForStream,
  getStreamOrg,
  orgDb,
} from "./org-db";
import { DEFAULT_STREAM_POLICY, PendingApproval } from "./org-types";

const OWNER_ADDR = "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";
const PAUSER_ADDR = "GPAUSER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7G";
const SETTLER_ADDR = "GSETTLER5IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS";
const VIEWER_ADDR = "GVIEWER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS";
const BETA_OWNER_ADDR = "GBETA7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRWA";

const USDC_KEY =
  "USDC:GBUQWP3BOUZX34AAQJR2U7Q5WAQLEGBXVFNNMLOTEWDTHJCIV6XTRAHW";

beforeEach(() => {
  _resetOrgDbForTesting();
});

// ─── Seed data ────────────────────────────────────────────────────────────────

describe("orgDb seed data", () => {
  it("seeds org-acme and org-beta only", () => {
    expect([...orgDb.orgs.keys()].sort()).toEqual(["org-acme", "org-beta"]);
    expect(orgDb.orgs.get("org-acme")?.name).toBe("Acme DAO");
    expect(orgDb.orgs.get("org-beta")?.name).toBe("Beta Corp");
  });

  it("seeds the org-acme member roles and wallets", () => {
    const acme = orgDb.orgs.get("org-acme")!;

    expect(
      acme.members.map((member) => ({
        walletAddress: member.walletAddress,
        role: member.role,
      })),
    ).toEqual([
      { walletAddress: OWNER_ADDR, role: "owner" },
      { walletAddress: PAUSER_ADDR, role: "pauser" },
      { walletAddress: SETTLER_ADDR, role: "settler" },
      { walletAddress: VIEWER_ADDR, role: "viewer" },
    ]);
  });

  it("seeds a single owner for org-beta", () => {
    const beta = orgDb.orgs.get("org-beta")!;

    expect(beta.members).toHaveLength(1);
    expect(beta.members[0].walletAddress).toBe(BETA_OWNER_ADDR);
    expect(beta.members[0].role).toBe("owner");
  });

  it("pins the approval thresholds", () => {
    expect(orgDb.orgs.get("org-acme")!.policy.requireApprovals).toBe(2);
    expect(orgDb.orgs.get("org-beta")!.policy.requireApprovals).toBe(1);
  });

  it("gives org-acme a normalised XLM + USDC allowlist", () => {
    expect(orgDb.orgs.get("org-acme")!.tokenAllowlist).toEqual(["XLM", USDC_KEY]);
  });

  it("leaves org-beta without a token allowlist", () => {
    expect(orgDb.orgs.get("org-beta")!.tokenAllowlist).toBeUndefined();
  });

  it("starts with stream-ada owned by org-acme and no approvals", () => {
    expect(orgDb.streamOwnership.get("stream-ada")).toBe("org-acme");
    expect(orgDb.streamOwnership.size).toBe(1);
    expect(orgDb.approvals.size).toBe(0);
  });
});

// ─── getStreamOrg ─────────────────────────────────────────────────────────────

describe("getStreamOrg", () => {
  it("returns the owning org for stream-ada", () => {
    const org = getStreamOrg("stream-ada");

    expect(org?.id).toBe("org-acme");
    expect(org?.name).toBe("Acme DAO");
  });

  it("returns undefined for an individually owned stream", () => {
    expect(getStreamOrg("stream-kemi")).toBeUndefined();
  });

  it("returns undefined when ownership points at an unknown org", () => {
    orgDb.streamOwnership.set("stream-orphan", "org-missing");

    expect(getStreamOrg("stream-orphan")).toBeUndefined();
  });

  it("returns undefined once the ownership mapping is removed", () => {
    orgDb.streamOwnership.delete("stream-ada");

    expect(getStreamOrg("stream-ada")).toBeUndefined();
  });
});

// ─── getActiveApprovalsForStream ──────────────────────────────────────────────

describe("getActiveApprovalsForStream", () => {
  const NOW = new Date("2026-05-01T12:00:00.000Z");

  function buildApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
    return {
      id: "approval-1",
      streamId: "stream-ada",
      orgId: "org-acme",
      action: "settle",
      initiatedBy: OWNER_ADDR,
      approvals: [OWNER_ADDR],
      requiredCount: 2,
      status: "pending",
      createdAt: "2026-05-01T00:00:00.000Z",
      expiresAt: "2026-05-02T00:00:00.000Z",
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns a pending approval that has not expired", () => {
    const approval = buildApproval();
    orgDb.approvals.set(approval.id, approval);

    const active = getActiveApprovalsForStream("stream-ada");

    expect(active).toEqual([approval]);
    expect(orgDb.approvals.get(approval.id)!.status).toBe("pending");
  });

  it("returns every active approval for the stream", () => {
    const first = buildApproval({ id: "approval-1" });
    const second = buildApproval({ id: "approval-2", action: "stop" });
    orgDb.approvals.set(first.id, first);
    orgDb.approvals.set(second.id, second);

    const active = getActiveApprovalsForStream("stream-ada");

    expect(active.map((approval) => approval.id)).toEqual([
      "approval-1",
      "approval-2",
    ]);
  });

  it("excludes approved and rejected approvals", () => {
    const approved = buildApproval({ id: "approved", status: "approved" });
    const rejected = buildApproval({ id: "rejected", status: "rejected" });
    orgDb.approvals.set(approved.id, approved);
    orgDb.approvals.set(rejected.id, rejected);

    expect(getActiveApprovalsForStream("stream-ada")).toEqual([]);
    // Terminal statuses are left untouched.
    expect(orgDb.approvals.get("approved")!.status).toBe("approved");
    expect(orgDb.approvals.get("rejected")!.status).toBe("rejected");
  });

  it("lazily marks a past-expiry approval as expired and excludes it", () => {
    const expired = buildApproval({
      id: "expired",
      expiresAt: "2026-04-30T00:00:00.000Z",
    });
    orgDb.approvals.set(expired.id, expired);

    const active = getActiveApprovalsForStream("stream-ada");

    expect(active).toEqual([]);
    expect(orgDb.approvals.get("expired")!.status).toBe("expired");
  });

  it("treats an approval expiring exactly now as expired", () => {
    const boundary = buildApproval({
      id: "boundary",
      expiresAt: NOW.toISOString(),
    });
    orgDb.approvals.set(boundary.id, boundary);

    expect(getActiveApprovalsForStream("stream-ada")).toEqual([]);
    expect(orgDb.approvals.get("boundary")!.status).toBe("expired");
  });

  it("ignores approvals belonging to another stream", () => {
    const other = buildApproval({
      id: "other-stream",
      streamId: "stream-beta",
      // Expired, but expiry is scoped to the requested stream.
      expiresAt: "2026-04-30T00:00:00.000Z",
    });
    orgDb.approvals.set(other.id, other);

    expect(getActiveApprovalsForStream("stream-ada")).toEqual([]);
    expect(orgDb.approvals.get("other-stream")!.status).toBe("pending");
  });
});

// ─── _resetOrgDbForTesting ────────────────────────────────────────────────────

describe("_resetOrgDbForTesting", () => {
  it("removes added orgs, approvals and ownerships", () => {
    orgDb.orgs.set("org-gamma", {
      id: "org-gamma",
      name: "Gamma",
      members: [],
      policy: { ...DEFAULT_STREAM_POLICY },
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    orgDb.streamOwnership.set("stream-gamma", "org-gamma");
    orgDb.approvals.set("approval-gamma", {
      id: "approval-gamma",
      streamId: "stream-gamma",
      orgId: "org-gamma",
      action: "stop",
      initiatedBy: OWNER_ADDR,
      approvals: [],
      requiredCount: 1,
      status: "pending",
      createdAt: "2026-05-01T00:00:00.000Z",
      expiresAt: "2026-05-02T00:00:00.000Z",
    });

    _resetOrgDbForTesting();

    expect([...orgDb.orgs.keys()].sort()).toEqual(["org-acme", "org-beta"]);
    expect(orgDb.streamOwnership.get("stream-gamma")).toBeUndefined();
    expect([...orgDb.streamOwnership.keys()]).toEqual(["stream-ada"]);
    expect(orgDb.approvals.size).toBe(0);
  });

  it("restores mutated seed values", () => {
    orgDb.orgs.get("org-acme")!.policy.requireApprovals = 1;
    orgDb.orgs.get("org-beta")!.name = "Mutated";

    _resetOrgDbForTesting();

    expect(orgDb.orgs.get("org-acme")!.policy.requireApprovals).toBe(2);
    expect(orgDb.orgs.get("org-beta")!.name).toBe("Beta Corp");
  });

  it("restores the seed allowlist without sharing the array reference", () => {
    const seeded = orgDb.orgs.get("org-acme")!.tokenAllowlist!;
    seeded.push("HACKED");

    _resetOrgDbForTesting();

    const restored = orgDb.orgs.get("org-acme")!.tokenAllowlist!;
    expect(restored).toEqual(["XLM", USDC_KEY]);
    expect(restored).not.toBe(seeded);

    // Mutating the restored copy must not leak into the next reset.
    restored.pop();
    _resetOrgDbForTesting();
    expect(orgDb.orgs.get("org-acme")!.tokenAllowlist).toEqual(["XLM", USDC_KEY]);
  });
});
