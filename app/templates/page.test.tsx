/**
 * @jest-environment jsdom
 */

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TemplatesPage from "./page";

const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  usePathname: () => "/templates",
}));

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
  mockPush.mockClear();

  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ templates: TEMPLATES }),
  });
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("TemplatesPage", () => {
  it("shows loading skeleton while fetching templates", () => {
    render(<TemplatesPage />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading templates/i);
  });

  it("renders the page heading", () => {
    render(<TemplatesPage />);
    expect(
      screen.getByRole("heading", { name: /start with a template/i }),
    ).toBeInTheDocument();
  });

  it("renders the browse templates section heading", () => {
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

  it("renders the template region with correct count", async () => {
    render(<TemplatesPage />);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    const region = screen.getByRole("region", { name: /showing 4 templates/i });
    expect(region).toBeInTheDocument();
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
});
