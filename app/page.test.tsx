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
  it("renders a skip link and main landmark for keyboard users", () => {
    render(<Home />);

    expect(
      screen.getByRole("link", { name: /skip to main content/i }),
    ).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });

  it("keeps header navigation and actions in a logical focus order", () => {
    render(<Home />);

    const banner = screen.getByRole("banner", { name: /workspace header/i });
    const focusables = Array.from(banner.querySelectorAll("a[href], button"));

    expect(getFocusableNames(focusables)).toEqual([
      "StreamPay",
      "Overview",
      "Streams",
      "Create stream",
      "New stream",
      "Connect wallet",
    ]);
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
});
