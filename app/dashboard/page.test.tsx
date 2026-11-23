/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react";
const { screen } = require("@testing-library/react") as any;
import DashboardPage from "./page";

const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => "/dashboard",
}));

describe("DashboardPage", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockPush.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("renders skeletons while loading", () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    render(<DashboardPage />);

    expect(screen.getByTestId("dashboard-skeleton")).toBeInTheDocument();
    expect(screen.getByText("Loading dashboard statistics…")).toBeInTheDocument();
  });

  it("renders summary tiles with formatted BigInt totals per token", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          counts: {
            draft: 1,
            active: 3,
            paused: 2,
            ended: 4,
            withdrawn: 0,
            cancelled: 0,
          },
          totals: {
            XLM: {
              escrowed: "123456789",
              released: "10000000",
            },
            USDC: {
              escrowed: "90071992547409930000000",
              released: "50000000",
            },
          },
          skipped: 0,
        },
      }),
    }) as unknown as typeof fetch;

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByTestId("dashboard-stats")).toBeInTheDocument();
    });

    expect(screen.getByTestId("stat-active")).toHaveTextContent("3");
    expect(screen.getByTestId("stat-paused")).toHaveTextContent("2");
    expect(screen.getByTestId("stat-ended")).toHaveTextContent("4");
    expect(screen.getByTestId("stat-escrowed")).toHaveTextContent("12.3456789 XLM");
    expect(screen.getByTestId("stat-escrowed")).toHaveTextContent("9007199254740993.0000000 USDC");
    expect(screen.getByTestId("stat-released")).toHaveTextContent("1.0000000 XLM");
    expect(screen.getByTestId("stat-released")).toHaveTextContent("5.0000000 USDC");
  });

  it("renders an empty state when there are zero streams", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          counts: {
            draft: 0,
            active: 0,
            paused: 0,
            ended: 0,
            withdrawn: 0,
            cancelled: 0,
          },
          totals: {},
          skipped: 0,
        },
      }),
    }) as unknown as typeof fetch;

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText("Your dashboard is empty")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Create stream" }));
    expect(mockPush).toHaveBeenCalledWith("/streams/new");
  });

  it("renders an accessible error state and retries on button click", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            counts: {
              draft: 0,
              active: 1,
              paused: 0,
              ended: 0,
              withdrawn: 0,
              cancelled: 0,
            },
            totals: {
              XLM: { escrowed: "10000000", released: "0" },
            },
            skipped: 0,
          },
        }),
      });

    global.fetch = fetchMock as unknown as typeof fetch;

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText("Could not load dashboard")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(screen.getByTestId("dashboard-stats")).toBeInTheDocument();
    });
    expect(screen.getByTestId("stat-active")).toHaveTextContent("1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
