/**
 * @jest-environment jsdom
 */

import React from "react";
import { render } from "@testing-library/react";
const { screen, fireEvent } = require("@testing-library/react") as typeof import("@testing-library/react");

import { ContactList, ContactRow } from "./ContactList";
import type { Contact } from "./types";

const SAMPLE_CONTACTS: Contact[] = [
  {
    id: "c-1",
    label: "Alice Studio",
    address: "GCLH2SNM5MTV4TGNNOADLYOZJYIFBXTIDVSNW4XP3LEI2UQV2MZ46OD7",
    federationAddress: "alice*studio.example.com",
    memo: "Design retainer",
    requiredMemo: { type: "id", value: "998877" },
    createdAt: "2026-04-01T09:00:00.000Z",
  },
  {
    id: "c-2",
    label: "Bob Ops",
    address: "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZLPXE",
    createdAt: "2026-04-02T09:00:00.000Z",
  },
];

describe("ContactList", () => {
  it("renders empty state when there are no contacts and triggers onAdd", () => {
    const onAdd = jest.fn();
    render(
      <ContactList
        contacts={[]}
        filtered={[]}
        search=""
        onAdd={onAdd}
        onEdit={jest.fn()}
        onDelete={jest.fn()}
      />,
    );

    expect(screen.getByText("No contacts yet")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Add your first contact" }),
    );
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("renders no-match status when search filters out all contacts", () => {
    render(
      <ContactList
        contacts={SAMPLE_CONTACTS}
        filtered={[]}
        search="zzz"
        onAdd={jest.fn()}
        onEdit={jest.fn()}
        onDelete={jest.fn()}
      />,
    );

    expect(screen.getByText("0 of 2 contacts")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "No saved contacts match zzz",
    );
  });

  it("renders contacts and invokes edit/delete callbacks", () => {
    const onEdit = jest.fn();
    const onDelete = jest.fn();

    render(
      <ContactList
        contacts={SAMPLE_CONTACTS}
        filtered={SAMPLE_CONTACTS}
        search=""
        onAdd={jest.fn()}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByText("2 contacts")).toBeInTheDocument();
    expect(screen.getByText("Alice Studio")).toBeInTheDocument();
    expect(screen.getByText("alice*studio.example.com")).toBeInTheDocument();
    expect(screen.getByText("Required memo (id): 998877")).toBeInTheDocument();
    expect(screen.getByText("Design retainer")).toBeInTheDocument();
    expect(screen.getByText("Bob Ops")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit contact Alice Studio" }),
    );
    expect(onEdit).toHaveBeenCalledWith(SAMPLE_CONTACTS[0]);

    fireEvent.click(
      screen.getByRole("button", { name: "Delete contact Bob Ops" }),
    );
    expect(onDelete).toHaveBeenCalledWith("c-2");
  });
});

describe("ContactRow", () => {
  it("invokes onEdit and onDelete for a single row", () => {
    const onEdit = jest.fn();
    const onDelete = jest.fn();

    render(
      <ContactRow
        contact={SAMPLE_CONTACTS[0]}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit contact Alice Studio" }),
    );
    expect(onEdit).toHaveBeenCalledWith(SAMPLE_CONTACTS[0]);

    fireEvent.click(
      screen.getByRole("button", { name: "Delete contact Alice Studio" }),
    );
    expect(onDelete).toHaveBeenCalledWith("c-1");
  });
});
