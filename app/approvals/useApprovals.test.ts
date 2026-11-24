import { act, renderHook, waitFor } from "@testing-library/react";
import {
  mapVoteErrorMessage,
  normaliseApprovalStatus,
  useApprovals,
} from "./useApprovals";
import type { PendingApproval } from "@/app/lib/org-types";

const OWNER = "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";
const SETTLER = "GSETTLER5IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS";

function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: "appr-1",
    streamId: "stream-ada",
    orgId: "org-acme",
    action: "settle",
    initiatedBy: OWNER,
    approvals: [OWNER],
    requiredCount: 2,
    status: "pending",
    createdAt: "2026-04-10T10:00:00.000Z",
    expiresAt: "2026-04-11T10:00:00.000Z",
    ...overrides,
  };
}

describe("useApprovals helpers", () => {
  it("normalises statuses into pending, approved, or rejected", () => {
    expect(normaliseApprovalStatus("pending")).toBe("pending");
    expect(normaliseApprovalStatus("approved")).toBe("approved");
    expect(normaliseApprovalStatus("rejected")).toBe("rejected");
    expect(normaliseApprovalStatus("expired")).toBe("rejected");
    expect(normaliseApprovalStatus(undefined)).toBe("pending");
  });

  it("maps server error codes to specific human-readable messages", () => {
    expect(mapVoteErrorMessage("APPROVAL_NOT_FOUND", 404)).toMatch(/could not be found/i);
    expect(
      mapVoteErrorMessage("VOTE_FAILED", 409, "Actor has already cast an approval for this record."),
    ).toMatch(/already voted/i);
    expect(
      mapVoteErrorMessage("VOTE_FAILED", 403, "Actor is not a member of this organization."),
    ).toMatch(/not a member/i);
    expect(
      mapVoteErrorMessage("VOTE_FAILED", 403, "Role 'viewer' is not permitted to perform 'settle'."),
    ).toMatch(/role does not have permission/i);
  });
});

describe("useApprovals hook", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("loads and groups approvals by status", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          makeApproval({ id: "appr-p", status: "pending" }),
          makeApproval({ id: "appr-a", status: "approved", approvals: [OWNER, SETTLER] }),
          makeApproval({ id: "appr-r", status: "rejected" }),
        ],
      }),
    }) as jest.Mock;

    const { result } = renderHook(() => useApprovals({ initialWalletAddress: SETTLER }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.pending).toHaveLength(1);
    expect(result.current.approved).toHaveLength(1);
    expect(result.current.rejected).toHaveLength(1);
  });

  it("applies optimistic vote and moves row to approved when thresholdMet is true", async () => {
    const initial = makeApproval({ id: "appr-1", approvals: [OWNER], requiredCount: 2 });
    const updated = makeApproval({
      id: "appr-1",
      approvals: [OWNER, SETTLER],
      requiredCount: 2,
      status: "approved",
    });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [initial] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: updated, meta: { thresholdMet: true } }),
      });
    global.fetch = fetchMock as jest.Mock;

    const { result } = renderHook(() => useApprovals({ initialWalletAddress: SETTLER }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let voteOutcome: Awaited<ReturnType<typeof result.current.vote>> | undefined;
    await act(async () => {
      voteOutcome = await result.current.vote("appr-1");
    });

    expect(voteOutcome?.ok).toBe(true);
    expect(voteOutcome?.thresholdMet).toBe(true);
    expect(result.current.pending).toHaveLength(0);
    expect(result.current.approved).toHaveLength(1);
    expect(result.current.approved[0].approvals).toEqual([OWNER, SETTLER]);
  });

  it("rolls back optimistic update on 403/404/409 server error", async () => {
    const initial = makeApproval({ id: "appr-1", approvals: [OWNER], requiredCount: 2 });

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [initial] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: "VOTE_FAILED",
            message: "Actor has already cast an approval for this record.",
          },
        }),
      }) as jest.Mock;

    const { result } = renderHook(() => useApprovals({ initialWalletAddress: SETTLER }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let voteOutcome: Awaited<ReturnType<typeof result.current.vote>> | undefined;
    await act(async () => {
      voteOutcome = await result.current.vote("appr-1");
    });

    expect(voteOutcome?.ok).toBe(false);
    expect(voteOutcome?.httpStatus).toBe(409);
    expect(voteOutcome?.errorMessage).toMatch(/already voted/i);
    // Rolled back to original 1 vote
    expect(result.current.pending[0].approvals).toEqual([OWNER]);
  });

  it("sends only one request when vote is called concurrently (double-click)", async () => {
    const initial = makeApproval({ id: "appr-1", approvals: [OWNER], requiredCount: 2 });

    let resolveVote!: (value: unknown) => void;
    const votePromise = new Promise((resolve) => {
      resolveVote = resolve;
    });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [initial] }),
      })
      .mockReturnValueOnce(votePromise);
    global.fetch = fetchMock as jest.Mock;

    const { result } = renderHook(() => useApprovals({ initialWalletAddress: SETTLER }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let firstPromise!: Promise<unknown>;
    let secondPromise!: Promise<unknown>;
    act(() => {
      firstPromise = result.current.vote("appr-1");
      secondPromise = result.current.vote("appr-1");
    });

    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 GET + 1 POST

    resolveVote({
      ok: true,
      json: async () => ({
        data: { ...initial, approvals: [OWNER, SETTLER], status: "approved" },
        meta: { thresholdMet: true },
      }),
    });

    await act(async () => {
      await Promise.all([firstPromise, secondPromise]);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
