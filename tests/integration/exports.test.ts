import jwt from "jsonwebtoken";
import { POST as createExport } from "@/app/api/exports/route";
import { GET as getExport } from "@/app/api/exports/[id]/route";
import { db, resetDb } from "@/app/lib/db";

const JWT_SECRET = "streampay-dev-secret-do-not-use-in-prod";
const OWNER = "GEXPORTOWNER";

function bearerToken(walletAddress: string) {
  return jwt.sign(
    {
      sub: walletAddress,
      role: "user",
      iss: "streampay",
      aud: "streampay-api",
    },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

function authenticatedRequest(url: string, token = bearerToken(OWNER)) {
  return new Request(url, {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function waitForReadyExport(id: string, token: string) {
  const deadline = Date.now() + 1_000;

  while (Date.now() < deadline) {
    const response = await getExport(
      authenticatedRequest(`http://localhost/api/exports/${id}`, token),
      { params: Promise.resolve({ id }) },
    );
    const body = await response.json();

    if (body.data?.status === "ready") {
      return body.data;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Export ${id} did not become ready before the timeout`);
}

describe("exports API integration", () => {
  beforeEach(() => {
    resetDb();
  });

  it("creates, processes, and downloads an owner-scoped export", async () => {
    db.streams.set("stream-owned", {
      id: "stream-owned",
      recipient: "GRECIPIENT",
      rate: "25",
      schedule: "month",
      status: "active",
      nextAction: "pause",
      createdAt: "2026-07-24T12:00:00.000Z",
      updatedAt: "2026-07-24T12:00:00.000Z",
      ownerId: OWNER,
    });
    db.streams.set("stream-other", {
      id: "stream-other",
      recipient: "GOTHERRECIPIENT",
      rate: "50",
      schedule: "month",
      status: "active",
      nextAction: "pause",
      createdAt: "2026-07-24T12:01:00.000Z",
      updatedAt: "2026-07-24T12:01:00.000Z",
      ownerId: "GOTHEROWNER",
    });

    const token = bearerToken(OWNER);
    const createResponse = await createExport(
      authenticatedRequest("http://localhost/api/exports", token),
    );

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.data).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        ownerId: OWNER,
        status: "pending",
        rows: 0,
      }),
    );

    const ready = await waitForReadyExport(created.data.id, token);
    expect(ready).toEqual(
      expect.objectContaining({
        status: "ready",
        rows: 1,
        signedUrl: expect.stringContaining("download=true"),
      }),
    );

    const downloadResponse = await getExport(
      authenticatedRequest(`http://localhost${ready.signedUrl}`, token),
      { params: Promise.resolve({ id: created.data.id }) },
    );

    expect(downloadResponse.status).toBe(200);
    const downloaded = await downloadResponse.json();
    expect(downloaded.data.id).toBe(created.data.id);
    expect(
      db.exportAudit.some(
        (record) =>
          record.type === "export.downloaded" &&
          record.exportId === created.data.id,
      ),
    ).toBe(true);
  });

  it("rejects export creation without authentication", async () => {
    const response = await createExport(
      new Request("http://localhost/api/exports", { method: "POST" }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNAUTHORIZED",
        message: expect.any(String),
        request_id: expect.any(String),
      },
    });
  });
});
