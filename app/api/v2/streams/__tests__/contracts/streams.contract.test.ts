/**
 * streams.contract.test.ts
 *
 * Pact-style contract verifier for /api/v2/streams.
 *
 * For each interaction in every fixture file, this test:
 *   1. Builds a real NextRequest from the fixture's request definition.
 *   2. Calls the live route handler directly (no HTTP server needed).
 *   3. Asserts the response status and body shape match the fixture.
 *
 * Run: npm test -- contracts
 */

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/v2/streams/route";
import { GET as GET_SINGLE } from "@/app/api/v2/streams/[id]/route";
import { getStore } from "@/app/lib/db";
import { loadAllFixtures, type PactInteraction } from "./pact-helpers";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNextRequest(interaction: PactInteraction): NextRequest {
  const baseUrl = "http://localhost:3000";
  const url = `${baseUrl}${interaction.request.path}`;
  const init: RequestInit = {
    method: interaction.request.method,
    headers: new Headers(interaction.request.headers ?? {}),
  };
  if (interaction.request.body) {
    init.body = JSON.stringify(interaction.request.body);
  }
  return new NextRequest(url, init as any);
}

async function callHandler(
  interaction: PactInteraction
): Promise<Response> {
  const req = makeNextRequest(interaction);
  const path = interaction.request.path;

  if (path.startsWith("/api/v2/streams/") && path !== "/api/v2/streams") {
    const id = path.replace("/api/v2/streams/", "");
    if (interaction.request.method === "GET") {
      return GET_SINGLE(req, { params: Promise.resolve({ id }) });
    }
  }

  switch (interaction.request.method) {
    case "GET":
      return GET(req);
    case "POST":
      return POST(req);
    default:
      throw new Error(`Unhandled method: ${interaction.request.method}`);
  }
}

function setupProviderState(providerState: string) {
  const { streamRepository } = getStore();
  if (providerState.includes("stream stream_abc123 exists")) {
    let status = "active";
    if (providerState.includes("ended")) status = "ended";
    if (providerState.includes("paused")) status = "paused";
    if (providerState.includes("active")) status = "active";

    streamRepository.streams.set("stream_abc123", {
      id: "stream_abc123",
      recipient: "GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234",
      rate: "120",
      schedule: "month",
      status,
      nextAction: status === "active" ? "pause" : status === "ended" ? "withdraw" : "start",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      token: "XLM",
    });
  }
}

// ── Contract verifier ─────────────────────────────────────────────────────────

describe("Pact contract verifier — /api/v2/streams", () => {
  const fixtures = loadAllFixtures();

  for (const fixture of fixtures) {
    describe(`${fixture.consumer.name} → ${fixture.provider.name}`, () => {
      for (const interaction of fixture.interactions) {
        it(interaction.description, async () => {
          setupProviderState(interaction.providerState ?? "");
          const response = await callHandler(interaction);

          // ── Status code ──────────────────────────────────────────────────
          expect(response.status).toBe(interaction.response.status);

          // ── Body shape ───────────────────────────────────────────────────
          if (interaction.response.body !== undefined) {
            const body = await response.json();
            const expected = interaction.response.body as Record<string, unknown>;

            // Top-level keys must all be present
            for (const key of Object.keys(expected)) {
              expect(body).toHaveProperty(key);
            }

            // Error responses: code and message must match exactly
            if (expected.error) {
              const expErr = expected.error as Record<string, unknown>;
              expect(body.error.code).toBe(expErr.code);
              expect(body.error.message).toBe(expErr.message);
            }

            // Stream list responses: must be an array
            if (Array.isArray(expected.streams)) {
              expect(Array.isArray(body.streams)).toBe(true);
            }

            // Single stream responses: check id and status
            if (expected.id !== undefined) {
              expect(typeof body.id).toBe("string");
              expect(typeof body.status).toBe("string");
              expect(["draft","active","paused","ended"]).toContain(body.status);
            }
          }
        });
      }
    });
  }
});
