/** @jest-environment node */
import fc from "fast-check";
import { deriveRawAllocationAmounts } from "./multi-recipient";
it("conserves maximum i64 raw amounts across rounded thirds", () => {
  const total = "9223372036854775807";
  const amounts = deriveRawAllocationAmounts(total, [33.3333, 33.3333, 33.3333]);
  expect(amounts.reduce((sum, value) => sum + value, 0n)).toBe(BigInt(total));
});
it("conserves amounts for one through twenty recipients", () => {
  fc.assert(fc.property(fc.bigInt({ min: 1n, max: 9_223_372_036_854_775_807n }), fc.integer({ min: 1, max: 20 }),
    (total, count) => {
      const weights = Array.from({ length: count }, () => Number((100 / count).toFixed(4)));
      const amounts = deriveRawAllocationAmounts(String(total), weights);
      expect(amounts.every(amount => amount >= 0n)).toBe(true);
      expect(amounts.reduce((sum, amount) => sum + amount, 0n)).toBe(total);
    }));
});
it("rejects malformed units and invalid allocation totals", () => {
  expect(() => deriveRawAllocationAmounts("1.2", [100])).toThrow();
  expect(() => deriveRawAllocationAmounts("100", [20, 20])).toThrow();
});
