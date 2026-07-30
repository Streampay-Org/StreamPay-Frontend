/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { IndexerStatus, type IndexerStatusData } from "./IndexerStatus";

const baseData: IndexerStatusData = {
  network: "testnet",
  lastProcessedLedger: 1_234_567,
  latestLedger: 1_234_568,
  status: "synced",
  lastUpdatedAt: new Date().toISOString(),
  lag: 1,
};

describe("IndexerStatus", () => {
  it("renders the card with a labelled heading", () => {
    render(<IndexerStatus data={baseData} />);
    expect(
      screen.getByRole("heading", { name: /indexer status/i }),
    ).toBeInTheDocument();
  });

  it("shows the network label", () => {
    render(<IndexerStatus data={baseData} />);
    expect(screen.getByText("testnet")).toBeInTheDocument();
  });

  it("displays the last processed ledger with tabular-nums formatting", () => {
    render(<IndexerStatus data={baseData} />);
    const dd = screen.getByLabelText(/last processed ledger/i);
    expect(dd).toHaveTextContent("1,234,567");
  });

  it("displays the latest ledger", () => {
    render(<IndexerStatus data={baseData} />);
    const dd = screen.getByLabelText(/latest ledger/i);
    expect(dd).toHaveTextContent("1,234,568");
  });

  it("shows the lag in ledgers", () => {
    render(<IndexerStatus data={{ ...baseData, lag: 42 }} />);
    const dd = screen.getByLabelText(/lag 42 ledgers/i);
    expect(dd).toHaveTextContent(/42/);
    expect(dd).toHaveTextContent(/ledgers/);
  });

  it("formats large lag with k-suffix", () => {
    render(<IndexerStatus data={{ ...baseData, lag: 1234 }} />);
    const dd = screen.getByLabelText(/lag 1234 ledgers/i);
    expect(dd).toHaveTextContent(/1\.2k/);
  });

  it("displays synced status label and success styling", () => {
    render(<IndexerStatus data={baseData} />);
    expect(screen.getByText("Synced")).toBeInTheDocument();
    const section = screen.getByRole("region", { name: /indexer status/i });
    expect(section.className).toContain("indexer-status--success");
  });

  it("displays syncing status label and warning styling", () => {
    render(
      <IndexerStatus
        data={{ ...baseData, status: "syncing", lag: 10 }}
      />,
    );
    expect(screen.getByText("Syncing")).toBeInTheDocument();
    const section = screen.getByRole("region", { name: /indexer status/i });
    expect(section.className).toContain("indexer-status--warning");
  });

  it("displays stalled status label and error styling", () => {
    render(<IndexerStatus data={{ ...baseData, status: "stalled" }} />);
    expect(screen.getByText("Stalled")).toBeInTheDocument();
    const section = screen.getByRole("region", { name: /indexer status/i });
    expect(section.className).toContain("indexer-status--error");
  });

  it("displays stopped status label and warning styling", () => {
    render(<IndexerStatus data={{ ...baseData, status: "stopped" }} />);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    const section = screen.getByRole("region", { name: /indexer status/i });
    expect(section.className).toContain("indexer-status--warning");
  });

  it("displays error status label and error styling", () => {
    render(<IndexerStatus data={{ ...baseData, status: "error" }} />);
    expect(screen.getByText("Error")).toBeInTheDocument();
    const section = screen.getByRole("region", { name: /indexer status/i });
    expect(section.className).toContain("indexer-status--error");
  });

  it("renders a relative timestamp", () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    render(<IndexerStatus data={{ ...baseData, lastUpdatedAt: recent }} />);
    expect(screen.getByText(/30s ago|updated/)).toBeInTheDocument();
  });

  it("shows just now for very recent updates", () => {
    const now = new Date().toISOString();
    render(<IndexerStatus data={{ ...baseData, lastUpdatedAt: now }} />);
    expect(screen.getByText(/just now/)).toBeInTheDocument();
  });

  it("shows hours ago for older timestamps", () => {
    const old = new Date(Date.now() - 3_600_000 * 2).toISOString();
    render(<IndexerStatus data={{ ...baseData, lastUpdatedAt: old }} />);
    expect(screen.getByText(/2h ago/)).toBeInTheDocument();
  });

  it("forwards additional class names", () => {
    render(<IndexerStatus data={baseData} className="custom-class" />);
    const section = screen.getByRole("region", { name: /indexer status/i });
    expect(section.className).toContain("custom-class");
  });

  it("falls back to raw ISO when timestamp is invalid", () => {
    render(
      <IndexerStatus
        data={{ ...baseData, lastUpdatedAt: "not-a-date" }}
      />,
    );
    expect(screen.getByText(/updated not-a-date/)).toBeInTheDocument();
  });
});
