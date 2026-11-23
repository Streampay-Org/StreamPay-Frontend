import { notFound } from "next/navigation";
import { headers, cookies } from "next/headers";
import {
  ACTOR_HEADER_NAME,
  DEFAULT_STREAM_TENANT_ID,
  TENANT_COOKIE_NAME,
  loadStreamForViewer,
} from "@/app/lib/stream-view";
import { StreamDetailClient } from "./StreamDetailClient";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
};

/**
 * Resolve the viewer's tenant + actor from the incoming request.
 *
 * Priority for the tenant:
 *   1. `x-tenant-id` request header (same contract as the API routes).
 *   2. `sp_tenant_id` cookie.
 *   3. The default demo tenant.
 *
 * Falls back silently — never throws — so unknown tenants simply see the
 * shared default tenant's streams rather than a server error.
 */
async function resolveViewerContext(): Promise<{ tenant: string; actor?: string }> {
  const headerList = await headers();
  const headerTenant = headerList.get("x-tenant-id")?.trim();
  if (headerTenant) {
    return { tenant: headerTenant, actor: headerList.get(ACTOR_HEADER_NAME)?.trim() || undefined };
  }

  const cookieStore = await cookies();
  const cookieTenant = cookieStore.get(TENANT_COOKIE_NAME)?.value?.trim();
  return {
    tenant: cookieTenant || DEFAULT_STREAM_TENANT_ID,
    actor: headerList.get(ACTOR_HEADER_NAME)?.trim() || undefined,
  };
}

export default async function StreamDetailPage({ params }: Props) {
  const { id } = await params;

  // Read from the shared persistence store (same data the API serves) instead
  // of a hard-coded fixture map, so streams created through the app or API
  // render here too. Invisible streams take the 404 path, per the API.
  const viewer = await resolveViewerContext();
  const stream = loadStreamForViewer(id, viewer);

  if (!stream) {
    notFound();
    return null;
  }

  const network =
    process.env.STELLAR_NETWORK === "mainnet" ? "mainnet" : "testnet";

  return <StreamDetailClient stream={stream} network={network} />;
}

export function generateMetadata() {
  return {
    title: "Stream Details — StreamPay",
    description: "Real-time payment stream details, status, next actions, and lifecycle timeline.",
  };
}
