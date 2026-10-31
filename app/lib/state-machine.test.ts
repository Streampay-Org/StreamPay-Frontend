import { allowedActions, nextActionFor, transition } from "./state-machine";
import { StreamStatus, StreamAction } from "@/app/types/openapi";
import * as fc from "fast-check";

describe("Stream State Machine", () => {
  it("matches the complete checked-in status/action matrix", () => {
    const expected: Record<StreamStatus, Record<StreamAction, StreamStatus | null>> = {
      draft: {
        start: "active",
        pause: null,
        stop: "ended",
        settle: null,
        withdraw: null,
        cancel: null,
      },
      active: {
        start: "active",
        pause: "paused",
        stop: "ended",
        settle: "ended",
        withdraw: null,
        cancel: "cancelled",
      },
      paused: {
        start: "active",
        pause: "paused",
        stop: "ended",
        settle: "ended",
        withdraw: null,
        cancel: "cancelled",
      },
      ended: {
        start: null,
        pause: null,
        stop: "ended",
        settle: "ended",
        withdraw: "withdrawn",
        cancel: null,
      },
      withdrawn: {
        start: null,
        pause: null,
        stop: null,
        settle: null,
        withdraw: "withdrawn",
        cancel: null,
      },
      cancelled: {
        start: null,
        pause: null,
        stop: null,
        settle: null,
        withdraw: null,
        cancel: null,
      },
    };

    for (const status of Object.keys(expected) as StreamStatus[]) {
      for (const action of Object.keys(expected[status]) as StreamAction[]) {
        const result = transition(status, action);
        const nextStatus = expected[status][action];
        if (nextStatus === null) {
          expect(result).toEqual({
            ok: false,
            code: "ILLEGAL_TRANSITION",
            error: `Action '${action}' is illegal for a stream in '${status}' state.`,
          });
        } else {
          expect(result).toEqual({ ok: true, nextStatus });
        }
      }
    }
  });

  it("returns allowed actions in transition-table order", () => {
    expect(allowedActions("paused")).toEqual(["start", "stop", "settle", "cancel", "pause"]);
  });

  it("derives next actions from the table", () => {
    expect(nextActionFor("draft")).toBe("start");
    expect(nextActionFor("active")).toBe("pause");
    expect(nextActionFor("paused")).toBe("start");
    expect(nextActionFor("ended")).toBe("withdraw");
    expect(nextActionFor("withdrawn")).toBeUndefined();
    expect(nextActionFor("cancelled")).toBeUndefined();
  });

  describe("Legal Transitions", () => {
    const cases: [StreamStatus, StreamAction, StreamStatus][] = [
      ["draft", "start", "active"],
      ["draft", "stop", "ended"],
      ["active", "pause", "paused"],
      ["active", "stop", "ended"],
      ["active", "settle", "ended"],
      ["active", "cancel", "cancelled"],
      ["paused", "start", "active"],
      ["paused", "stop", "ended"],
      ["paused", "cancel", "cancelled"],
      ["ended", "withdraw", "withdrawn"],
    ];

    test.each(cases)("from %s, action %s should lead to %s", (current, action, expected) => {
      const result = transition(current, action);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.nextStatus).toBe(expected);
      }
    });
  });

  describe("Idempotent Actions", () => {
    const cases: [StreamStatus, StreamAction][] = [
      ["active", "start"],
      ["paused", "pause"],
      ["ended", "stop"],
      ["ended", "settle"],
      ["withdrawn", "withdraw"],
    ];

    test.each(cases)("from %s, action %s should be idempotent", (current, action) => {
      const result = transition(current, action);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.nextStatus).toBe(current);
      }
    });
  });

  describe("Illegal Transitions", () => {
    const cases: [StreamStatus, StreamAction][] = [
      ["draft", "pause"],
      ["draft", "settle"],
      ["draft", "withdraw"],
      ["ended", "start"],
      ["ended", "pause"],
      ["withdrawn", "stop"],
      ["cancelled", "cancel"],
    ];

    test.each(cases)("from %s, action %s should be illegal", (current, action) => {
      const result = transition(current, action);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("ILLEGAL_TRANSITION");
      }
    });
  });

  describe("Property-based testing", () => {
    it("should never allow a transition to 'active' from 'ended'", () => {
      fc.assert(
        fc.property(
          fc.constantFrom<StreamStatus>("ended", "withdrawn", "cancelled"),
          fc.constantFrom<StreamAction>("start", "pause", "stop", "settle", "cancel"),
          (status, action) => {
            const result = transition(status, action);
            if (result.ok) {
              return result.nextStatus !== "active";
            }
            return true;
          }
        )
      );
    });

    it("should reach 'withdrawn' only if it was previously 'ended'", () => {
      // This is a bit complex for a stateless transition function, 
      // but we can verify that only 'ended' -> 'withdraw' leads to 'withdrawn'.
      fc.assert(
        fc.property(
          fc.constantFrom<StreamStatus>("draft", "active", "paused", "ended", "withdrawn", "cancelled"),
          fc.constantFrom<StreamAction>("start", "pause", "stop", "settle", "withdraw", "cancel"),
          (status, action) => {
            const result = transition(status, action);
            if (result.ok && result.nextStatus === "withdrawn") {
              return status === "ended" || status === "withdrawn";
            }
            if (result.ok && result.nextStatus === "cancelled") {
              return status === "active" || status === "paused";
            }
            return true;
          }
        )
      );
    });
  });
});
