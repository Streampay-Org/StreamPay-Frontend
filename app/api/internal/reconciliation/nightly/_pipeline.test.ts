import { diffRows, normalizeAmountForKind } from "./_pipeline";

describe("diffRows", () => {
  it("zero drift on empty inputs", () => {
    const { summary, diff } = diffRows([], []);
    expect(summary).toEqual({
      totalDBRows: 0, totalIndexerRows: 0,
      missingInIndexerCount: 0, missingInDBCount: 0,
      mismatchedAmountCount: 0, mismatchedStatusCount: 0,
    });
    expect(diff.missingInIndexer).toEqual([]);
    expect(diff.missingInDB).toEqual([]);
  });

  it("flags rows present in DB but missing in indexer", () => {
    const { diff, summary } = diffRows(
      [{ id: "a", amount: "10", status: "confirmed", createdAt: "2026-01-01" }],
      [],
    );
    expect(diff.missingInIndexer).toEqual([{ id: "a", amount: "10", createdAt: "2026-01-01" }]);
    expect(summary.missingInIndexerCount).toBe(1);
  });

  it("flags rows present in indexer but missing in DB", () => {
    const { diff, summary } = diffRows(
      [],
      [{ id: "b", amount: "10", status: "confirmed", ledgerSeq: 42 }],
    );
    expect(diff.missingInDB).toEqual([{ id: "b", amount: "10", ledgerSeq: 42 }]);
    expect(summary.missingInDBCount).toBe(1);
  });

  it("flags mismatched amounts", () => {
    const { diff, summary } = diffRows(
      [{ id: "a", amount: "10", status: "confirmed", createdAt: "x" }],
      [{ id: "a", amount: "11", status: "confirmed", ledgerSeq: 1 }],
    );
    expect(diff.mismatchedAmount).toEqual([{ id: "a", dbAmount: "10", indexerAmount: "11" }]);
    expect(summary.mismatchedAmountCount).toBe(1);
  });

  it("flags mismatched statuses", () => {
    const { diff, summary } = diffRows(
      [{ id: "a", amount: "10", status: "pending", createdAt: "x" }],
      [{ id: "a", amount: "10", status: "confirmed", ledgerSeq: 1 }],
    );
    expect(summary.mismatchedStatusCount).toBe(1);
    expect(diff.mismatchedStatus).toEqual([{ id: "a", dbStatus: "pending", indexerStatus: "confirmed" }]);
  });

  it("reports zero drift when both sides agree", () => {
    const { summary, diff } = diffRows(
      [{ id: "a", amount: "10", status: "confirmed", createdAt: "x" }],
      [{ id: "a", amount: "10", status: "confirmed", ledgerSeq: 1 }],
    );
    expect(summary).toEqual({
      totalDBRows: 1, totalIndexerRows: 1,
      missingInIndexerCount: 0, missingInDBCount: 0,
      mismatchedAmountCount: 0, mismatchedStatusCount: 0,
    });
    expect(diff.missingInIndexer).toEqual([]);
    expect(diff.missingInDB).toEqual([]);
    expect(diff.mismatchedAmount).toEqual([]);
    expect(diff.mismatchedStatus).toEqual([]);
  });

  it("keys comparisons by (kind, id) so equal ids across kinds never collide", () => {
    const { summary, diff } = diffRows(
      [
        { id: "42", kind: "standard", amount: "100", status: "confirmed", createdAt: "2026-01-01" },
        { id: "42", kind: "split", amount: "0", total: "500", status: "confirmed", createdAt: "2026-01-01" },
      ],
      [
        { id: "42", kind: "standard", amount: "100", status: "confirmed", ledgerSeq: 10 },
        { id: "42", kind: "split", amount: "0", total_amount: "500", status: "confirmed", ledgerSeq: 11 },
      ],
    );

    expect(summary).toEqual({
      totalDBRows: 2,
      totalIndexerRows: 2,
      missingInIndexerCount: 0,
      missingInDBCount: 0,
      mismatchedAmountCount: 0,
      mismatchedStatusCount: 0,
      byKind: {
        standard: {
          totalDBRows: 1,
          totalIndexerRows: 1,
          missingInIndexerCount: 0,
          missingInDBCount: 0,
          mismatchedAmountCount: 0,
          mismatchedStatusCount: 0,
        },
        split: {
          totalDBRows: 1,
          totalIndexerRows: 1,
          missingInIndexerCount: 0,
          missingInDBCount: 0,
          mismatchedAmountCount: 0,
          mismatchedStatusCount: 0,
        },
      },
    });
    expect(diff.missingInIndexer).toEqual([]);
    expect(diff.missingInDB).toEqual([]);
    expect(diff.mismatchedAmount).toEqual([]);
    expect(diff.mismatchedStatus).toEqual([]);
  });

  it("reports missing split in indexer and recurring amount mismatch with bigint precision", () => {
    const { summary, diff } = diffRows(
      [
        { id: "sp-1", kind: "split", amount: "0", total: "9999999999999999999999", status: "active", createdAt: "2026-01-01" },
        {
          id: "rec-1",
          kind: "recurring",
          amount: "0",
          amount_per_cycle: "1000000000000000000000",
          total_cycles: 12,
          status: "active",
          createdAt: "2026-01-01",
        },
      ],
      [
        {
          id: "rec-1",
          kind: "recurring",
          amount: "12000000000000000000001",
          status: "active",
          ledgerSeq: 99,
        },
      ],
    );

    expect(summary.missingInIndexerCount).toBe(1);
    expect(summary.mismatchedAmountCount).toBe(1);
    expect(summary.byKind?.split?.missingInIndexerCount).toBe(1);
    expect(summary.byKind?.recurring?.mismatchedAmountCount).toBe(1);
    expect(diff.missingInIndexer).toEqual([
      { id: "sp-1", kind: "split", amount: "9999999999999999999999", createdAt: "2026-01-01" },
    ]);
    expect(diff.mismatchedAmount).toEqual([
      {
        id: "rec-1",
        kind: "recurring",
        dbAmount: "12000000000000000000000",
        indexerAmount: "12000000000000000000001",
      },
    ]);
  });

  it("preserves unknown kinds from the indexer under their own byKind key", () => {
    const { summary, diff } = diffRows(
      [],
      [{ id: "u-1", kind: "milestone", amount: "750", status: "active", ledgerSeq: 5 }],
    );

    expect(summary.missingInDBCount).toBe(1);
    expect(summary.byKind?.milestone).toEqual({
      totalDBRows: 0,
      totalIndexerRows: 1,
      missingInIndexerCount: 0,
      missingInDBCount: 1,
      mismatchedAmountCount: 0,
      mismatchedStatusCount: 0,
    });
    expect(diff.missingInDB).toEqual([
      { id: "u-1", kind: "milestone", amount: "750", ledgerSeq: 5 },
    ]);
  });
});

describe("normalizeAmountForKind", () => {
  it("normalises split total vs total_amount and recurring amount_per_cycle * total_cycles", () => {
    expect(normalizeAmountForKind({ kind: "standard", amount: "001234567890123456789012345" })).toBe(
      "1234567890123456789012345",
    );
    expect(normalizeAmountForKind({ kind: "split", amount: "0", total: "5000" })).toBe("5000");
    expect(normalizeAmountForKind({ kind: "split", amount: "0", total_amount: "5000" })).toBe("5000");
    expect(
      normalizeAmountForKind({
        kind: "recurring",
        amount: "0",
        amount_per_cycle: "9007199254740993",
        total_cycles: "1000000",
      }),
    ).toBe("9007199254740993000000");
  });
});