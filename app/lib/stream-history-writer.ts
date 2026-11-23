/**
 * appendStreamHistoryEvent — lifecycle write-path helper.
 *
 * Called by route handlers immediately after a committed state transition.
 * Idempotent replays intercepted by the idempotency layer never reach this code.
 * Failed operations (route returns 4xx/5xx before calling this) never append.
 *
 * No PII: actor wallet is truncated to first 6 chars before storing.
 */

import { randomUUID } from "crypto";
import { getStore } from "@/app/lib/db";
import { truncateActor, type StreamHistoryEventType } from "@/app/lib/repositories/stream-history";

export interface AppendStreamHistoryArgs {
  streamId: string;
  type: StreamHistoryEventType;
  fromStatus?: string;
  toStatus: string;
  /** ISO-8601 UTC timestamp of the committed change. */
  at: string;
  /** Full wallet address — will be truncated before storing. */
  actorWallet?: string | null;
  txHash?: string;
  amountRaw?: string;
}

export function appendStreamHistoryEvent(args: AppendStreamHistoryArgs): void {
  const { streamId, type, fromStatus, toStatus, at, actorWallet, txHash, amountRaw } = args;
  getStore().streamHistory.append({
    id: randomUUID(),
    streamId,
    type,
    fromStatus,
    toStatus,
    at,
    actor: truncateActor(actorWallet),
    txHash,
    amountRaw,
  });
}
