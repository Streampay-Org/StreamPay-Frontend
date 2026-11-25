/** @jest-environment node */

import { signToken } from "@/app/lib/auth";
import { auditLogStore, resetAuditLogStore } from "@/app/lib/audit-log";
import { _resetOrgDbForTesting, orgDb } from "@/app/lib/org-db";
import { MAX_MESSAGE_LENGTH } from "@/app/lib/receipt-theme";
import { GET as listOrgs } from "../../route";
import { GET as getOrg } from "../route";
import { DELETE, GET, PUT } from "./route";

const orgId = "org-acme";
const context = { params: Promise.resolve({ orgId }) };
const url = `http://localhost/api/orgs/${orgId}/receipt-theme`;
const originalHosts = process.env.RECEIPT_LOGO_ALLOWED_HOSTS;

function request(
  method: string,
  role?: "owner" | "viewer" | "outsider",
  body?: unknown,
) {
  const wallet = role === "outsider"
    ? "unknown-wallet"
    : orgDb.orgs.get(orgId)?.members.find((member) => member.role === role)?.walletAddress;
  return new Request(url, {
    method,
    headers: wallet ? { "Actor-Wallet-Address": wallet } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  _resetOrgDbForTesting();
  resetAuditLogStore();
  process.env.RECEIPT_LOGO_ALLOWED_HOSTS = "images.example.test";
});

afterEach(() => {
  if (originalHosts === undefined) delete process.env.RECEIPT_LOGO_ALLOWED_HOSTS;
  else process.env.RECEIPT_LOGO_ALLOWED_HOSTS = originalHosts;
});

it("limits reads to members and mutations to owners", async () => {
  expect((await GET(request("GET"), context)).status).toBe(403);
  expect((await GET(request("GET", "outsider"), context)).status).toBe(403);
  expect((await GET(request("GET", "owner"), { params: Promise.resolve({ orgId: "missing" }) })).status)
    .toBe(404);
  const member = await GET(request("GET", "viewer"), context);
  expect(await member.json()).toMatchObject({ data: { theme: null, canEdit: false } });
  expect((await PUT(request("PUT", "viewer", {}), context)).status).toBe(403);
  expect((await DELETE(request("DELETE", "viewer"), context)).status).toBe(403);
});

it("rejects a wallet header that disagrees with the signed actor", async () => {
  const viewer = orgDb.orgs.get(orgId)!.members.find((member) => member.role === "viewer")!;
  const write = request("PUT", "owner", { accentColor: "#123" });
  write.headers.set("Authorization", `Bearer ${signToken(viewer.walletAddress)}`);
  const response = await PUT(write, context);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "ACTOR_MISMATCH" } });
});

it("returns field errors for invalid input and does not update the theme", async () => {
  const response = await PUT(request("PUT", "owner", {
    accentColor: "teal",
    logoUrl: "http://images.example.test/logo.png",
    message: "x".repeat(MAX_MESSAGE_LENGTH + 1),
  }), context);
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    error: {
      code: "VALIDATION_ERROR",
      fields: {
        accentColor: expect.any(String),
        logoUrl: expect.any(String),
        message: expect.any(String),
      },
    },
  });
  expect((await PUT(request("PUT", "owner", { logoUrl: "https://other.example.test/img" }), context)).status)
    .toBe(422);
  expect(orgDb.orgs.get(orgId)?.receiptTheme).toBeUndefined();
});

it("normalises and persists a theme, omits it from public org responses, and audits changes", async () => {
  const logoUrl = "https://images.example.test/logo.png";
  const theme = { accentColor: "#abc", logoUrl, message: "Thank you 💙 <team>" };
  const update = () => PUT(request("PUT", "owner", {
    accentColor: " #AbC ", logoUrl: ` ${logoUrl} `, message: ` ${theme.message} `,
  }), context);

  expect(await (await update()).json()).toMatchObject({ data: { theme, canEdit: true } });
  expect(await (await GET(request("GET", "viewer"), context)).json()).toMatchObject({ data: { theme } });
  expect(orgDb.orgs.get(orgId)?.receiptTheme).toEqual(theme);
  await update();

  const listed = await (await listOrgs(new Request("http://localhost/api/orgs"))).json();
  expect(listed.data.find((org: { id: string }) => org.id === orgId)).not.toHaveProperty("receiptTheme");
  const details = await (await getOrg(new Request(`http://localhost/api/orgs/${orgId}`), context)).json();
  expect(details.data).not.toHaveProperty("receiptTheme");

  expect(await (await DELETE(request("DELETE", "owner"), context)).json()).toMatchObject({
    data: { theme: null },
  });
  await DELETE(request("DELETE", "owner"), context);
  expect(await (await GET(request("GET", "owner"), context)).json()).toMatchObject({ data: { theme: null } });

  const { data } = auditLogStore.getPaginated({ orgId, limit: 50 });
  const events = data.filter((entry) => entry.action.startsWith("org.receipt_theme."));
  expect(events.map((entry) => entry.action).sort()).toEqual([
    "org.receipt_theme.reset",
    "org.receipt_theme.updated",
  ]);
  expect(events.every((entry) => entry.metadata?.orgId === orgId)).toBe(true);
  expect(auditLogStore.assertIntegrity()).toBe(true);
});
