/**
 * @jest-environment node
 *
 * Unit tests for the stream list keyset cursor helpers.
 */

import {
  decodeStreamCursor,
  encodeStreamCursor,
  InvalidStreamCursorError,
  isAfterCursor,
} from "@/app/lib/stream-cursor";

describe("encodeStreamCursor / decodeStreamCursor", () => {
  it("round-trips a keyset position", () => {
    const cursor = { createdAt: "2026-01-01T00:00:00.000Z", id: "stream-abc" };
    expect(decodeStreamCursor(encodeStreamCursor(cursor))).toEqual(cursor);
  });

  it("rejects an empty cursor", () => {
    expect(() => decodeStreamCursor("")).toThrow(InvalidStreamCursorError);
  });

  it("rejects text that is not base64", () => {
    expect(() => decodeStreamCursor("not-base64")).toThrow(InvalidStreamCursorError);
  });

  it("rejects base64 that does not decode to a usable cursor", () => {
    const cursor = Buffer.from("garbage").toString("base64");
    expect(() => decodeStreamCursor(cursor)).toThrow(InvalidStreamCursorError);
  });

  it("rejects a legacy cursor for an unknown stream", () => {
    const cursor = Buffer.from("stream-unknown").toString("base64");
    expect(() => decodeStreamCursor(cursor, { resolveLegacyId: () => null })).toThrow(
      InvalidStreamCursorError,
    );
  });

  it("accepts a legacy plain-id cursor while the stream still exists", () => {
    const cursor = Buffer.from("stream-known").toString("base64");
    expect(
      decodeStreamCursor(cursor, {
        resolveLegacyId: (id) => ({ createdAt: "2026-01-01T00:00:00.000Z", id }),
      }),
    ).toEqual({ createdAt: "2026-01-01T00:00:00.000Z", id: "stream-known" });
  });

  it("rejects a legacy cursor that does not look like a stream id", () => {
    const cursor = Buffer.from("not-a-stream").toString("base64");
    expect(() => decodeStreamCursor(cursor, { resolveLegacyId: () => null })).toThrow(
      InvalidStreamCursorError,
    );
  });
});

describe("isAfterCursor", () => {
  const cursor = { createdAt: "2026-01-02T00:00:00.000Z", id: "stream-b" };

  it("is false for a row created before the cursor", () => {
    expect(
      isAfterCursor({ createdAt: "2026-01-01T00:00:00.000Z", id: "stream-z" }, cursor),
    ).toBe(false);
  });

  it("is false for the cursor row itself", () => {
    expect(isAfterCursor(cursor, cursor)).toBe(false);
  });

  it("is true for a row created after the cursor", () => {
    expect(
      isAfterCursor({ createdAt: "2026-01-03T00:00:00.000Z", id: "stream-a" }, cursor),
    ).toBe(true);
  });

  it("breaks ties on the id", () => {
    expect(isAfterCursor({ createdAt: cursor.createdAt, id: "stream-c" }, cursor)).toBe(true);
    expect(isAfterCursor({ createdAt: cursor.createdAt, id: "stream-a" }, cursor)).toBe(false);
  });
});