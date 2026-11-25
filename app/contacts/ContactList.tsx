"use client";

import React from "react";
import { CopyAddress } from "../components/CopyAddress";
import { EmptyState } from "../components/EmptyState";
import type { Contact } from "./types";

// ─── ContactRow ───────────────────────────────────────────────────────────────

export interface ContactRowProps {
  contact: Contact;
  onEdit: (contact: Contact) => void;
  onDelete: (id: string) => void;
}

export function ContactRow({ contact, onEdit, onDelete }: ContactRowProps) {
  return (
    <article
      className="activity-card contact-row"
      aria-label={`Contact: ${contact.label}`}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          <strong style={{ fontSize: "1rem", fontWeight: 700 }}>
            {contact.label}
          </strong>
          {contact.federationAddress && (
            <span
              style={{
                fontSize: "0.75rem",
                color: "var(--muted)",
                fontFamily: "monospace",
              }}
            >
              {contact.federationAddress}
            </span>
          )}
        </div>

        <div style={{ marginTop: "0.25rem" }}>
          <CopyAddress value={contact.address} truncateChars={8} />
        </div>

        {contact.requiredMemo && (
          <div style={{ marginTop: "0.375rem" }}>
            <span
              style={{
                display: "inline-block",
                fontSize: "0.75rem",
                fontWeight: 600,
                padding: "0.15rem 0.5rem",
                borderRadius: "9999px",
                background: "var(--muted)",
                color: "var(--foreground)",
              }}
            >
              Required memo ({contact.requiredMemo.type}): {contact.requiredMemo.value}
            </span>
          </div>
        )}

        {contact.memo && (
          <p
            style={{
              fontSize: "0.85rem",
              color: "var(--muted-foreground)",
              marginTop: "0.25rem",
            }}
          >
            {contact.memo}
          </p>
        )}
      </div>

      <div className="contact-row__actions">
        <button
          type="button"
          className="button button--secondary"
          onClick={() => onEdit(contact)}
          aria-label={`Edit contact ${contact.label}`}
          style={{ padding: "0.375rem 0.875rem", fontSize: "0.875rem" }}
        >
          Edit
        </button>
        <button
          type="button"
          className="button button--danger"
          onClick={() => onDelete(contact.id)}
          aria-label={`Delete contact ${contact.label}`}
          style={{ padding: "0.375rem 0.875rem", fontSize: "0.875rem" }}
        >
          Delete
        </button>
      </div>
    </article>
  );
}

// ─── ContactList ──────────────────────────────────────────────────────────────

export interface ContactListProps {
  contacts: Contact[];
  filtered: Contact[];
  search: string;
  onAdd: () => void;
  onEdit: (contact: Contact) => void;
  onDelete: (id: string) => void;
}

export function ContactList({
  contacts,
  filtered,
  search,
  onAdd,
  onEdit,
  onDelete,
}: ContactListProps) {
  return (
    <>
      {/* Count */}
      {contacts.length > 0 && (
        <p
          aria-live="polite"
          style={{
            fontSize: "0.8rem",
            color: "var(--muted)",
            marginBottom: "1rem",
          }}
        >
          {filtered.length === contacts.length
            ? `${contacts.length} contact${contacts.length !== 1 ? "s" : ""}`
            : `${filtered.length} of ${contacts.length} contacts`}
        </p>
      )}

      {/* List */}
      {contacts.length === 0 ? (
        <EmptyState
          eyebrow="Contacts"
          title="No contacts yet"
          description="Add a Stellar address with a label so you can find it quickly when setting up a payment stream."
          actionLabel="Add your first contact"
          onAction={onAdd}
          guidanceSteps={[
            "Click \"Add your first contact\" to get started",
            "Enter a label (e.g. Alice Design Studio) and a Stellar address",
            "Use federation addresses (user*domain.com) for automatic resolution",
          ]}
        />
      ) : filtered.length === 0 ? (
        <p
          role="status"
          style={{
            color: "var(--muted-foreground)",
            textAlign: "center",
            padding: "3rem 0",
          }}
        >
          No saved contacts match <strong>{search}</strong>
        </p>
      ) : (
        <section aria-label="Contact list">
          <ul
            style={{
              listStyle: "none",
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
            }}
          >
            {filtered.map((contact) => (
              <li key={contact.id}>
                <ContactRow
                  contact={contact}
                  onEdit={onEdit}
                  onDelete={onDelete}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
