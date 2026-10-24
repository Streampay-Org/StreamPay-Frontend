/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, waitFor } from "@testing-library/react";
const { screen, fireEvent, within } = require("@testing-library/react") as typeof import("@testing-library/react");

import userEvent from "@testing-library/user-event";
import axe from "axe-core";

import ContactsPage, { type Contact } from "./page";
import * as federation from "../utils/federation";

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock("../utils/federation", () => ({
  isFederationAddress: jest.fn(() => false),
  resolveFederationAddress: jest.fn(),
  FederationError: class FederationError extends Error {
    constructor(
      message: string,
      public readonly code: string,
    ) {
      super(message);
      this.name = "FederationError";
    }
  },
}));

jest.mock("../hooks/useToast", () => ({
  useToast: () => ({
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
    toast: jest.fn(),
    dismiss: jest.fn(),
    dismissAll: jest.fn(),
  }),
}));

// The real Modal works but animates; intercept to avoid jsdom animation issues.
jest.mock("../components/Modal", () => ({
  Modal: ({
    isOpen,
    children,
    title,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
    title: string;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    ) : null,
}));

// ─── localStorage stub ────────────────────────────────────────────────────────

let store: Record<string, string> = {};

const localStorageMock = {
  getItem: jest.fn((key: string) => store[key] ?? null),
  setItem: jest.fn((key: string, value: string) => {
    store[key] = value;
  }),
  removeItem: jest.fn((key: string) => {
    delete store[key];
  }),
  clear: jest.fn(() => {
    store = {};
  }),
};

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
  writable: true,
});

// Stable UUID for assertions
Object.defineProperty(global.crypto, "randomUUID", {
  value: jest.fn(() => "test-uuid-1"),
  configurable: true,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedContacts(contacts: Contact[]) {
  store["streampay_contacts"] = JSON.stringify(contacts);
}

const ALICE: Contact = {
  id: "id-alice",
  label: "Alice Design",
  address: "GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12345678",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const BOB: Contact = {
  id: "id-bob",
  label: "Bob Builder",
  address: "GBBB1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12345678",
  memo: "Contractor Q3",
  createdAt: "2026-01-02T00:00:00.000Z",
};

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  store = {};
  jest.clearAllMocks();
  (federation.isFederationAddress as jest.Mock).mockReturnValue(false);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ContactsPage — page shell", () => {
  it("renders the page heading", () => {
    render(<ContactsPage />);
    expect(
      screen.getByRole("heading", { name: /address book/i }),
    ).toBeInTheDocument();
  });

  it("renders the eyebrow label", () => {
    render(<ContactsPage />);
    const eyebrows = screen.getAllByText(/contacts/i);
    expect(eyebrows.length).toBeGreaterThanOrEqual(1);
    // The page-hero eyebrow should always be present
    expect(
      document.querySelector(".page-hero__eyebrow"),
    ).toHaveTextContent("Contacts");
  });
});

describe("ContactsPage — empty state", () => {
  it("shows the empty state when there are no saved contacts", () => {
    render(<ContactsPage />);
    expect(
      screen.getByRole("heading", { name: /no contacts yet/i }),
    ).toBeInTheDocument();
  });

  it("does not show a count when the list is empty", () => {
    render(<ContactsPage />);
    // The count bar (aria-live region with "1 contact" etc.) should not appear
    expect(
      screen.queryByText(/^\d+ contact/),
    ).not.toBeInTheDocument();
  });

  it("opens the add modal when the empty state CTA button is clicked", () => {
    render(<ContactsPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /add your first contact/i }),
    );
    expect(
      screen.getByRole("dialog", { name: /add contact/i }),
    ).toBeInTheDocument();
  });

  it("renders getting-started guidance steps in the empty state", () => {
    render(<ContactsPage />);
    expect(
      screen.getByText(/enter a label/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/federation addresses/i),
    ).toBeInTheDocument();
  });
});

describe("ContactsPage — localStorage edge cases", () => {
  it("handles corrupted localStorage gracefully", () => {
    store["streampay_contacts"] = "{invalid-json}";
    render(<ContactsPage />);
    // Should show the empty state, not crash
    expect(
      screen.getByRole("heading", { name: /no contacts yet/i }),
    ).toBeInTheDocument();
  });
});

describe("ContactsPage — rendering saved contacts", () => {
  it("displays a contact loaded from localStorage", () => {
    seedContacts([ALICE]);
    render(<ContactsPage />);
    expect(screen.getByText("Alice Design")).toBeInTheDocument();
  });

  it("shows the memo when present", () => {
    seedContacts([BOB]);
    render(<ContactsPage />);
    expect(screen.getByText("Contractor Q3")).toBeInTheDocument();
  });

  it("shows the federation address badge when a contact has one", () => {
    const fedContact: Contact = {
      ...ALICE,
      federationAddress: "alice*example.com",
    };
    seedContacts([fedContact]);
    render(<ContactsPage />);
    expect(screen.getByText("alice*example.com")).toBeInTheDocument();
  });

  it("displays the singular count for one contact", () => {
    seedContacts([ALICE]);
    render(<ContactsPage />);
    expect(screen.getByText("1 contact")).toBeInTheDocument();
  });

  it("displays the plural count for multiple contacts", () => {
    seedContacts([ALICE, BOB]);
    render(<ContactsPage />);
    expect(screen.getByText("2 contacts")).toBeInTheDocument();
  });
});

describe("ContactsPage — search / filter", () => {
  beforeEach(() => seedContacts([ALICE, BOB]));

  it("filters contacts by label", () => {
    render(<ContactsPage />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "alice" },
    });
    expect(screen.getByText("Alice Design")).toBeInTheDocument();
    expect(screen.queryByText("Bob Builder")).not.toBeInTheDocument();
  });

  it("filters contacts by memo", () => {
    render(<ContactsPage />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "contractor" },
    });
    expect(screen.getByText("Bob Builder")).toBeInTheDocument();
    expect(screen.queryByText("Alice Design")).not.toBeInTheDocument();
  });

  it("shows a no-match status message when nothing matches", () => {
    render(<ContactsPage />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "zzz" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(/no saved contacts match/i);
  });

  it("shows filtered count vs total when a search is active", () => {
    render(<ContactsPage />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "alice" },
    });
    expect(screen.getByText(/1 of 2 contacts/i)).toBeInTheDocument();
  });
});

describe("ContactsPage — add contact modal", () => {
  it("opens the add modal when the + Add contact button is clicked", () => {
    render(<ContactsPage />);
    fireEvent.click(screen.getByRole("button", { name: /\+ add contact/i }));
    expect(
      screen.getByRole("dialog", { name: /add contact/i }),
    ).toBeInTheDocument();
  });

  it("closes the modal when Cancel is clicked", () => {
    render(<ContactsPage />);
    fireEvent.click(screen.getByRole("button", { name: /\+ add contact/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows validation errors for an empty form submission", async () => {
    render(<ContactsPage />);
    fireEvent.click(screen.getByRole("button", { name: /\+ add contact/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /add contact/i }),
    );
    expect(await screen.findByText(/label is required/i)).toBeInTheDocument();
    expect(
      await screen.findByText(/address is required/i),
    ).toBeInTheDocument();
  });

  it("rejects a label longer than 64 characters", async () => {
    render(<ContactsPage />);
    fireEvent.click(screen.getByRole("button", { name: /\+ add contact/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^label$/i), {
      target: { value: "a".repeat(65) },
    });
    fireEvent.change(
      within(dialog).getByLabelText(/stellar address or federation address/i),
      {
        target: {
          value: "GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12345678",
        },
      },
    );
    fireEvent.blur(
      within(dialog).getByLabelText(/stellar address or federation address/i),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: /add contact/i }),
    );
    expect(
      await screen.findByText(/label must be 64 characters/i),
    ).toBeInTheDocument();
  });

  it("rejects an invalid address format", async () => {
    render(<ContactsPage />);
    fireEvent.click(screen.getByRole("button", { name: /\+ add contact/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^label$/i), {
      target: { value: "Test" },
    });
    fireEvent.change(
      within(dialog).getByLabelText(/stellar address or federation address/i),
      { target: { value: "not-an-address" } },
    );
    fireEvent.blur(
      within(dialog).getByLabelText(/stellar address or federation address/i),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: /add contact/i }),
    );
    expect(
      await screen.findByText(/enter a valid stellar address/i),
    ).toBeInTheDocument();
  });

  it("saves a contact with a valid Stellar address to localStorage", async () => {
    render(<ContactsPage />);
    // The toolbar "+ Add contact" button is always visible
    const addButton = screen.getByRole("button", { name: /\+ add contact/i });
    fireEvent.click(addButton);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^label$/i), {
      target: { value: "Carol" },
    });
    const addressInput = within(dialog).getByLabelText(
      /stellar address or federation address/i,
    );
    // Use a valid 56-char Stellar address (G + 55 chars from A-Z,2-7)
    const validAddress = `G${'A'.repeat(55)}`;
    fireEvent.change(addressInput, {
      target: { value: validAddress },
    });
    fireEvent.blur(addressInput);
    // Submit the form
    fireEvent.click(
      within(dialog).getByRole("button", { name: /add contact/i }),
    );
    await waitFor(() => {
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "streampay_contacts",
        expect.stringContaining("Carol"),
      );
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("ContactsPage — federation address resolution", () => {
  it("calls resolveFederationAddress on address blur when format matches", async () => {
    (federation.isFederationAddress as jest.Mock).mockReturnValue(true);
    (federation.resolveFederationAddress as jest.Mock).mockResolvedValue({
      stellar_address: "alice*example.com",
      account_id: "GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12345678",
    });

    render(<ContactsPage />);
    fireEvent.click(screen.getByRole("button", { name: /\+ add contact/i }));
    const dialog = screen.getByRole("dialog");
    const addressInput = within(dialog).getByLabelText(
      /stellar address or federation address/i,
    );

    fireEvent.change(addressInput, { target: { value: "alice*example.com" } });
    fireEvent.blur(addressInput);

    await waitFor(() => {
      expect(federation.resolveFederationAddress).toHaveBeenCalledWith(
        "alice*example.com",
      );
    });

    expect(await screen.findByText(/resolved:/i)).toBeInTheDocument();
  });

  it("shows an error message when federation resolution fails", async () => {
    (federation.isFederationAddress as jest.Mock).mockReturnValue(true);
    const { FederationError } = jest.requireMock("../utils/federation") as {
      FederationError: new (msg: string, code: string) => Error;
    };
    (federation.resolveFederationAddress as jest.Mock).mockRejectedValue(
      new FederationError("Federation address not found", "NOT_FOUND"),
    );

    render(<ContactsPage />);
    fireEvent.click(screen.getByRole("button", { name: /\+ add contact/i }));
    const dialog = screen.getByRole("dialog");
    const addressInput = within(dialog).getByLabelText(
      /stellar address or federation address/i,
    );

    fireEvent.change(addressInput, {
      target: { value: "unknown*example.com" },
    });
    fireEvent.blur(addressInput);

    await waitFor(() => {
      expect(federation.resolveFederationAddress).toHaveBeenCalled();
    });

    expect(
      await screen.findByText(/federation address not found/i),
    ).toBeInTheDocument();
  });
});

describe("ContactsPage — edit contact", () => {
  it("pre-fills the address with the federation address when one exists", () => {
    const fedContact: Contact = {
      ...ALICE,
      federationAddress: "alice*example.com",
    };
    seedContacts([fedContact]);
    render(<ContactsPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /edit contact alice design/i }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByLabelText(/stellar address or federation address/i),
    ).toHaveValue("alice*example.com");
  });

  it("pre-fills the address with the raw address when no federation address exists", () => {
    seedContacts([ALICE]);
    render(<ContactsPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /edit contact alice design/i }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByLabelText(/stellar address or federation address/i),
    ).toHaveValue(
      "GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12345678",
    );
  });
  it("opens the edit modal when the Edit button is clicked", () => {
    seedContacts([ALICE]);
    render(<ContactsPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /edit contact alice design/i }),
    );
    expect(
      screen.getByRole("dialog", { name: /edit contact/i }),
    ).toBeInTheDocument();
  });

  it("pre-fills the form with the existing contact's label", () => {
    seedContacts([ALICE]);
    render(<ContactsPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /edit contact alice design/i }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText(/^label$/i)).toHaveValue(
      "Alice Design",
    );
  });

  it("closes the edit modal when Cancel is clicked", () => {
    seedContacts([ALICE]);
    render(<ContactsPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /edit contact alice design/i }),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("ContactsPage — delete contact", () => {
  it("opens a confirmation modal when Delete is clicked", () => {
    seedContacts([ALICE]);
    render(<ContactsPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /delete contact alice design/i }),
    );
    expect(
      screen.getByRole("dialog", { name: /delete contact/i }),
    ).toBeInTheDocument();
  });

  it("mentions the contact name in the confirmation modal", () => {
    seedContacts([ALICE]);
    render(<ContactsPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /delete contact alice design/i }),
    );
    const dialog = screen.getByRole("dialog", { name: /delete contact/i });
    expect(within(dialog).getByText(/alice design/i)).toBeInTheDocument();
  });

  it("removes the contact after confirming deletion", async () => {
    seedContacts([ALICE]);
    render(<ContactsPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /delete contact alice design/i }),
    );
    const dialog = screen.getByRole("dialog", { name: /delete contact/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => {
      expect(screen.queryByText("Alice Design")).not.toBeInTheDocument();
    });
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      "streampay_contacts",
      "[]",
    );
  });

  it("cancels the delete when Cancel is clicked", () => {
    seedContacts([ALICE]);
    render(<ContactsPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /delete contact alice design/i }),
    );
    const dialog = screen.getByRole("dialog", { name: /delete contact/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Alice Design")).toBeInTheDocument();
  });
});

// ─── Submit-time normalisation & accessible errors ───────────────────────────

describe("ContactForm — normalise on submit and accessible errors", () => {
  const VALID_UPPER = `G${"A".repeat(55)}`;
  const RESOLVED_ID = `G${"B".repeat(55)}`;

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function openAddForm() {
    render(<ContactsPage />);
    fireEvent.click(screen.getByRole("button", { name: /\+ add contact/i }));
    const dialog = screen.getByRole("dialog");
    return {
      dialog,
      labelInput: within(dialog).getByLabelText(/^label$/i),
      addressInput: within(dialog).getByLabelText(
        /stellar address or federation address/i,
      ),
      saveButton: within(dialog).getByRole("button", { name: /add contact/i }),
    };
  }

  function savedContacts(): Contact[] {
    return JSON.parse(store["streampay_contacts"] ?? "[]") as Contact[];
  }

  function contactWrites() {
    return localStorageMock.setItem.mock.calls.filter(
      ([key]) => key === "streampay_contacts",
    );
  }

  beforeEach(() => {
    (federation.isFederationAddress as jest.Mock).mockImplementation(
      (v: string) => /^[^*\s]+\*[^*\s]+\.[^*\s]+$/.test(v),
    );
  });

  it("1. stores an uppercase address when a lowercase G-address is submitted with Enter", async () => {
    const user = userEvent.setup();
    const { labelInput, addressInput } = openAddForm();

    await user.type(labelInput, "Carol");
    await user.type(addressInput, `${VALID_UPPER.toLowerCase()}{Enter}`);

    await waitFor(() => expect(savedContacts()).toHaveLength(1));
    expect(savedContacts()[0].address).toBe(VALID_UPPER);
  });

  it("2. resolves a federation address on Enter and saves the resolved id", async () => {
    const user = userEvent.setup();
    (federation.resolveFederationAddress as jest.Mock).mockResolvedValue({
      stellar_address: "carol*example.com",
      account_id: RESOLVED_ID,
    });
    const { labelInput, addressInput } = openAddForm();

    await user.type(labelInput, "Carol");
    await user.type(addressInput, "carol*example.com{Enter}");

    await waitFor(() => expect(savedContacts()).toHaveLength(1));
    expect(federation.resolveFederationAddress).toHaveBeenCalledWith(
      "carol*example.com",
    );
    expect(savedContacts()[0]).toMatchObject({
      address: RESOLVED_ID,
      federationAddress: "carol*example.com",
    });
  });

  it("3. shows an error and focuses the address input when the resolver rejects on submit", async () => {
    const user = userEvent.setup();
    const { FederationError } = jest.requireMock("../utils/federation") as {
      FederationError: new (msg: string, code: string) => Error;
    };
    (federation.resolveFederationAddress as jest.Mock).mockRejectedValue(
      new FederationError("Federation address not found", "NOT_FOUND"),
    );
    const { labelInput, addressInput } = openAddForm();

    await user.type(labelInput, "Carol");
    await user.type(addressInput, "nobody*example.com{Enter}");

    expect(
      await screen.findByText(/federation address not found/i),
    ).toBeInTheDocument();
    await waitFor(() => expect(addressInput).toHaveFocus());
    expect(addressInput).toHaveAttribute("aria-invalid", "true");
    expect(savedContacts()).toHaveLength(0);
  });

  it("4. applies only the latest resolution when an earlier blur resolves late", async () => {
    const user = userEvent.setup();
    const a = deferred<{ stellar_address: string; account_id: string }>();
    const b = deferred<{ stellar_address: string; account_id: string }>();
    (federation.resolveFederationAddress as jest.Mock).mockImplementation(
      (addr: string) => (addr.startsWith("a*") ? a.promise : b.promise),
    );
    const { labelInput, addressInput } = openAddForm();

    await user.type(addressInput, "a*example.com");
    await user.click(labelInput); // blur A → resolving
    await user.clear(addressInput);
    await user.type(addressInput, "b*example.com");
    await user.click(labelInput); // blur B → resolving

    b.resolve({ stellar_address: "b*example.com", account_id: RESOLVED_ID });
    expect(
      await screen.findByText(`Resolved: ${RESOLVED_ID}`),
    ).toBeInTheDocument();

    a.resolve({ stellar_address: "a*example.com", account_id: VALID_UPPER });
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText(`Resolved: ${RESOLVED_ID}`)).toBeInTheDocument();
    expect(
      screen.queryByText(`Resolved: ${VALID_UPPER}`),
    ).not.toBeInTheDocument();
  });

  it("5. renders one alert summary and focuses the label input on an empty submit", async () => {
    const user = userEvent.setup();
    const { labelInput, saveButton } = openAddForm();

    await user.click(saveButton);

    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(/2 fields need attention/i);
    expect(within(alerts[0]).getAllByRole("link")).toHaveLength(2);
    expect(labelInput).toHaveFocus();

    // Field errors are plain text wired up via aria-describedby.
    const errId = labelInput
      .getAttribute("aria-describedby")!
      .split(" ")
      .find((id) => id.endsWith("-err"))!;
    expect(document.getElementById(errId)).toHaveTextContent(
      /label is required/i,
    );
  });

  it("6. caps the label at 64 characters with a live counter", async () => {
    const user = userEvent.setup();
    const { dialog, labelInput } = openAddForm();

    expect(labelInput).toHaveAttribute("maxLength", "64");
    expect(within(dialog).getByText("0/64")).toBeInTheDocument();

    await user.type(labelInput, "x".repeat(70));

    expect(labelInput).toHaveValue("x".repeat(64));
    expect(within(dialog).getByText("64/64")).toBeInTheDocument();
  });

  it("7. calls onSubmit once when save is double-clicked while resolving", async () => {
    const user = userEvent.setup();
    const pending = deferred<{ stellar_address: string; account_id: string }>();
    (federation.resolveFederationAddress as jest.Mock).mockReturnValue(
      pending.promise,
    );
    const { labelInput, addressInput, saveButton } = openAddForm();

    await user.type(labelInput, "Carol");
    await user.type(addressInput, "carol*example.com");
    await user.dblClick(saveButton);

    expect(saveButton).toHaveTextContent("Resolving…");
    expect(saveButton).toHaveAttribute("aria-busy", "true");

    pending.resolve({
      stellar_address: "carol*example.com",
      account_id: RESOLVED_ID,
    });

    await waitFor(() => expect(savedContacts()).toHaveLength(1));
    expect(contactWrites()).toHaveLength(1);
    expect(federation.resolveFederationAddress).toHaveBeenCalledTimes(1);
  });

  it("8. has no serious axe violations in the error state", async () => {
    const user = userEvent.setup();
    const { dialog, saveButton } = openAddForm();

    await user.click(saveButton);
    await screen.findByRole("alert");

    const results = await axe.run(dialog, {
      rules: { "color-contrast": { enabled: false } },
    });
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious).toEqual([]);
  });
});
