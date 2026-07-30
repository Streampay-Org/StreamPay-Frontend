import { diffRows } from "./_pipeline";

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
});