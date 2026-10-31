import type { Stream } from "@/app/types/openapi";

export interface MultiGroupLeg extends Stream {
  multiGroupId: string;
  multiName: string;
  multiRank: number;
  multiLegCount: number;
  multiPercentage: string;
  multiStartAt: string;
  multiEndAt: string;
}

export function sortGroupLegs(legs: MultiGroupLeg[]): MultiGroupLeg[] {
  return [...legs].sort(
    (left, right) => left.multiRank - right.multiRank || left.id.localeCompare(right.id),
  );
}

function sumFixedDecimals(values: string[], decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const total = values.reduce((sum, value) => {
    const [whole = "0", fraction = ""] = value.split(".");
    return sum + BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, "0").slice(0, decimals));
  }, 0n);
  const whole = total / scale;
  const fraction = (total % scale).toString().padStart(decimals, "0");
  return `${whole}.${fraction}`;
}

export function buildMultiGroupManifest(groupId: string, inputLegs: MultiGroupLeg[]) {
  const legs = sortGroupLegs(inputLegs);
  const statuses = new Set(legs.map((leg) => leg.status));
  const first = legs[0];

  return {
    id: groupId,
    kind: "multi_recipient" as const,
    name: first.multiName,
    token: first.token ?? "XLM",
    status: statuses.size === 1 ? first.status : "mixed",
    total_amount: sumFixedDecimals(legs.map((leg) => leg.totalAmount ?? "0"), 7),
    allocated_percentage: sumFixedDecimals(legs.map((leg) => leg.multiPercentage), 4),
    recipient_count: legs.length,
    start_at: first.multiStartAt,
    end_at: first.multiEndAt,
    created_at: first.createdAt,
    settlement: null,
    recipients: legs.map((leg) => ({
      rank: leg.multiRank,
      stream_id: leg.id,
      address: leg.recipient,
      percentage: leg.multiPercentage,
      amount: leg.totalAmount ?? "0.0000000",
      status: leg.status,
    })),
    links: {
      self: `/api/v2/streams/multi/${groupId}`,
      collection: "/api/v2/streams",
    },
  };
}