import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getJwtSecret,
  INSECURE_DEV_JWT_SECRET,
} from "@/app/lib/auth";

const EMBED_TOKEN_TTL_SECONDS = 15 * 60;
const MAX_STREAM_ID_LENGTH = 256;

type EmbedTokenPayload = {
  streamId: string;
  exp: number;
};

function getSigningSecret(): string {
  const secret = getJwtSecret();

  // Never allow the development fallback to sign production embed tokens.
  if (
    process.env.NODE_ENV === "production" &&
    secret === INSECURE_DEV_JWT_SECRET
  ) {
    throw new Error("A secure JWT_SECRET is required for embed tokens");
  }

  return secret;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
}

export function createEmbedToken(
  streamId: string,
  now = Date.now(),
): string {
  if (
    typeof streamId !== "string" ||
    !streamId.trim() ||
    streamId.length > MAX_STREAM_ID_LENGTH
  ) {
    throw new Error("Invalid stream ID");
  }

  const payload: EmbedTokenPayload = {
    streamId,
    exp: Math.floor(now / 1000) + EMBED_TOKEN_TTL_SECONDS,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );

  const signature = sign(encodedPayload, getSigningSecret());

  return `${encodedPayload}.${signature}`;
}

export function verifyEmbedToken(
  token: string,
  streamId: string,
  now = Date.now(),
): boolean {
  try {
    if (
      typeof token !== "string" ||
      token.length > 2048 ||
      typeof streamId !== "string" ||
      !streamId.trim() ||
      streamId.length > MAX_STREAM_ID_LENGTH
    ) {
      return false;
    }

    const parts = token.split(".");
    if (parts.length !== 2) return false;

    const [encodedPayload, providedSignature] = parts;

    if (!encodedPayload || !providedSignature) return false;

    const expectedSignature = sign(encodedPayload, getSigningSecret());

    const expected = Buffer.from(expectedSignature, "base64url");
    const provided = Buffer.from(providedSignature, "base64url");

    if (
      expected.length !== provided.length ||
      !timingSafeEqual(expected, provided)
    ) {
      return false;
    }

    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as EmbedTokenPayload;

    return (
      payload.streamId === streamId &&
      Number.isSafeInteger(payload.exp) &&
      payload.exp > Math.floor(now / 1000)
    );
  } catch {
    return false;
  }
}