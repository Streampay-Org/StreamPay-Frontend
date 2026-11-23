import { reportClientError, type ClientErrorPayload } from "./reportClientError";

describe("reportClientError", () => {
  const originalSendBeaconDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "sendBeacon",
  );
  const originalFetch = global.fetch;

  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalSendBeaconDescriptor) {
      Object.defineProperty(navigator, "sendBeacon", originalSendBeaconDescriptor);
    } else {
      delete (navigator as unknown as Record<string, unknown>).sendBeacon;
    }
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function setSendBeacon(value: unknown): void {
    Object.defineProperty(navigator, "sendBeacon", {
      value,
      configurable: true,
      writable: true,
    });
  }

  describe("sendBeacon transport", () => {
    it("uses navigator.sendBeacon when available with exact URL and JSON payload", () => {
      const sendBeaconMock = jest.fn().mockReturnValue(true);
      setSendBeacon(sendBeaconMock);

      const payload: ClientErrorPayload = {
        digest: "abc-123",
        name: "TypeError",
        message: "Cannot read properties of undefined",
        stack: "TypeError: Cannot read...\n    at Component (app.tsx:10:5)",
        kind: "boundary",
      };

      reportClientError(payload);

      expect(sendBeaconMock).toHaveBeenCalledTimes(1);
      expect(sendBeaconMock).toHaveBeenCalledWith(
        "/api/client-errors",
        JSON.stringify(payload),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("fetch fallback transport", () => {
    it("falls back to fetch with POST, JSON headers, and keepalive when sendBeacon is undefined", () => {
      setSendBeacon(undefined);

      const payload: ClientErrorPayload = {
        name: "ChunkLoadError",
        message: "Loading chunk 42 failed",
        kind: "chunk",
      };

      reportClientError(payload);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith("/api/client-errors", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        keepalive: true,
      });
    });
  });

  describe("failure swallowing", () => {
    it("never throws when JSON.stringify fails on a circular payload", () => {
      const sendBeaconMock = jest.fn().mockReturnValue(true);
      setSendBeacon(sendBeaconMock);

      const circular: Record<string, unknown> = { message: "boom" };
      circular.self = circular;

      expect(() =>
        reportClientError(circular as unknown as ClientErrorPayload),
      ).not.toThrow();
      expect(sendBeaconMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("never throws when navigator.sendBeacon throws", () => {
      const sendBeaconMock = jest.fn(() => {
        throw new Error("sendBeacon failed");
      });
      setSendBeacon(sendBeaconMock);

      expect(() =>
        reportClientError({ message: "beacon error", kind: "unhandled" }),
      ).not.toThrow();
      expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    });

    it("never throws and leaves no unhandled rejection when fetch rejects", async () => {
      setSendBeacon(undefined);
      fetchMock.mockRejectedValueOnce(new Error("network offline"));

      const unhandledRejection = jest.fn();
      process.on("unhandledRejection", unhandledRejection);

      try {
        expect(() =>
          reportClientError({ message: "fetch reject", kind: "unhandled" }),
        ).not.toThrow();

        // Flush microtask and macrotask queues to verify rejection is caught
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(unhandledRejection).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandledRejection);
      }
    });

    it("never throws when fetch throws synchronously", () => {
      setSendBeacon(undefined);
      fetchMock.mockImplementationOnce(() => {
        throw new Error("sync fetch failure");
      });

      expect(() =>
        reportClientError({ message: "sync fetch error" }),
      ).not.toThrow();
    });
  });

  describe("edge cases", () => {
    it("handles a payload with only a message", () => {
      const sendBeaconMock = jest.fn().mockReturnValue(true);
      setSendBeacon(sendBeaconMock);

      reportClientError({ message: "minimal error" });

      expect(sendBeaconMock).toHaveBeenCalledWith(
        "/api/client-errors",
        JSON.stringify({ message: "minimal error" }),
      );
    });

    it("sends a very long stack string without truncation (current behaviour)", () => {
      // Current behaviour: reportClientError does not truncate or redact payloads;
      // any size limits or redaction are the responsibility of the /api/client-errors route.
      const sendBeaconMock = jest.fn().mockReturnValue(true);
      setSendBeacon(sendBeaconMock);

      const longStack = "at fn (file.ts:1:1)\n".repeat(5_000);
      const payload: ClientErrorPayload = {
        message: "deep recursion",
        stack: longStack,
      };

      reportClientError(payload);

      expect(sendBeaconMock).toHaveBeenCalledTimes(1);
      const [, sentBody] = sendBeaconMock.mock.calls[0] as [string, string];
      const parsed = JSON.parse(sentBody) as ClientErrorPayload;
      expect(parsed.stack).toBe(longStack);
      expect(parsed.stack?.length).toBe(longStack.length);
    });
  });
});
