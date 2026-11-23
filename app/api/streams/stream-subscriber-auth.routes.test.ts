import jwt from "jsonwebtoken";
import { GET as getStreamEvents } from "./[id]/events/route";
import { GET as getEvents } from "./events/route";
import { JWT_SECRET } from "@/app/lib/auth";
import { db, resetDb, getStore } from "@/app/lib/db";
import { _resetOrgDbForTesting, orgDb } from "@/app/lib/org-db";
import type { Stream } from "@/app/types/openapi";

const streamId = "subscriber-auth-route-test";
const streamEmail = "private-stream@example.test";
const recipientWallet = "RECIPIENT_WALLET";
const senderWallet = "SENDER_WALLET";
const orgMemberWallet = "GVIEWER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS";
const tenant = "tenant-1";

type Scenario = {
  name: string;
  walletAddress: string;
  role?: "user" | "admin";
  stream?: Partial<Stream>;
  userEmail?: string | null;
  requestTenant?: string;
  expectedStatus: number;
};

const scenarios: Scenario[] = [
  { name: "recipient", walletAddress: recipientWallet, expectedStatus: 200 },
  {
    name: "sender",
    walletAddress: senderWallet,
    stream: { senderAddress: senderWallet },
    expectedStatus: 200,
  },
  {
    name: "owning org member",
    walletAddress: orgMemberWallet,
    expectedStatus: 200,
  },
  { name: "unrelated wallet", walletAddress: "UNRELATED_WALLET", expectedStatus: 403 },
  { name: "admin", walletAddress: "ADMIN_WALLET", role: "admin", expectedStatus: 200 },
  {
    name: "wrong tenant",
    walletAddress: recipientWallet,
    requestTenant: "tenant-2",
    expectedStatus: 404,
  },
  {
    name: "both emails missing",
    walletAddress: "NO_EMAIL",
    stream: { email: undefined },
    userEmail: null,
    expectedStatus: 403,
  },
  {
    name: "case-insensitive email match",
    walletAddress: "EMAIL_MATCH",
    stream: { email: "PRIVATE-STREAM@EXAMPLE.TEST" },
    userEmail: streamEmail,
    expectedStatus: 200,
  },
];

function createRequest(
  walletAddress: string,
  role: "user" | "admin",
  requestTenant: string | null = tenant,
): Request {
  const token = jwt.sign(
    { sub: walletAddress, role, actorId: walletAddress, iss: "streampay", aud: "streampay-api" },
    JWT_SECRET,
  );
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (requestTenant) headers["x-tenant-id"] = requestTenant;
  return new Request(`http://localhost/api/streams/events?streamId=${streamId}`, { headers });
}

async function callRoute(
  route: "id" | "query",
  request: Request,
): Promise<Response> {
  if (route === "query") {
    return getEvents(request as never);
  }
  return getStreamEvents(request as never, { params: Promise.resolve({ id: streamId }) });
}

describe("SSE subscriber authorization consistency", () => {
  beforeEach(() => {
    resetDb();
    _resetOrgDbForTesting();
    const stream: Stream = {
      id: streamId,
      tenant,
      recipient: recipientWallet,
      email: streamEmail,
      rate: "1 XLM / month",
      schedule: "Monthly",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      token: "XLM",
    };
    getStore().streamRepository.streams.set(streamId, stream);
    orgDb.streamOwnership.set(streamId, "org-acme");
  });

  it.each(scenarios)("returns the same authorization result for both routes: $name", async (scenario) => {
    const currentStream = getStore().streamRepository.streams.get(streamId)!;
    getStore().streamRepository.streams.set(streamId, { ...currentStream, ...scenario.stream });
    if (scenario.userEmail !== undefined) {
      db.users.set(scenario.walletAddress, {
        wallet_address: scenario.walletAddress,
        email: scenario.userEmail,
        display_name: "SSE test user",
        avatar_url: null,
        created_at: "2026-01-01T00:00:00Z",
        last_seen: null,
      });
    }

    const responses = await Promise.all(
      (["id", "query"] as const).map((route) =>
        callRoute(route, createRequest(scenario.walletAddress, scenario.role ?? "user", scenario.requestTenant ?? tenant)),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([
      scenario.expectedStatus,
      scenario.expectedStatus,
    ]);

    if (scenario.expectedStatus === 200) {
      await Promise.all(responses.map((response) => response.body?.cancel()));
      return;
    }

    const bodies = await Promise.all(responses.map((response) => response.json()));
    const expectedCode = scenario.expectedStatus === 404 ? "NOT_FOUND" : "FORBIDDEN";
    expect(bodies.map((body) => body.error.code)).toEqual([expectedCode, expectedCode]);
    for (const body of bodies) {
      const serializedBody = JSON.stringify(body);
      expect(serializedBody).not.toContain(streamEmail);
      expect(serializedBody).not.toContain(recipientWallet);
      expect(serializedBody).not.toContain(senderWallet);
    }
  });

  it("defaults the per-stream route to the default tenant when the header is omitted", async () => {
    const stream = getStore().streamRepository.streams.get(streamId)!;
    getStore().streamRepository.streams.set(streamId, { ...stream, tenant: undefined });
    const response = await callRoute("id", createRequest(recipientWallet, "user", null));

    expect(response.status).toBe(200);
    await response.body?.cancel();
  });
});
