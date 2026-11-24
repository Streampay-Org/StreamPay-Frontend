import { cookies, headers } from "next/headers";
import { getOrgReceiptTheme, getStreamOrg } from "@/app/lib/org-db";
import { normalizeReceiptTheme } from "@/app/lib/receipt-theme";
import {
  DEFAULT_STREAM_TENANT_ID,
  loadStreamForViewer,
  TENANT_COOKIE_NAME,
} from "@/app/lib/stream-view";
import { makeDemoDateShifter } from "@/app/lib/demo-dates";
import { notFound } from "next/navigation";
import { ReceiptBuilder } from "../../../components/ReceiptBuilder";
import type { Stream } from "../../../types/openapi";

// Keep seeded demo timestamps recent (no-op under Jest).
const demoDate = makeDemoDateShifter("2024-11-21T00:00:00.000Z");

// Placeholder streams that match the mock data used across the app.
// Replace with a real API/DB fetch once the data layer is wired.
const MOCK_STREAMS: Record<string, Stream> = {
  "stream-ada": {
    id: "stream-ada",
    recipient: "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZK7G",
    rate: "120 XLM / month",
    schedule: "Pays every 30 days",
    status: "active",
    label: "Ada Creative Studio",
    email: "ada@example.com",
    createdAt: demoDate("2024-11-01T09:00:00.000Z"),
    updatedAt: demoDate("2024-11-20T14:30:00.000Z"),
    settlementTxHash:
      "c3f8a12e4b76d09e1a23f456bc78d90e1f234a5678b9c0d1e2f3a4b5c6d7e8f9",
    token: "XLM",
  },
  "stream-kemi": {
    id: "stream-kemi",
    recipient: "GBVZZ5QKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2Z",
    rate: "32 XLM / week",
    schedule: "Draft stream ready to launch",
    status: "draft",
    label: "Kemi Onboarding Support",
    createdAt: demoDate("2024-11-15T11:00:00.000Z"),
    updatedAt: demoDate("2024-11-15T11:00:00.000Z"),
    token: "XLM",
  },
  "stream-yusuf": {
    id: "stream-yusuf",
    recipient: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGYWDEAVQBMJ87WGNB55IAA",
    rate: "18 XLM / day",
    schedule: "Ended yesterday with funds available",
    status: "ended",
    label: "Yusuf QA Partnership",
    createdAt: demoDate("2024-10-01T08:00:00.000Z"),
    updatedAt: demoDate("2024-11-19T17:45:00.000Z"),
    settlementTxHash:
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    withdrawal: {
      state: "pending",
      requestedAt: demoDate("2024-11-19T18:00:00.000Z"),
      lastCheckedAt: demoDate("2024-11-19T18:05:00.000Z"),
      attempts: 1,
    },
    token: "XLM",
  },
};

type Props = {
  params: Promise<{ id: string }>;
};

export default async function StreamReceiptPage({ params }: Props) {
  const { id } = await params;
  const [headerStore, cookieStore] = await Promise.all([headers(), cookies()]);
  const tenant = headerStore.get("x-tenant-id")?.trim()
    || cookieStore.get(TENANT_COOKIE_NAME)?.value?.trim()
    || DEFAULT_STREAM_TENANT_ID;
  const demoStream = tenant === DEFAULT_STREAM_TENANT_ID && Object.hasOwn(MOCK_STREAMS, id)
    ? MOCK_STREAMS[id]
    : undefined;
  const storedStream = loadStreamForViewer(id, { tenant });
  const stream = demoStream ?? storedStream;
  if (!stream) {
    notFound();
    return null;
  }

  const themeOrgId = storedStream?.orgId ?? stream.orgId ?? getStreamOrg(id)?.id;
  const theme = themeOrgId ? getOrgReceiptTheme(themeOrgId) : undefined;

  const network =
    process.env.STELLAR_NETWORK === "mainnet" ? "mainnet" : "testnet";

  return (
    <ReceiptBuilder
      generatedAt={new Date().toISOString()}
      network={network}
      stream={stream}
      theme={theme ? normalizeReceiptTheme(theme) : undefined}
    />
  );
}

export function generateMetadata() {
  return {
    title: "Stream Receipt — StreamPay",
    description: "Print-friendly payment stream summary",
  };
}

// Read the active theme for each receipt request.
export const dynamic = "force-dynamic";
