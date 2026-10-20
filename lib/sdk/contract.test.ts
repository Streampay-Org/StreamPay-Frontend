import streamCreatePact from "../../app/api/v2/streams/__tests__/contracts/fixtures/stream-create.json";
import streamListPact from "../../app/api/v2/streams/__tests__/contracts/fixtures/stream-list.json";
import {
  StreamPayClient,
  type StreamPayStream,
  type StreamPayStreamList,
} from "./index";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

const listBody = streamListPact.interactions[0].response.body as {
  streams: StreamPayStream[];
};
const createBody = streamCreatePact.interactions[0].response.body as StreamPayStream;

describe("SDK v2 stream Pact contracts", () => {
  it("returns streams from the stream-list Pact body and warns once for data", async () => {
    const onDiagnostic = jest.fn();
    const client = new StreamPayClient({
      baseUrl: "https://api.streampay.test",
      fetchFn: jest.fn().mockResolvedValue(jsonResponse(listBody)),
      onDiagnostic,
    });

    const page = await client.listStreams();
    expect(page.streams[0].id).toBe("stream_abc123");

    // @ts-expect-error The compatibility getter is runtime-only and deprecated.
    const oldData: StreamPayStream[] = page.data;
    const runtimePage = page as StreamPayStreamList & {
      readonly data: StreamPayStream[];
    };
    expect(oldData).toBe(page.streams);
    expect(runtimePage.data).toBe(page.streams);
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("listStreams().data is deprecated"),
    );
  });

  it("returns the bare stream from the stream-create Pact body", async () => {
    const client = new StreamPayClient({
      baseUrl: "https://api.streampay.test",
      fetchFn: jest.fn().mockResolvedValue(jsonResponse(createBody, 201)),
    });

    const stream = await client.createStream({
      recipient: createBody.recipient,
      rate: createBody.rate,
      schedule: "month",
    });

    expect(stream.id).toBe("stream_abc123");
    expect(stream).not.toHaveProperty("data");
  });

  it.each(["cancelled", "archived"] as const)(
    "preserves the %s status value",
    async (status) => {
      const stream = {
        id: "stream-status",
        recipient: "GABC",
        rate: "120",
        status,
      } satisfies StreamPayStream;
      const client = new StreamPayClient({
        baseUrl: "https://api.streampay.test",
        fetchFn: jest.fn().mockResolvedValue(jsonResponse(stream)),
      });

      await expect(
        client.createStream({
          recipient: stream.recipient,
          rate: stream.rate,
          schedule: "month",
        }),
      ).resolves.toMatchObject({ status });
    },
  );

  it("returns data from the get-stream response envelope", async () => {
    const stream = {
      id: "stream-get",
      recipient: "GABC",
      rate: "120",
      status: "withdrawn",
    } satisfies StreamPayStream;
    const client = new StreamPayClient({
      baseUrl: "https://api.streampay.test",
      fetchFn: jest.fn().mockResolvedValue(
        jsonResponse({
          ...stream,
          data: stream,
          links: { self: "/api/v2/streams/stream-get" },
        }),
      ),
    });

    await expect(client.getStream(stream.id)).resolves.toEqual(stream);
  });
});
