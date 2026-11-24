/**
 * @jest-environment jsdom
 */

import React, { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { DeleteAccountDialog } from "./DeleteAccountDialog";
import { fetchWithIdempotency } from "@/lib/apiClient";

jest.mock("@/lib/apiClient", () => ({
  fetchWithIdempotency: jest.fn(),
}));

const mockedFetch = fetchWithIdempotency as jest.MockedFunction<
  typeof fetchWithIdempotency
>;

function finishDialogClose() {
  const overlay = document.querySelector('[data-modal-overlay="true"]');
  if (overlay) fireEvent.animationEnd(overlay);
}

function Harness({
  getAuthToken = () => "test-jwt-token",
}: {
  getAuthToken?: () => string | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
      >
        Request account deletion
      </button>
      <DeleteAccountDialog
        isOpen={open}
        onClose={() => setOpen(false)}
        restoreFocusTarget={triggerRef}
        getAuthToken={getAuthToken}
      />
    </div>
  );
}

describe("DeleteAccountDialog", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  afterEach(() => {
    finishDialogClose();
    jest.restoreAllMocks();
  });

  it("requires typing DELETE before submitting and sends nothing on cancel", () => {
    render(<Harness />);

    const trigger = screen.getByRole("button", {
      name: "Request account deletion",
    });
    trigger.focus();
    fireEvent.click(trigger);

    const submitButton = screen.getByRole("button", {
      name: "Request account deletion",
    });
    const input = screen.getByLabelText(/Type DELETE to confirm/i);

    expect(submitButton).toBeDisabled();

    fireEvent.change(input, { target: { value: "delete" } });
    expect(submitButton).toBeDisabled();

    fireEvent.change(input, { target: { value: "DELETE" } });
    expect(submitButton).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    finishDialogClose();

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes on Escape and restores focus to the trigger", () => {
    render(<Harness />);

    const trigger = screen.getByRole("button", {
      name: "Request account deletion",
    });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    finishDialogClose();

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("submits with Bearer token, prevents double submission, and displays 202 confirmation with copy", async () => {
    let resolveRequest!: (value: unknown) => void;
    mockedFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<Harness getAuthToken={() => "session-token-xyz"} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Request account deletion" }),
    );
    fireEvent.change(screen.getByLabelText(/Type DELETE to confirm/i), {
      target: { value: "DELETE" },
    });

    const submitButton = screen.getByRole("button", {
      name: "Request account deletion",
    });
    fireEvent.click(submitButton);
    fireEvent.click(submitButton);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toBe("/api/identity/me/delete");
    expect(init?.method).toBe("DELETE");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer session-token-xyz",
    );
    expect(
      screen.getByRole("button", { name: "Requesting deletion..." }),
    ).toBeDisabled();

    resolveRequest({
      data: {
        requestId: "dsr-abc-123",
        status: "processing",
        message: "Your deletion request has been received.",
        completion_estimate: "2026-12-23T12:00:00.000Z",
      },
    });

    expect(
      await screen.findByRole("heading", { name: "Deletion request received" }),
    ).toBeInTheDocument();
    expect(screen.getByText("dsr-abc-123")).toBeInTheDocument();
    expect(screen.getByText("processing")).toBeInTheDocument();
    expect(screen.getByText(/Dec 23, 2026/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy request ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("dsr-abc-123"));
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });

  it("shows an accessible error with server request_id and retry on 401/500 failure", async () => {
    mockedFetch
      .mockRejectedValueOnce({
        code: "UNAUTHORIZED",
        message: "Missing or invalid authorization header",
        requestId: "req-401-xyz",
      })
      .mockResolvedValueOnce({
        data: {
          requestId: "dsr-retry-789",
          status: "processing",
          completion_estimate: "2026-12-23T12:00:00.000Z",
        },
      });

    render(<Harness />);

    fireEvent.click(
      screen.getByRole("button", { name: "Request account deletion" }),
    );
    fireEvent.change(screen.getByLabelText(/Type DELETE to confirm/i), {
      target: { value: "DELETE" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Request account deletion" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/session has expired/i);
    expect(alert).toHaveTextContent("req-401-xyz");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("dsr-retry-789")).toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("handles network failures with a recoverable retry state", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("Network error"));

    render(<Harness />);

    fireEvent.click(
      screen.getByRole("button", { name: "Request account deletion" }),
    );
    fireEvent.change(screen.getByLabelText(/Type DELETE to confirm/i), {
      target: { value: "DELETE" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Request account deletion" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Network error");
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("has no serious accessibility violations", async () => {
    render(<Harness />);

    fireEvent.click(
      screen.getByRole("button", { name: "Request account deletion" }),
    );

    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  });
});
