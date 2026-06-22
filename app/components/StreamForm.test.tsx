/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react";
const { fireEvent, screen, waitFor } = require("@testing-library/react") as any;
import { StreamForm } from "./StreamForm";

const mockPush = jest.fn();
const mockPost = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@/lib/apiClient", () => ({
  post: (...args: unknown[]) => mockPost(...args),
}));

// Mock wallet-link so our test keys always pass client-side validation
jest.mock("@/app/lib/wallet-link", () => ({
  isValidStellarPublicKey: (key: string) =>
    key === "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZK7G",
}));

const VALID_STELLAR_KEY = "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZK7G";

function fillField(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function selectOption(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("StreamForm", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders all form fields and the submit button", () => {
    render(<StreamForm />);

    expect(screen.getByLabelText(/recipient/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/rate/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/schedule/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/token/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create stream/i })).toBeInTheDocument();
  });

  it("shows client-side validation errors when submitting empty form", async () => {
    render(<StreamForm />);

    fireEvent.click(screen.getByRole("button", { name: /create stream/i }));

    await waitFor(() => {
      expect(screen.getByText(/recipient is required/i)).toBeInTheDocument();
      expect(screen.getByText(/rate is required/i)).toBeInTheDocument();
      expect(screen.getByText(/schedule is required/i)).toBeInTheDocument();
    });

    expect(mockPost).not.toHaveBeenCalled();
  });

  it("shows field-level error for invalid stellar key", async () => {
    render(<StreamForm />);

    fillField("Recipient", "INVALID_KEY");
    fillField("Rate", "100");
    selectOption("Schedule", "month");

    fireEvent.click(screen.getByRole("button", { name: /create stream/i }));

    await waitFor(() => {
      expect(screen.getByText(/valid stellar public key/i)).toBeInTheDocument();
    });

    expect(mockPost).not.toHaveBeenCalled();
  });

  it("shows field-level error for negative rate", async () => {
    render(<StreamForm />);

    fillField("Recipient", VALID_STELLAR_KEY);
    fillField("Rate", "-10");
    selectOption("Schedule", "month");

    fireEvent.click(screen.getByRole("button", { name: /create stream/i }));

    await waitFor(() => {
      expect(screen.getByText(/positive decimal number/i)).toBeInTheDocument();
    });

    expect(mockPost).not.toHaveBeenCalled();
  });

  it("submits valid data and redirects on success", async () => {
    mockPost.mockResolvedValueOnce({
      id: "stream_new123",
      recipient: VALID_STELLAR_KEY,
      rate: "100",
      status: "draft",
      allowed_actions: ["start"],
      created_at: new Date().toISOString(),
      settlement: null,
    });

    render(<StreamForm />);

    fillField("Recipient", VALID_STELLAR_KEY);
    fillField("Rate", "100");
    selectOption("Schedule", "month");

    fireEvent.click(screen.getByRole("button", { name: /create stream/i }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith("/api/v2/streams", {
        recipient: VALID_STELLAR_KEY,
        rate: "100",
        schedule: "month",
      });
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/streams/stream_new123");
    });
  });

  it("submits with optional token field", async () => {
    mockPost.mockResolvedValueOnce({
      id: "stream_token123",
      recipient: VALID_STELLAR_KEY,
      rate: "50",
      status: "draft",
      allowed_actions: ["start"],
      created_at: new Date().toISOString(),
      settlement: null,
    });

    render(<StreamForm />);

    fillField("Recipient", VALID_STELLAR_KEY);
    fillField("Rate", "50");
    selectOption("Schedule", "week");
    fillField("Token (optional)", "XLM");

    fireEvent.click(screen.getByRole("button", { name: /create stream/i }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith("/api/v2/streams", {
        recipient: VALID_STELLAR_KEY,
        rate: "50",
        schedule: "week",
        token: "XLM",
      });
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/streams/stream_token123");
    });
  });

  it("disables submit button while submitting", async () => {
    let resolvePromise!: (value: unknown) => void;
    mockPost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePromise = resolve;
        }),
    );

    render(<StreamForm />);

    fillField("Recipient", VALID_STELLAR_KEY);
    fillField("Rate", "100");
    selectOption("Schedule", "month");

    const submitBtn = screen.getByRole("button", { name: /create stream/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /creating stream/i })).toBeDisabled();
    });

    // Resolve the pending promise so the test doesn't hang
    resolvePromise({
      id: "stream_busy",
      recipient: VALID_STELLAR_KEY,
      rate: "100",
      status: "draft",
      allowed_actions: ["start"],
      created_at: new Date().toISOString(),
      settlement: null,
    });
  });

  it("renders server validation errors mapped to fields", async () => {
    const serverError = new Error("Validation failed");
    (serverError as any).status = 422;
    (serverError as any).code = "VALIDATION_ERROR";
    (serverError as any).meta = {
      "0": {
        field: "recipient",
        code: "INVALID_STELLAR_KEY",
        message: "recipient must be a valid Stellar public key.",
      },
    };

    mockPost.mockRejectedValueOnce(serverError);

    render(<StreamForm />);

    fillField("Recipient", VALID_STELLAR_KEY);
    fillField("Rate", "100");
    selectOption("Schedule", "month");

    fireEvent.click(screen.getByRole("button", { name: /create stream/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/recipient must be a valid Stellar public key/i),
      ).toBeInTheDocument();
    });
  });

  it("renders ErrorBanner for non-422 server errors", async () => {
    const serverError = new Error("Server error");
    (serverError as any).status = 500;
    (serverError as any).code = "INTERNAL_ERROR";
    (serverError as any).title = "Internal Server Error";
    (serverError as any).detail = "Something went wrong on our end.";
    (serverError as any).category = "server";
    (serverError as any).retry = { retryable: true };

    mockPost.mockRejectedValueOnce(serverError);

    render(<StreamForm />);

    fillField("Recipient", VALID_STELLAR_KEY);
    fillField("Rate", "100");
    selectOption("Schedule", "month");

    fireEvent.click(screen.getByRole("button", { name: /create stream/i }));

    await waitFor(() => {
      expect(screen.getByTestId("error-banner")).toBeInTheDocument();
    });
  });
});
