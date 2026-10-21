import type { AuthenticatedActor } from "@/app/lib/auth";
import { db } from "@/app/lib/db";
import { orgDb } from "@/app/lib/org-db";
import type { Stream } from "@/app/types/openapi";

export const DEFAULT_STREAM_TENANT = "default";

export type StreamSubscriberAuthorization =
  | { ok: true }
  | { ok: false; status: 403 | 404 };

export function authorizeStreamSubscriber(
  actor: Pick<AuthenticatedActor, "walletAddress" | "role">,
  stream: Stream,
  tenant: string,
): StreamSubscriberAuthorization {
  if ((stream.tenant ?? DEFAULT_STREAM_TENANT) !== tenant) {
    return { ok: false, status: 404 };
  }

  if (actor.role === "admin" || stream.recipient === actor.walletAddress || stream.senderAddress === actor.walletAddress) {
    return { ok: true };
  }

  const orgId = orgDb.streamOwnership.get(stream.id);
  const org = orgId ? orgDb.orgs.get(orgId) : undefined;
  if (org?.members.some((member) => member.walletAddress === actor.walletAddress)) {
    return { ok: true };
  }

  const streamEmail = stream.email?.trim();
  const userEmail = db.users.get(actor.walletAddress)?.email?.trim();
  if (streamEmail && userEmail && streamEmail.toLowerCase() === userEmail.toLowerCase()) {
    return { ok: true };
  }

  return { ok: false, status: 403 };
}
