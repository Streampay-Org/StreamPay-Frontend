/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import StreamDetailPage from "./page";
import { notFound } from "next/navigation";
import { resetDb, db } from "@/app/lib/db";
import type { Stream } from "../../types/openapi";

// Mock next/navigation
jest.mock("next/navigation", () => ({
  notFound: jest.fn(),
}));

// Request copies of the viewer context asserted by the tests below. The
// jest.mock factory closures read these lazily, so tests mutate them before
// rendering.
const requestHeaders = new Map<string, string>();
const requestCookies = new Map<string, string>();
const mockHeaders = jest.fn();
const mockCookies = jest.fn();

jest.mock("next/headers", () => ({
  headers: () => mockHeaders(),
  cookies: () => mockCookies(),
}));

function seedViewerContext({
  tenant,
  cookieTenant,
}: {
  tenant?: string | null;
  cookieTenant?: string | null;
} = {}) {
  requestHeaders.clear();
  requestCookies.clear();
  if (tenant) requestHeaders.set("x-tenant-id", tenant);
  if (cookieTenant) requestCookies.set("sp_tenant_id", cookieTenant);

  mockHeaders.mockImplementation(() => ({
    get: (name: string) => requestHeaders.get(name) ?? null,
  }));
  mockCookies.mockImplementation(() => ({
    get: (name: string) =>
      requestCookies.has(name) ? { name, value: requestCookies.get(name)! } : undefined,
  }));
}

async function renderDetailPage(id: string) {
  const params = Promise.resolve({ id });
  const jsx = await StreamDetailPage({ params });
  return render(jsx);
}

function seedCreatedStream(): Stream {
  // Mirrors the shape POST /api/streams persists: tenant-less minimally
  // populated row.
  const now = new Date().toISOString();
  const created: Stream = {
    id: "stream-created-via-api",
    recipient: "GCREATE00000000000000000000000000000000000000000000000000",
    rate: "10 XLM / month",
    schedule: "Pays every 30 days",
    status: "draft",
    nextAction: "start",
    createdAt: now,
    updatedAt: now,
    token: "XLM",
  };
  db.streams.set(created.id, created);
  return created;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetDb();
  seedViewerContext();
});

describe("StreamDetailPage (persistence-store backed)", () => {
  it("renders the seeded stream-ada detail from the store", async () => {
    await renderDetailPage("stream-ada");

    // Verify summary details come from the store seed
    expect(screen.getByRole("heading", { name: /stream summary/i })).toBeInTheDocument();
    expect(screen.getByText("stream-ada")).toBeInTheDocument();
    expect(screen.getByText("Design Retainer Q2")).toBeInTheDocument();
    expect(screen.getByText("fixture-user-1@example.test")).toBeInTheDocument();
    expect(screen.getAllByText("120 XLM / month")[0]).toBeInTheDocument();
    // Seed carries a valid Stellar G-address recipient (rendered in print mode)
    const recipient = "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZK7G";
    expect(screen.getByText(recipient)).toBeInTheDocument();
    // Seed parity: richer demo amounts + settlement data from the fixture
    expect(screen.getByText("c3f8a12e4b76d09e1a23f456bc78d90e1f234a5678b9c0d1e2f3a4b5c6d7e8f9")).toBeInTheDocument();

    // Verify next action mirrors StreamRow behavior ("Pause" for active)
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();

    // Verify print receipt link is rendered correctly
    const receiptLink = screen.getByRole("link", { name: /print stream receipt/i });
    expect(receiptLink).toBeInTheDocument();
    expect(receiptLink).toHaveAttribute("href", "/streams/stream-ada/receipt");

    // Verify accessible vertical timeline ordered list semantics
    const timelineList = screen.getByRole("list", { name: /payment lifecycle stages/i });
    expect(timelineList.tagName).toBe("OL");

    // Verify steps have descriptive status texts for screen readers
    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(4);

    // Created + started stages completed, settled current, withdrawn upcoming
    expect(steps[0]).toHaveTextContent("Stream Created");
    expect(steps[1]).toHaveTextContent("Stream Started");
    expect(steps[2]).toHaveTextContent("Funds Settled");
    expect(steps[3]).toHaveTextContent("Funds Withdrawn");
  });

  it.each([
    [
      "stream-kemi",
      "Kemi Onboarding Support",
      "32 XLM / week",
      "April Support batch",
      "GBVZZ5QKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2Z",
      "Start",
    ],
    [
      "stream-yusuf",
      "Yusuf QA Partnership",
      "18 XLM / day",
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
      "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGYWDEAVQBMJ87WGNB55IAA",
      "Withdraw",
    ],
  ])("renders seeded %s detail from the store", async (id, label, rate, memo, recipient, action) => {
    await renderDetailPage(id);

    // Header keeps the demo name the old fixture showed (not the "Payment Stream" fallback)
    expect(screen.getAllByText(label)[0]).toBeInTheDocument();
    expect(screen.getByText(id)).toBeInTheDocument();
    expect(screen.getAllByText(rate)[0]).toBeInTheDocument();
    expect(screen.getByText(memo)).toBeInTheDocument();
    // Seed carries a valid Stellar G-address recipient (rendered in print mode)
    expect(screen.getByText(recipient)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
  });

  it("renders an API-created stream instead of the Next.js 404 page", async () => {
    const created = seedCreatedStream();

    const jsx = await StreamDetailPage({
      params: Promise.resolve({ id: created.id }),
    });
    const { container } = render(jsx);

    expect(container.textContent).toContain("stream-created-via-api");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("calls notFound() for an unknown stream id", async () => {
    await StreamDetailPage({
      params: Promise.resolve({ id: "non-existent-stream-id" }),
    });

    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("calls notFound() instead of leaking another tenant's stream", async () => {
    // Give the seeded stream an explicit tenant the viewer does not belong to.
    const stream = db.streams.get("stream-ada")!;
    (stream as { tenant?: string }).tenant = "org-acme";
    db.streams.set("stream-ada", stream);

    await StreamDetailPage({
      params: Promise.resolve({ id: "stream-ada" }),
    });

    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("renders a tenant-scoped stream when the viewer sends its tenant header", async () => {
    const stream = db.streams.get("stream-ada")!;
    (stream as { tenant?: string }).tenant = "org-acme";
    db.streams.set("stream-ada", stream);

    seedViewerContext({ tenant: "org-acme" });
    const jsx = await StreamDetailPage({ params: Promise.resolve({ id: "stream-ada" }) });
    const { container } = render(jsx);

    expect(notFound).not.toHaveBeenCalled();
    expect(container.textContent).toContain("stream-ada");
  });

  it("falls back to the sp_tenant_id cookie when no tenant header is present", async () => {
    seedViewerContext({ cookieTenant: "org-cookie" });

    const stream = db.streams.get("stream-kemi")!;
    (stream as { tenant?: string }).tenant = "org-cookie";
    db.streams.set("stream-kemi", stream);

    const jsx = await StreamDetailPage({ params: Promise.resolve({ id: "stream-kemi" }) });
    const { container } = render(jsx);

    expect(notFound).not.toHaveBeenCalled();
    expect(container.textContent).toContain("stream-kemi");
  });
});
