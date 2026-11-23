import { InMemoryRateLimitStore } from "./rate-limit-store";

describe("InMemoryRateLimitStore cleanup timer", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("unrefs the cleanup interval handle when supported by the runtime", () => {
    const unref = jest.fn();
    const fakeHandle = { unref } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = jest
      .spyOn(global, "setInterval")
      .mockReturnValue(fakeHandle);
    const clearIntervalSpy = jest
      .spyOn(global, "clearInterval")
      .mockImplementation(() => {});

    const store = new InMemoryRateLimitStore();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(unref).toHaveBeenCalledTimes(1);

    store.destroy();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(fakeHandle);
  });

  it("handles runtimes where setInterval returns a numeric handle", () => {
    const numericHandle = 42 as unknown as ReturnType<typeof setInterval>;
    jest.spyOn(global, "setInterval").mockReturnValue(numericHandle);
    const clearIntervalSpy = jest
      .spyOn(global, "clearInterval")
      .mockImplementation(() => {});

    const store = new InMemoryRateLimitStore();

    store.destroy();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(numericHandle);
  });

  it("makes destroy() idempotent when called multiple times", () => {
    const unref = jest.fn();
    const fakeHandle = { unref } as unknown as ReturnType<typeof setInterval>;
    jest.spyOn(global, "setInterval").mockReturnValue(fakeHandle);
    const clearIntervalSpy = jest
      .spyOn(global, "clearInterval")
      .mockImplementation(() => {});

    const store = new InMemoryRateLimitStore();

    store.destroy();
    store.destroy();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(fakeHandle);
  });

  it("does not leak an open handle under NODE_ENV=test", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    try {
      const store = new InMemoryRateLimitStore();
      const result = await store.check("client-1", 5, 60_000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
      store.destroy();
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV =
        originalNodeEnv;
    }
  });
});
