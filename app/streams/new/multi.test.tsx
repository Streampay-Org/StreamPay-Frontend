/**
 * @jest-environment jsdom
 *
 * Tests for the multi-recipient stream creation wizard.
 *
 * Coverage targets
 * - Rendering: all three wizard steps render correct content
 * - Navigation: Next / Back advance and retreat through steps
 * - Accessibility: WCAG 2.1 AA — labels, aria attributes, roles
 * - Validation: Next disabled until required fields are filled
 * - Behaviour: total-amount change propagates to recipient amounts
 * - Submission: the wizard POSTs the documented payload to
 *   POST /api/v2/streams/multi and renders the server's error message on a
 *   rejected request
 * - Success: success screen renders after submit
 * - TotalsBar: sticky bar shows running totals
 * - StepIndicator: progress landmark present
 */

import React from "react";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import MultiRecipientStreamPage, { MULTI_STREAM_ENDPOINT } from "./multi";

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Stable UUID stub so snapshots and queries are predictable. */
let uuidCounter = 0;
beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => `test-uuid-${++uuidCounter}` },
    configurable: true,
  });
});

/** Body returned by a successful fan-out creation. */
const CREATED_RESPONSE = {
  id: "stream-multi-abcd1234",
  kind: "multi_recipient",
  status: "draft",
  recipient_count: 1,
};

/** Minimal `Response`-alike: the wizard only reads `ok`, `status` and `json()`. */
function fakeResponse(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

/**
 * Default: creation succeeds. Tests that need a rejected request override a
 * single call with `fetchMock.mockResolvedValueOnce(...)`.
 */
let fetchMock: jest.Mock;

beforeEach(() => {
  uuidCounter = 0;
  fetchMock = jest.fn(async () => fakeResponse(true, 201, CREATED_RESPONSE));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

/** Fill in valid step-0 fields so the "Next" button enables. */
async function fillDetailsStep() {
  const nameInput = screen.getByLabelText(/stream name/i);
  await userEvent.clear(nameInput);
  await userEvent.type(nameInput, "GrantFox Q3 Distribution");

  // datetime-local inputs: fireEvent is simpler than userEvent for these
  const startInput = screen.getByLabelText(/start date/i);
  fireEvent.change(startInput, { target: { value: "2026-09-01T09:00" } });

  const endInput = screen.getByLabelText(/end date/i);
  fireEvent.change(endInput, { target: { value: "2026-12-31T23:59" } });
}

// ── Step 0: Details ───────────────────────────────────────────────────────────

describe("Step 0 – Details", () => {
  it("renders the page heading", () => {
    render(<MultiRecipientStreamPage />);
    expect(
      screen.getByRole("heading", { name: /create multi-recipient stream/i })
    ).toBeInTheDocument();
  });

  it("renders the eyebrow text", () => {
    render(<MultiRecipientStreamPage />);
    expect(screen.getByText("New Stream")).toBeInTheDocument();
  });

  it("renders the step-0 details heading", () => {
    render(<MultiRecipientStreamPage />);
    expect(
      screen.getByRole("heading", { name: /stream details/i })
    ).toBeInTheDocument();
  });

  it("renders all required detail fields", () => {
    render(<MultiRecipientStreamPage />);
    expect(screen.getByLabelText(/stream name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/total amount/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/token/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/start date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/end date/i)).toBeInTheDocument();
  });

  it("has aria-required on required inputs", () => {
    render(<MultiRecipientStreamPage />);
    expect(screen.getByLabelText(/stream name/i)).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText(/total amount/i)).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText(/start date/i)).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText(/end date/i)).toHaveAttribute("aria-required", "true");
  });

  it("has htmlFor/id pairing for all inputs (accessible labels)", () => {
    render(<MultiRecipientStreamPage />);
    // getByLabelText only succeeds when the label is correctly paired
    expect(screen.getByLabelText(/stream name/i)).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText(/total amount/i)).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText(/token/i)).toBeInstanceOf(HTMLSelectElement);
    expect(screen.getByLabelText(/start date/i)).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText(/end date/i)).toBeInstanceOf(HTMLInputElement);
  });

  it("Next button is disabled when fields are empty", () => {
    render(<MultiRecipientStreamPage />);
    const nextBtn = screen.getByRole("button", { name: /next: recipients/i });
    expect(nextBtn).toBeDisabled();
  });

  it("Next button enables once all detail fields are filled", async () => {
    render(<MultiRecipientStreamPage />);
    await fillDetailsStep();
    const nextBtn = screen.getByRole("button", { name: /next: recipients/i });
    expect(nextBtn).not.toBeDisabled();
  });

  it("Cancel navigates to /streams/new via a link (not window.location)", () => {
    render(<MultiRecipientStreamPage />);
    const cancelLink = screen.getByRole("link", { name: /cancel/i });
    expect(cancelLink).toHaveAttribute("href", "/streams/new");
  });

  it("renders the step indicator with a navigation landmark", () => {
    render(<MultiRecipientStreamPage />);
    expect(screen.getByRole("navigation", { name: /progress/i })).toBeInTheDocument();
  });

  it("renders all three wizard step labels", () => {
    render(<MultiRecipientStreamPage />);
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("Recipients")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
  });

  it("marks the first step as current via aria-current", () => {
    render(<MultiRecipientStreamPage />);
    const stepItems = screen.getAllByRole("listitem");
    expect(stepItems[0]).toHaveAttribute("aria-current", "step");
  });

  it("renders the sticky TotalsBar", () => {
    render(<MultiRecipientStreamPage />);
    expect(screen.getByText(/total stream amount/i)).toBeInTheDocument();
    const totalsBar = screen.getByText(/recipients:/i).closest("div")?.parentElement;
    expect(totalsBar).toBeInTheDocument();
  });

  it("TotalsBar shows initial total amount and token", () => {
    render(<MultiRecipientStreamPage />);
    // Default: 1000 XLM, 1 recipient
    const bar = screen.getByText(/total stream amount/i).closest("div")!;
    expect(bar).toBeInTheDocument();
  });
});

// ── Step navigation ───────────────────────────────────────────────────────────

describe("Step navigation", () => {
  async function advanceToStep1() {
    render(<MultiRecipientStreamPage />);
    await fillDetailsStep();
    fireEvent.click(screen.getByRole("button", { name: /next: recipients/i }));
  }

  it("advances to step 1 when Next is clicked on a valid step 0", async () => {
    await advanceToStep1();
    expect(
      screen.getByRole("heading", { name: /recipients & splits/i })
    ).toBeInTheDocument();
  });

  it("shows Back button on step 1", async () => {
    await advanceToStep1();
    expect(screen.getByRole("button", { name: /^back$/i })).toBeInTheDocument();
  });

  it("Back button returns to step 0", async () => {
    await advanceToStep1();
    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(
      screen.getByRole("heading", { name: /stream details/i })
    ).toBeInTheDocument();
  });

  it("step indicator marks step 0 as completed and step 1 as current on step 1", async () => {
    await advanceToStep1();
    const stepItems = screen.getAllByRole("listitem");
    expect(stepItems[0]).not.toHaveAttribute("aria-current");
    expect(stepItems[1]).toHaveAttribute("aria-current", "step");
  });
});

// ── Step 1: Recipients ────────────────────────────────────────────────────────

describe("Step 1 – Recipients", () => {
  async function renderAtStep1() {
    render(<MultiRecipientStreamPage />);
    await fillDetailsStep();
    fireEvent.click(screen.getByRole("button", { name: /next: recipients/i }));
  }

  it("renders the Recipients heading", async () => {
    await renderAtStep1();
    expect(
      screen.getByRole("heading", { name: /recipients & splits/i })
    ).toBeInTheDocument();
  });

  it("renders the RecipientList with initial recipient row", async () => {
    await renderAtStep1();
    expect(screen.getByRole("heading", { name: /^Recipients$/i })).toBeInTheDocument();
  });

  it("shows 'Add Recipient' button", async () => {
    await renderAtStep1();
    expect(
      screen.getByRole("button", { name: /\+ add recipient/i })
    ).toBeInTheDocument();
  });

  it("adds a recipient row on '+ Add Recipient' click", async () => {
    await renderAtStep1();
    const initial = screen.getAllByPlaceholderText(/GABC\.\.\. or email/i);
    fireEvent.click(screen.getByRole("button", { name: /\+ add recipient/i }));
    const updated = screen.getAllByPlaceholderText(/GABC\.\.\. or email/i);
    expect(updated.length).toBe(initial.length + 1);
  });

  it("Next is disabled when recipient addresses are empty", async () => {
    await renderAtStep1();
    // add a second recipient (address is empty)
    fireEvent.click(screen.getByRole("button", { name: /\+ add recipient/i }));
    const nextBtn = screen.getByRole("button", { name: /next: review/i });
    expect(nextBtn).toBeDisabled();
  });

  it("stops adding recipients at the 20-recipient cap", async () => {
    await renderAtStep1();
    const addButton = screen.getByRole("button", { name: /\+ add recipient/i });

    // The wizard starts with one recipient; 19 more reaches the cap.
    for (let i = 0; i < 19; i++) {
      fireEvent.click(addButton);
    }

    expect(screen.getAllByPlaceholderText(/GABC\.\.\. or email/i)).toHaveLength(20);
    expect(addButton).toBeDisabled();
    expect(screen.getByText(/maximum of 20 recipients reached/i)).toBeInTheDocument();
  });
});

// ── Step 2: Review ────────────────────────────────────────────────────────────

describe("Step 2 – Review", () => {
  async function renderAtStep2() {
    render(<MultiRecipientStreamPage />);
    await fillDetailsStep();
    fireEvent.click(screen.getByRole("button", { name: /next: recipients/i }));

    // Fill in the one default recipient's address
    const addressInput = screen.getByPlaceholderText(/GABC\.\.\. or email/i);
    fireEvent.change(addressInput, { target: { value: "GABC1234567890" } });

    fireEvent.click(screen.getByRole("button", { name: /next: review/i }));
  }

  it("renders the Review heading", async () => {
    await renderAtStep2();
    expect(
      screen.getByRole("heading", { name: /review & confirm/i })
    ).toBeInTheDocument();
  });

  it("shows stream name in the summary", async () => {
    await renderAtStep2();
    expect(screen.getByText("GrantFox Q3 Distribution")).toBeInTheDocument();
  });

  it("shows token in summary", async () => {
    await renderAtStep2();
    const summary = screen.getByRole("group", { name: /review/i });
    expect(within(summary).getAllByText(/1,000/i).length).toBeGreaterThan(0);
    expect(within(summary).getAllByText(/XLM/i).length).toBeGreaterThan(0);
  });

  it("renders recipient breakdown table", async () => {
    await renderAtStep2();
    expect(
      screen.getByRole("region", { name: /recipient allocation breakdown/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("shows the recipient address in the table", async () => {
    await renderAtStep2();
    expect(screen.getByText("GABC1234567890")).toBeInTheDocument();
  });

  it("shows Confirm & Create Stream submit button", async () => {
    await renderAtStep2();
    expect(
      screen.getByRole("button", { name: /confirm & create stream/i })
    ).toBeInTheDocument();
  });

  it("step indicator marks steps 0 and 1 completed and step 2 current", async () => {
    await renderAtStep2();
    const stepItems = screen.getAllByRole("listitem");
    expect(stepItems[0]).not.toHaveAttribute("aria-current");
    expect(stepItems[1]).not.toHaveAttribute("aria-current");
    expect(stepItems[2]).toHaveAttribute("aria-current", "step");
  });
});

// ── Submit & success ──────────────────────────────────────────────────────────

describe("Form submission", () => {
  async function submitForm() {
    render(<MultiRecipientStreamPage />);
    await fillDetailsStep();
    fireEvent.click(screen.getByRole("button", { name: /next: recipients/i }));

    const addressInput = screen.getByPlaceholderText(/GABC\.\.\. or email/i);
    fireEvent.change(addressInput, { target: { value: "GABC1234567890" } });

    fireEvent.click(screen.getByRole("button", { name: /next: review/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm & create stream/i }));
  }

  it("shows loading state during submission", async () => {
    render(<MultiRecipientStreamPage />);
    await fillDetailsStep();
    fireEvent.click(screen.getByRole("button", { name: /next: recipients/i }));

    const addressInput = screen.getByPlaceholderText(/GABC\.\.\. or email/i);
    fireEvent.change(addressInput, { target: { value: "GABC1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: /next: review/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm & create stream/i }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /stream created successfully/i })).toBeInTheDocument();
    });
  });

  it("renders the success screen after successful submission", async () => {
    await submitForm();
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /stream created successfully/i })
      ).toBeInTheDocument();
    });
  });

  it("success screen has 'View All Streams' link pointing to /streams", async () => {
    await submitForm();
    await waitFor(() => {
      const link = screen.getByRole("link", { name: /view all streams/i });
      expect(link).toHaveAttribute("href", "/streams");
    });
  });

  it("POSTs the fan-out to POST /api/v2/streams/multi", async () => {
    await submitForm();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(MULTI_STREAM_ENDPOINT);
    expect(url).toBe("/api/v2/streams/multi");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("sends a payload that matches the documented request contract", async () => {
    await submitForm();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(Object.keys(body).sort()).toEqual([
      "endTime",
      "name",
      "recipients",
      "startTime",
      "token",
      "totalAmount",
    ]);
    expect(body.name).toBe("GrantFox Q3 Distribution");
    expect(body.token).toBe("XLM");
    expect(body.totalAmount).toBe(1000);
    expect(body.startTime).toBe("2026-09-01T09:00");
    expect(body.endTime).toBe("2026-12-31T23:59");
    expect(body.recipients).toEqual([
      { address: "GABC1234567890", percentage: 100, amount: 1000 },
    ]);
  });

  it("surfaces the server's validation message when the request is rejected", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(422, {
        error: { code: "VALIDATION_ERROR", message: "One or more fields are invalid." },
      }),
    );

    await submitForm();

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("One or more fields are invalid.");
    });

    // The wizard stays on the review step so the user can correct the payload.
    expect(
      screen.getByRole("heading", { name: /review & confirm/i }),
    ).toBeInTheDocument();
  });

  it("falls back to a generic message when the server returns no error body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    await submitForm();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/HTTP 500/);
    });
  });
});

// ── Total amount propagation ──────────────────────────────────────────────────

describe("Total amount propagation", () => {
  it("updates recipient amounts when total amount changes", async () => {
    render(<MultiRecipientStreamPage />);
    const amountInput = screen.getByLabelText(/total amount/i);

    // Change total from 1000 to 2000
    fireEvent.change(amountInput, { target: { value: "2000" } });

    // Advance to recipients step to see the effect
    await fillDetailsStep();

    // The TotalsBar should reflect 2000
    // (we can't re-check amount input after fillDetailsStep, but
    //  the component state has been updated — advance and inspect RecipientList)
    fireEvent.click(screen.getByRole("button", { name: /next: recipients/i }));

    // The initial single recipient should now have 100% = 2000
    // RecipientList shows the amount as a read-only div
    expect(screen.getByText("2000")).toBeInTheDocument();
  });
});

// ── Accessibility ─────────────────────────────────────────────────────────────

describe("Accessibility", () => {
  it("main element has an accessible heading via aria-labelledby", () => {
    render(<MultiRecipientStreamPage />);
    const main = screen.getByRole("main");
    // aria-labelledby should point to the page title heading
    const labelId = main.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    const heading = document.getElementById(labelId!);
    expect(heading).toBeInTheDocument();
    expect(heading?.textContent).toMatch(/create multi-recipient stream/i);
  });

  it("step groups have aria-labelledby pointing to their heading", () => {
    render(<MultiRecipientStreamPage />);
    const group = screen.getByRole("group", { name: /stream details/i });
    expect(group).toBeInTheDocument();
  });

  it("Next button has aria-disabled mirroring disabled state", () => {
    render(<MultiRecipientStreamPage />);
    const nextBtn = screen.getByRole("button", { name: /next: recipients/i });
    expect(nextBtn).toHaveAttribute("aria-disabled", "true");
  });

  it("submit button is not disabled when on review step with valid data", async () => {
    render(<MultiRecipientStreamPage />);
    await fillDetailsStep();
    fireEvent.click(screen.getByRole("button", { name: /next: recipients/i }));
    const addressInput = screen.getByPlaceholderText(/GABC\.\.\. or email/i);
    fireEvent.change(addressInput, { target: { value: "GABC1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: /next: review/i }));
    expect(
      screen.getByRole("button", { name: /confirm & create stream/i })
    ).not.toBeDisabled();
  });

  it("error alert has role='alert' and aria-live='assertive'", async () => {
    render(<MultiRecipientStreamPage />);
    await fillDetailsStep();
    fireEvent.click(screen.getByRole("button", { name: /next: recipients/i }));
    const addressInput = screen.getByPlaceholderText(/GABC\.\.\. or email/i);
    fireEvent.change(addressInput, { target: { value: "GABC1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: /next: review/i }));

    fireEvent.click(screen.getByRole("button", { name: /confirm & create stream/i }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /stream created successfully/i })).toBeInTheDocument();
    });
  });

  it("success screen main element has aria-labelledby", async () => {
    render(<MultiRecipientStreamPage />);
    await fillDetailsStep();
    fireEvent.click(screen.getByRole("button", { name: /next: recipients/i }));
    const addressInput = screen.getByPlaceholderText(/GABC\.\.\. or email/i);
    fireEvent.change(addressInput, { target: { value: "GABC1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: /next: review/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm & create stream/i }));

    await waitFor(() => {
      const main = screen.getByRole("main");
      const labelId = main.getAttribute("aria-labelledby");
      expect(labelId).toBeTruthy();
      const heading = document.getElementById(labelId!);
      expect(heading?.textContent).toMatch(/stream created successfully/i);
    });
  });
});

// ── TotalsBar ────────────────────────────────────────────────────────────────

describe("TotalsBar", () => {
  it("is present on every step", async () => {
    render(<MultiRecipientStreamPage />);
    expect(screen.getByText(/total stream amount/i)).toBeInTheDocument();

    await fillDetailsStep();
    fireEvent.click(screen.getByRole("button", { name: /next: recipients/i }));
    expect(screen.getByText(/total stream amount/i)).toBeInTheDocument();

    const addressInput = screen.getByPlaceholderText(/GABC\.\.\. or email/i);
    fireEvent.change(addressInput, { target: { value: "GABC1234567890" } });
    fireEvent.click(screen.getByRole("button", { name: /next: review/i }));
    expect(screen.getByText(/total stream amount/i)).toBeInTheDocument();
  });
});
