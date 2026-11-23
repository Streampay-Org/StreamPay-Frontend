/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react";
import { useResolvedRecipient } from "./useResolvedRecipient";
import {
  FederationError,
  resolveFederationAddress,
  type FederationRecord,
} from "../utils/federation";

jest.mock("../utils/federation", () => {
  const actual = jest.requireActual("../utils/federation");
  return {
    ...actual,
    resolveFederationAddress: jest.fn(),
  };
});

const mockedResolve = resolveFederationAddress as jest.MockedFunction<
  typeof resolveFederationAddress
>;

const VALID_G_ALICE =
  "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZLPXE";
const VALID_G_BOB =
  "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGYWDEAVQBMJ7WGNB55IVJV";

describe("useResolvedRecipient", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedResolve.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns idle for empty or whitespace input without calling federation", () => {
    const { result, rerender } = renderHook(
      ({ val }) => useResolvedRecipient(val),
      { initialProps: { val: "" } },
    );

    expect(result.current).toEqual({ status: "idle" });

    rerender({ val: "   " });
    expect(result.current).toEqual({ status: "idle" });
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it("short-circuits immediately for a valid Stellar G address with no network call", () => {
    const { result } = renderHook(() => useResolvedRecipient(VALID_G_ALICE));

    expect(result.current).toEqual({
      status: "resolved",
      address: VALID_G_ALICE,
    });
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it("returns an error immediately for malformed federation addresses containing '*'", () => {
    const { result } = renderHook(() => useResolvedRecipient("alice*"));

    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/federation address/i);
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it("debounces and resolves a valid federation address", async () => {
    mockedResolve.mockResolvedValueOnce({
      stellar_address: "alice*example.com",
      account_id: VALID_G_ALICE,
    });

    const { result } = renderHook(() =>
      useResolvedRecipient("alice*example.com", { debounceMs: 250 }),
    );

    expect(result.current).toEqual({ status: "loading" });
    expect(mockedResolve).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(250);
      await Promise.resolve();
    });

    expect(mockedResolve).toHaveBeenCalledTimes(1);
    expect(mockedResolve).toHaveBeenCalledWith("alice*example.com");
    expect(result.current).toEqual({
      status: "resolved",
      address: VALID_G_ALICE,
    });
  });

  it("resolves federation addresses with uppercase domains", async () => {
    mockedResolve.mockResolvedValueOnce({
      stellar_address: "alice*example.com",
      account_id: VALID_G_ALICE,
    });

    const { result } = renderHook(() =>
      useResolvedRecipient("alice*EXAMPLE.COM", { debounceMs: 100 }),
    );

    await act(async () => {
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });

    expect(mockedResolve).toHaveBeenCalledWith("alice*EXAMPLE.COM");
    expect(result.current).toEqual({
      status: "resolved",
      address: VALID_G_ALICE,
    });
  });

  it("surfaces required memo returned by the federation server", async () => {
    mockedResolve.mockResolvedValueOnce({
      stellar_address: "alice*example.com",
      account_id: VALID_G_ALICE,
      memo_type: "id",
      memo: "123456",
    });

    const { result } = renderHook(() =>
      useResolvedRecipient("alice*example.com", { debounceMs: 100 }),
    );

    await act(async () => {
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });

    expect(result.current).toEqual({
      status: "resolved",
      address: VALID_G_ALICE,
      memo: { type: "id", value: "123456" },
    });
  });

  it("returns error state on NOT_FOUND federation error", async () => {
    mockedResolve.mockRejectedValueOnce(
      new FederationError(
        'Federation address "nobody*example.com" was not found',
        "NOT_FOUND",
      ),
    );

    const { result } = renderHook(() =>
      useResolvedRecipient("nobody*example.com", { debounceMs: 100 }),
    );

    await act(async () => {
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });

    expect(result.current).toEqual({
      status: "error",
      error: 'Federation address "nobody*example.com" was not found',
    });
  });

  it("returns error state on federation timeout / network error", async () => {
    mockedResolve.mockRejectedValueOnce(
      new FederationError(
        'Could not reach federation server for "slow.example.com"',
        "NETWORK_ERROR",
      ),
    );

    const { result } = renderHook(() =>
      useResolvedRecipient("alice*slow.example.com", { debounceMs: 100 }),
    );

    await act(async () => {
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });

    expect(result.current).toEqual({
      status: "error",
      error: 'Could not reach federation server for "slow.example.com"',
    });
  });

  it("ignores stale responses when input changes rapidly", async () => {
    let resolveAlice!: (rec: FederationRecord) => void;
    let resolveBob!: (rec: FederationRecord) => void;

    mockedResolve
      .mockImplementationOnce(
        () =>
          new Promise<FederationRecord>((res) => {
            resolveAlice = res;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<FederationRecord>((res) => {
            resolveBob = res;
          }),
      );

    const { result, rerender } = renderHook(
      ({ val }) => useResolvedRecipient(val, { debounceMs: 100 }),
      { initialProps: { val: "alice*example.com" } },
    );

    // Trigger first request for alice
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(mockedResolve).toHaveBeenCalledWith("alice*example.com");

    // User edits input to bob before alice resolves
    rerender({ val: "bob*example.com" });
    expect(result.current.status).toBe("loading");

    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(mockedResolve).toHaveBeenCalledWith("bob*example.com");

    // Bob resolves first
    await act(async () => {
      resolveBob({
        stellar_address: "bob*example.com",
        account_id: VALID_G_BOB,
      });
      await Promise.resolve();
    });

    expect(result.current).toEqual({
      status: "resolved",
      address: VALID_G_BOB,
    });

    // Stale alice response arrives later and must be ignored
    await act(async () => {
      resolveAlice({
        stellar_address: "alice*example.com",
        account_id: VALID_G_ALICE,
      });
      await Promise.resolve();
    });

    expect(result.current).toEqual({
      status: "resolved",
      address: VALID_G_BOB,
    });
  });
});
