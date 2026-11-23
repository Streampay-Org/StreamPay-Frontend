import {
  createStreamPayClient,
  StreamPayClient,
  StreamPaySdkError,
  type EventSourceLike,
} from "./index";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
    statusText: status >= 400 ? "Error" : "OK",
  });
}

class FakeEventSource implements EventSourceLike {
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  close(): void {
    this.closed = true;
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, data: unknown): void {
    const listener = this.listeners.get(type);
    listener?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }

  emitRawEvent(type: string, data: string): void {
    const listener = this.listeners.get(type);
    listener?.({ data } as MessageEvent<string>);
  }

  emitRawMessage(data: string): void {
    const event = { data } as MessageEvent<string>;
    this.onmessage?.(event);
  }

  emitOpen(): void {
    this.onopen?.(new Event("open"));
  }

  emitError(): void {
    this.onerror?.(new Event("error"));
  }
}

describe("StreamPayClient", () => {
  it("sends typed REST requests with auth and correlation headers", async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse({
        streams: [{ id: "stream-1", recipient: "Ada", rate: "10 XLM/month", status: "active" }],
        meta: { hasNext: false, nextCursor: null, total: 1 },
        links: { self: "/api/v2/streams" },
      }),
    );
    const client = new StreamPayClient({
      baseUrl: "https://api.streampay.test",
      fetchFn,
      requestIdFactory: () => "req-test",
      token: "partner-token",
    });

    const result = await client.listStreams({ limit: 10, status: "active" });

    expect(result.streams[0].id).toBe("stream-1");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.streampay.test/api/v2/streams?limit=10&status=active",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    const headers = fetchFn.mock.calls[0][1].headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer partner-token");
    expect(headers.get("x-request-id")).toBe("req-test");
  });

  it("rejects malformed pagination cursors before making requests", async () => {
    const fetchFn = jest.fn();
    const client = new StreamPayClient({
      baseUrl: "https://api.streampay.test",
      fetchFn,
    });

    await expect(client.listActivity({ cursor: " bad cursor " })).rejects.toThrow(
      "Pagination cursor must be a trimmed string",
    );
    await expect(client.listStreams({ cursor: "<script>" })).rejects.toThrow(
      "Pagination cursor contains invalid characters",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("adds idempotency keys and JSON bodies for stream creation", async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse({
        id: "stream-2", recipient: "Kemi", rate: "5 XLM/week", status: "draft",
      }),
    );
    const client = new StreamPayClient({ baseUrl: "https://api.streampay.test", fetchFn });

    await client.createStream(
      { recipient: "Kemi", rate: "5", schedule: "week" },
      { idempotencyKey: "create-kemi" },
    );

    const init = fetchFn.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ recipient: "Kemi", rate: "5", schedule: "week" }));
    expect((init.headers as Headers).get("Idempotency-Key")).toBe("create-kemi");
  });

  it("normalizes API error envelopes", async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "STREAM_NOT_FOUND",
            message: "Stream not found",
            request_id: "req-api",
          },
        },
        404,
      ),
    );
    const client = new StreamPayClient({ baseUrl: "https://api.streampay.test", fetchFn });

    await expect(client.getStream("missing")).rejects.toMatchObject<Partial<StreamPaySdkError>>({
      code: "STREAM_NOT_FOUND",
      message: "Stream not found",
      requestId: "req-api",
      status: 404,
    });
  });

  it("redacts sensitive fields from error-envelope details (request-body echo)", async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid payload",
            request_id: "req-api",
            details: {
              request: {
                recipient: "GABC",
                rate: "10",
                token: "partner-token",
                secret: "s3cr3t",
              },
              fieldErrors: { email: "invalid" },
            },
          },
        },
        422,
      ),
    );
    const client = new StreamPayClient({ baseUrl: "https://api.streampay.test", fetchFn });

    try {
      await client.createStream({ recipient: "GABC", rate: "10", schedule: "week" });
      throw new Error("expected createStream to reject");
    } catch (err) {
      const sdkError = err as StreamPaySdkError;
      expect(sdkError.code).toBe("VALIDATION_ERROR");
      expect(sdkError.requestId).toBe("req-api");
      const details = sdkError.details as {
        request: Record<string, unknown>;
        fieldErrors: Record<string, unknown>;
      };
      expect(details.request.token).toBe("[REDACTED]");
      expect(details.request.secret).toBe("[REDACTED]");
      expect(details.request.recipient).toBe("GABC");
      expect(details.fieldErrors.email).toBe("invalid");
    }
  });

  it("redacts sensitive fields from non-envelope error bodies", async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse(
        {
          message: "backend rejected",
          privateKey: `S${"A".repeat(55)}`,
          nested: { authorization: "Bearer leaked" },
        },
        500,
      ),
    );
    const client = new StreamPayClient({ baseUrl: "https://api.streampay.test", fetchFn });

    try {
      await client.listStreams();
      throw new Error("expected listStreams to reject");
    } catch (err) {
      const sdkError = err as StreamPaySdkError;
      expect(sdkError.code).toBe("HTTP_ERROR");
      const details = sdkError.details as Record<string, unknown>;
      expect(details.privateKey).toBe("[REDACTED]");
      expect(details.nested).toEqual({ authorization: "[REDACTED]" });
      expect(details.message).toBe("backend rejected");
    }
  });

  it("redacts Stellar secret seeds inside error diagnostics regardless of key", async () => {
    const seed = `S${"A".repeat(55)}`;
    const fetchFn = jest.fn().mockResolvedValue(
      jsonResponse({ value: seed, keep: "ok" }, 500),
    );
    const client = new StreamPayClient({ baseUrl: "https://api.streampay.test", fetchFn });

    try {
      await client.listStreams();
      throw new Error("expected listStreams to reject");
    } catch (err) {
      const sdkError = err as StreamPaySdkError;
      const details = sdkError.details as Record<string, unknown>;
      expect(details.value).toBe("[REDACTED]");
      expect(details.keep).toBe("ok");
    }
  });

  it("wraps SSE stream update and settlement events", () => {
    const source = new FakeEventSource();
    const factory = jest.fn(() => source);
    const onUpdate = jest.fn();
    const onSettlement = jest.fn();
    const client = new StreamPayClient({
      baseUrl: "https://api.streampay.test/",
      eventSourceFactory: factory,
      token: "partner-token",
    });

    const subscription = client.subscribeToStream("stream-ada", { onSettlement, onUpdate });

    expect(subscription.url).toBe(
      "https://api.streampay.test/api/streams/events?streamId=stream-ada&token=partner-token",
    );
    source.emit("stream:updated", { id: "stream-ada", status: "active" });
    source.emit("settle:finished", { id: "stream-ada", status: "ended" });

    expect(onUpdate).toHaveBeenCalledWith({ id: "stream-ada", status: "active" });
    expect(onSettlement).toHaveBeenCalledWith({ id: "stream-ada", status: "ended" });

    subscription.close();
    expect(source.closed).toBe(true);
  });

  it("prevents duplicate SDK event subscriptions by sharing underlying EventSource", () => {
    const source = new FakeEventSource();
    const factory = jest.fn(() => source);
    const client = new StreamPayClient({
      baseUrl: "https://api.streampay.test",
      eventSourceFactory: factory,
    });

    const sub1OnUpdate = jest.fn();
    const sub2OnUpdate = jest.fn();

    // Call subscribe twice for the same streamId
    const sub1 = client.subscribeToStream("stream-dedup", { onUpdate: sub1OnUpdate });
    const sub2 = client.subscribeToStream("stream-dedup", { onUpdate: sub2OnUpdate });

    // Factory should have been invoked exactly ONCE
    expect(factory).toHaveBeenCalledTimes(1);

    // Both subscribers should receive events
    source.emit("stream:updated", { id: "stream-dedup", status: "active" });
    expect(sub1OnUpdate).toHaveBeenCalledWith({ id: "stream-dedup", status: "active" });
    expect(sub2OnUpdate).toHaveBeenCalledWith({ id: "stream-dedup", status: "active" });

    // Closing first subscription should NOT close the underlying EventSource
    sub1.close();
    expect(source.closed).toBe(false);

    // Event still flows to remaining subscriber
    source.emit("stream:updated", { id: "stream-dedup", status: "paused" });
    expect(sub2OnUpdate).toHaveBeenCalledWith({ id: "stream-dedup", status: "paused" });
    expect(sub1OnUpdate).toHaveBeenCalledTimes(1); // sub1 did not receive the second event

    // Closing the last subscription cleans up and closes the EventSource
    sub2.close();
    expect(source.closed).toBe(true);
  });

  it("handles idempotent close calls safely without errors", () => {
    const source = new FakeEventSource();
    const factory = jest.fn(() => source);
    const client = new StreamPayClient({
      baseUrl: "https://api.streampay.test",
      eventSourceFactory: factory,
    });

    const sub = client.subscribeToStream("stream-idem");
    expect(() => {
      sub.close();
      sub.close();
      sub.close();
    }).not.toThrow();
    expect(source.closed).toBe(true);
  });

  it("isolates handler errors so faulty listener does not block others", () => {
    const source = new FakeEventSource();
    const factory = jest.fn(() => source);
    const client = new StreamPayClient({
      baseUrl: "https://api.streampay.test",
      eventSourceFactory: factory,
    });

    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const buggyHandler = jest.fn(() => {
      throw new Error("handler crash");
    });
    const healthyHandler = jest.fn();

    const sub1 = client.subscribeToStream("stream-err", { onUpdate: buggyHandler });
    const sub2 = client.subscribeToStream("stream-err", { onUpdate: healthyHandler });

    source.emit("stream:updated", { id: "stream-err", status: "active" });

    expect(buggyHandler).toHaveBeenCalled();
    expect(healthyHandler).toHaveBeenCalledWith({ id: "stream-err", status: "active" });

    sub1.close();
    sub2.close();
    consoleSpy.mockRestore();
  });

  it("validates required ids, stream fields, and the base URL", async () => {
    expect(() => new StreamPayClient({ baseUrl: "  " })).toThrow(
      "StreamPayClient requires a non-empty baseUrl",
    );

    const fetchFn = jest.fn();
    const client = new StreamPayClient({
      baseUrl: "https://api.streampay.test",
      fetchFn,
      eventSourceFactory: () => new FakeEventSource(),
    });

    await expect(client.getStream(" ")).rejects.toThrow("stream id is required");
    await expect(client.deleteStream("")).rejects.toThrow("stream id is required");
    expect(() => client.subscribeToStream(" ")).toThrow("stream id is required");
    await expect(
      client.createStream({ recipient: " ", rate: "10", schedule: "month" }),
    ).rejects.toThrow("recipient, rate, and schedule are required");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("keeps activity pages and handles empty delete responses", async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: "event-1", type: "created", timestamp: "now" }] }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new StreamPayClient({
      baseUrl: "https://api.streampay.test",
      fetchFn,
    });

    await expect(client.listActivity({ streamId: "stream-1" })).resolves.toMatchObject({
      data: [{ id: "event-1" }],
    });
    await expect(client.deleteStream("stream-1")).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenLastCalledWith(
      "https://api.streampay.test/api/v2/streams/stream-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("parses non-JSON errors and falls back to response request IDs", async () => {
    const fetchFn = jest
      .fn()
      .mockResolvedValueOnce(
        new Response("upstream unavailable", {
          headers: { "content-type": "text/plain" },
          status: 502,
          statusText: "Bad Gateway",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { details: { field: "rate" } } },
          422,
          { "x-request-id": "req-header" },
        ),
      );
    const client = new StreamPayClient({
      baseUrl: "https://api.streampay.test",
      fetchFn,
      requestIdFactory: () => "req-fallback",
    });

    await expect(client.listActivity()).rejects.toMatchObject({
      code: "HTTP_ERROR",
      details: "upstream unavailable",
      status: 502,
    });
    await expect(client.listActivity()).rejects.toMatchObject({
      code: "UNKNOWN_ERROR",
      requestId: "req-header",
      status: 422,
    });
  });

  it("dispatches SSE lifecycle events and reports malformed payloads", () => {
    const source = new FakeEventSource();
    const onOpen = jest.fn();
    const onError = jest.fn();
    const onMessage = jest.fn();
    const onUpdate = jest.fn();
    const onSettlement = jest.fn();
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    source.close = jest.fn(() => {
      throw new Error("close failed");
    });
    const client = new StreamPayClient({
      baseUrl: "https://api.streampay.test",
      eventSourceFactory: () => source,
    });
    const subscription = client.subscribeToStream("stream-lifecycle", {
      onOpen,
      onError,
      onMessage,
      onUpdate,
      onSettlement,
    });
    const failingSubscription = client.subscribeToStream("stream-lifecycle", {
      onError: () => {
        throw new Error("error handler failed");
      },
      onSettlement: () => {
        throw new Error("settlement handler failed");
      },
    });

    source.emitOpen();
    source.emitError();
    source.emitRawMessage("hello");
    source.emit("stream:updated", { id: "stream-lifecycle", status: "active" });
    source.emit("settle:finished", { id: "stream-lifecycle", status: "ended" });
    source.emitRawEvent("stream:updated", "{");
    source.emitRawEvent("settle:finished", "{");

    expect(onOpen).toHaveBeenCalledWith(expect.any(Event));
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onMessage).toHaveBeenCalledWith({ data: "hello" });
    expect(onUpdate).toHaveBeenCalledWith({ id: "stream-lifecycle", status: "active" });
    expect(onSettlement).toHaveBeenCalledWith({ id: "stream-lifecycle", status: "ended" });
    subscription.close();
    failingSubscription.close();
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("constructs clients through the exported factory", () => {
    expect(createStreamPayClient({ baseUrl: "https://api.streampay.test" })).toBeInstanceOf(
      StreamPayClient,
    );
  });
});
