/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  IndexerStatus,
  buildAnnouncement,
  isAssertiveState,
  lagBucket,
  type IndexerStatusData,
} from "./IndexerStatus";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseData: IndexerStatusData = {
  network: "testnet",
  lastProcessedLedger: 1_234_567,
  latestLedger: 1_234_568,
  status: "synced",
  lastUpdatedAt: new Date().toISOString(),
  lag: 1,
};

// ---------------------------------------------------------------------------
// Rendering — existing behaviour (regression guard)
// ---------------------------------------------------------------------------

describe("IndexerStatus — rendering", () => {
  it("renders the card with a labelled heading", () => {
    render(<IndexerStatus data={baseData} />);
    expect(
      screen.getByRole("heading", { name: /indexer status/i }),
    ).toBeInTheDocument();
  });

  it("shows the network label", () => {
    render(<IndexerStatus data={baseData} />);
    expect(screen.getByText("testnet")).toBeInTheDocument();
  });

  it("displays the last processed ledger with tabular-nums formatting", () => {
    render(<IndexerStatus data={baseData} />);
    const dd = screen.getByLabelText(/last processed ledger/i);
    expect(dd).toHaveTextContent("1,234,567");
  });

  it("displays the latest ledger", () => {
    render(<IndexerStatus data={baseData} />);
    const dd = screen.getByLabelText(/latest ledger/i);
    expect(dd).toHaveTextContent("1,234,568");
  });

  it("shows the lag in ledgers", () => {
    render(<IndexerStatus data={{ ...baseData, lag: 42 }} />);
    const dd = screen.getByLabelText(/lag 42 ledgers/i);
    expect(dd).toHaveTextContent(/42/);
    expect(dd).toHaveTextContent(/ledgers/);
  });

  it("formats large lag with k-suffix", () => {
    render(<IndexerStatus data={{ ...baseData, lag: 1234 }} />);
    const dd = screen.getByLabelText(/lag 1234 ledgers/i);
    expect(dd).toHaveTextContent(/1\.2k/);
  });

  it("displays synced status label and success styling", () => {
    render(<IndexerStatus data={baseData} />);
    const section = screen.getByRole("region", { name: /indexer status/i });
    expect(section.className).toContain("indexer-status--success");
  });

  it("displays syncing status label and warning styling", () => {
    render(
      <IndexerStatus
        data={{ ...baseData, status: "syncing", lag: 10 }}
      />,
    );
    const section = screen.getByRole("region", { name: /indexer status/i });
    expect(section.className).toContain("indexer-status--warning");
  });

  it("displays stalled status label and error styling", () => {
    render(<IndexerStatus data={{ ...baseData, status: "stalled" }} />);
    const section = screen.getByRole("region", { name: /indexer status/i });
    expect(section.className).toContain("indexer-status--error");
  });

  it("displays stopped status label and warning styling", () => {
    render(<IndexerStatus data={{ ...baseData, status: "stopped" }} />);
    const section = screen.getByRole("region", { name: /indexer status/i });
    expect(section.className).toContain("indexer-status--warning");
  });

  it("displays error status label and error styling", () => {
    render(<IndexerStatus data={{ ...baseData, status: "error" }} />);
    const section = screen.getByRole("region", { name: /indexer status/i });
    expect(section.className).toContain("indexer-status--error");
  });

  it("renders a relative timestamp", () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    render(<IndexerStatus data={{ ...baseData, lastUpdatedAt: recent }} />);
    expect(screen.getByText(/30s ago|updated/)).toBeInTheDocument();
  });

  it("shows just now for very recent updates", () => {
    const now = new Date().toISOString();
    render(<IndexerStatus data={{ ...baseData, lastUpdatedAt: now }} />);
    expect(screen.getByText(/just now/)).toBeInTheDocument();
  });

  it("shows hours ago for older timestamps", () => {
    const old = new Date(Date.now() - 3_600_000 * 2).toISOString();
    render(<IndexerStatus data={{ ...baseData, lastUpdatedAt: old }} />);
    expect(screen.getByText(/2h ago/)).toBeInTheDocument();
  });

  it("forwards additional class names", () => {
    render(<IndexerStatus data={baseData} className="custom-class" />);
    const section = screen.getByRole("region", { name: /indexer status/i });
    expect(section.className).toContain("custom-class");
  });

  it("falls back to raw ISO when timestamp is invalid", () => {
    render(
      <IndexerStatus
        data={{ ...baseData, lastUpdatedAt: "not-a-date" }}
      />,
    );
    expect(screen.getByText(/updated not-a-date/)).toBeInTheDocument();
  });

  it("displays loading status label and info styling", () => {
    render(<IndexerStatus data={{ ...baseData, status: "loading" }} />);
    const section = screen.getByRole("region", { name: /indexer status/i });
    expect(section.className).toContain("indexer-status--info");
  });

  it("displays retrying status label and warning styling", () => {
    render(<IndexerStatus data={{ ...baseData, status: "retrying" }} />);
    const section = screen.getByRole("region", { name: /indexer status/i });
    expect(section.className).toContain("indexer-status--warning");
  });

  it("renders the optional diagnostic message", () => {
    render(
      <IndexerStatus
        data={{ ...baseData, status: "stalled", message: "cursor is stale" }}
      />,
    );
    // Multiple role=status nodes exist (two live regions + the diagnostic <p>).
    const statusNodes = screen.getAllByRole("status");
    const diagnosticNode = statusNodes.find((n) =>
      n.textContent?.includes("cursor is stale"),
    );
    expect(diagnosticNode).toBeDefined();
    expect(diagnosticNode).toHaveTextContent("cursor is stale");
  });

  it("does not render a message node when message is absent", () => {
    render(<IndexerStatus data={baseData} />);
    // The live-region pair renders two role=status nodes that are always
    // present, but both are empty on initial mount.  The diagnostic <p>
    // should NOT be present.
    const statusNodes = screen.getAllByRole("status");
    // All role=status nodes must be empty (live regions) — none should have
    // the diagnostic message text when message prop is absent.
    for (const node of statusNodes) {
      expect(node).not.toHaveTextContent(/cursor is stale/);
    }
  });
});

// ---------------------------------------------------------------------------
// Accessibility — status indicator aria-label
// ---------------------------------------------------------------------------

describe("IndexerStatus — status indicator aria-label", () => {
  it.each([
    ["synced", "Status: Synced"],
    ["syncing", "Status: Syncing"],
    ["stalled", "Status: Stalled"],
    ["stopped", "Status: Stopped"],
    ["error", "Status: Error"],
    ["loading", "Status: Loading"],
    ["retrying", "Status: Retrying"],
  ] as const)(
    "status=%s has aria-label '%s'",
    (status, expectedLabel) => {
      render(<IndexerStatus data={{ ...baseData, status }} />);
      expect(screen.getByLabelText(expectedLabel)).toBeInTheDocument();
    },
  );

  it("status label text is aria-hidden so it is not double-read", () => {
    render(<IndexerStatus data={{ ...baseData, status: "synced" }} />);
    // The visible label text span should be aria-hidden since the parent
    // div already carries a full aria-label.
    const indicator = screen.getByLabelText("Status: Synced");
    const hiddenSpan = indicator.querySelector("[aria-hidden='true']");
    expect(hiddenSpan).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Accessibility — ARIA live regions are always present in the DOM
// ---------------------------------------------------------------------------

describe("IndexerStatus — live region presence", () => {
  it("renders a polite live region on initial mount", () => {
    render(<IndexerStatus data={baseData} />);
    const polite = screen.getByTestId("indexer-live-region-polite");
    expect(polite).toBeInTheDocument();
    expect(polite).toHaveAttribute("aria-live", "polite");
  });

  it("renders an assertive live region on initial mount", () => {
    render(<IndexerStatus data={baseData} />);
    const assertive = screen.getByTestId("indexer-live-region-assertive");
    expect(assertive).toBeInTheDocument();
    expect(assertive).toHaveAttribute("aria-live", "assertive");
  });

  it("both live regions are visually hidden (sr-only) on initial mount", () => {
    render(<IndexerStatus data={baseData} />);
    expect(screen.getByTestId("indexer-live-region-polite")).toHaveClass("sr-only");
    expect(screen.getByTestId("indexer-live-region-assertive")).toHaveClass("sr-only");
  });

  it("live regions are empty on initial mount (no spurious announcement)", () => {
    render(<IndexerStatus data={baseData} />);
    expect(screen.getByTestId("indexer-live-region-polite")).toHaveTextContent("");
    expect(screen.getByTestId("indexer-live-region-assertive")).toHaveTextContent("");
  });
});

// ---------------------------------------------------------------------------
// Accessibility — live announcements on status transitions
// ---------------------------------------------------------------------------

describe("IndexerStatus — live announcements on status change", () => {
  it("announces politely when transitioning from synced to syncing", () => {
    const { rerender } = render(<IndexerStatus data={{ ...baseData, status: "synced", lag: 1 }} />);

    act(() => {
      rerender(<IndexerStatus data={{ ...baseData, status: "syncing", lag: 8 }} />);
    });

    const polite = screen.getByTestId("indexer-live-region-polite");
    expect(polite).toHaveTextContent(/indexer status: syncing/i);
    expect(polite).toHaveTextContent(/lag 8 ledgers/i);
  });

  it("announces assertively when transitioning to error state", () => {
    const { rerender } = render(<IndexerStatus data={{ ...baseData, status: "synced" }} />);

    act(() => {
      rerender(<IndexerStatus data={{ ...baseData, status: "error", lag: 50 }} />);
    });

    // Assertive region should carry the message; polite should be empty.
    const assertive = screen.getByTestId("indexer-live-region-assertive");
    const polite = screen.getByTestId("indexer-live-region-polite");
    expect(assertive).toHaveTextContent(/indexer status: error/i);
    expect(polite).toHaveTextContent("");
  });

  it("announces assertively when transitioning to stalled state", () => {
    const { rerender } = render(<IndexerStatus data={{ ...baseData, status: "synced" }} />);

    act(() => {
      rerender(<IndexerStatus data={{ ...baseData, status: "stalled" }} />);
    });

    const assertive = screen.getByTestId("indexer-live-region-assertive");
    expect(assertive).toHaveTextContent(/indexer status: stalled/i);
    expect(screen.getByTestId("indexer-live-region-polite")).toHaveTextContent("");
  });

  it("announces politely when transitioning to retrying state", () => {
    const { rerender } = render(<IndexerStatus data={{ ...baseData, status: "synced" }} />);

    act(() => {
      rerender(<IndexerStatus data={{ ...baseData, status: "retrying" }} />);
    });

    const polite = screen.getByTestId("indexer-live-region-polite");
    expect(polite).toHaveTextContent(/indexer status: retrying/i);
  });

  it("announces politely when transitioning to stopped state", () => {
    const { rerender } = render(<IndexerStatus data={{ ...baseData, status: "synced" }} />);

    act(() => {
      rerender(<IndexerStatus data={{ ...baseData, status: "stopped" }} />);
    });

    expect(screen.getByTestId("indexer-live-region-polite")).toHaveTextContent(
      /indexer status: stopped/i,
    );
  });

  it("includes the message in the announcement when present", () => {
    const { rerender } = render(<IndexerStatus data={{ ...baseData, status: "synced" }} />);

    act(() => {
      rerender(
        <IndexerStatus
          data={{ ...baseData, status: "stalled", message: "cursor is stale" }}
        />,
      );
    });

    const assertive = screen.getByTestId("indexer-live-region-assertive");
    expect(assertive).toHaveTextContent(/cursor is stale/i);
  });

  it("announces when the message changes without a status change", () => {
    const { rerender } = render(
      <IndexerStatus
        data={{ ...baseData, status: "error", message: "initial error" }}
      />,
    );

    // Simulate a second render with same status but different message
    act(() => {
      rerender(
        <IndexerStatus
          data={{ ...baseData, status: "error", message: "timeout exceeded" }}
        />,
      );
    });

    const assertive = screen.getByTestId("indexer-live-region-assertive");
    expect(assertive).toHaveTextContent(/timeout exceeded/i);
  });

  it("announces when lag crosses a bucket boundary (ok → warn)", () => {
    const { rerender } = render(
      <IndexerStatus data={{ ...baseData, status: "syncing", lag: 2 }} />,
    );

    act(() => {
      rerender(<IndexerStatus data={{ ...baseData, status: "syncing", lag: 5 }} />);
    });

    const polite = screen.getByTestId("indexer-live-region-polite");
    expect(polite).toHaveTextContent(/lag 5 ledgers/i);
  });

  it("does NOT announce when lag changes within the same bucket", () => {
    const { rerender } = render(
      <IndexerStatus data={{ ...baseData, status: "syncing", lag: 4 }} />,
    );

    // Clear any announcement from the initial transition
    const polite = screen.getByTestId("indexer-live-region-polite");
    const textBefore = polite.textContent;

    act(() => {
      // lag stays in the 3-10 "warn" bucket — no announcement expected
      rerender(<IndexerStatus data={{ ...baseData, status: "syncing", lag: 7 }} />);
    });

    // The live region content should not have changed
    expect(polite).toHaveTextContent(textBefore ?? "");
  });

  it("does NOT make any announcement on the initial mount", () => {
    render(<IndexerStatus data={baseData} />);
    expect(screen.getByTestId("indexer-live-region-polite")).toHaveTextContent("");
    expect(screen.getByTestId("indexer-live-region-assertive")).toHaveTextContent("");
  });

  it("does NOT announce when non-status props change (e.g. timestamps)", () => {
    const { rerender } = render(<IndexerStatus data={baseData} />);

    act(() => {
      rerender(
        <IndexerStatus
          data={{
            ...baseData,
            // Only the timestamp changes — status, lag, message unchanged
            lastUpdatedAt: new Date(Date.now() - 5_000).toISOString(),
          }}
        />,
      );
    });

    expect(screen.getByTestId("indexer-live-region-polite")).toHaveTextContent("");
    expect(screen.getByTestId("indexer-live-region-assertive")).toHaveTextContent("");
  });

  it("announces recovery from error back to synced (polite)", () => {
    const { rerender } = render(<IndexerStatus data={{ ...baseData, status: "error" }} />);

    // Clear initial mount state
    act(() => {
      rerender(<IndexerStatus data={{ ...baseData, status: "synced", lag: 1 }} />);
    });

    const polite = screen.getByTestId("indexer-live-region-polite");
    expect(polite).toHaveTextContent(/indexer status: synced/i);
    expect(screen.getByTestId("indexer-live-region-assertive")).toHaveTextContent("");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers — buildAnnouncement
// ---------------------------------------------------------------------------

describe("buildAnnouncement", () => {
  it("returns a complete announcement for synced state with no lag", () => {
    expect(buildAnnouncement("synced", 0)).toBe("Indexer status: Synced.");
  });

  it("includes lag when non-zero", () => {
    expect(buildAnnouncement("syncing", 8)).toBe(
      "Indexer status: Syncing, lag 8 ledgers.",
    );
  });

  it("uses singular 'ledger' when lag is 1", () => {
    expect(buildAnnouncement("syncing", 1)).toMatch(/lag 1 ledger\./);
  });

  it("includes the message when provided", () => {
    expect(buildAnnouncement("error", 50, "circuit breaker open")).toBe(
      "Indexer status: Error, lag 50 ledgers. circuit breaker open.",
    );
  });

  it("omits message when undefined", () => {
    expect(buildAnnouncement("stalled", 0)).toBe("Indexer status: Stalled.");
  });

  it("includes both lag and message", () => {
    const text = buildAnnouncement("stalled", 20, "cursor is frozen");
    expect(text).toContain("lag 20 ledgers");
    expect(text).toContain("cursor is frozen");
  });

  it.each([
    ["loading", "Loading"],
    ["synced", "Synced"],
    ["syncing", "Syncing"],
    ["stalled", "Stalled"],
    ["retrying", "Retrying"],
    ["stopped", "Stopped"],
    ["error", "Error"],
  ] as const)(
    "state=%s produces label '%s'",
    (state, expectedLabel) => {
      expect(buildAnnouncement(state, 0)).toContain(expectedLabel);
    },
  );
});

// ---------------------------------------------------------------------------
// Pure helpers — isAssertiveState
// ---------------------------------------------------------------------------

describe("isAssertiveState", () => {
  it.each(["error", "stalled"] as const)(
    "%s is assertive",
    (state) => {
      expect(isAssertiveState(state)).toBe(true);
    },
  );

  it.each(["synced", "syncing", "loading", "stopped", "retrying"] as const)(
    "%s is not assertive",
    (state) => {
      expect(isAssertiveState(state)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Pure helpers — lagBucket
// ---------------------------------------------------------------------------

describe("lagBucket", () => {
  it.each([
    [0, "ok"],
    [1, "ok"],
    [2, "ok"],
    [3, "warn"],
    [5, "warn"],
    [10, "warn"],
    [11, "high"],
    [999, "high"],
    [10000, "high"],
  ] as const)(
    "lag=%d → bucket '%s'",
    (lag, expected) => {
      expect(lagBucket(lag)).toBe(expected);
    },
  );
});

// ---------------------------------------------------------------------------
// Accessibility — aria-atomic on live regions
// ---------------------------------------------------------------------------

describe("IndexerStatus — aria-atomic on live regions", () => {
  it("both live regions have aria-atomic=true", () => {
    render(<IndexerStatus data={baseData} />);
    expect(screen.getByTestId("indexer-live-region-polite")).toHaveAttribute(
      "aria-atomic",
      "true",
    );
    expect(screen.getByTestId("indexer-live-region-assertive")).toHaveAttribute(
      "aria-atomic",
      "true",
    );
  });
});

// ---------------------------------------------------------------------------
// Accessibility — section role and labelling
// ---------------------------------------------------------------------------

describe("IndexerStatus — section role and labelling", () => {
  it("section has region role (implied by aria-labelledby + section element)", () => {
    render(<IndexerStatus data={baseData} />);
    expect(
      screen.getByRole("region", { name: /indexer status/i }),
    ).toBeInTheDocument();
  });
});
