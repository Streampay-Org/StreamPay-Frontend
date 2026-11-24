/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, waitFor } from "@testing-library/react";
const { screen, fireEvent } = require("@testing-library/react") as typeof import("@testing-library/react");
import userEvent from "@testing-library/user-event";

import { ContactForm } from "./ContactForm";
import * as federation from "../utils/federation";

const VALID_STELLAR_ADDRESS =
  "GCLH2SNM5MTV4TGNNOADLYOZJYIFBXTIDVSNW4XP3LEI2UQV2MZ46OD7";

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

describe("ContactForm", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (federation.isFederationAddress as jest.Mock).mockReturnValue(false);
  });

  it("shows validation messages and error summary when submitted empty", async () => {
    const onSubmit = jest.fn();
    const onCancel = jest.fn();

    render(
      <ContactForm
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitLabel="Add contact"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add contact" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "2 fields need attention",
    );
    expect(screen.getByText("Label is required")).toBeInTheDocument();
    expect(screen.getByText("Address is required")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows an error for an invalid address format", async () => {
    const onSubmit = jest.fn();
    render(
      <ContactForm
        onSubmit={onSubmit}
        onCancel={jest.fn()}
        submitLabel="Add contact"
      />,
    );

    await userEvent.type(screen.getByLabelText("Label"), "Alice");
    await userEvent.type(
      screen.getByLabelText("Stellar address or federation address"),
      "not-a-valid-address",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add contact" }));

    expect(
      await screen.findByText(
        "Enter a valid Stellar address (G…) or federation address (user*domain.com)",
      ),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("normalises a lowercase Stellar address and submits", async () => {
    const onSubmit = jest.fn();
    render(
      <ContactForm
        onSubmit={onSubmit}
        onCancel={jest.fn()}
        submitLabel="Add contact"
      />,
    );

    await userEvent.type(screen.getByLabelText("Label"), "  Alice Studio  ");
    await userEvent.type(
      screen.getByLabelText("Stellar address or federation address"),
      VALID_STELLAR_ADDRESS.toLowerCase(),
    );
    await userEvent.type(screen.getByLabelText(/Note/i), "Monthly retainer");

    fireEvent.click(screen.getByRole("button", { name: "Add contact" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        label: "Alice Studio",
        address: VALID_STELLAR_ADDRESS.toLowerCase(),
        memo: "Monthly retainer",
        resolvedAddress: VALID_STELLAR_ADDRESS,
        federationAddress: undefined,
        requiredMemo: undefined,
      });
    });
  });

  it("resolves a federation address with required memo and submits", async () => {
    (federation.isFederationAddress as jest.Mock).mockImplementation((v: string) =>
      v.includes("*"),
    );
    (federation.resolveFederationAddress as jest.Mock).mockResolvedValue({
      stellar_address: "alice*example.com",
      account_id: VALID_STELLAR_ADDRESS,
      memo_type: "id",
      memo: "12345",
    });

    const onSubmit = jest.fn();
    render(
      <ContactForm
        onSubmit={onSubmit}
        onCancel={jest.fn()}
        submitLabel="Add contact"
      />,
    );

    await userEvent.type(screen.getByLabelText("Label"), "Alice");
    const addressInput = screen.getByLabelText(
      "Stellar address or federation address",
    );
    await userEvent.type(addressInput, "alice*example.com");
    fireEvent.blur(addressInput);

    expect(
      await screen.findByText(`Resolved: ${VALID_STELLAR_ADDRESS}`),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Required memo")).toHaveValue("12345");

    fireEvent.click(screen.getByRole("button", { name: "Add contact" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        label: "Alice",
        address: "alice*example.com",
        memo: "",
        resolvedAddress: VALID_STELLAR_ADDRESS,
        federationAddress: "alice*example.com",
        requiredMemo: { type: "id", value: "12345" },
      });
    });
  });

  it("surfaces federation lookup failure on blur and blocks submit", async () => {
    (federation.isFederationAddress as jest.Mock).mockImplementation((v: string) =>
      v.includes("*"),
    );
    (federation.resolveFederationAddress as jest.Mock).mockRejectedValue(
      new federation.FederationError("Account not found", "NOT_FOUND"),
    );

    const onSubmit = jest.fn();
    render(
      <ContactForm
        onSubmit={onSubmit}
        onCancel={jest.fn()}
        submitLabel="Add contact"
      />,
    );

    await userEvent.type(screen.getByLabelText("Label"), "Ghost");
    const addressInput = screen.getByLabelText(
      "Stellar address or federation address",
    );
    await userEvent.type(addressInput, "ghost*example.com");
    fireEvent.blur(addressInput);

    expect(await screen.findByText("Account not found")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add contact" }));
    await waitFor(() => {
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  it("calls onCancel when Cancel is clicked", () => {
    const onCancel = jest.fn();
    render(
      <ContactForm
        onSubmit={jest.fn()}
        onCancel={onCancel}
        submitLabel="Save changes"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
