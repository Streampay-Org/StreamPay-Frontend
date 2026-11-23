import {
  createInMemoryPersistenceStore,
  resetDb,
  setStore,
  getStore,
} from "@/app/lib/db";
import {
  ACTOR_HEADER_NAME,
  DEFAULT_STREAM_TENANT_ID,
  TENANT_COOKIE_NAME,
  loadStreamForViewer,
} from "@/app/lib/stream-view";
import type { Stream } from "@/app/types/openapi";

function seedTenantStream(id: string, tenant?: string): Stream {
  const now = new Date().toISOString();
  const stream: Stream = {
    id,
    recipient: "GTEST00000000000000000000000000000000000000000000000000",
    rate: "5 XLM / month",
    schedule: "Pays every 30 days",
    status: "draft",
    nextAction: "start",
    createdAt: now,
    updatedAt: now,
    token: "XLM",
  };
  if (tenant !== undefined) {
    (stream as { tenant?: string }).tenant = tenant;
  }
  getStore().streamRepository.streams.set(id, stream);
  return stream;
}

beforeEach(() => {
  setStore(createInMemoryPersistenceStore());
  resetDb();
});

describe("viewer context contract", () => {
  it("exports the header/cookie names the page loader consumes", () => {
    expect(TENANT_COOKIE_NAME).toBe("sp_tenant_id");
    expect(ACTOR_HEADER_NAME).toBe("x-streampay-actor-id");
  });
});

describe("loadStreamForViewer", () => {
  it("returns a seeded (tenant-less) stream for the default tenant viewer", () => {
    const stream = loadStreamForViewer("stream-ada", {});
    expect(stream?.id).toBe("stream-ada");
  });

  it("returns null for an unknown stream id", () => {
    expect(loadStreamForViewer("stream-does-not-exist", {})).toBeNull();
  });

  it("resolves the tenant from options without mutating defaults", () => {
    expect(DEFAULT_STREAM_TENANT_ID).toBe("default-tenant");
    expect(loadStreamForViewer("stream-ada", { tenant: null })).not.toBeNull();
  });

  it("uses the default viewer context when options are omitted entirely", () => {
    expect(loadStreamForViewer("stream-ada")).not.toBeNull();
  });

  it("hides an explicitly-tenanted stream from other tenants (no cross-tenant leak)", () => {
    seedTenantStream("stream-tenanted", "org-acme");

    expect(loadStreamForViewer("stream-tenanted", { tenant: DEFAULT_STREAM_TENANT_ID })).toBeNull();
  });

  it("returns the explicitly-tenanted stream to its own tenant", () => {
    const seeded = seedTenantStream("stream-tenanted", "org-acme");

    expect(loadStreamForViewer("stream-tenanted", { tenant: "org-acme" })).toEqual(seeded);
  });

  it("treats whitespace-only tenant values as the default tenant", () => {
    seedTenantStream("stream-tenanted", "org-acme");

    expect(loadStreamForViewer("stream-tenanted", { tenant: "   " })).toBeNull();
    expect(loadStreamForViewer("stream-ada", { tenant: "   " })).not.toBeNull();
  });

  it("trims the viewer tenant before comparing", () => {
    seedTenantStream("stream-tenanted", "org-acme");

    expect(
      loadStreamForViewer("stream-tenanted", { tenant: "  org-acme  " }),
    ).toEqual(expect.objectContaining({ id: "stream-tenanted" }));
  });

  it("does not leak a tenant-less stream to a foreign tenant viewer", () => {
    seedTenantStream("stream-foreign", "some-other-org");

    // Tenant-less row belongs to the default tenant; a viewer resolving to
    // that default may see it (demo + API-created streams), but a viewer
    // resolving to another org must not see anything.
    expect(loadStreamForViewer("stream-foreign", { tenant: DEFAULT_STREAM_TENANT_ID })).toBeNull();
  });

  it("accepts an actor in the viewer context without changing visibility", () => {
    const seeded = seedTenantStream("stream-tenanted", "org-acme");

    expect(
      loadStreamForViewer("stream-tenanted", { tenant: "org-acme", actor: "GACTOR" }),
    ).toEqual(seeded);
    expect(
      loadStreamForViewer("stream-tenanted", { tenant: "org-beta", actor: "GACTOR" }),
    ).toBeNull();
  });

  it("returns the tenant-less row when the viewer resolves to the default tenant", () => {
    const seeded = seedTenantStream("stream-created-via-api");

    expect(
      loadStreamForViewer("stream-created-via-api", { actor: "GACTOR" }),
    ).toEqual(seeded);
  });
});
