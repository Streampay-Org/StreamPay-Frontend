/**
 * @jest-environment jsdom
 */

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { TemplatesBrowser } from "./TemplatesBrowser";

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

jest.mock("next/navigation");

function setUrl(query = "") {
  jest
    .mocked(useSearchParams)
    .mockReturnValue(
      new URLSearchParams(query) as ReturnType<typeof useSearchParams>
    );
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
  HTMLElement.prototype.scrollIntoView = jest.fn();
  mockPush.mockClear();
  mockReplace.mockClear();
  jest.mocked(useRouter).mockReturnValue(mockRouter);
  jest.mocked(usePathname).mockReturnValue("/templates");
  setUrl();
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("TemplatesBrowser", () => {
  it("renders all initial templates", () => {
    render(<TemplatesBrowser initialTemplates={TEMPLATES} />);
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(
      screen.getByRole("heading", { name: "Monthly Savings" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Freelancer Income" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Utility Bill" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Savings Roundup" })
    ).toBeInTheDocument();
  });

  it("renders empty state when initialTemplates is empty", () => {
    render(<TemplatesBrowser initialTemplates={[]} />);
    expect(
      screen.getByRole("heading", { name: /no templates available/i })
    ).toBeInTheDocument();
  });

  it("filters templates by category", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TemplatesBrowser initialTemplates={TEMPLATES} />);

    const incomeTab = screen.getByRole("tab", { name: "Income" });
    await user.click(incomeTab);

    expect(mockReplace).toHaveBeenCalledWith("/templates?category=income", {
      scroll: false,
    });
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "Freelancer Income" })
    ).toBeInTheDocument();
  });

  it("filters templates by search term with debounce", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TemplatesBrowser initialTemplates={TEMPLATES} />);

    const searchInput = screen.getByRole("searchbox", {
      name: /search templates/i,
    });
    await user.type(searchInput, "Utility");

    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(mockReplace).toHaveBeenCalledWith("/templates?q=Utility", {
      scroll: false,
    });
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "Utility Bill" })
    ).toBeInTheDocument();
  });

  it("navigates to /streams/new when Use template is clicked", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TemplatesBrowser initialTemplates={TEMPLATES} />);

    const firstCard = screen.getAllByRole("article")[0];
    const applyButton = within(firstCard).getByRole("button", {
      name: /use template/i,
    });
    await user.click(applyButton);

    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining("/streams/new?")
    );
    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining("templateId=tpl_1")
    );
  });

  it("supports keyboard navigation on category tabs", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TemplatesBrowser initialTemplates={TEMPLATES} />);

    const allTab = screen.getByRole("tab", { name: "All" });
    allTab.focus();

    await user.keyboard("{ArrowRight}");
    const savingsTab = screen.getByRole("tab", { name: "Savings" });
    expect(savingsTab).toHaveFocus();

    await user.keyboard("{End}");
    const customTab = screen.getByRole("tab", { name: "Custom" });
    expect(customTab).toHaveFocus();

    await user.keyboard("{Home}");
    expect(allTab).toHaveFocus();
  });

  it("shows no-results empty state and allows clearing filters", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<TemplatesBrowser initialTemplates={TEMPLATES} />);

    const searchInput = screen.getByRole("searchbox", {
      name: /search templates/i,
    });
    await user.type(searchInput, "nonexistent");
    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(
      screen.getByRole("heading", { name: /no templates found/i })
    ).toBeInTheDocument();

    const clearButton = screen.getByRole("button", { name: /clear filters/i });
    await user.click(clearButton);

    expect(screen.getAllByRole("article")).toHaveLength(4);
  });

  it("has no axe violations in populated and empty panels", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { container } = render(<TemplatesBrowser initialTemplates={TEMPLATES} />);
    jest.useRealTimers();
    expect(await axe(container)).toHaveNoViolations();
    jest.useFakeTimers();
    await user.click(screen.getByRole("tab", { name: "Custom" }));
    jest.useRealTimers();
    expect(await axe(container)).toHaveNoViolations();
    jest.useFakeTimers();
  });
});
