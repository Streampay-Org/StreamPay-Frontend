/** @jest-environment node */

import { HorizonIndexer } from "../lib/indexer";
import { runBackfill } from "./backfill-indexer";

jest.mock("../lib/indexer");

const MockHorizonIndexer = HorizonIndexer as jest.MockedClass<
  typeof HorizonIndexer
>;

describe("backfill-indexer", () => {
  const envKeys = [
    "TARGET_LEDGER",
    "NETWORK",
    "HORIZON_URL",
    "OVERLAP_WINDOW",
  ] as const;
  const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> =
    {};

  let mockBackfill: jest.Mock;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    mockBackfill = jest.fn().mockResolvedValue(undefined);
    MockHorizonIndexer.mockImplementation(
      () =>
        ({
          backfill: mockBackfill,
        }) as unknown as HorizonIndexer,
    );

    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    jest.restoreAllMocks();
  });

  it("returns exit code 1 and does not construct indexer when TARGET_LEDGER is missing", async () => {
    const code = await runBackfill();

    expect(code).toBe(1);
    expect(MockHorizonIndexer).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Error: TARGET_LEDGER environment variable is required and must be > 0.",
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it.each(["0", "-10", "abc"])(
    "returns exit code 1 and does not construct indexer when TARGET_LEDGER=%s",
    async (value) => {
      process.env.TARGET_LEDGER = value;

      const code = await runBackfill();

      expect(code).toBe(1);
      expect(MockHorizonIndexer).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    },
  );

  it("uses default env options when NETWORK, HORIZON_URL, and OVERLAP_WINDOW are unset", async () => {
    process.env.TARGET_LEDGER = "123456";

    const code = await runBackfill();

    expect(code).toBe(0);
    expect(MockHorizonIndexer).toHaveBeenCalledTimes(1);
    expect(MockHorizonIndexer).toHaveBeenCalledWith({
      network: "public",
      horizonUrl: "https://horizon.stellar.org",
      overlapWindow: 100,
      stallThresholdMs: 300000,
    });
    expect(mockBackfill).toHaveBeenCalledWith(123456, []);
    expect(logSpy).toHaveBeenCalledWith("Backfill completed successfully.");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("passes env-derived NETWORK, HORIZON_URL, and OVERLAP_WINDOW options", async () => {
    process.env.TARGET_LEDGER = "98765";
    process.env.NETWORK = "testnet";
    process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
    process.env.OVERLAP_WINDOW = "250";

    const code = await runBackfill();

    expect(code).toBe(0);
    expect(MockHorizonIndexer).toHaveBeenCalledWith({
      network: "testnet",
      horizonUrl: "https://horizon-testnet.stellar.org",
      overlapWindow: 250,
      stallThresholdMs: 300000,
    });
    expect(mockBackfill).toHaveBeenCalledWith(98765, []);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("returns exit code 1 when indexer.backfill rejects", async () => {
    process.env.TARGET_LEDGER = "500";
    const boom = new Error("Horizon unavailable");
    mockBackfill.mockRejectedValueOnce(boom);

    const code = await runBackfill();

    expect(code).toBe(1);
    expect(mockBackfill).toHaveBeenCalledWith(500, []);
    expect(errorSpy).toHaveBeenCalledWith("Backfill job failed:", boom);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
