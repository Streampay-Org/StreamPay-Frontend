/**
 * @jest-environment jsdom
 */

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import TemplatesPage, { formatInterval } from "./page";

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
    amountPerInterval: "50",
    intervalSeconds: 2592000,
    memo: "Automated monthly savings",
    createdAt: "2026-01-15T00:00:00.000Z",
  },
  {
    id: "tpl_2",
    name: "Freelancer Income",
    asset: "USDC",
    amountPerInterval: "2000",
    intervalSeconds: 604800,
    memo: "Weekly freelancer payout",
    createdAt: "2026-02-10T00:00:00.000Z",
  },
  {
    id: "tpl_3",
    name: "Utility Bill",
    asset: "XLM",
    amountPerInterval: "120",
    intervalSeconds: 2592000,
    memo: "Monthly utility payment",
    createdAt: "2026-03-05T00:00:00.000Z",
  },
  {
    id: "tpl_4",
    name: "Savings Roundup",
    asset: "XLM",
    amountPerInterval: "10",
    intervalSeconds: 86400,
    createdAt: "2026-04-20T00:00:00.000Z",
  },
  {
    id: "tpl_5",
    name: "Rent Split",
    asset: "USDC",
    amountPerInterval: 750,
    intervalSeconds: 2592000,
    memo: "Monthly rent contribution",
    createdAt: "2026-05-01T00:00:00.000Z",
  },
  {
    id: "tpl_6",
    name: "Micro Investment",
    asset: "XLM",
    amountPerInterval: 5,
    intervalSeconds: 3600,
    memo: "Hourly micro-investing",
    createdAt: "2026-06-01T00:00:00.000Z",
  },
];

describe("TemplatesPage (Server Component)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("server page render with 6 seeds renders all 6 template names", async () => {
    jest.mocked(templatesRepo.listTemplates).mockResolvedValue(MOCK_SEEDS);

    const jsx = await TemplatesPage();
    render(jsx);

    expect(screen.getByRole("heading", { name: "Monthly Savings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Freelancer Income" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Utility Bill" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Savings Roundup" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Rent Split" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Micro Investment" })).toBeInTheDocument();
  });

  it("renders empty state on the server when repository returns empty array", async () => {
    jest.mocked(templatesRepo.listTemplates).mockResolvedValue([]);

    const jsx = await TemplatesPage();
    render(jsx);

    expect(screen.getByRole("heading", { name: /no templates available/i })).toBeInTheDocument();
  });

  it("propagates repository error when listTemplates throws", async () => {
    jest.mocked(templatesRepo.listTemplates).mockRejectedValue(new Error("Database connection failed"));

    await expect(TemplatesPage()).rejects.toThrow("Database connection failed");
  });

  it("navigates with exact decimal string rate without scientific notation on apply (Scenario 7)", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const microTemplate = {
      id: "tpl_micro",
      name: "Micro Stream",
      asset: "USDC",
      amountPerInterval: "0.0000001",
      intervalSeconds: 86400,
      memo: "Micro payment",
      createdAt: "2026-04-20T00:00:00.000Z",
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ templates: [microTemplate] }),
    });

    await renderLoaded();
    const applyButton = screen.getByRole("button", { name: /use template/i });
    await user.click(applyButton);

    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining("rate=0.0000001"),
    );
    expect(mockPush).not.toHaveBeenCalledWith(
      expect.stringContaining("1e-7"),
    );
  });
});

describe("formatInterval (Scenario 8)", () => {
  it("formats whole intervals without fractional units", () => {
    expect(formatInterval(129600)).toBe("36 hours");
    expect(formatInterval(86400)).toBe("Daily");
    expect(formatInterval(172800)).toBe("2 days");
    expect(formatInterval(2592000)).toBe("30 days");
    expect(formatInterval(3600)).toBe("Hourly");
    expect(formatInterval(7200)).toBe("2 hours");
    expect(formatInterval(60)).toBe("Minute");
    expect(formatInterval(180)).toBe("3 minutes");
    expect(formatInterval(45)).toBe("45s");
  });
});

