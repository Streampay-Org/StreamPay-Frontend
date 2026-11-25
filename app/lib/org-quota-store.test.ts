import {
  InMemoryOrgQuotaStore,
  getOrgQuotaStore,
  resetOrgQuotaStore,
} from "./org-quota-store";

describe("InMemoryOrgQuotaStore cleanup timer", () => {
  afterEach(() => {
    resetOrgQuotaStore();
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

    const store = new InMemoryOrgQuotaStore();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      60 * 60 * 1_000
    );
    expect(unref).toHaveBeenCalledTimes(1);

    store.destroy();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(fakeHandle);
  });

  it("handles runtimes where setInterval returns a numeric handle", () => {
    const numericHandle = 99 as unknown as ReturnType<typeof setInterval>;
    jest.spyOn(global, "setInterval").mockReturnValue(numericHandle);
    const clearIntervalSpy = jest
      .spyOn(global, "clearInterval")
      .mockImplementation(() => {});

    const store = new InMemoryOrgQuotaStore();

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

    const store = new InMemoryOrgQuotaStore();

    store.destroy();
    store.destroy();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(fakeHandle);
  });

  it("clears the interval via resetOrgQuotaStore() and counts quotas accurately", async () => {
    const store = getOrgQuotaStore();
    const first = await store.increment("org-1");
    const second = await store.increment("org-1");

    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
    expect(await store.peek("org-1")).toBe(2);

    resetOrgQuotaStore();
  });
});
