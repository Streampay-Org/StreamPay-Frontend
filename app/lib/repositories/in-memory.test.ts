import {
  createInMemoryPersistenceStore,
  createPostgresPersistenceStore,
  db,
  decodeCursor,
  createDefaultStore,
  encodeCursor,
  idempotencyToken,
  POSTGRES_ROLLOUT_NOTES,
  POSTGRES_SCHEMA_SKETCH,
  setStore,
  getStore,
  resetDb,
} from "@/app/lib/db";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

describe("repository adapters", () => {
  afterEach(() => {
    setStore(createInMemoryPersistenceStore());
  });

  it("seeds the default in-memory store and resets transient state", () => {
    const store = createInMemoryPersistenceStore();
    setStore(store);

    expect(store.streamRepository.users.size).toBe(1);
    expect(store.streamRepository.streams.size).toBe(3);
    expect(store.streamRepository.activity.size).toBe(6);

    store.streamRepository.streams.set("stream-extra", {
      id: "stream-extra",
      recipient: "Extra Recipient",
      rate: "5 XLM / month",
      schedule: "Monthly",
      status: "draft",
      nextAction: "start",
      createdAt: "2026-05-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
      token: "XLM",
    });
    store.idempotencyStore.set("streams.create:abc", { ok: true });
    store.exportRepository.jobs.set("job-1", {
      id: "job-1",
      ownerId: "owner-1",
      status: "pending",
      requestedAt: "2026-05-01T00:00:00Z",
      expiresAt: "2026-05-08T00:00:00Z",
      fileName: "job-1.csv",
      rows: 0,
    });
    store.exportRepository.audit.push({
      id: "audit-1",
      exportId: "job-1",
      type: "export.requested",
      timestamp: "2026-05-01T00:00:00Z",
    });

    resetDb();

    expect(getStore().streamRepository.streams.size).toBe(3);
    expect(getStore().streamRepository.streams.has("stream-extra")).toBe(false);
    expect(getStore().idempotencyStore.size).toBe(0);
    expect(getStore().exportRepository.jobs.size).toBe(0);
    expect(getStore().exportRepository.audit.length).toBe(0);
  });

  it("keeps the legacy db facade wired to the active repository store", () => {
    const store = createInMemoryPersistenceStore();
    setStore(store);

    // Verify operations on db facade route to the active store
    const testUser = { wallet_address: "TEST", email: "test@test.com", display_name: "Test", avatar_url: null, created_at: "" };
    db.users.set("TEST", testUser);
    expect(store.streamRepository.users.get("TEST")).toBe(testUser);

    const testStream = { id: "TEST_STR", recipient: "Test", rate: "1", schedule: "1", status: "active", nextAction: "pause", createdAt: "", updatedAt: "", token: "XLM" } as any;
    db.streams.set("TEST_STR", testStream);
    expect(store.streamRepository.streams.get("TEST_STR")).toBe(testStream);

    const testActivity = { id: "TEST_ACT", type: "wallet.connected", timestamp: "", description: "" };
    db.activity.set("TEST_ACT", testActivity);
    expect(store.streamRepository.activity.get("TEST_ACT")).toBe(testActivity);

    db.idempotency.set("TEST_IDEM", "val");
    expect(store.idempotencyStore.get("TEST_IDEM")).toBe("val");

    const testJob = { id: "TEST_JOB", ownerId: "owner", status: "pending", requestedAt: "", expiresAt: "", fileName: "", rows: 0 } as any;
    db.exportJobs.set("TEST_JOB", testJob);
    expect(store.exportRepository.jobs.get("TEST_JOB")).toBe(testJob);

    expect(db.exportAudit).toBe(store.exportRepository.audit);

    const testPromise = Promise.resolve();
    db.exportProcessing.set("TEST_PROC", testPromise);
    expect(store.exportRepository.processing.get("TEST_PROC")).toBe(testPromise);
  });

  it("inserts a key only when it does not already exist", () => {
    const store = createInMemoryPersistenceStore();
    setStore(store);

    const stream = { id: "stream-unique", status: "draft" } as any;
    expect(store.streamRepository.streams.insert("stream-unique", stream)).toBe(true);
    expect(store.streamRepository.streams.get("stream-unique")).toBe(stream);

    const duplicate = { id: "stream-unique", status: "active" } as any;
    expect(store.streamRepository.streams.insert("stream-unique", duplicate)).toBe(false);
    expect(store.streamRepository.streams.get("stream-unique")?.status).toBe("draft");
  });

  it("serializes concurrent work for the same lock key", async () => {
    const store = createInMemoryPersistenceStore();
    const gate = deferred();
    const order: string[] = [];

    const first = store.streamRepository.withLock("stream-ada", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
      return "first";
    });

    const second = store.streamRepository.withLock("stream-ada", async () => {
      order.push("second:start");
      return "second";
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    gate.resolve();

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("allows different lock keys to proceed independently", async () => {
    const store = createInMemoryPersistenceStore();
    const gate = deferred();
    const order: string[] = [];

    const first = store.streamRepository.withLock("stream-ada", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });

    const second = store.streamRepository.withLock("stream-kemi", async () => {
      order.push("second:start");
    });

    await second;
    expect(order).toContain("second:start");

    gate.resolve();
    await first;
  });

  it("preserves cursor encoding and decoding semantics", () => {
    const id = "stream-ada";
    const cursor = encodeCursor(id);

    expect(decodeCursor(cursor)).toBe(id);
    expect(() => decodeCursor("")).toThrow("Invalid cursor: must be non-empty string");
  });

  it("preserves idempotency token scoping", () => {
    expect(idempotencyToken("streams.create", "abc123")).toBe("streams.create:abc123");
  });

  it("tracks idempotency and export state through the repository seam", () => {
    const store = createInMemoryPersistenceStore();

    store.idempotencyStore.set("streams.pause:key-1", { data: "cached" });
    expect(store.idempotencyStore.has("streams.pause:key-1")).toBe(true);
    expect(store.idempotencyStore.get("streams.pause:key-1")).toEqual({ data: "cached" });

    store.exportRepository.jobs.set("job-1", {
      id: "job-1",
      ownerId: "owner-1",
      status: "ready",
      requestedAt: "2026-05-01T00:00:00Z",
      expiresAt: "2026-05-08T00:00:00Z",
      fileName: "job-1.csv",
      rows: 3,
    });
    store.exportRepository.audit.push({
      id: "audit-1",
      exportId: "job-1",
      type: "export.downloaded",
      timestamp: "2026-05-02T00:00:00Z",
    });
    store.exportRepository.processing.set("job-1", Promise.resolve());

    expect(store.exportRepository.jobs.get("job-1")?.status).toBe("ready");
    expect(store.exportRepository.audit.some((record) => record.type === "export.downloaded")).toBe(true);
    expect(store.exportRepository.processing.has("job-1")).toBe(true);
    expect(store.exportRepository.jobs.entries().next().value?.[0]).toBe("job-1");
    expect(store.exportRepository.jobs.delete("job-1")).toBe(true);
    expect(store.exportRepository.jobs.has("job-1")).toBe(false);
    expect(store.exportRepository.audit.toArray()).toHaveLength(1);
  });

  it("exposes a postgres adapter seam plus schema and rollout notes", () => {
    const store = createPostgresPersistenceStore({
      executor: {
        query: async () => ({ rows: [] }),
      },
    });

    expect(store.kind).toBe("postgres");
    expect(POSTGRES_SCHEMA_SKETCH).toContain("create table streams");
    expect(POSTGRES_SCHEMA_SKETCH).toContain("create table idempotency_keys");
    expect(POSTGRES_ROLLOUT_NOTES.length).toBeGreaterThanOrEqual(4);
    expect(() => store.streamRepository.streams.get("stream-ada")).toThrow(
      "PostgreSQL persistence seam is defined",
    );
    expect(() => store.exportRepository.audit.toArray()).toThrow(
      "PostgreSQL persistence seam is defined",
    );
    expect(() => store.idempotencyStore.reset()).toThrow(
      "PostgreSQL persistence seam is defined",
    );
  });

  it("resets a durable store back to the default in-memory adapter", () => {
    setStore(
      createPostgresPersistenceStore({
        executor: {
          query: async () => ({ rows: [] }),
        },
      }),
    );

    resetDb();

    expect(getStore().kind).toBe("memory");
    expect(getStore().streamRepository.streams.size).toBe(
      createDefaultStore().streamRepository.streams.size,
    );
  });

  describe("InMemoryStreamRepository secondary indexes and visibleTo", () => {
    const fc = require("fast-check") as typeof import("fast-check");
    const {
      IndexedStreamStore,
      resolveStreamTenant,
      visibleTo,
    } = require("@/app/lib/repositories/in-memory") as typeof import("@/app/lib/repositories/in-memory");
    const {
      redactStreamPii,
      resolveRequestActor,
      resolveRequestTenant,
    } = require("@/app/lib/stream-visibility") as typeof import("@/app/lib/stream-visibility");
    const { signToken } = require("@/app/lib/auth") as typeof import("@/app/lib/auth");
    const { getAdminAddress } = require("@/app/lib/admin-guard") as typeof import("@/app/lib/admin-guard");
    const { orgDb, _resetOrgDbForTesting } = require("@/app/lib/org-db") as typeof import("@/app/lib/org-db");

    afterEach(() => {
      _resetOrgDbForTesting();
    });

    it("indexes initial seeded streams by default tenant and participants", () => {
      const store = createInMemoryPersistenceStore();
      const repo = store.streamRepository;

      const defaultTenantStreams = repo.listByTenant!("default-tenant");
      expect(defaultTenantStreams.map((s) => s.id).sort()).toEqual([
        "stream-ada",
        "stream-kemi",
        "stream-yusuf",
      ]);

      // Blank or omitted tenant falls back to default-tenant
      expect(repo.listByTenant!("").map((s) => s.id)).toHaveLength(3);
      expect(repo.listByTenant!("unknown-tenant")).toEqual([]);

      const senderStreams = repo.listByParticipant!(
        "GSENDER00000000000000000000000000000000000000000000",
        "default-tenant",
      );
      expect(senderStreams).toHaveLength(3);

      const adaRecipientStreams = repo.listByParticipant!(
        "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZK7G",
      );
      expect(adaRecipientStreams.map((s) => s.id)).toEqual(["stream-ada"]);
    });

    it("maintains tenant and participant indexes when updating tenantId or participants and deleting", () => {
      const indexedStore = new IndexedStreamStore();

      indexedStore.set("s1", {
        id: "s1",
        tenantId: "tenant-a",
        senderAddress: "GWALLET_SENDER_1",
        recipient: "GWALLET_RECIP_1",
        rate: "10",
        schedule: "month",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        token: "XLM",
      });

      expect(indexedStore.listByTenant("tenant-a").map((s) => s.id)).toEqual(["s1"]);
      expect(indexedStore.listByParticipant("GWALLET_SENDER_1").map((s) => s.id)).toEqual(["s1"]);
      expect(indexedStore.listByParticipant("GWALLET_RECIP_1").map((s) => s.id)).toEqual(["s1"]);
      expect(indexedStore.has("s1")).toBe(true);
      expect(Array.from(indexedStore.entries()).map(([k]) => k)).toEqual(["s1"]);
      expect(Array.from(indexedStore.values()).map((v) => v.id)).toEqual(["s1"]);
      const visited: string[] = [];
      indexedStore.forEach((v, k) => visited.push(`${k}:${v.id}`));
      expect(visited).toEqual(["s1:s1"]);

      // Update tenantId and participants on the same stream id
      indexedStore.set("s1", {
        id: "s1",
        tenantId: "tenant-b",
        senderAddress: "GWALLET_SENDER_2",
        recipient: "GWALLET_RECIP_2",
        rate: "10",
        schedule: "month",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        token: "XLM",
      });

      expect(indexedStore.listByTenant("tenant-a")).toEqual([]);
      expect(indexedStore.byTenant.has("tenant-a")).toBe(false);
      expect(indexedStore.listByTenant("tenant-b").map((s) => s.id)).toEqual(["s1"]);

      expect(indexedStore.listByParticipant("GWALLET_SENDER_1")).toEqual([]);
      expect(indexedStore.byParticipant.has("GWALLET_SENDER_1")).toBe(false);
      expect(indexedStore.listByParticipant("GWALLET_RECIP_1")).toEqual([]);
      expect(indexedStore.byParticipant.has("GWALLET_RECIP_1")).toBe(false);

      expect(indexedStore.listByParticipant("GWALLET_SENDER_2", "tenant-b").map((s) => s.id)).toEqual(["s1"]);
      expect(indexedStore.listByParticipant("GWALLET_SENDER_2", "tenant-a")).toEqual([]);
      expect(indexedStore.listByParticipant("GWALLET_RECIP_2", "tenant-b").map((s) => s.id)).toEqual(["s1"]);
      expect(indexedStore.listByParticipant("   ")).toEqual([]);

      // Delete non-existent key returns false
      expect(indexedStore.delete("non-existent")).toBe(false);

      // Delete s1 removes all index entries
      expect(indexedStore.delete("s1")).toBe(true);
      expect(indexedStore.byTenant.size).toBe(0);
      expect(indexedStore.byParticipant.size).toBe(0);
    });

    it("matches brute-force filtering across random set, update, and delete operations (fast-check)", () => {
      const idArb = fc.constantFrom("s-1", "s-2", "s-3", "s-4", "s-5", "s-6");
      const tenantArb = fc.option(fc.constantFrom("tenant-a", "tenant-b", "tenant-c", "default-tenant"), {
        nil: undefined,
      });
      const walletArb = fc.constantFrom("GWALLET_A", "GWALLET_B", "GWALLET_C", "GWALLET_D");

      const opArb = fc.oneof(
        fc.record({
          type: fc.constant("set" as const),
          id: idArb,
          tenantId: tenantArb,
          senderAddress: fc.option(walletArb, { nil: undefined }),
          recipient: walletArb,
        }),
        fc.record({
          type: fc.constant("delete" as const),
          id: idArb,
        }),
      );

      fc.assert(
        fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
          const indexedStore = new IndexedStreamStore();
          const bruteForce = new Map<string, import("@/app/types/openapi").Stream>();

          for (const op of ops) {
            if (op.type === "set") {
              const stream: import("@/app/types/openapi").Stream = {
                id: op.id,
                tenantId: op.tenantId,
                senderAddress: op.senderAddress,
                recipient: op.recipient,
                rate: "10",
                schedule: "month",
                status: "active",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                token: "XLM",
              };
              indexedStore.set(op.id, stream);
              bruteForce.set(op.id, stream);
            } else {
              indexedStore.delete(op.id);
              bruteForce.delete(op.id);
            }
          }

          const allTenants = ["tenant-a", "tenant-b", "tenant-c", "default-tenant"];
          const allWallets = ["GWALLET_A", "GWALLET_B", "GWALLET_C", "GWALLET_D"];

          for (const tenant of allTenants) {
            const indexedIds = indexedStore
              .listByTenant(tenant)
              .map((s) => s.id)
              .sort();
            const expectedIds = Array.from(bruteForce.values())
              .filter((s) => resolveStreamTenant(s) === tenant)
              .map((s) => s.id)
              .sort();
            expect(indexedIds).toEqual(expectedIds);
          }

          for (const wallet of allWallets) {
            const indexedAllTenants = indexedStore
              .listByParticipant(wallet)
              .map((s) => s.id)
              .sort();
            const expectedAllTenants = Array.from(bruteForce.values())
              .filter((s) => s.senderAddress === wallet || s.recipient === wallet)
              .map((s) => s.id)
              .sort();
            expect(indexedAllTenants).toEqual(expectedAllTenants);

            for (const tenant of allTenants) {
              const indexedScoped = indexedStore
                .listByParticipant(wallet, tenant)
                .map((s) => s.id)
                .sort();
              const expectedScoped = Array.from(bruteForce.values())
                .filter(
                  (s) =>
                    resolveStreamTenant(s) === tenant &&
                    (s.senderAddress === wallet || s.recipient === wallet),
                )
                .map((s) => s.id)
                .sort();
              expect(indexedScoped).toEqual(expectedScoped);
            }
          }
        }),
        { numRuns: 100 },
      );
    });

    it("evaluates visibleTo across sender, recipient, org member, admin, and unauthenticated callers", () => {
      const stream: import("@/app/types/openapi").Stream = {
        id: "stream-owned",
        tenantId: "tenant-a",
        senderAddress: "GSENDER_A",
        recipient: "GRECIPIENT_A",
        orgId: "org-acme",
        rate: "100",
        schedule: "month",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        token: "XLM",
        email: "secret@example.com",
        label: "Confidential",
        memo: "Internal memo",
        partnerId: "PARTNER-9",
      };

      // Wrong tenant is always rejected, even for admins
      expect(visibleTo({ role: "admin" }, "tenant-b")(stream)).toBe(false);
      expect(visibleTo("GSENDER_A", "tenant-b")(stream)).toBe(false);

      // Unauthenticated / null actor -> tenant-only rule
      expect(visibleTo(null, "tenant-a")(stream)).toBe(true);
      expect(visibleTo("   ", "tenant-a")(stream)).toBe(true);
      expect(visibleTo({}, "tenant-a")(stream)).toBe(true);

      // Sender and recipient see the stream
      expect(visibleTo("GSENDER_A", "tenant-a")(stream)).toBe(true);
      expect(visibleTo({ walletAddress: "GRECIPIENT_A" }, "tenant-a")(stream)).toBe(true);

      // Org member of org-acme sees the stream
      expect(
        visibleTo("GVIEWER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS", "tenant-a")(stream),
      ).toBe(true);
      expect(visibleTo({ orgIds: ["org-acme"] }, "tenant-a")(stream)).toBe(true);

      // Member of a different org (org-beta) or unrelated wallet does not see the stream
      expect(
        visibleTo("GBETA7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRWA", "tenant-a")(stream),
      ).toBe(false);
      expect(visibleTo("GSTRANGER", "tenant-a")(stream)).toBe(false);

      // Admin sees all streams in the tenant
      expect(visibleTo({ role: "admin" }, "tenant-a")(stream)).toBe(true);
      expect(visibleTo({ isAdmin: true }, "tenant-a")(stream)).toBe(true);
      expect(visibleTo(getAdminAddress(), "tenant-a")(stream)).toBe(true);

      // Stream with non-existent orgId does not grant org access to strangers
      const streamUnknownOrg = { ...stream, id: "stream-no-org", orgId: "org-missing" };
      expect(visibleTo("GSTRANGER", "tenant-a")(streamUnknownOrg)).toBe(false);
      orgDb.streamOwnership.delete("stream-no-org");
      const streamNoOrg = { ...stream, id: "stream-no-org", orgId: undefined };
      expect(visibleTo("GSTRANGER", "tenant-a")(streamNoOrg)).toBe(false);

      // redactStreamPii strips email, label, memo, partnerId
      const redacted = redactStreamPii(stream);
      expect(redacted).not.toHaveProperty("email");
      expect(redacted).not.toHaveProperty("label");
      expect(redacted).not.toHaveProperty("memo");
      expect(redacted).not.toHaveProperty("partnerId");
      expect(redacted.id).toBe("stream-owned");
    });

    it("resolves tenant and actor from Request headers, cookies, and JWTs", () => {
      // Cookie tenant fallback
      const reqWithCookie = new Request("http://localhost/api/streams", {
        headers: { cookie: "foo=bar; sp_tenant_id=tenant-cookie" },
      });
      expect(resolveRequestTenant(reqWithCookie)).toBe("tenant-cookie");

      // Signed JWT actor resolution
      const token = signToken("GWALLET_JWT", { role: "admin" });
      const reqWithJwt = new Request("http://localhost/api/v2/streams", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(resolveRequestActor(reqWithJwt)).toEqual({
        actorId: "GWALLET_JWT",
        walletAddress: "GWALLET_JWT",
        role: "admin",
        isAdmin: true,
      });

      // Cookie without target name
      const reqCookieOther = new Request("http://localhost/api/streams", {
        headers: { cookie: "other_cookie=123" },
      });
      expect(resolveRequestTenant(reqCookieOther)).toBe("default-tenant");

      // Structured JWT token with sub
      const jwt = require("jsonwebtoken");
      const customJwt = jwt.sign({ sub: "GWALLET_CUSTOM", actorId: "actor-custom" }, "random-secret");
      const reqWithCustomJwt = new Request("http://localhost/api/v2/streams", {
        headers: { authorization: `Bearer ${customJwt}` },
      });
      expect(resolveRequestActor(reqWithCustomJwt)).toEqual({
        actorId: "actor-custom",
        walletAddress: "GWALLET_CUSTOM",
        role: "user",
        isAdmin: false,
      });

      // visibleTo with actor having orgIds but null walletAddress
      expect(
        visibleTo({ walletAddress: null, orgIds: ["org-acme"] }, "tenant-a")({
          id: "stream-org",
          tenantId: "tenant-a",
          senderAddress: "SENDER1",
          recipient: "RECIP1",
          orgId: "org-acme",
        } as any),
      ).toBe(true);

      // Header role admin fallback without wallet header
      const reqWithRoleOnly = new Request("http://localhost/api/streams", {
        headers: { "x-streampay-actor-role": "admin" },
      });
      expect(resolveRequestActor(reqWithRoleOnly)?.isAdmin).toBe(true);
    });
  });
});
