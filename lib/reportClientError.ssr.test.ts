/** @jest-environment node */

import { reportClientError } from "./reportClientError";

describe("reportClientError (SSR / Node environment)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns early without throwing or calling fetch when window is undefined", () => {
    expect(typeof window).toBe("undefined");

    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(() =>
      reportClientError({ message: "server-side error", kind: "boundary" }),
    ).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
