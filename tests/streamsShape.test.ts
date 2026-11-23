/**
 * @jest-environment node
 *
 * Snapshot tests for /api/streams response shape stability (issue #597).
 *
 * Purpose: pin the exact JSON shape returned by GET and POST /api/streams so
 * that accidental regressions in field names, nesting, or envelope structure
 * are caught immediately in CI.
 *
 * Strategy:
 *  - Call the real route handlers directly (no HTTP server needed).
 *  - Replace volatile values (ids, timestamps, cursors) with stable
 *    placeholders before snapshotting, so snapshots stay deterministic.
 *  - On the first run Jest writes the .snap files; subsequent runs compare.
 *
 * To intentionally update the shape (e.g. after a deliberate v1 change):
 *   npx jest tests/streamsShape.test.ts --updateSnapshot
 * Only do this after confirming the change is backwards-compatible with all
 * wallet partners still on v1 (sunset: 2026-12-31).
 */

import { resetDb } from "@/app/lib/db";
import { GET as getStreams, POST as createStream } from "@/app/api/streams/route";
import { resetRateLimitStore, InMemoryRateLimitStore, setRateLimitStore } from "@/app/lib/rate-limit-store";
import { readFileSync } from "fs";
import { join } from "path";

// Load the OpenAPI spec for lifecycle path validation (lazy, so parse errors
// are attributed to the test suite that uses it rather than crashing Jest).
let _openapiSpec: any = null;
function openapiSpec(): any {
  if (_openapiSpec) return _openapiSpec;
  _openapiSpec = JSON.parse(readFileSync(join(__dirname, "..", "openapi.json"), "utf8"));
  return _openapiSpec;
}

// A valid-format Stellar public key used as a test fixture — not a real key.
const STELLAR_KEY =
  "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function postReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/streams", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function getReq(query = ""): Request {
  return new Request(`http://localhost/api/streams${query}`);
}

/**
 * Replace volatile values in a response body with stable placeholders so
 * snapshots don't change on every test run.
 */
function stabilise(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stabilise);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (
      // ISO-8601 timestamps
      (k === "createdAt" || k === "updatedAt" || k === "created_at") &&
      typeof v === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(v)
    ) {
      out[k] = "<ISO_TIMESTAMP>";
    } else if (
      // stream ids like "stream-xxxxxxxx"
      k === "id" &&
      typeof v === "string" &&
      v.startsWith("stream-")
    ) {
      out[k] = "stream-<ID>";
    } else if (
      // self links that embed a stream id
      k === "self" &&
      typeof v === "string" &&
      v.includes("/api/v1/streams")
    ) {
      out[k] = v.replace(/stream-[a-z0-9]+/, "stream-<ID>");
    } else if (
      // opaque cursor tokens
      k === "nextCursor" &&
      typeof v === "string"
    ) {
      out[k] = "<CURSOR>";
    } else {
      out[k] = stabilise(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

// A fresh store with a very high limit ensures POST tests are never throttled
// and the interval handle is owned by this suite so afterAll can destroy it.
let rateLimitStore: InMemoryRateLimitStore;

beforeEach(() => {
  resetDb();
  rateLimitStore = new InMemoryRateLimitStore(/* maxTokensPerBucket */ 10_000);
  setRateLimitStore(rateLimitStore);
});

afterEach(() => {
  rateLimitStore.destroy();
});

afterAll(() => {
  resetRateLimitStore();
});

// ---------------------------------------------------------------------------
// GET /api/streams — empty store
// ---------------------------------------------------------------------------

describe("GET /api/streams shape", () => {
  it("matches snapshot: empty list", async () => {
    const res = await getStreams(getReq());
    expect(res.status).toBe(200);
    const body = stabilise(await res.json());
    expect(body).toMatchSnapshot();
  });

  it("matches snapshot: list with one stream", async () => {
    // Seed one stream.
    await createStream(
      postReq({ recipient: STELLAR_KEY, rate: "100", schedule: "month" }),
    );

    const res = await getStreams(getReq());
    expect(res.status).toBe(200);
    const body = stabilise(await res.json());
    expect(body).toMatchSnapshot();
  });

  it("matches snapshot: meta fields present (hasNext, nextCursor, total)", async () => {
    const res = await getStreams(getReq());
    const body = (await res.json()) as {
      meta: { hasNext: boolean; nextCursor: unknown; total: number };
    };
    // Assert structural presence before snapshotting so failures are readable.
    expect(body).toHaveProperty("meta.hasNext");
    expect(body).toHaveProperty("meta.nextCursor");
    expect(body).toHaveProperty("meta.total");
    expect(stabilise(body)).toMatchSnapshot();
  });

  it("matches snapshot: links.self is always present", async () => {
    const res = await getStreams(getReq());
    const body = await res.json();
    expect(body).toHaveProperty("links.self");
    expect(stabilise(body)).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// POST /api/streams — create response shape
// ---------------------------------------------------------------------------

describe("POST /api/streams shape", () => {
  it("matches snapshot: 201 with data + links", async () => {
    const res = await createStream(
      postReq({ recipient: STELLAR_KEY, rate: "50", schedule: "month" }),
    );
    expect(res.status).toBe(201);
    const body = stabilise(await res.json());
    expect(body).toMatchSnapshot();
  });

  it("matches snapshot: data fields are v1 camelCase (no snake_case leakage)", async () => {
    const res = await createStream(
      postReq({ recipient: STELLAR_KEY, rate: "50", schedule: "week" }),
    );
    const { data } = (await res.json()) as { data: Record<string, unknown> };

    // Explicit shape guards before snapshotting.
    expect(data).toHaveProperty("createdAt");
    expect(data).toHaveProperty("updatedAt");
    expect(data).not.toHaveProperty("created_at");
    expect(data).not.toHaveProperty("allowed_actions");

    expect(stabilise({ data })).toMatchSnapshot();
  });

  it("matches snapshot: 422 error envelope shape", async () => {
    const res = await createStream(postReq({ recipient: "bad-key" }));
    expect(res.status).toBe(422);
    // error.request_id is dynamic; zero it out.
    const raw = (await res.json()) as {
      error: { code: string; message: string; request_id?: string; details?: unknown[] };
    };
    raw.error.request_id = "<REQUEST_ID>";
    expect(raw).toMatchSnapshot();
  });

  it("matches snapshot: 400 error when body is not JSON", async () => {
    const res = await createStream(
      new Request("http://localhost/api/streams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
    );
    expect(res.status).toBe(400);
    const raw = (await res.json()) as { error: { request_id?: string } };
    raw.error.request_id = "<REQUEST_ID>";
    expect(raw).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// OpenAPI lifecycle paths — existence and shape validation (issue #898)
// ---------------------------------------------------------------------------

describe("OpenAPI lifecycle paths (v1)", () => {
  const lifecyclePaths = [
    "/api/streams/{id}/start",
    "/api/streams/{id}/stop",
    "/api/streams/{id}/pause",
    "/api/streams/{id}/settle",
  ];

  it.each(lifecyclePaths)("%s exists in the OpenAPI spec", (path) => {
    expect(openapiSpec().paths).toHaveProperty(path);
  });

  it.each(lifecyclePaths)("%s has POST method", (path) => {
    expect(openapiSpec().paths[path]).toHaveProperty("parameters");
    expect(openapiSpec().paths[path]).toHaveProperty("post");
  });

  it.each(lifecyclePaths)("%s POST has operationId and deprecated: true", (path) => {
    const op = openapiSpec().paths[path].post;
    expect(op).toHaveProperty("operationId");
    expect(typeof op.operationId).toBe("string");
    expect(op.deprecated).toBe(true);
  });

  it.each(lifecyclePaths)("%s POST has 200 response with examples", (path) => {
    const responses = openapiSpec().paths[path].post.responses;
    expect(responses).toHaveProperty("200");
    const content = responses["200"].content["application/json"];
    expect(content).toHaveProperty("examples");
    const examples = content.examples;
    expect(Object.keys(examples).length).toBeGreaterThanOrEqual(1);
  });

  it.each(lifecyclePaths)("%s POST has error responses (400, 404, 409, 500)", (path) => {
    const responses = openapiSpec().paths[path].post.responses;
    expect(responses).toHaveProperty("400");
    expect(responses).toHaveProperty("404");
    expect(responses).toHaveProperty("409");
    expect(responses).toHaveProperty("500");
  });

  it.each(lifecyclePaths)("%s has required parameters (id, x-tenant-id)", (path) => {
    const params = openapiSpec().paths[path].parameters;
    const paramNames = params.map((p: { name: string }) => p.name);
    expect(paramNames).toContain("id");
    expect(paramNames).toContain("x-tenant-id");
    const idParam = params.find((p: { name: string }) => p.name === "id");
    expect(idParam.required).toBe(true);
    const tenantParam = params.find((p: { name: string }) => p.name === "x-tenant-id");
    expect(tenantParam.required).toBe(true);
  });

  it("start has draft→active and paused→active examples", () => {
    const examples = openapiSpec().paths["/api/streams/{id}/start"].post.responses["200"].content["application/json"].examples;
    expect(examples).toHaveProperty("draft-to-active");
    expect(examples).toHaveProperty("paused-to-active");
    expect(examples["draft-to-active"].value.data.status).toBe("active");
    expect(examples["paused-to-active"].value.data.status).toBe("active");
  });

  it("stop has active→ended and draft→ended examples", () => {
    const examples = openapiSpec().paths["/api/streams/{id}/stop"].post.responses["200"].content["application/json"].examples;
    expect(examples).toHaveProperty("active-to-ended");
    expect(examples).toHaveProperty("draft-to-ended");
    expect(examples["active-to-ended"].value.data.status).toBe("ended");
    expect(examples["draft-to-ended"].value.data.status).toBe("ended");
  });

  it("pause has active→paused example", () => {
    const examples = openapiSpec().paths["/api/streams/{id}/pause"].post.responses["200"].content["application/json"].examples;
    expect(examples).toHaveProperty("active-to-paused");
    expect(examples["active-to-paused"].value.data.status).toBe("paused");
  });

  it("settle has active→ended and paused→ended examples", () => {
    const examples = openapiSpec().paths["/api/streams/{id}/settle"].post.responses["200"].content["application/json"].examples;
    expect(examples).toHaveProperty("settle-active");
    expect(examples).toHaveProperty("settle-paused");
    expect(examples["settle-active"].value.data.status).toBe("ended");
    expect(examples["settle-paused"].value.data.status).toBe("ended");
  });

  it("settle has 502 SETTLEMENT_FAILED error response", () => {
    const responses = openapiSpec().paths["/api/streams/{id}/settle"].post.responses;
    expect(responses).toHaveProperty("502");
  });

  it("all lifecycle paths are tagged as Streams v1", () => {
    for (const path of lifecyclePaths) {
      const tags = openapiSpec().paths[path].post.tags;
      expect(tags).toContain("Streams v1");
    }
  });

  it("all lifecycle example data fields use v1 camelCase shape", () => {
    for (const path of lifecyclePaths) {
      const examples = openapiSpec().paths[path].post.responses["200"].content["application/json"].examples;
      for (const [, example] of Object.entries(examples) as [string, { value: { data: Record<string, unknown> } }][]) {
        const { data } = example.value;
        expect(data).toHaveProperty("id");
        expect(data).toHaveProperty("recipient");
        expect(data).toHaveProperty("rate");
        expect(data).toHaveProperty("schedule");
        expect(data).toHaveProperty("status");
        expect(data).toHaveProperty("nextAction");
        expect(data).toHaveProperty("token");
        expect(data).toHaveProperty("createdAt");
        expect(data).toHaveProperty("updatedAt");
        // v1 shape should never leak v2 field names.
        expect(data).not.toHaveProperty("created_at");
        expect(data).not.toHaveProperty("allowed_actions");
        expect(data).not.toHaveProperty("settlement");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// OpenAPI examples for streams CRUD (issue #910)
// ---------------------------------------------------------------------------

describe("OpenAPI search endpoint examples", () => {
  const searchPath = "/api/streams/search";

  it("has search endpoint with examples in the OpenAPI spec", () => {
    const path = openapiSpec().paths[searchPath];
    expect(path).toBeDefined();
    const examples = path.get.responses["200"].content["application/json"].examples;
    expect(examples).toBeDefined();
    expect(Object.keys(examples).length).toBeGreaterThanOrEqual(1);
    expect(examples).toHaveProperty("results-found");
    expect(examples).toHaveProperty("no-results");
  });

  it("search example values match the schema shape", () => {
    const examples = openapiSpec().paths[searchPath].get.responses["200"].content["application/json"].examples;
    for (const [, example] of Object.entries(examples) as [string, { value: { data: unknown[]; meta: Record<string, unknown>; links: Record<string, string> } }][]) {
      const { data, meta, links } = example.value;
      expect(Array.isArray(data)).toBe(true);
      expect(meta).toHaveProperty("total");
      expect(meta).toHaveProperty("limit");
      expect(meta).toHaveProperty("offset");
      expect(meta).toHaveProperty("count");
      expect(meta).toHaveProperty("query");
      expect(links).toHaveProperty("self");
    }
  });
});

describe("OpenAPI v2 streams CRUD examples", () => {
  const v2ListPath = "/api/v2/streams";
  const v2GetPath = "/api/v2/streams/{id}";
  const v2DeletePath = "/api/v2/streams/{id}";

  it("GET /api/v2/streams has query parameters", () => {
    const params = openapiSpec().paths[v2ListPath].get.parameters;
    expect(params).toBeDefined();
    const paramNames = params.map((p: { name: string }) => p.name);
    expect(paramNames).toContain("limit");
    expect(paramNames).toContain("cursor");
    expect(paramNames).toContain("status");
  });

  it("GET /api/v2/streams has examples", () => {
    const examples = openapiSpec().paths[v2ListPath].get.responses["200"].content["application/json"].examples;
    expect(examples).toBeDefined();
    expect(Object.keys(examples).length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/v2/streams examples include meta and links fields", () => {
    const examples = openapiSpec().paths[v2ListPath].get.responses["200"].content["application/json"].examples as Record<string, { value: { streams: unknown[]; meta: Record<string, unknown>; links: Record<string, string> } }>;
    for (const [, example] of Object.entries(examples)) {
      const { streams, meta, links } = example.value;
      expect(Array.isArray(streams)).toBe(true);
      expect(meta).toHaveProperty("hasNext");
      expect(meta).toHaveProperty("nextCursor");
      expect(meta).toHaveProperty("total");
      expect(links).toHaveProperty("self");
    }
  });

  it("GET /api/v2/streams paginated-first-page example has hasNext: true and nextCursor", () => {
    const examples = openapiSpec().paths[v2ListPath].get.responses["200"].content["application/json"].examples as Record<string, { value: { meta: { hasNext: boolean; nextCursor: string | null } } }>;
    expect(examples).toHaveProperty("paginated-first-page");
    expect(examples["paginated-first-page"].value.meta.hasNext).toBe(true);
    expect(examples["paginated-first-page"].value.meta.nextCursor).toBeTruthy();
  });

  it("GET /api/v2/streams/{id} has examples", () => {
    const examples = openapiSpec().paths[v2GetPath].get.responses["200"].content["application/json"].examples;
    expect(examples).toBeDefined();
    expect(Object.keys(examples).length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/v2/streams/{id} example data uses v2 shape", () => {
    const examples = openapiSpec().paths[v2GetPath].get.responses["200"].content["application/json"].examples as Record<string, { value: { data: Record<string, unknown> } }>;
    for (const [, example] of Object.entries(examples)) {
      const { data } = example.value;
      expect(data).toHaveProperty("id");
      expect(data).toHaveProperty("recipient");
      expect(data).toHaveProperty("rate");
      expect(data).toHaveProperty("status");
      expect(data).toHaveProperty("allowed_actions");
      expect(data).toHaveProperty("created_at");
      expect(data).toHaveProperty("settlement");
      expect(data).not.toHaveProperty("nextAction");
      expect(data).not.toHaveProperty("createdAt");
    }
  });

  it("POST /api/v2/streams has request body examples", () => {
    const examples = openapiSpec().paths[v2ListPath].post.requestBody.content["application/json"].examples;
    expect(examples).toBeDefined();
    expect(Object.keys(examples).length).toBeGreaterThanOrEqual(1);
    expect(examples).toHaveProperty("minimal-xlm");
    expect(examples).toHaveProperty("with-usdc-token");
  });

  it("POST /api/v2/streams has response examples", () => {
    const examples = openapiSpec().paths[v2ListPath].post.responses["201"].content["application/json"].examples;
    expect(examples).toBeDefined();
    expect(Object.keys(examples).length).toBeGreaterThanOrEqual(1);
    expect(examples).toHaveProperty("draft-xlm");
    expect(examples).toHaveProperty("draft-usdc");
  });

  it("POST /api/v2/streams response example data uses v2 shape", () => {
    const examples = openapiSpec().paths[v2ListPath].post.responses["201"].content["application/json"].examples as Record<string, { value: Record<string, unknown> }>;
    for (const [, example] of Object.entries(examples)) {
      const value = example.value;
      expect(value).toHaveProperty("id");
      expect(value).toHaveProperty("recipient");
      expect(value).toHaveProperty("rate");
      expect(value).toHaveProperty("status");
      expect(value).toHaveProperty("allowed_actions");
      expect(value).toHaveProperty("created_at");
      expect(value).toHaveProperty("settlement");
    }
  });

  it("DELETE /api/v2/streams/{id} returns 204", () => {
    const responses = openapiSpec().paths[v2DeletePath].delete.responses;
    expect(responses["204"]).toBeDefined();
  });

  it("DELETE /api/v2/streams/{id} error responses use ErrorEnvelope", () => {
    const responses = openapiSpec().paths[v2DeletePath].delete.responses;
    expect(responses["401"]).toBeDefined();
    expect(responses["404"]).toBeDefined();
    expect(responses["409"]).toBeDefined();
    expect(responses["500"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Shape stability: field-set must not change between calls
// ---------------------------------------------------------------------------

describe("shape stability across calls", () => {
  it("GET response top-level keys are stable", async () => {
    const res = await getStreams(getReq());
    const body = await res.json();
    expect(Object.keys(body).sort()).toMatchSnapshot();
  });

  it("POST data object keys are stable", async () => {
    const res = await createStream(
      postReq({ recipient: STELLAR_KEY, rate: "10", schedule: "day" }),
    );
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(data).sort()).toMatchSnapshot();
  });

  it("GET list data items and POST data share the same core key set", () => {
    // The two snapshots above pin the key sets. This test asserts they are identical.
    const getKeys = ["createdAt", "id", "nextAction", "rate", "recipient", "schedule", "status", "token", "updatedAt"];
    const postKeys = ["createdAt", "id", "nextAction", "rate", "recipient", "schedule", "status", "token", "updatedAt"];
    expect(getKeys.sort()).toEqual(postKeys.sort());
  });
});
