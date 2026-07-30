/**
 * @jest-environment jsdom
 */

import { render, fireEvent } from "@testing-library/react";
const { screen } = require("@testing-library/react") as any;
import { StreamsPageContent } from "./StreamsPageContent";

const STORAGE_KEY = "streampay.density";


describe("StreamsPageContent", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the empty state", () => {
    render(<StreamsPageContent state="empty" streams={[]} />);

    expect(screen.getByRole("heading", { name: /start your first stream/i })).toBeInTheDocument();
    expect(screen.getByText(/define a recipient, cadence, and amount in minutes/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create your first stream/i })).toBeInTheDocument();
    expect(screen.getByText(/what you'll set up/i)).toBeInTheDocument();
    expect(screen.getByText(/choose a collaborator or vendor to pay/i)).toBeInTheDocument();
  });

  it("renders the loading skeleton state", () => {
    render(<StreamsPageContent state="loading" />);

    expect(screen.getByLabelText(/loading streams/i)).toBeInTheDocument();
    expect(screen.getAllByTestId("stream-row-skeleton")).toHaveLength(3);
  });

  it("renders a filtered empty state when the current view has no matches", () => {
    render(<StreamsPageContent state="populated" streams={[]} emptyStateVariant="filtered" />);

    expect(screen.getByRole("heading", { name: /no streams match your current filters/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear filters/i })).toBeInTheDocument();
  });

  it("renders the populated list state", () => {
    render(<StreamsPageContent state="populated" />);

    expect(screen.getByRole("heading", { name: /streams overview/i })).toBeInTheDocument();
    expect(screen.getByText(/ada creative studio/i)).toBeInTheDocument();
    expect(screen.getByText(/120 xlm \/ month/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/stream status: active/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export history/i })).toBeInTheDocument();
  });

  it("renders calendar-month edge case schedule messaging", () => {
    render(
      <StreamsPageContent
        state="populated"
        streams={[
          {
            id: "stream-jan-31",
            nextAction: "Pause",
            rate: "45 XLM / month",
            recipient: "January 31 Studio",
            schedule: "Starts Jan 31; Feb prorated (UTC)",
            status: "active",
          },
          {
            id: "stream-feb",
            nextAction: "Pause",
            rate: "60 XLM / month",
            recipient: "Non-Leap Ops",
            schedule: "Non-leap Feb proration applied",
            status: "active",
          },
          {
            id: "stream-dst",
            nextAction: "Pause",
            rate: "22 XLM / month",
            recipient: "DST Display",
            schedule: "DST shift shown in local time (display only)",
            status: "active",
          },
          {
            id: "stream-pause",
            nextAction: "Withdraw",
            rate: "18 XLM / month",
            recipient: "End-of-Month Pause",
            schedule: "Paused on last day; final day prorated (UTC)",
            status: "ended",
          },
        ]}
      />,
    );

    expect(screen.getByText(/starts jan 31; feb prorated/i)).toBeInTheDocument();
    expect(screen.getByText(/non-leap feb proration applied/i)).toBeInTheDocument();
    expect(screen.getByText(/dst shift shown in local time/i)).toBeInTheDocument();
    expect(screen.getByText(/paused on last day; final day prorated/i)).toBeInTheDocument();
  });

  it("renders the error state with heading and contact support link", () => {
    render(<StreamsPageContent state="error" />);

    expect(
      screen.getByRole("heading", { name: /couldn't load your streams/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /contact support/i })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("renders a retry button in the error state when onRetry is provided", () => {
    const onRetry = jest.fn();
    render(<StreamsPageContent state="error" onRetry={onRetry} />);

    const retryBtn = screen.getByRole("button", { name: /try again/i });
    expect(retryBtn).toBeInTheDocument();
    retryBtn.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders a custom errorMessage in the error panel", () => {
    render(
      <StreamsPageContent
        state="error"
        errorMessage="The API returned a 503."
      />,
    );
    expect(screen.getByText(/the api returned a 503/i)).toBeInTheDocument();
  });

  it("applies the animation class only to active streams", () => {
    const streams = [
      {
        id: "stream-active",
        nextAction: "Pause",
        rate: "100 XLM / month",
        recipient: "Active Recipient",
        schedule: "Daily",
        status: "active" as const,
      },
      {
        id: "stream-draft",
        nextAction: "Start",
        rate: "50 XLM / month",
        recipient: "Draft Recipient",
        schedule: "Weekly",
        status: "draft" as const,
      },
    ];
    render(<StreamsPageContent state="populated" streams={streams} />);
    
    expect(screen.getByText(/100 XLM \/ month/i)).toHaveClass("stream-row__accrued--animated");
    expect(screen.getByText(/50 XLM \/ month/i)).not.toHaveClass("stream-row__accrued--animated");
  });

  describe("tag chip filtering", () => {
    const taggedStreams = [
      {
        id: "stream-ada",
        nextAction: "Pause",
        rate: "120 XLM / month",
        recipient: "Ada Creative Studio",
        schedule: "Pays every 30 days",
        status: "active" as const,
        tags: ["design", "vendor"],
      },
      {
        id: "stream-kemi",
        nextAction: "Start",
        rate: "32 XLM / week",
        recipient: "Kemi Onboarding Support",
        schedule: "Draft stream ready to launch",
        status: "draft" as const,
        tags: ["onboarding"],
      },
    ];

    it("does not render a tag filter bar when no stream has tags", () => {
      render(
        <StreamsPageContent
          state="populated"
          streams={[
            {
              id: "stream-untagged",
              nextAction: "Pause",
              rate: "10 XLM / month",
              recipient: "Untagged Recipient",
              schedule: "Daily",
              status: "active",
            },
          ]}
        />,
      );

      expect(screen.queryByRole("group", { name: /filter by tag/i })).not.toBeInTheDocument();
    });

    it("filters the list to streams matching the clicked tag", () => {
      render(<StreamsPageContent state="populated" streams={taggedStreams} />);

      expect(screen.getByText(/ada creative studio/i)).toBeInTheDocument();
      expect(screen.getByText(/kemi onboarding support/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "onboarding" }));

      expect(screen.getByText(/kemi onboarding support/i)).toBeInTheDocument();
      expect(screen.queryByText(/ada creative studio/i)).not.toBeInTheDocument();
    });

    it("shows a no-matches message and clears back to the full list", () => {
      render(<StreamsPageContent state="populated" streams={taggedStreams} />);

      fireEvent.click(screen.getByRole("button", { name: "onboarding" }));
      fireEvent.click(screen.getByRole("button", { name: "onboarding" }));

      expect(screen.getByText(/ada creative studio/i)).toBeInTheDocument();
      expect(screen.getByText(/kemi onboarding support/i)).toBeInTheDocument();
    });
  });
});

describe("Density toggle", () => {
  it("renders the density toggle with both options", () => {
    render(<StreamsPageContent state="populated" />);

    const radiogroup = screen.getByRole("radiogroup", { name: /list density/i });
    expect(radiogroup).toBeInTheDocument();

    expect(screen.getByRole("radio", { name: /cozy/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /compact/i })).toBeInTheDocument();
  });

  it("defaults to cozy with cozy radio checked", () => {
    render(<StreamsPageContent state="populated" />);

    const cozyRadio = screen.getByRole("radio", { name: /cozy/i });
    expect(cozyRadio).toHaveAttribute("aria-checked", "true");

    const compactRadio = screen.getByRole("radio", { name: /compact/i });
    expect(compactRadio).toHaveAttribute("aria-checked", "false");
  });

  it("switches to compact when compact option is clicked", () => {
    render(<StreamsPageContent state="populated" />);

    fireEvent.click(screen.getByRole("radio", { name: /compact/i }));

    expect(screen.getByRole("radio", { name: /compact/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /cozy/i })).toHaveAttribute("aria-checked", "false");
  });

  it("applies compact class to stream list and stream rows", () => {
    render(<StreamsPageContent state="populated" />);

    fireEvent.click(screen.getByRole("radio", { name: /compact/i }));

    const list = screen.getByLabelText(/streams list/i);
    expect(list).toHaveClass("stream-list--compact");

    const rows = screen.getAllByRole("article");
    for (const row of rows) {
      expect(row).toHaveClass("stream-row--compact");
    }
  });

  it("reverts to cozy when cozy option is clicked after compact", () => {
    render(<StreamsPageContent state="populated" />);

    fireEvent.click(screen.getByRole("radio", { name: /compact/i }));
    fireEvent.click(screen.getByRole("radio", { name: /cozy/i }));

    expect(screen.getByRole("radio", { name: /cozy/i })).toHaveAttribute("aria-checked", "true");

    const list = screen.getByLabelText(/streams list/i);
    expect(list).not.toHaveClass("stream-list--compact");
  });

  it("does not render density toggle when state is empty", () => {
    render(<StreamsPageContent state="empty" streams={[]} />);

    expect(screen.queryByRole("radiogroup", { name: /list density/i })).not.toBeInTheDocument();
  });

  it("does not render density toggle when state is loading", () => {
    render(<StreamsPageContent state="loading" />);

    expect(screen.queryByRole("radiogroup", { name: /list density/i })).not.toBeInTheDocument();
  });

  it("does not render density toggle when state is error", () => {
    render(<StreamsPageContent state="error" />);

    expect(screen.queryByRole("radiogroup", { name: /list density/i })).not.toBeInTheDocument();
  });

  it("persists density choice to localStorage", () => {
    render(<StreamsPageContent state="populated" />);

    fireEvent.click(screen.getByRole("radio", { name: /compact/i }));

    expect(localStorage.getItem("streampay-density")).toBe("compact");
  });

  it("reads density preference from localStorage on mount", () => {
    localStorage.setItem("streampay-density", "compact");

    render(<StreamsPageContent state="populated" />);

    expect(screen.getByRole("radio", { name: /compact/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /cozy/i })).toHaveAttribute("aria-checked", "false");

    const list = screen.getByLabelText(/streams list/i);
    expect(list).toHaveClass("stream-list--compact");
  });
});
