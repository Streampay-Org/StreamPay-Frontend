import {
  createInMemoryPersistenceStore,
  getStore,
  setStore,
} from "@/app/lib/db";
import {
  _resetAllowlistForTesting,
  checkTokenAllowed,
} from "@/app/lib/token-allowlist";
import * as streamIdModule from "@/app/lib/stream-id";
import type { Stream } from "@/app/types/openapi";
import { createStreamCore } from "./stream-create-core";

jest.mock("@/app/lib/stream-id", () => ({
  ...jest.requireActual("@/app/lib/stream-id"),
  newStreamId: jest.fn(),
}));

jest.mock("@/app/lib/token-allowlist", () => ({
  ...jest.requireActual("@/app/lib/token-allowlist"),
  checkTokenAllowed: jest.fn(),
}));

const VALID_RECIPIENT =
  "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";
const VALID_USDC = `USDC:${VALID_RECIPIENT}`;

const validBody = {
  recipient: VALID_RECIPIENT,
  rate: "100",
  schedule: "month",
};

function existingStream(id: string): Stream {
  return {
    id,
    recipient: VALID_RECIPIENT,
    rate: "50",
    schedule: "month",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    token: "XLM",
  };
}

beforeEach(() => {
  setStore(createInMemoryPersistenceStore(false));
  getStore().streamRepository.streams.clear();
  jest.clearAllMocks();
  _resetAllowlistForTesting();
  jest.mocked(streamIdModule.newStreamId).mockReturnValue("stream-test-id");
  jest.mocked(checkTokenAllowed).mockResolvedValue({ accepted: true });
});

describe("createStreamCore", () => {
  it("returns VALIDATION_ERROR for an empty body", async () => {
    const result = await createStreamCore({}, { dryRun: false });

    expect(result).toMatchObject({
      ok: false,
      status: 422,
      code: "VALIDATION_ERROR",
    });
    if (!result.ok) {
      expect(result.details?.length).toBeGreaterThan(0);
    }
    expect(checkTokenAllowed).not.toHaveBeenCalled();
  });

  it("returns INVALID_TOKEN when token normalisation fails", async () => {
    const result = await createStreamCore(
      { ...validBody, token: "NOT:A:VALID:TOKEN" },
      { dryRun: false },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 422,
      code: "INVALID_TOKEN",
    });
    expect(checkTokenAllowed).not.toHaveBeenCalled();
  });

  it("returns TOKEN_NOT_ALLOWED when the allowlist rejects the token", async () => {
    jest.mocked(checkTokenAllowed).mockResolvedValue({
      accepted: false,
      reason: "Token is not allowed",
    });

    const result = await createStreamCore(
      { ...validBody, token: "XLM" },
      { dryRun: false },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 422,
      code: "TOKEN_NOT_ALLOWED",
      message: "Token is not allowed",
    });
    expect(getStore().streamRepository.streams.size).toBe(0);
  });

  it("persists a draft with the default token and tenant extras", async () => {
    const store = getStore();
    const result = await createStreamCore(validBody, {
      dryRun: false,
      extras: { tenantId: "acme" },
    });

    if (!result.ok) {
      throw new Error(`Expected stream creation to succeed, got ${result.code}`);
    }

    expect(result.stream).toMatchObject({
      status: "draft",
      nextAction: "start",
      token: "XLM",
      tenantId: "acme",
    });
    expect(store.streamRepository.streams.get(result.stream.id)).toEqual(result.stream);
    expect(checkTokenAllowed).toHaveBeenCalledWith("XLM");
  });

  it.each([
    ["token with surrounding whitespace", "  XLM  ", "XLM"],
    ["USDC issuer token", VALID_USDC, VALID_USDC],
  ])("normalises %s before checking the allowlist", async (_label, input, expected) => {
    const result = await createStreamCore(
      { ...validBody, token: input },
      { dryRun: true },
    );

    if (!result.ok) {
      throw new Error(`Expected preview creation to succeed, got ${result.code}`);
    }

    expect(result.stream.token).toBe(expected);
    expect(checkTokenAllowed).toHaveBeenCalledWith(expected);
  });

  it("returns a preview ID without persisting the stream", async () => {
    const store = getStore();
    const initialSize = store.streamRepository.streams.size;

    const result = await createStreamCore(validBody, { dryRun: true });

    if (!result.ok) {
      throw new Error(`Expected preview creation to succeed, got ${result.code}`);
    }

    expect(result.stream.id).toMatch(/^preview-/);
    expect(store.streamRepository.streams.size).toBe(initialSize);
    expect(store.streamRepository.streams.has(result.stream.id)).toBe(false);
  });

  it("retries ID collisions and persists after the third ID attempt", async () => {
    const store = getStore();
    const collisionId = "stream-collision";
    const successId = "stream-success";
    const original = existingStream(collisionId);
    store.streamRepository.streams.set(collisionId, original);
    jest
      .mocked(streamIdModule.newStreamId)
      .mockReturnValueOnce(collisionId)
      .mockReturnValueOnce(collisionId)
      .mockReturnValueOnce(successId);

    const result = await createStreamCore(validBody, { dryRun: false });

    if (!result.ok) {
      throw new Error(`Expected stream creation to succeed, got ${result.code}`);
    }

    expect(result.stream.id).toBe(successId);
    expect(store.streamRepository.streams.get(collisionId)).toEqual(original);
    expect(store.streamRepository.streams.get(successId)).toEqual(result.stream);
    expect(streamIdModule.newStreamId).toHaveBeenCalledTimes(3);
  });

  it("returns ID_GENERATION_FAILED after three collisions", async () => {
    const store = getStore();
    const collisionId = "stream-permanent-collision";
    const original = existingStream(collisionId);
    store.streamRepository.streams.set(collisionId, original);
    jest.mocked(streamIdModule.newStreamId).mockReturnValue(collisionId);

    const result = await createStreamCore(validBody, { dryRun: false });

    expect(result).toMatchObject({
      ok: false,
      status: 500,
      code: "ID_GENERATION_FAILED",
    });
    expect(store.streamRepository.streams.size).toBe(1);
    expect(store.streamRepository.streams.get(collisionId)).toEqual(original);
    expect(streamIdModule.newStreamId).toHaveBeenCalledTimes(3);
  });
});
