import { runWithTimeout, TimeoutError } from "./with-timeout";

describe("runWithTimeout", () => {
  it("resolves with the work result under the deadline", async () => {
    await expect(runWithTimeout(1000, async () => "ok")).resolves.toBe("ok");
  });

  it("rejects with TimeoutError when the deadline passes", async () => {
    await expect(
      runWithTimeout(
        20,
        (signal) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve("late")),
          ),
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("aborts the signal so work can stop gracefully", async () => {
    let aborted = false;
    await runWithTimeout(
      20,
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(null);
          });
        }),
    ).catch(() => undefined);
    expect(aborted).toBe(true);
  });

  it("propagates work failures unchanged", async () => {
    await expect(
      runWithTimeout(1000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
