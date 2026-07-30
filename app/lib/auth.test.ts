import jwt from "jsonwebtoken";
import { getJwtJwks, signToken, tryAuthenticateRequest } from "./auth";

const TEST_SECRET = "test-secret-at-least-32-characters-long";
const PREVIOUS_SECRET = "previous-secret-at-least-32-characters-long";
const WALLET_ADDRESS = "GDUKMGUGDZQK6Y2VCXWQ3BWYQF6Q3EDL2CIMH6H3K7VKTDH6ZVSTREAM";

describe("auth JWKS and rotation helpers", () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalPreviousSecret = process.env.JWT_PREVIOUS_SECRET;
  const originalKeyId = process.env.JWT_KEY_ID;
  const originalPreviousKeyId = process.env.JWT_PREVIOUS_KEY_ID;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
    delete process.env.JWT_PREVIOUS_SECRET;
    delete process.env.JWT_KEY_ID;
    delete process.env.JWT_PREVIOUS_KEY_ID;
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }

    if (originalPreviousSecret === undefined) {
      delete process.env.JWT_PREVIOUS_SECRET;
    } else {
      process.env.JWT_PREVIOUS_SECRET = originalPreviousSecret;
    }

    if (originalKeyId === undefined) {
      delete process.env.JWT_KEY_ID;
    } else {
      process.env.JWT_KEY_ID = originalKeyId;
    }

    if (originalPreviousKeyId === undefined) {
      delete process.env.JWT_PREVIOUS_KEY_ID;
    } else {
      process.env.JWT_PREVIOUS_KEY_ID = originalPreviousKeyId;
    }
  });

  it("exposes a JWKS document with the active signing key", () => {
    const jwks = getJwtJwks();

    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      kty: "oct",
      alg: "HS256",
      kid: "streampay-current",
    });
  });

  it("includes a previous key when a rotated secret is configured", () => {
    process.env.JWT_PREVIOUS_SECRET = PREVIOUS_SECRET;
    process.env.JWT_PREVIOUS_KEY_ID = "streampay-previous";

    const jwks = getJwtJwks();

    expect(jwks.keys).toHaveLength(2);
    expect(jwks.keys.map((entry) => entry.kid)).toEqual(["streampay-current", "streampay-previous"]);
  });

  it("signs tokens with the active key id and authenticates with the current key", () => {
    const token = signToken(WALLET_ADDRESS);
    const header = jwt.decode(token, { complete: true })?.header as { kid?: string } | undefined;
    const request = new Request("http://localhost", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(header?.kid).toBe("streampay-current");
    expect(tryAuthenticateRequest(request)).toMatchObject({ walletAddress: WALLET_ADDRESS });
  });

  it("authenticates tokens signed with a previous rotated key", () => {
    process.env.JWT_PREVIOUS_SECRET = PREVIOUS_SECRET;
    process.env.JWT_PREVIOUS_KEY_ID = "streampay-previous";
    const token = jwt.sign(
      { sub: WALLET_ADDRESS, iss: "streampay", aud: "streampay-api" },
      PREVIOUS_SECRET,
      { algorithm: "HS256", expiresIn: "15m", header: { kid: "streampay-previous" } },
    );
    const request = new Request("http://localhost", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(tryAuthenticateRequest(request)).toMatchObject({ walletAddress: WALLET_ADDRESS });
  });
});
