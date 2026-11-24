import {
  createEmbedToken,
  verifyEmbedToken,
} from "./embed-token";

describe("embed tokens", () => {
  const now = 1_700_000_000_000;
  const streamId = "stream-123";

  it("creates and verifies a valid token", () => {
    const token = createEmbedToken(streamId, now);

    expect(verifyEmbedToken(token, streamId, now)).toBe(true);
  });

  it("rejects a token for a different stream", () => {
    const token = createEmbedToken(streamId, now);

    expect(verifyEmbedToken(token, "another-stream", now)).toBe(false);
  });

  it("rejects expired tokens", () => {
    const token = createEmbedToken(streamId, now);

    expect(
      verifyEmbedToken(token, streamId, now + 16 * 60 * 1000),
    ).toBe(false);
  });

  it("rejects malformed tokens", () => {
    expect(verifyEmbedToken("invalid-token", streamId, now)).toBe(false);
    expect(verifyEmbedToken("", streamId, now)).toBe(false);
  });

  it("rejects tokens with a modified signature", () => {
    const token = createEmbedToken(streamId, now);
    const [payload, signature] = token.split(".");
    const modified = `${payload}.${signature}invalid`;

    expect(verifyEmbedToken(modified, streamId, now)).toBe(false);
  });
});
