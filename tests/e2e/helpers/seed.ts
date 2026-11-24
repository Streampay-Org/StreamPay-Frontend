import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";

const TEST_WALLET = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";
const TEST_RECIPIENT = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";
const JWT_ISSUER = "streampay";
const JWT_AUDIENCE = "streampay-api";

function authorizationHeader(): string {
  const token = jwt.sign(
    { sub: TEST_WALLET, iss: JWT_ISSUER, aud: JWT_AUDIENCE },
    process.env.JWT_SECRET ?? "streampay-playwright-test-only-secret-not-for-production",
    { expiresIn: "15m", algorithm: "HS256" },
  );
  return `Bearer ${token}`;
}

async function assertSuccessful(response: APIResponse, action: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`Failed to seed ${action}: ${response.status} ${await response.text()}`);
  }
}

export async function seedActiveStream(request: APIRequestContext): Promise<string> {
  const authorization = authorizationHeader();
  const headers = {
    Authorization: authorization,
    "Content-Type": "application/json",
    "x-tenant-id": "default-tenant",
  };

  const createResponse = await request.post("/api/streams", {
    headers: { ...headers, "Idempotency-Key": `pw-create-${randomUUID()}` },
    data: {
      recipient: TEST_RECIPIENT,
      rate: "25",
      schedule: "month",
      token: "XLM",
      totalAmount: "1000000000",
    },
  });
  await assertSuccessful(createResponse, "stream creation");

  const created = (await createResponse.json()) as { data?: { id?: string } };
  const streamId = created.data?.id;
  if (!streamId) {
    throw new Error("Failed to seed stream: creation response did not contain an id.");
  }

  const startResponse = await request.post(`/api/streams/${streamId}/start`, {
    headers: { ...headers, "Idempotency-Key": `pw-start-${randomUUID()}` },
  });
  await assertSuccessful(startResponse, "stream activation");

  return streamId;
}
