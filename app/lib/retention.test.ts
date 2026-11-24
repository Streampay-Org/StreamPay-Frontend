import { db, getStore, resetDb } from "./db";
import { isPastRetention, RETENTION_PERIOD_MS } from "./privacy";
import { purgeExpiredStreams } from "./retention";
import type { Stream } from "@/app/types/openapi";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function isoAt(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function makeStream(overrides: Partial<Stream> & { id: string }): Stream {
  return {
    id: overrides.id,
    recipient: "GRECIPIENT1234567890ABCDEFGHIJKLMNOPQRSTUVW",
    rate: "10 XLM / day",
    schedule: "daily",
    status: "active",
    token: "XLM",
    createdAt: isoAt(-8 * 365 * DAY_MS),
    updatedAt: isoAt(-8 * 365 * DAY_MS),
    ...overrides,
  };
}

function seed(stream: Stream): Stream {
  getStore().streamRepository.streams.set(stream.id, stream);
  return stream;
}

beforeEach(() => {
  resetDb();
  db.streams.clear();
});

describe("isPastRetention", () => {
  it("accepts an injected clock", () => {
    expect(isPastRetention(isoAt(-RETENTION_PERIOD_MS - 1), NOW)).toBe(true);
    expect(isPastRetention(isoAt(-RETENTION_PERIOD_MS), NOW)).toBe(false);
    expect(isPastRetention(isoAt(-RETENTION_PERIOD_MS + 1), NOW)).toBe(false);
    expect(isPastRetention(isoAt(-RETENTION_PERIOD_MS - 1), new Date(NOW))).toBe(
      true
    );
  });

  it("never treats unparsable or future dates as past retention", () => {
    expect(isPastRetention("not-a-date", NOW)).toBe(false);
    expect(isPastRetention("", NOW)).toBe(false);
    expect(isPastRetention(isoAt(DAY_MS), NOW)).toBe(false);
    expect(isPastRetention(isoAt(-RETENTION_PERIOD_MS - 1), Number.NaN)).toBe(
      false
    );
  });

  it("defaults to the current clock", () => {
    expect(isPastRetention(new Date(Date.now() - RETENTION_PERIOD_MS - DAY_MS).toISOString())).toBe(
      true
    );
    expect(isPastRetention(new Date().toISOString())).toBe(false);
  });
});

describe("purgeExpiredStreams", () => {
  it("scrubs only streams past retention and keeps the aggregates", () => {
    const expired = seed(
      makeStream({
        id: "expired",
        email: "old@example.test",
        label: "Old Label",
        memo: "Old memo",
        partnerId: "P-OLD",
        totalAmount: "3600",
        vestedAmount: "1800",
      })
    );
    const young = seed(
      makeStream({
        id: "young",
        createdAt: isoAt(-365 * DAY_MS),
        updatedAt: isoAt(-365 * DAY_MS),
        email: "new@example.test",
        label: "New Label",
      })
    );

    const result = purgeExpiredStreams({ now: NOW });

    expect(result).toMatchObject({
      scanned: 2,
      eligible: 1,
      alreadyScrubbed: 0,
      purged: 1,
      remaining: 0,
      selectedIds: ["expired"],
      purgedIds: ["expired"],
      dryRun: false,
    });
    expect(result.cutoff).toBe(isoAt(-RETENTION_PERIOD_MS));

    const scrubbed = db.streams.get("expired");
    expect(scrubbed).toMatchObject({
      id: expired.id,
      recipient: expired.recipient,
      rate: expired.rate,
      status: expired.status,
      totalAmount: "3600",
      vestedAmount: "1800",
      updatedAt: new Date(NOW).toISOString(),
    });
    expect(scrubbed?.email).toBeUndefined();
    expect(scrubbed?.label).toBeUndefined();
    expect(scrubbed?.memo).toBeUndefined();
    expect(scrubbed?.partnerId).toBeUndefined();

    expect(db.streams.get("young")).toEqual(young);
  });

  it("leaves unparsable and future createdAt values untouched", () => {
    const invalid = seed(
      makeStream({ id: "invalid", createdAt: "not-a-date", email: "a@b.test" })
    );
    const future = seed(
      makeStream({
        id: "future",
        createdAt: isoAt(DAY_MS),
        updatedAt: isoAt(DAY_MS),
        email: "c@d.test",
      })
    );

    const result = purgeExpiredStreams({ now: NOW });

    expect(result.scanned).toBe(2);
    expect(result.eligible).toBe(0);
    expect(result.purged).toBe(0);
    expect(db.streams.get(invalid.id)).toEqual(invalid);
    expect(db.streams.get(future.id)).toEqual(future);
  });

  it("does not mutate streams on a dry run", () => {
    const expired = seed(
      makeStream({ id: "expired", email: "old@example.test", label: "Old" })
    );

    const result = purgeExpiredStreams({ now: NOW, dryRun: true });

    expect(result).toMatchObject({
      eligible: 1,
      purged: 0,
      selectedIds: ["expired"],
      purgedIds: [],
      dryRun: true,
    });
    expect(db.streams.get(expired.id)).toEqual(expired);
  });

  it("honours the limit oldest-first and reports what remains", () => {
    seed(
      makeStream({
        id: "oldest",
        createdAt: isoAt(-9 * 365 * DAY_MS),
        email: "oldest@example.test",
      })
    );
    seed(
      makeStream({
        id: "middle",
        createdAt: isoAt(-8 * 365 * DAY_MS),
        email: "middle@example.test",
      })
    );
    seed(
      makeStream({
        id: "newest",
        createdAt: isoAt(-7 * 365 * DAY_MS - DAY_MS),
        email: "newest@example.test",
      })
    );

    const result = purgeExpiredStreams({ now: NOW, limit: 2 });

    expect(result.eligible).toBe(3);
    expect(result.purged).toBe(2);
    expect(result.remaining).toBe(1);
    expect(result.purgedIds).toEqual(["oldest", "middle"]);
    expect(db.streams.get("oldest")?.email).toBeUndefined();
    expect(db.streams.get("newest")?.email).toBe("newest@example.test");
  });

  it("is idempotent across repeated runs", () => {
    seed(makeStream({ id: "expired", email: "old@example.test" }));

    const first = purgeExpiredStreams({ now: NOW });
    const snapshot = db.streams.get("expired");
    const second = purgeExpiredStreams({ now: NOW });

    expect(first.purged).toBe(1);
    expect(second).toMatchObject({
      eligible: 0,
      alreadyScrubbed: 1,
      purged: 0,
      purgedIds: [],
    });
    expect(db.streams.get("expired")).toEqual(snapshot);
  });

  it("treats already-scrubbed streams as no-ops and empty PII as scrubbed", () => {
    const scrubbed = seed(
      makeStream({ id: "already", updatedAt: isoAt(-DAY_MS) })
    );
    seed(makeStream({ id: "blank", email: "  ", label: "" }));

    const result = purgeExpiredStreams({ now: NOW });

    expect(result.eligible).toBe(0);
    expect(result.alreadyScrubbed).toBe(2);
    expect(db.streams.get("already")).toEqual(scrubbed);
  });

  it("clamps an out-of-range limit instead of throwing", () => {
    seed(makeStream({ id: "expired" }));

    expect(purgeExpiredStreams({ now: NOW, limit: 0 }).limit).toBe(1);
    expect(purgeExpiredStreams({ now: NOW, limit: 10_000 }).limit).toBe(500);
  });
});
