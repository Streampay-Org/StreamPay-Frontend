/**
 * @jest-environment jsdom
 */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AmendStreamModal } from "./AmendStreamModal";
import type { Stream } from "../types/openapi";

const baseStream: Stream = {
  id: "stream-ui-1",
  recipient: "GRECIP333333333333333333333333333333333333333333333333333",
  senderAddress: "GSENDER11111111111111111111111111111111111111111111111111",
  rate: "10",
  schedule: "Continuous",
  status: "active",
  token: "XLM",
  startTime: new Date(Date.now() - 3600_000).toISOString(),
  endTime: new Date(Date.now() + 24 * 3600_000).toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("AmendStreamModal", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("renders accessible dialog with labelled fields and total preview", () => {
    render(
      <AmendStreamModal
        isOpen={true}
        onClose={jest.fn()}
        stream={baseStream}
        onAmended={jest.fn()}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText(/Rate \(XLM\/sec\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/End date/i)).toBeInTheDocument();
    expect(screen.getByTestId("amend-total-preview")).toBeInTheDocument();
  });

  it("validates non-positive rate before submitting", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");
    render(
      <AmendStreamModal
        isOpen={true}
        onClose={jest.fn()}
        stream={baseStream}
        onAmended={jest.fn()}
      />,
    );

    const rateInput = screen.getByLabelText(/Rate \(XLM\/sec\)/i);
    fireEvent.change(rateInput, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /Save amendment/i }));

    expect(await screen.findByText(/Rate must be greater than 0/i)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows server error without closing the modal", async () => {
    const onClose = jest.fn();
    jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: "FORBIDDEN", message: "Only the stream sender may amend this stream." },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(
      <AmendStreamModal
        isOpen={true}
        onClose={onClose}
        stream={baseStream}
        onAmended={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Save amendment/i }));

    expect(await screen.findByTestId("amend-server-error")).toHaveTextContent(
      "Only the stream sender may amend this stream.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows approval notice when server responds with 202", async () => {
    const onClose = jest.fn();
    const onApprovalRequired = jest.fn();
    jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { id: "appr-1", action: "amend", status: "pending" },
          meta: { approvalRequired: true },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(
      <AmendStreamModal
        isOpen={true}
        onClose={onClose}
        stream={baseStream}
        onAmended={jest.fn()}
        onApprovalRequired={onApprovalRequired}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Save amendment/i }));

    expect(await screen.findByTestId("amend-approval-notice")).toHaveTextContent(
      /submitted for organization approval/i,
    );
    expect(onApprovalRequired).toHaveBeenCalledWith(
      expect.objectContaining({ id: "appr-1", action: "amend" }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onAmended and closes on 200, sending Idempotency-Key", async () => {
    const onClose = jest.fn();
    const onAmended = jest.fn();
    const updatedStream: Stream = { ...baseStream, rate: "25" };

    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: updatedStream }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(
      <AmendStreamModal
        isOpen={true}
        onClose={onClose}
        stream={baseStream}
        onAmended={onAmended}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Rate \(XLM\/sec\)/i), {
      target: { value: "25" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save amendment/i }));

    await waitFor(() => {
      expect(onAmended).toHaveBeenCalledWith(updatedStream);
      expect(onClose).toHaveBeenCalled();
    });

    const [, init] = fetchSpy.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeTruthy();
  });
});
