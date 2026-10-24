/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import TemplatesPage from "./page";
import * as templatesRepo from "../lib/repositories/templates";

jest.mock("../lib/repositories/templates");
jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  usePathname: () => "/templates",
  useSearchParams: () => new URLSearchParams(),
}));

const MOCK_SEEDS = [
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
});
