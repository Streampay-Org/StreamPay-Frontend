import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";

import FaqSearch from "./FaqSearch";
import { FAQ_SECTIONS } from "./faq-data";

const mockReplace = jest.fn();
const mockToast = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/help",
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("../components/ToastProvider", () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useToast: () => ({ showToast: mockToast }),
}));

const allItems = FAQ_SECTIONS.flatMap((section) => section.items);

function renderIsland() {
  return render(
    <FaqSearch
      sections={FAQ_SECTIONS}
      supportHref="/contact"
    />,
  );
}

describe("FaqSearch", () => {
  beforeEach(() => {
    mockReplace.mockClear();
    mockToast.mockClear();
    window.location.hash = "";
  });

  it("shows all items by default", () => {
    renderIsland();
    for (const item of allItems) {
      expect(screen.getByText(item.question)).toBeVisible();
    }
  });

  it("filters by question text and highlights matches", async () => {
    const user = userEvent.setup();
    renderIsland();
    await user.type(screen.getByLabelText(/search faq/i), "freighter");
    const marks = screen.getAllByTextMatch(/mark/i);
    expect(marks.length).toBeGreaterThan(0);
  });

  it("is case-insensitive", async () => {
    const user = userEvent.setup();
    renderIsland();
    const input = screen.getByLabelText(/search faq/i);
    await user.type(input, "settle");
    const lower = screen.getAllByTextMatch(/mark/i).length;
    await user.clear(input);
    await user.type(input, "Settle");
    const upper = screen.getAllByTextMatch(/mark/i).length;
    expect(upper).toEqual(lower);
  });

  it("shows empty message and support link when nothing matches", async () => {
    const user = userEvent.setup();
    renderIsland();
    await user.type(screen.getByLabelText(/search faq/i), "zzzzqq");
    expect(screen.getByText(/No answers match/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /contact support/i })).toHaveAttribute("href", "/contact");
  });

  it("reflects the query in the URL", async () => {
    const user = userEvent.setup();
    renderIsland();
    await user.type(screen.getByLabelText(/search faq/i), "freighter");
    expect(mockReplace).toHaveBeenCalled();
  });

  it("copies a deep link and shows a toast", async () => {
    const writeText = jest.fn().resolve();
    Object.assign(navigator, { clipboard: { writeText } });
    const user = userEvent.setup();
    renderIsland();
    const item = allItems[0];
    const escaped = item.question.replace(/[.*+??^${}()|[\]\\\\]/g, "\\$&");
    const button = screen.getByRole("button", {
      name: new RegExp(escaped, "i"),
    });
    await user.click(button);
    expect(writeText).toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalled();
  });

  it("focuses the deep-linked heading on load", async () => {
    window.location.hash = "#withdraw-funds";
    renderIsland();
    await waitFor(() => {
      const heading = document.getElementById("withdraw-funds");
      expect(heading).toBeTruthy();
    });
  });

  it("respects reduced motion when scrolling", async () => {
    const scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    window.matchMedia = jest.fn().mockImplementation(() => ({
      matches: true,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    }));
    window.location.hash = "#withdraw-funds";
    renderIsland();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "auto" }),
    );
  });

  it("announces the result count", async () => {
    const user = userEvent.setup();
    renderIsland();
    await user.type(screen.getByLabelText(/search faq/i), "freighter");
    const status = screen.getByRole("status");
    expect(status.textContent).toMatch(/\d+/);
  });

  it("has no serious axe violations", async () => {
    const { container } = renderIsland();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
