import { db, resetDb } from "@/app/lib/db";
import { _resetOrgDbForTesting, orgDb } from "@/app/lib/org-db";
import { authorizeStreamSubscriber } from "@/app/lib/stream-subscriber-auth";
import type { Stream } from "@/app/types/openapi";

const stream: Stream = {
  id: "subscriber-auth-test-stream",
  tenant: "tenant-1",
  recipient: "RECIPIENT_WALLET",
  senderAddress: "SENDER_WALLET",
  email: "recipient@example.test",
  rate: "1 XLM / month",
  schedule: "Monthly",
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  token: "XLM",
};

function actor(walletAddress: string, role: "user" | "admin" = "user") {
  return { walletAddress, role };
}

describe("authorizeStreamSubscriber", () => {
  beforeEach(() => {
    resetDb();
    _resetOrgDbForTesting();
    orgDb.streamOwnership.set(stream.id, "org-acme");
  });

  it.each([
    ["recipient", actor(stream.recipient), stream, "tenant-1", { ok: true }],
    ["sender", actor(stream.senderAddress!), stream, "tenant-1", { ok: true }],
    [
      "org member",
      actor("GVIEWER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS"),
      stream,
      "tenant-1",
      { ok: true },
    ],
    ["admin", actor("ADMIN_WALLET", "admin"), stream, "tenant-1", { ok: true }],
    ["wrong tenant", actor(stream.recipient), stream, "tenant-2", { ok: false, status: 404 }],
    ["unrelated wallet", actor("UNRELATED_WALLET"), stream, "tenant-1", { ok: false, status: 403 }],
  ])("authorizes %s", (_name, subscriber, candidateStream, tenant, expected) => {
    expect(authorizeStreamSubscriber(subscriber, candidateStream, tenant)).toEqual(expected);
  });

  it("requires non-empty emails on both sides and compares case-insensitively", () => {
    db.users.set("EMAIL_MATCH", {
      wallet_address: "EMAIL_MATCH",
      email: "  RECIPIENT@example.test ",
      display_name: "Email match",
      avatar_url: null,
      created_at: "2026-01-01T00:00:00Z",
      last_seen: null,
    });

    expect(authorizeStreamSubscriber(actor("EMAIL_MATCH"), stream, "tenant-1")).toEqual({ ok: true });

    const noStreamEmail = { ...stream, email: undefined };
    expect(authorizeStreamSubscriber(actor("EMAIL_MATCH"), noStreamEmail, "tenant-1")).toEqual({ ok: false, status: 403 });

    db.users.set("NO_EMAIL", {
      wallet_address: "NO_EMAIL",
      email: null,
      display_name: "No email",
      avatar_url: null,
      created_at: "2026-01-01T00:00:00Z",
      last_seen: null,
    });
    expect(authorizeStreamSubscriber(actor("NO_EMAIL"), noStreamEmail, "tenant-1")).toEqual({ ok: false, status: 403 });

    const emptyEmail = { ...stream, email: "  " };
    expect(authorizeStreamSubscriber(actor("NO_EMAIL"), emptyEmail, "tenant-1")).toEqual({ ok: false, status: 403 });
  });

  it("uses the default tenant for streams without a tenant stamp", () => {
    const unstampedStream = { ...stream, tenant: undefined };

    expect(authorizeStreamSubscriber(actor("UNRELATED_WALLET"), unstampedStream, "default")).toEqual({
      ok: false,
      status: 403,
    });
    expect(authorizeStreamSubscriber(actor("UNRELATED_WALLET"), unstampedStream, "tenant-1")).toEqual({
      ok: false,
      status: 404,
    });
  });

  it("allows no organization ownership mapping for individually owned streams", () => {
    orgDb.streamOwnership.delete(stream.id);

    expect(authorizeStreamSubscriber(actor("UNRELATED_WALLET"), stream, "tenant-1")).toEqual({
      ok: false,
      status: 403,
    });
  });
});
