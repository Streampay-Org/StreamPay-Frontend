import { render, screen, within } from "@testing-library/react";
import Home from "./page";

const getFocusableNames = (elements: Element[]) =>
  elements.map((element) => {
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) {
      return ariaLabel;
    }

    return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
  });

describe("Home", () => {
  it("renders the updated stream action heading", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", {
        name: /manage payment streams with clear, consistent actions/i,
      }),
    ).toBeInTheDocument();
  });

  it("renders labeled create form controls in review order", () => {
    render(<Home />);

    const form = screen.getByRole("form", { name: /create a stream/i });
    const controls = Array.from(form.querySelectorAll("input, select, textarea, button"));
    const recipientAddress = screen.getByLabelText(/recipient address/i);
    const amount = screen.getByLabelText(/amount/i);
    const distributionInterval = screen.getByLabelText(/distribution interval/i);
    const startDate = screen.getByLabelText(/start date/i);
    const notes = screen.getByLabelText(/notes/i);
    const createStream = screen.getByRole("button", { name: /create stream/i });
    const clearForm = screen.getByRole("button", { name: /clear form/i });

    expect(controls).toEqual([
      recipientAddress,
      amount,
      distributionInterval,
      startDate,
      notes,
      createStream,
      clearForm,
    ]);
  });

  it("does not rely on manual tab index overrides", () => {
    const { container } = render(<Home />);

    expect(container.querySelectorAll("[tabindex]")).toHaveLength(0);
  });

  it("renders discrete stream actions instead of nested interactive cards", () => {
    render(<Home />);

    const streamsSection = screen.getByRole("region", { name: /active streams/i });
    const cards = within(streamsSection).getAllByRole("listitem");

    expect(cards).toHaveLength(3);
    expect(
      within(cards[0]).getByRole("link", { name: /open details for alma k\./i }),
    ).toBeInTheDocument();
    expect(
      within(cards[0]).getByRole("button", { name: /pause alma k\./i }),
    ).toBeInTheDocument();
    expect(
      within(cards[0]).getByRole("button", {
        name: /copy wallet address for alma k\./i,
      }),
    ).toBeInTheDocument();
  });

  it("renders clear wallet and stream action CTAs", () => {
    render(<Home />);
    expect(screen.getByRole("link", { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view stream actions/i })).toBeInTheDocument();
  });

  it("renders the standardized stream action labels", () => {
    render(<Home />);
    for (const action of ["Start", "Pause", "Stop", "Settle", "Withdraw"]) {
      expect(screen.getByRole("heading", { name: action })).toBeInTheDocument();
    }
  });

  it("renders the reusable stream status badge section", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: /stream statuses/i })).toBeInTheDocument();
    expect(screen.getAllByLabelText(/stream status: active/i)).toHaveLength(2);
    expect(screen.getByLabelText(/stream status: draft/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/stream status: paused/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/stream status: ended/i)).toBeInTheDocument();
  });
});
