/**
 * @jest-environment jsdom
 */

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import TemplatesPage from "./page";

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockRouter = {
  push: mockPush,
  replace: mockReplace,
  back: jest.fn(),
  forward: jest.fn(),
  refresh: jest.fn(),
  prefetch: jest.fn(),
};

// Use the shared __mocks__/next/navigation.js rather than a page-only mock.
jest.mock("next/navigation");

function setUrl(query = "") {
  jest.mocked(useSearchParams).mockReturnValue(new URLSearchParams(query) as ReturnType<typeof useSearchParams>);
}

async function renderLoaded() {
  const view = render(<TemplatesPage />);
  await screen.findByRole("tablist", { name: "Template categories" });
  return view;
}

const TEMPLATES = [
  {
    id: "tpl_1",
    name: "Monthly Savings",
    asset: "XLM",
    amountPerInterval: 50,
    intervalSeconds: 2592000,
    memo: "Automated monthly savings",
    createdAt: "2026-01-15T00:00:00.000Z",
  },
  {
    id: "tpl_2",
    name: "Freelancer Income",
    asset: "USDC",
    amountPerInterval: 2000,
    intervalSeconds: 604800,
    memo: "Weekly freelancer payout",
    createdAt: "2026-02-10T00:00:00.000Z",
  },
  {
    id: "tpl_3",
    name: "Utility Bill",
    asset: "XLM",
    amountPerInterval: 120,
    intervalSeconds: 2592000,
    memo: "Monthly utility payment",
    createdAt: "2026-03-05T00:00:00.000Z",
  },
  {
    id: "tpl_4",
    name: "Savings Roundup",
    asset: "XLM",
    amountPerInterval: 10,
    intervalSeconds: 86400,
    createdAt: "2026-04-20T00:00:00.000Z",
  },
];

beforeEach(() => {
  jest.useFakeTimers();
  // jsdom has no layout or scrolling implementation.
  HTMLElement.prototype.scrollIntoView = jest.fn();
  mockPush.mockClear();
  mockReplace.mockClear();
  jest.mocked(useRouter).mockReturnValue(mockRouter);
  jest.mocked(usePathname).mockReturnValue("/templates");
  setUrl();

  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ templates: TEMPLATES }),
  });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("TemplatesPage", () => {
  it("shows loading skeleton while fetching templates", () => {
    global.fetch = jest.fn(() => new Promise<Response>(() => {}));
    render(<TemplatesPage />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading templates/i);
  });

  it("renders the page heading", () => {
    global.fetch = jest.fn(() => new Promise<Response>(() => {}));
    render(<TemplatesPage />);
    expect(
      screen.getByRole("heading", { name: /start with a template/i }),
    ).toBeInTheDocument();
  });

  it("renders the browse templates section heading", () => {
    global.fetch = jest.fn(() => new Promise<Response>(() => {}));
    render(<TemplatesPage />);
    expect(
      screen.getByRole("heading", { name: /browse templates/i }),
    ).toBeInTheDocument();
  });

  it("renders templates after loading", async () => {
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(screen.getByText("Monthly Savings")).toBeInTheDocument();
    expect(screen.getByText("Freelancer Income")).toBeInTheDocument();
    expect(screen.getByText("Utility Bill")).toBeInTheDocument();
    expect(screen.getByText("Savings Roundup")).toBeInTheDocument();
  });

  it("renders the template panel with the result count", async () => {
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    const panel = screen.getByRole("tabpanel", { name: "All" });
    expect(within(panel).getByRole("status")).toHaveTextContent("Showing 4 templates");
  });

  it("clears aria-busy once templates are loaded", async () => {
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    const section = screen.getByRole("region", { name: /browse templates/i });
    expect(section).toHaveAttribute("aria-busy", "false");
  });

  it("renders category filter tabs", async () => {
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(screen.getByRole("tab", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Savings" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Income" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Bills" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Custom" })).toBeInTheDocument();
  });

  it("marks All tab as selected by default", async () => {
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    const allTab = screen.getByRole("tab", { name: "All" });
    expect(allTab).toHaveAttribute("aria-selected", "true");
  });

  it("filters templates by category", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    await user.click(screen.getByRole("tab", { name: "Savings" }));

    expect(screen.getByText("Monthly Savings")).toBeInTheDocument();
    expect(screen.getByText("Savings Roundup")).toBeInTheDocument();
    expect(screen.queryByText("Freelancer Income")).not.toBeInTheDocument();
    expect(screen.queryByText("Utility Bill")).not.toBeInTheDocument();
  });

  it("filters templates by Income category", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    await user.click(screen.getByRole("tab", { name: "Income" }));

    expect(screen.getByText("Freelancer Income")).toBeInTheDocument();
    expect(screen.queryByText("Monthly Savings")).not.toBeInTheDocument();
    expect(screen.queryByText("Utility Bill")).not.toBeInTheDocument();
  });

  it("shows empty state when no templates match filter", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ templates: [TEMPLATES[1]] }),
    });

    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    await user.click(screen.getByRole("tab", { name: "Savings" }));

    expect(screen.getByText("No templates found")).toBeInTheDocument();
    expect(screen.getByText("Clear filters")).toBeInTheDocument();
  });

  it("search filters templates by name", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    const searchInput = screen.getByPlaceholderText(/search templates/i);
    await user.type(searchInput, "savings");

    expect(screen.getByText("Monthly Savings")).toBeInTheDocument();
    expect(screen.getByText("Savings Roundup")).toBeInTheDocument();
    expect(screen.queryByText("Freelancer Income")).not.toBeInTheDocument();
    expect(screen.queryByText("Utility Bill")).not.toBeInTheDocument();
  });

  it("search filters templates by memo", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    const searchInput = screen.getByPlaceholderText(/search templates/i);
    await user.type(searchInput, "freelancer");

    expect(screen.getByText("Freelancer Income")).toBeInTheDocument();
    expect(screen.queryByText("Monthly Savings")).not.toBeInTheDocument();
  });

  it("search filters templates by asset", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    const searchInput = screen.getByPlaceholderText(/search templates/i);
    await user.type(searchInput, "USDC");

    expect(screen.getByText("Freelancer Income")).toBeInTheDocument();
    expect(screen.queryByText("Monthly Savings")).not.toBeInTheDocument();
    expect(screen.queryByText("Utility Bill")).not.toBeInTheDocument();
  });

  it("Use template button navigates to stream creation", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    const applyButtons = screen.getAllByText("Use template");
    await user.click(applyButtons[0]);

    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining("/streams/new?"),
    );
  });

  it("navigates with correct template params", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    const applyButtons = screen.getAllByText("Use template");
    await user.click(applyButtons[1]);

    const callArg = mockPush.mock.calls[0][0];
    expect(callArg).toContain("templateId=tpl_2");
    expect(callArg).toContain("asset=USDC");
    expect(callArg).toContain("rate=2000");
    expect(callArg).toContain("interval=604800");
  });

  it("shows error state when fetch fails", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(screen.getByText("Couldn't load templates")).toBeInTheDocument();
    expect(screen.getByText("Try again")).toBeInTheDocument();
  });

  it("retry button re-fetches templates", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ templates: TEMPLATES }),
    });

    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.click(screen.getByText("Try again"));

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(screen.getByText("Monthly Savings")).toBeInTheDocument();
  });

  it("cleans up fetch abort on unmount", () => {
    global.fetch = jest.fn(() => new Promise<Response>(() => {}));
    const abortSpy = jest.spyOn(AbortController.prototype, "abort");
    const { unmount } = render(<TemplatesPage />);
    unmount();
    expect(abortSpy).toHaveBeenCalled();
    abortSpy.mockRestore();
  });

  it("displays category badges with correct labels", async () => {
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    const savingsCards = screen.getAllByText("savings");
    expect(savingsCards.length).toBe(2);

    const incomeCards = screen.getAllByText("income");
    expect(incomeCards.length).toBe(1);

    const billsCards = screen.getAllByText("bills");
    expect(billsCards.length).toBe(1);
  });

  it("displays template rates and intervals", async () => {
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(screen.getByText("50 XLM")).toBeInTheDocument();
    expect(screen.getByText("2000 USDC")).toBeInTheDocument();
    expect(screen.getByText("120 XLM")).toBeInTheDocument();
    expect(screen.getByText("10 XLM")).toBeInTheDocument();
  });

  it("displays memo text when present", async () => {
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(screen.getByText("Automated monthly savings")).toBeInTheDocument();
    expect(screen.getByText("Weekly freelancer payout")).toBeInTheDocument();
    expect(screen.getByText("Monthly utility payment")).toBeInTheDocument();
  });

  it("clear filters button resets category and search", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ templates: [TEMPLATES[1]] }),
    });

    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    await user.click(screen.getByRole("tab", { name: "Savings" }));
    expect(screen.queryByText("Freelancer Income")).not.toBeInTheDocument();

    await user.click(screen.getByText("Clear filters"));

    expect(screen.getByText("Freelancer Income")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
  });

  it("renders search input", async () => {
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(screen.getByPlaceholderText(/search templates/i)).toBeInTheDocument();
  });

  it("automatically selects Savings and moves focus with ArrowRight", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderLoaded();
    act(() => screen.getByRole("tab", { name: "All" }).focus());

    await user.keyboard("{ArrowRight}");

    const savings = screen.getByRole("tab", { name: "Savings" });
    expect(savings).toHaveFocus();
    expect(savings).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Savings" })).toHaveTextContent("Monthly Savings");
  });

  it("supports End, Home and arrow-key wrapping", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderLoaded();
    act(() => screen.getByRole("tab", { name: "All" }).focus());

    for (const [key, label] of [
      ["{End}", "Custom"],
      ["{ArrowRight}", "All"],
      ["{ArrowLeft}", "Custom"],
      ["{Home}", "All"],
    ]) {
      await user.keyboard(key);
      const tab = screen.getByRole("tab", { name: label });
      expect(tab).toHaveFocus();
      expect(tab).toHaveAttribute("aria-selected", "true");
    }
  });

  it("keeps only the active tab in the tab order and lets Tab leave the list", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderLoaded();
    await user.click(screen.getByRole("tab", { name: "Income" }));

    const tabs = screen.getAllByRole("tab");
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toEqual([screen.getByRole("tab", { name: "Income" })]);
    tabs.filter((tab) => tab.textContent !== "Income").forEach((tab) => {
      expect(tab).toHaveAttribute("tabindex", "-1");
      expect(tab).toHaveAttribute("aria-selected", "false");
    });
    await user.tab();
    expect(screen.getByRole("searchbox", { name: "Search templates" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("tabpanel", { name: "Income" })).toHaveFocus();
  });

  it("links every tab to the panel, including the empty state", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderLoaded();

    screen.getAllByRole("tab").forEach((tab) => {
      expect(tab.id).not.toBe("");
      expect(tab).toHaveAttribute("aria-controls", "template-panel");
    });
    await user.click(screen.getByRole("tab", { name: "Custom" }));
    const panel = screen.getByRole("tabpanel", { name: "Custom" });
    expect(panel).toHaveAttribute("id", "template-panel");
    expect(panel).toHaveAttribute("aria-labelledby", screen.getByRole("tab", { selected: true }).id);
    expect(within(panel).getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });

  it("restores category and search from a shared URL without replacing it on mount", async () => {
    setUrl("category=bills&q=host");
    await renderLoaded();

    expect(screen.getByRole("tab", { name: "Bills" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("searchbox")).toHaveValue("host");
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("replaces the URL immediately when selecting Income and preserves other parameters", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    setUrl("ref=shared");
    await renderLoaded();
    await user.click(screen.getByRole("tab", { name: "Income" }));

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/templates?ref=shared&category=income", { scroll: false });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("filters search immediately but replaces the URL only once after 300ms", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderLoaded();
    await user.type(screen.getByRole("searchbox"), "savings");

    expect(screen.queryByText("Freelancer Income")).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(299));
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/templates?q=savings", { scroll: false });
  });

  it("falls back to All for an unknown category", async () => {
    setUrl("category=bogus");
    await renderLoaded();

    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("article")).toHaveLength(TEMPLATES.length);
  });

  it("restarts the debounce after each edit and safely encodes the final search", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await renderLoaded();
    await user.type(screen.getByRole("searchbox"), "a");
    act(() => jest.advanceTimersByTime(250));
    await user.type(screen.getByRole("searchbox"), " & b");
    act(() => jest.advanceTimersByTime(299));
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/templates?q=a+%26+b", { scroll: false });
  });

  it("removes default category and empty search parameters", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    setUrl("category=savings&q=savings");
    await renderLoaded();
    await user.click(screen.getByRole("tab", { name: "All" }));
    expect(mockReplace).toHaveBeenLastCalledWith("/templates?q=savings", { scroll: false });
    await user.clear(screen.getByRole("searchbox"));
    act(() => jest.advanceTimersByTime(300));
    expect(mockReplace).toHaveBeenLastCalledWith("/templates", { scroll: false });
  });

  it("clears filter parameters immediately, cancels pending search and restores focus", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    setUrl("category=bills&q=host&ref=shared");
    await renderLoaded();
    await user.type(screen.getByRole("searchbox"), "missing");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(screen.getByRole("tab", { name: "All" })).toHaveFocus();
    expect(mockReplace).toHaveBeenCalledWith("/templates?ref=shared", { scroll: false });
    act(() => jest.advanceTimersByTime(300));
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it("removes the query string entirely when clearing the only parameters", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    setUrl("category=bills&q=missing");
    await renderLoaded();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(mockReplace).toHaveBeenCalledWith("/templates", { scroll: false });
  });

  it("preserves pending search across category replacements without flushing its debounce", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { rerender } = await renderLoaded();
    await user.type(screen.getByRole("searchbox"), "host");
    await user.click(screen.getByRole("tab", { name: "Bills" }));
    expect(mockReplace).toHaveBeenLastCalledWith("/templates?category=bills", { scroll: false });

    setUrl("category=bills");
    rerender(<TemplatesPage />);
    expect(screen.getByRole("searchbox")).toHaveValue("host");
    act(() => jest.advanceTimersByTime(300));
    expect(mockReplace).toHaveBeenLastCalledWith("/templates?category=bills&q=host", { scroll: false });
    expect(mockReplace).toHaveBeenCalledTimes(2);
  });

  it("restores filters on URL navigation and cancels an outdated search", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { rerender } = await renderLoaded();
    await user.type(screen.getByRole("searchbox"), "unfinished");

    setUrl("category=income&q=freelancer");
    rerender(<TemplatesPage />);
    expect(screen.getByRole("tab", { name: "Income" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("searchbox")).toHaveValue("freelancer");
    act(() => jest.advanceTimersByTime(300));
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("cancels a pending search when unmounted", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { unmount } = await renderLoaded();
    await user.type(screen.getByRole("searchbox"), "savings");
    unmount();
    act(() => jest.advanceTimersByTime(300));
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("has no axe violations in populated and empty panels", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { container } = await renderLoaded();
    jest.useRealTimers();
    expect(await axe(container)).toHaveNoViolations();
    jest.useFakeTimers();
    await user.click(screen.getByRole("tab", { name: "Custom" }));
    jest.useRealTimers();
    expect(await axe(container)).toHaveNoViolations();
    jest.useFakeTimers();
  });
});
