/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AnalyticsPage from "./page";

const WALLET = "G-WALLET";

function identityResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ data: { wallet_address: WALLET } }),
  };
}

function streamsResponse(data: unknown[] = []) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data, meta: { hasNext: false, nextCursor: null } }),
  };
}

describe("AnalyticsPage", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("loads the forecast, updates the selected range, and keeps totals and daily table exact", async () => {
    jest.spyOn(global, "fetch")
      .mockResolvedValueOnce(identityResponse() as Response)
      .mockResolvedValueOnce(streamsResponse([
        {
          id: "incoming",
          status: "active",
          rate: "1.0000001",
          schedule: "day",
          recipient: WALLET,
          senderAddress: "G-SENDER",
          startTime: "2020-01-01T00:00:00.000Z",
        },
        {
          id: "outgoing",
          status: "active",
          rate: "0.5",
          schedule: "day",
          recipient: "G-RECIPIENT",
          senderAddress: WALLET,
          startTime: "2020-01-01T00:00:00.000Z",
        },
      ]) as Response);

    render(<AnalyticsPage />);

    expect(await screen.findByTestId("forecast-incoming")).toHaveTextContent("30.0000030");
    expect(screen.getByTestId("forecast-outgoing")).toHaveTextContent("15.0000000");
    expect(screen.getByTestId("forecast-net")).toHaveTextContent("15.0000030");
    expect(screen.getAllByRole("row")).toHaveLength(31);

    fireEvent.change(screen.getByLabelText("Forecast range"), { target: { value: "7" } });
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(8));
    expect(screen.getByTestId("forecast-incoming")).toHaveTextContent("7.0000007");
    expect(screen.getByTestId("forecast-outgoing")).toHaveTextContent("3.5000000");
    expect(screen.getByTestId("forecast-net")).toHaveTextContent("3.5000007");

    const firstDataRow = screen.getAllByRole("row")[1];
    expect(within(firstDataRow).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "1.0000001",
      "0.5000000",
      "0.5000001",
    ]);
  });

  it("shows a disconnected-wallet state without requesting streams", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(identityResponse(401) as Response);

    render(<AnalyticsPage />);

    expect(await screen.findByRole("heading", { name: "Connect your wallet" })).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("shows an explicit loading error and supports retry", async () => {
    jest.spyOn(global, "fetch")
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(identityResponse() as Response)
      .mockResolvedValueOnce(streamsResponse() as Response);

    render(<AnalyticsPage />);

    expect(await screen.findByRole("heading", { name: "Could not load cash-flow forecast" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "No streams to forecast" })).toBeInTheDocument();
  });
});
