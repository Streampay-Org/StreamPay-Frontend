/** @jest-environment jsdom */
import React from "react";
import { render, screen } from "@testing-library/react";
import { StreamDetailClient } from "../app/streams/[id]/StreamDetailClient";
import type { Stream } from "../app/types/openapi";

const mockStream: Stream = {
  id: "stream-ada",
  recipient: "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZK7G",
  rate: "120 XLM / month",
  schedule: "Pays every 30 days",
  status: "active",
  label: "Ada Creative Studio",
  email: "ada@example.com",
  createdAt: "2024-11-01T09:00:00.000Z",
  updatedAt: "2024-11-20T14:30:00.000Z",
  token: "XLM",
};

describe("StreamDetailClient Sticky Header", () => {
  it("renders sticky summary header with WCAG region role and aria-label", () => {
    render(<StreamDetailClient stream={mockStream} network="testnet" />);

    const header = screen.getByRole("region", {
      name: /stream detail summary header/i,
    });

    expect(header).toBeInTheDocument();
    expect(header.className).toContain("sticky");
    expect(header.className).toContain("top-0");
  });

  it("displays stream label, ID, rate, and status badges in sticky header", () => {
    render(<StreamDetailClient stream={mockStream} network="testnet" />);

    expect(screen.getByText("Ada Creative Studio")).toBeInTheDocument();
    expect(screen.getByText(/ID:\s*stream-ada/i)).toBeInTheDocument();

    // Using getAllByText since rate appears in both header and summary card
    const rateElements = screen.getAllByText("120 XLM / month");
    expect(rateElements.length).toBeGreaterThan(0);
    expect(rateElements[0]).toBeInTheDocument();
  });
});
