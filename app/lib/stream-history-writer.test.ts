import { randomUUID } from "crypto";
import { getStore } from "@/app/lib/db";
import { appendStreamHistoryEvent } from "./stream-history-writer";

jest.mock("crypto", () => ({
  randomUUID: jest.fn(),
}));

jest.mock("@/app/lib/db", () => ({
  getStore: jest.fn(),
}));

const mockedRandomUUID = randomUUID as jest.MockedFunction<typeof randomUUID>;
const mockedGetStore = getStore as jest.MockedFunction<typeof getStore>;

describe("appendStreamHistoryEvent", () => {
  const appendMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockedRandomUUID.mockReturnValue("11111111-2222-4333-8444-555555555555");
    mockedGetStore.mockReturnValue({
      streamHistory: {
        append: appendMock,
      },
    } as unknown as ReturnType<typeof getStore>);
  });

  it("appends all fields and truncates a full G-address actor wallet to 6 characters", () => {
    const fullWallet = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

    appendStreamHistoryEvent({
      streamId: "stream-123",
      type: "started",
      fromStatus: "draft",
      toStatus: "active",
      at: "2026-06-01T12:00:00.000Z",
      actorWallet: fullWallet,
      txHash: "0xabc123def456",
      amountRaw: "120 XLM",
    });

    expect(mockedRandomUUID).toHaveBeenCalledTimes(1);
    expect(mockedGetStore).toHaveBeenCalledTimes(1);
    expect(appendMock).toHaveBeenCalledTimes(1);

    const appendedEntry = appendMock.mock.calls[0][0];
    expect(appendedEntry).toEqual({
      id: "11111111-2222-4333-8444-555555555555",
      streamId: "stream-123",
      type: "started",
      fromStatus: "draft",
      toStatus: "active",
      at: "2026-06-01T12:00:00.000Z",
      actor: "GAAZI4",
      txHash: "0xabc123def456",
      amountRaw: "120 XLM",
    });
    expect(appendedEntry.actor).toHaveLength(6);
    expect(JSON.stringify(appendedEntry)).not.toContain(fullWallet);
  });

  it.each([
    { label: "null", actorWallet: null },
    { label: "undefined", actorWallet: undefined },
    { label: "empty string", actorWallet: "" },
  ])(
    "sets actor to undefined when actorWallet is $label and passes through optional fields",
    ({ actorWallet }) => {
      appendStreamHistoryEvent({
        streamId: "stream-456",
        type: "paused",
        fromStatus: "active",
        toStatus: "paused",
        at: "2026-06-02T08:30:00.000Z",
        actorWallet,
        txHash: "tx-hash-789",
        amountRaw: "50 USDC",
      });

      expect(appendMock).toHaveBeenCalledTimes(1);
      expect(appendMock).toHaveBeenCalledWith({
        id: "11111111-2222-4333-8444-555555555555",
        streamId: "stream-456",
        type: "paused",
        fromStatus: "active",
        toStatus: "paused",
        at: "2026-06-02T08:30:00.000Z",
        actor: undefined,
        txHash: "tx-hash-789",
        amountRaw: "50 USDC",
      });
    },
  );

  it("preserves undefined for omitted optional fields", () => {
    appendStreamHistoryEvent({
      streamId: "stream-789",
      type: "created",
      toStatus: "draft",
      at: "2026-06-03T00:00:00.000Z",
    });

    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(appendMock).toHaveBeenCalledWith({
      id: "11111111-2222-4333-8444-555555555555",
      streamId: "stream-789",
      type: "created",
      fromStatus: undefined,
      toStatus: "draft",
      at: "2026-06-03T00:00:00.000Z",
      actor: undefined,
      txHash: undefined,
      amountRaw: undefined,
    });
  });
});
