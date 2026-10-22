"use client";

import React, { useCallback, useEffect, useId, useState } from "react";
import { escapeCsv } from "../lib/exportCsv";
import { isValidStellarPublicKey } from "../lib/stellar-address";
import { CopyAddress } from "../components/CopyAddress";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { useToast } from "../hooks/useToast";
import {
  buildExportCsv,
  buildExportJson,
  classifyImport,
  parseCsv,
  type ClassifyResult,
  type ImportRowStatus,
} from "./importExport";
import {
  FederationError,
  isFederationAddress,
  resolveFederationAddress,
} from "../utils/federation";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Contact {
  id: string;
  label: string;
  /** Resolved Stellar account ID (G…) */
  address: string;
  /** Original federation address when the user entered one (user*domain.com) */
  federationAddress?: string;
  memo?: string;
  createdAt: string;
}

// ─── localStorage persistence ─────────────────────────────────────────────────

const CONTACTS_KEY = "streampay_contacts";

// Sample address book shown on a visitor's first visit so the demo is populated.
// Once the visitor saves, edits or deletes a contact their own list is persisted.
// Not applied under Jest so the empty-state behaviour stays testable.
const DEMO_CONTACTS: Contact[] = [
  { id: "demo-ada", label: "Ada Creative Studio", address: "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZK7GQ", memo: "Design retainer, paid monthly", createdAt: "2026-04-01T09:00:00.000Z" },
  { id: "demo-kemi", label: "Kemi Onboarding Support", address: "GBVZZ5QKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2ZQK", memo: "Weekly onboarding help", createdAt: "2026-04-10T11:00:00.000Z" },
  { id: "demo-yusuf", label: "Yusuf QA Partnership", address: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGYWDEAVQBMJ7WGNB55IAAQ", federationAddress: "yusuf*qa.example.com", createdAt: "2026-04-15T08:00:00.000Z" },
];

function loadContacts(): Contact[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CONTACTS_KEY);
    if (raw === null && process.env.NODE_ENV !== "test") return DEMO_CONTACTS;
    return raw ? (JSON.parse(raw) as Contact[]) : [];
  } catch {
    return [];
  }
}

function persistContacts(contacts: Contact[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(CONTACTS_KEY, JSON.stringify(contacts));
}

// ─── Import / export constants ────────────────────────────────────────────────

const MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_IMPORT_ROWS = 1000;

// ─── Validation ───────────────────────────────────────────────────────────────

function isValidStellarAddress(value: string): boolean {
  return isValidStellarPublicKey(value);
}

const LABEL_MAX_LENGTH = 64;
const MEMO_MAX_LENGTH = 256;

const INVALID_ADDRESS_MESSAGE =
  "Enter a valid Stellar address (G…) or federation address (user*domain.com)";

type NormaliseResult =
  | { resolved: string; federation?: string }
  | { error: string };

/**
 * Shared address normaliser used by both blur and submit.
 *
 * - Stellar account IDs are canonicalised to uppercase.
 * - Federation addresses are resolved to their account ID.
 * - Anything else yields a validation error.
 *
 * Staleness is handled by the caller (`ContactForm.runNormalise`), which
 * aborts the previous run's controller and discards superseded results.
 */
async function normaliseAddressInput(
  raw: string,
): Promise<NormaliseResult> {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "Address is required" };

  if (isFederationAddress(trimmed)) {
    try {
      const record = await resolveFederationAddress(trimmed);
      return { resolved: record.account_id, federation: trimmed };
    } catch (err) {
      return {
        error:
          err instanceof FederationError
            ? err.message
            : "Failed to resolve federation address",
      };
    }
  }

  if (isValidStellarAddress(trimmed)) {
    // Normalise to uppercase so stored addresses are canonical.
    return { resolved: trimmed.toUpperCase() };
  }

  return { error: INVALID_ADDRESS_MESSAGE };
}

// ─── ContactForm ──────────────────────────────────────────────────────────────

interface FormValues {
  label: string;
  address: string;
  memo: string;
}

interface FormSubmitResult extends FormValues {
  resolvedAddress: string;
  federationAddress?: string;
}

interface ContactFormProps {
  initial?: FormValues;
  onSubmit: (result: FormSubmitResult) => void;
  onCancel: () => void;
  submitLabel: string;
}

type FieldName = "label" | "address" | "memo";

const FIELD_ORDER: FieldName[] = ["label", "address", "memo"];

const FIELD_NAMES: Record<FieldName, string> = {
  label: "Label",
  address: "Address",
  memo: "Note",
};

function ContactForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel,
}: ContactFormProps) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [memo, setMemo] = useState(initial?.memo ?? "");

  const [resolving, setResolving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resolvedAddress, setResolvedAddress] = useState("");
  const [federationAddress, setFederationAddress] = useState<
    string | undefined
  >();
  const [resolveError, setResolveError] = useState("");
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>(
    {},
  );
  const [showSummary, setShowSummary] = useState(false);

  const labelId = useId();
  const addressId = useId();
  const memoId = useId();
  const summaryId = useId();

  const labelRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const memoRef = useRef<HTMLInputElement>(null);

  /** One controller per resolution so stale results are discarded. */
  const resolutionRef = useRef<AbortController | null>(null);
  /** In-flight normalisation for the current input, so submit can await it. */
  const pendingRef = useRef<Promise<NormaliseResult | null> | null>(null);
  /** Synchronous guard against double submission. */
  const submittingRef = useRef(false);

  const fieldIds: Record<FieldName, string> = {
    label: labelId,
    address: addressId,
    memo: memoId,
  };
  const fieldRefs: Record<FieldName, React.RefObject<HTMLInputElement>> = {
    label: labelRef,
    address: addressRef,
    memo: memoRef,
  };

  useEffect(() => () => resolutionRef.current?.abort(), []);

  /**
   * Run the shared normaliser, abort any earlier in-flight run, and apply the
   * result to state. Returns `null` if this run was superseded.
   */
  const runNormalise = useCallback(
    (raw: string): Promise<NormaliseResult | null> => {
      resolutionRef.current?.abort();
      const controller = new AbortController();
      resolutionRef.current = controller;

      const run = (async () => {
        const isFederation = isFederationAddress(raw.trim());
        if (isFederation) setResolving(true);

        const result = await normaliseAddressInput(raw);
        if (controller.signal.aborted) return null;

        resolutionRef.current = null;
        pendingRef.current = null;
        if (isFederation) setResolving(false);

        if ("resolved" in result) {
          setResolvedAddress(result.resolved);
          setFederationAddress(result.federation);
          setResolveError("");
          setErrors((prev) => ({ ...prev, address: undefined }));
        } else {
          setResolvedAddress("");
          setFederationAddress(undefined);
          // Only surface resolver failures on blur; format errors wait for submit.
          setResolveError(isFederation ? result.error : "");
        }
        return result;
      })();

      pendingRef.current = run;
      return run;
    },
    [],
  );

  const handleAddressBlur = useCallback(async () => {
    if (!address.trim()) return;
    await runNormalise(address);
  }, [address, runNormalise]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);

    try {
      const next: Partial<Record<FieldName, string>> = {};

      const trimmedLabel = label.trim();
      if (!trimmedLabel) {
        next.label = "Label is required";
      } else if (trimmedLabel.length > LABEL_MAX_LENGTH) {
        next.label = `Label must be ${LABEL_MAX_LENGTH} characters or fewer`;
      }

      // Reuse a result produced by blur for the current input, await a blur
      // resolution that is still in flight, or run the same step now.
      let finalAddress = resolvedAddress;
      let finalFederation = federationAddress;
      if (!finalAddress) {
        const result = await (pendingRef.current ?? runNormalise(address));
        if (result === null) return; // superseded by a newer edit
        if ("resolved" in result) {
          finalAddress = result.resolved;
          finalFederation = result.federation;
        } else {
          next.address = result.error;
        }
      }

      if (memo.length > MEMO_MAX_LENGTH) {
        next.memo = `Note must be ${MEMO_MAX_LENGTH} characters or fewer`;
      }

      setErrors(next);

      const firstInvalid = FIELD_ORDER.find((f) => next[f]);
      if (firstInvalid) {
        setShowSummary(true);
        fieldRefs[firstInvalid].current?.focus();
        return;
      }

      setShowSummary(false);
      onSubmit({
        label: trimmedLabel,
        address: address.trim(),
        memo: memo.trim(),
        resolvedAddress: finalAddress,
        federationAddress: finalFederation,
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const busy = resolving || submitting;
  const addressError = errors.address || resolveError;
  const summaryFields = FIELD_ORDER.filter((f) => errors[f]);

  const fieldStyle: React.CSSProperties = {
    width: "100%",
    padding: "0.75rem 1rem",
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: "0.5rem",
    color: "var(--foreground)",
    fontSize: "1rem",
    outline: "none",
  };

  const fieldErrorStyle: React.CSSProperties = {
    ...fieldStyle,
    borderColor: "var(--system-error-border)",
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: "0.75rem",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--muted-foreground)",
    marginBottom: "0.5rem",
  };

  const errorMsgStyle: React.CSSProperties = {
    color: "var(--system-error-text)",
    fontSize: "0.8rem",
    marginTop: "0.375rem",
  };

  const hintStyle: React.CSSProperties = {
    color: "var(--muted-foreground)",
    fontSize: "0.75rem",
    marginTop: "0.375rem",
    textAlign: "right",
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>

        {/* Error summary */}
        {showSummary && summaryFields.length > 0 && (
          <div
            id={summaryId}
            role="alert"
            style={{
              border: "1px solid var(--system-error-border)",
              borderRadius: "0.5rem",
              padding: "0.75rem 1rem",
              color: "var(--system-error-text)",
              fontSize: "0.875rem",
            }}
          >
            <p style={{ fontWeight: 700 }}>
              {summaryFields.length === 1
                ? "1 field needs attention"
                : `${summaryFields.length} fields need attention`}
            </p>
            <ul style={{ margin: "0.375rem 0 0", paddingLeft: "1.25rem" }}>
              {summaryFields.map((f) => (
                <li key={f}>
                  <a
                    href={`#${fieldIds[f]}`}
                    onClick={(e) => {
                      e.preventDefault();
                      fieldRefs[f].current?.focus();
                    }}
                    style={{ color: "inherit", textDecoration: "underline" }}
                  >
                    {FIELD_NAMES[f]}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Label */}
        <div>
          <label htmlFor={labelId} style={labelStyle}>
            Label
          </label>
          <input
            ref={labelRef}
            id={labelId}
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Alice Design Studio"
            maxLength={LABEL_MAX_LENGTH}
            aria-required="true"
            aria-invalid={!!errors.label}
            aria-describedby={[
              errors.label ? `${labelId}-err` : "",
              `${labelId}-count`,
            ]
              .filter(Boolean)
              .join(" ")}
            style={errors.label ? fieldErrorStyle : fieldStyle}
          />
          <p id={`${labelId}-count`} style={hintStyle}>
            {label.length}/{LABEL_MAX_LENGTH}
          </p>
          {errors.label && (
            <p id={`${labelId}-err`} style={errorMsgStyle}>
              {errors.label}
            </p>
          )}
        </div>

        {/* Address */}
        <div>
          <label htmlFor={addressId} style={labelStyle}>
            Stellar address or federation address
          </label>
          <div style={{ position: "relative" }}>
            <input
              ref={addressRef}
              id={addressId}
              type="text"
              value={address}
              onChange={(e) => {
                // Invalidate any in-flight resolution for the old value.
                resolutionRef.current?.abort();
                resolutionRef.current = null;
                pendingRef.current = null;
                setResolving(false);
                setAddress(e.target.value);
                setResolvedAddress("");
                setFederationAddress(undefined);
                setResolveError("");
              }}
              onBlur={handleAddressBlur}
              placeholder="GABC… or user*domain.com"
              aria-required="true"
              aria-invalid={!!addressError}
              aria-describedby={
                [
                  addressError ? `${addressId}-err` : "",
                  resolvedAddress ? `${addressId}-resolved` : "",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              style={{
                ...(addressError ? fieldErrorStyle : fieldStyle),
                paddingRight: resolving ? "3rem" : "1rem",
                fontFamily: "monospace",
              }}
            />
            {resolving && (
              <span
                aria-label="Resolving federation address…"
                style={{
                  position: "absolute",
                  right: "0.75rem",
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--muted)",
                  fontSize: "0.875rem",
                  pointerEvents: "none",
                }}
              >
                ⟳
              </span>
            )}
          </div>

          {resolvedAddress && isFederationAddress(address.trim()) && (
            <p
              id={`${addressId}-resolved`}
              style={{
                fontSize: "0.8rem",
                color: "var(--system-success-text)",
                marginTop: "0.375rem",
                fontFamily: "monospace",
                wordBreak: "break-all",
              }}
            >
              Resolved: {resolvedAddress}
            </p>
          )}

          {addressError && (
            <p id={`${addressId}-err`} style={errorMsgStyle}>
              {addressError}
            </p>
          )}
        </div>

        {/* Memo */}
        <div>
          <label htmlFor={memoId} style={labelStyle}>
            Note{" "}
            <span style={{ fontWeight: 400, textTransform: "none" }}>
              (optional)
            </span>
          </label>
          <input
            ref={memoRef}
            id={memoId}
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="e.g. Design retainer for Q3"
            maxLength={257}
            aria-invalid={!!errors.memo}
            aria-describedby={errors.memo ? `${memoId}-err` : undefined}
            style={errors.memo ? fieldErrorStyle : fieldStyle}
          />
          {errors.memo && (
            <p id={`${memoId}-err`} style={errorMsgStyle}>
              {errors.memo}
            </p>
          )}
        </div>

        {/* Actions */}
        <div
          style={{
            display: "flex",
            gap: "0.75rem",
            justifyContent: "flex-end",
            paddingTop: "0.5rem",
          }}
        >
          <button
            type="button"
            className="button button--secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button button--primary"
            // aria-disabled (not disabled) so a click that blurs the address
            // field still reaches submit, which awaits the pending resolution.
            // Double submission is prevented by submittingRef.
            aria-disabled={busy}
            aria-busy={resolving}
          >
            {resolving ? "Resolving…" : submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

// ─── ContactRow ───────────────────────────────────────────────────────────────

interface ContactRowProps {
  contact: Contact;
  onEdit: (contact: Contact) => void;
  onDelete: (id: string) => void;
}

function ContactRow({ contact, onEdit, onDelete }: ContactRowProps) {
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Contact | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const searchId = useId();
  const toast = useToast();

  useEffect(() => {
    setContacts(loadContacts());
  }, []);

  const filtered = contacts.filter((c) => {
    const q = search.toLowerCase();
    return (
      c.label.toLowerCase().includes(q) ||
      c.address.toLowerCase().includes(q) ||
      (c.federationAddress?.toLowerCase().includes(q) ?? false) ||
      (c.memo?.toLowerCase().includes(q) ?? false)
    );
  });

  const applyUpdate = (next: Contact[]) => {
    const previous = contacts;
    setContacts(next);
    try {
      persistContacts(next);
    } catch (err) {
      setContacts(previous);
      const isQuota =
        err instanceof DOMException &&
        (err.name === "QuotaExceededError" ||
          err.name === "NS_ERROR_DOM_QUOTA_REACHED");
      toast.error(
        isQuota
          ? "Storage is full. Your change was not saved."
          : "Could not save contacts. Your change was not saved.",
      );
    }
  };

  const handleAdd = ({
    label,
    memo,
    resolvedAddress,
    federationAddress,
  }: FormSubmitResult) => {
    const contact: Contact = {
      id: crypto.randomUUID(),
      label,
      address: resolvedAddress,
      federationAddress,
      memo: memo || undefined,
      createdAt: new Date().toISOString(),
    };
    applyUpdate([...contacts, contact]);
    setAddOpen(false);
    toast.success(`Contact "${label}" added`);
  };

  const handleEdit = ({
    label,
    memo,
    resolvedAddress,
    federationAddress,
  }: FormSubmitResult) => {
    if (!editTarget) return;
    applyUpdate(
      contacts.map((c) =>
        c.id === editTarget.id
          ? {
              ...c,
              label,
              address: resolvedAddress,
              federationAddress,
              memo: memo || undefined,
            }
          : c,
      ),
    );
    setEditTarget(null);
    toast.success(`Contact "${label}" updated`);
  };

  const confirmDelete = () => {
    if (!deleteId) return;
    const target = contacts.find((c) => c.id === deleteId);
    applyUpdate(contacts.filter((c) => c.id !== deleteId));
    setDeleteId(null);
    if (target) toast.success(`Contact "${target.label}" deleted`);
  };

  const deleteTarget = contacts.find((c) => c.id === deleteId);

  return (
    <main className="page-shell">
      <header className="page-hero">
        <div className="page-hero__content">
          <p className="page-hero__eyebrow">Contacts</p>
          <h1 className="page-hero__title">Address Book</h1>
          <p className="page-hero__description">
            Save Stellar addresses with labels. Enter a federation address
            (user*domain.com) to resolve it automatically.
          </p>
        </div>
      </header>

      <div style={{ maxWidth: "48rem", width: "100%", margin: "0 auto" }}>

        {/* Toolbar */}
        <div
          style={{
            display: "flex",
            gap: "1rem",
            alignItems: "center",
            marginBottom: "1.5rem",
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: "200px" }}>
            <label
              htmlFor={searchId}
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                padding: 0,
                margin: -1,
                overflow: "hidden",
                clip: "rect(0,0,0,0)",
                whiteSpace: "nowrap",
                border: 0,
              }}
            >
              Search contacts
            </label>
            <input
              id={searchId}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by label, address, or note…"
              style={{
                width: "100%",
                padding: "0.625rem 1rem",
                background: "var(--panel)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                color: "var(--foreground)",
                fontSize: "0.9375rem",
                outline: "none",
              }}
            />
          </div>

          <ExportMenu contacts={contacts} />
          <ImportButton
            contacts={contacts}
            onApply={applyUpdate}
            onError={(msg) => toast.error(msg)}
            onSuccess={(msg) => toast.success(msg)}
          />

          <button
            type="button"
            className="button button--primary"
            onClick={() => setAddOpen(true)}
          >
            + Add contact
          </button>
        </div>

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
            onAction={() => setAddOpen(true)}
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
                    onEdit={setEditTarget}
                    onDelete={setDeleteId}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {/* Add modal */}
      <Modal isOpen={addOpen} onClose={() => setAddOpen(false)} title="Add contact">
        <ContactForm
          onSubmit={handleAdd}
          onCancel={() => setAddOpen(false)}
          submitLabel="Add contact"
        />
      </Modal>

      {/* Edit modal */}
      <Modal
        isOpen={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title="Edit contact"
      >
        {editTarget && (
          <ContactForm
            initial={{
              label: editTarget.label,
              address: editTarget.federationAddress ?? editTarget.address,
              memo: editTarget.memo ?? "",
            }}
            onSubmit={handleEdit}
            onCancel={() => setEditTarget(null)}
            submitLabel="Save changes"
          />
        )}
      </Modal>

      {/* Delete confirmation modal */}
      <Modal
        isOpen={deleteId !== null}
        onClose={() => setDeleteId(null)}
        title="Delete contact"
      >
        <p style={{ color: "var(--muted-foreground)", marginBottom: "1.5rem" }}>
          Are you sure you want to delete{" "}
          <strong>{deleteTarget?.label}</strong>? This action cannot be undone.
        </p>
        <div
          style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}
        >
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setDeleteId(null)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={confirmDelete}
          >
            Delete
          </button>
        </div>
      </Modal>
    </main>
  );
}

// ─── ExportMenu ───────────────────────────────────────────────────────────────

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function ExportMenu({ contacts }: { contacts: Contact[] }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const disabled = contacts.length === 0;

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="button button--secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        Export
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 0.25rem)",
            right: 0,
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: "0.5rem",
            padding: "0.25rem",
            zIndex: 20,
            minWidth: "10rem",
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="button button--secondary"
            style={{ width: "100%", justifyContent: "flex-start" }}
            onClick={() => {
              downloadFile(
                "contacts.json",
                buildExportJson(contacts),
                "application/json",
              );
              setOpen(false);
            }}
          >
            Export JSON
          </button>
          <button
            type="button"
            role="menuitem"
            className="button button--secondary"
            style={{ width: "100%", justifyContent: "flex-start" }}
            onClick={() => {
              downloadFile(
                "contacts.csv",
                buildExportCsv(contacts),
                "text/csv",
              );
              setOpen(false);
            }}
          >
            Export CSV
          </button>
        </div>
      )}
    </div>
  );
}

// ─── ImportButton + Preview ───────────────────────────────────────────────────

interface ImportButtonProps {
  contacts: Contact[];
  onApply: (next: Contact[]) => void;
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}

type ConflictChoice = "skip" | "overwrite" | "keep-both";

function ImportButton({
  contacts,
  onApply,
  onError,
  onSuccess,
}: ImportButtonProps) {
  const inputId = useId();
  const [preview, setPreview] = useState<ClassifyResult | null>(null);
  const [conflictChoices, setConflictChoices] = useState<
    Record<number, ConflictChoice>
  >({});

  const handleFile = async (file: File) => {
    if (file.size > MAX_IMPORT_BYTES) {
      onError("File is larger than 1 MB");
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      onError("Could not read file");
      return;
    }
    const result = classifyImport(text, file.name, contacts);
    if (result.error) {
      onError(result.error);
      return;
    }
    if (result.rows.length === 0) {
      onError("File contains no rows");
      return;
    }
    const choices: Record<number, ConflictChoice> = {};
    result.rows.forEach((r, i) => {
      if (r.status === "conflict") choices[i] = "skip";
    });
    setConflictChoices(choices);
    setPreview(result);
  };

  const commit = () => {
    if (!preview) return;
    const next = [...contacts];
    preview.rows.forEach((row, i) => {
      if (row.status === "invalid" || row.status === "duplicate") return;
      if (row.status === "conflict") {
        const choice = conflictChoices[i] ?? "skip";
        if (choice === "skip") return;
        if (choice === "overwrite") {
          const idx = next.findIndex((c) => c.id === row.existingId);
          if (idx >= 0) {
            next[idx] = {
              ...next[idx],
              label: row.label,
              memo: row.note || undefined,
            };
          }
          return;
        }
      }
      next.push({
        id: crypto.randomUUID(),
        label: row.label,
        address: row.address,
        federationAddress: row.federation || undefined,
        memo: row.note || undefined,
        createdAt: row.createdAt,
      });
    });
    onApply(next);
    const added = preview.rows.filter(
      (r) => r.status === "new",
    ).length;
    setPreview(null);
    onSuccess(`Imported ${added} contact${added !== 1 ? "s" : ""}`);
  };

  const counts = preview
    ? preview.rows.reduce<Record<ImportRowStatus, number>>(
        (acc, r) => {
          acc[r.status] += 1;
          return acc;
        },
        { new: 0, duplicate: 0, conflict: 0, invalid: 0 },
      )
    : null;

  return (
    <>
      <label
        htmlFor={inputId}
        className="button button--secondary"
        style={{ cursor: "pointer" }}
      >
        Import
      </label>
      <input
        id={inputId}
        type="file"
        accept=".json,.csv,application/json,text/csv"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void handleFile(file);
        }}
      />

      <Modal
        isOpen={preview !== null}
        onClose={() => setPreview(null)}
        title="Import preview"
      >
        {preview && counts && (
          <div>
            <p
              aria-live="polite"
              style={{ fontSize: "0.85rem", color: "var(--muted-foreground)" }}
            >
              {counts.new} new · {counts.duplicate} duplicate ·{" "}
              {counts.conflict} conflict · {counts.invalid} invalid
            </p>
            <div className="import-preview">
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th scope="col" style={{ textAlign: "left" }}>Label</th>
                    <th scope="col" style={{ textAlign: "left" }}>Address</th>
                    <th scope="col" style={{ textAlign: "left" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={i}>
                      <td>{row.label || "—"}</td>
                      <td style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                        {row.address || "—"}
                      </td>
                      <td>
                        {row.status}
                        {row.reason ? `: ${row.reason}` : ""}
                        {row.needsResolution ? " (needs resolution)" : ""}
                        {row.status === "conflict" && (
                          <select
                            aria-label={`Conflict resolution for ${row.label}`}
                            value={conflictChoices[i] ?? "skip"}
                            onChange={(e) =>
                              setConflictChoices((prev) => ({
                                ...prev,
                                [i]: e.target.value as ConflictChoice,
                              }))
                            }
                          >
                            <option value="skip">Skip</option>
                            <option value="overwrite">Overwrite</option>
                            <option value="keep-both">Keep both</option>
                          </select>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                justifyContent: "flex-end",
                marginTop: "1rem",
              }}
            >
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setPreview(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={commit}
              >
                Import
              </button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
