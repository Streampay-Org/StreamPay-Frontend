/**
 * @jest-environment jsdom
 */

import {
  getSnapshot,
  subscribe,
} from "./minute-ticker";

describe("minute ticker", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("creates one interval for many subscribers", () => {
    const setIntervalSpy = jest.spyOn(window, "setInterval");
    const listeners = Array.from({ length: 100 }, () => jest.fn());
    const unsubscribes = listeners.map((listener) => subscribe(listener));

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    unsubscribes.forEach((unsubscribe) => unsubscribe());
    setIntervalSpy.mockRestore();
  });

  it("clears the interval on the last unsubscribe", () => {
    const clearIntervalSpy = jest.spyOn(window, "clearInterval");
    const unsubscribeOne = subscribe(jest.fn());
    const unsubscribeTwo = subscribe(jest.fn());

    unsubscribeOne();
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    unsubscribeTwo();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    clearIntervalSpy.mockRestore();
  });

  it("calls listeners each minute and advances the snapshot", () => {
    const listener = jest.fn();
    const unsubscribe = subscribe(listener);
    const initialSnapshot = getSnapshot();

    jest.advanceTimersByTime(60_000);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSnapshot()).toBe(initialSnapshot + 1);

    unsubscribe();
  });

  it("supports subscribe and unsubscribe churn", () => {
    const setIntervalSpy = jest.spyOn(window, "setInterval");
    const clearIntervalSpy = jest.spyOn(window, "clearInterval");

    const unsubscribeOne = subscribe(jest.fn());
    unsubscribeOne();
    const unsubscribeTwo = subscribe(jest.fn());

    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    unsubscribeTwo();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("does not call a listener removed during a tick", () => {
    let unsubscribeSecond = () => {};
    const first = jest.fn(() => unsubscribeSecond());
    const second = jest.fn();

    const unsubscribeFirst = subscribe(first);
    unsubscribeSecond = subscribe(second);

    jest.advanceTimersByTime(60_000);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    unsubscribeSecond();
    unsubscribeFirst();
  });
});
