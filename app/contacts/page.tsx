"use client";

import React, { useEffect, useId, useMemo, useState } from "react";
import { Modal } from "../components/Modal";
import { ResetFiltersButton } from "../components/ResetFiltersButton";
import { useToast } from "../hooks/useToast";
import { safeStorage } from "../lib/safeStorage";
import { filterContacts, sortContacts, type ContactSortKey } from "./filter";
import {
  buildExportCsv,
  buildExportJson,
  classifyImport,
  type ClassifyResult,
} from "./importExport";
import { ContactForm, type FormSubmitResult } from "./ContactForm";
import { ContactList } from "./ContactList";
import { ImportPreview, type ConflictChoice } from "./ImportPreview";
import type { Contact } from "./types";

export type { Contact, RequiredMemo, ContactPaymentTarget } from "./types";
export { getContactPaymentTarget } from "./types";

// ─── localStorage persistence ─────────────────────────────────────────────────

const CONTACTS_KEY = "streampay_contacts";
const CONTACT_SORT_KEY = "streampay-contacts-sort";

const SORT_OPTIONS: { value: ContactSortKey; label: string }[] = [
  { value: "label-asc", label: "Label A-Z" },
  { value: "label-desc", label: "Label Z-A" },
  { value: "recent", label: "Newest" },
  { value: "oldest", label: "Oldest" },
];

function isContactSortKey(value: string | null): value is ContactSortKey {
  return SORT_OPTIONS.some((option) => option.value === value);
}

// Sample address book shown on a visitor's first visit so the demo is populated.
// Once the visitor saves, edits or deletes a contact their own list is persisted.
// Not applied under Jest so the empty-state behaviour stays testable.
const DEMO_CONTACTS: Contact[] = [
  { id: "demo-ada", label: "Ada Creative Studio", address: "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZLPXE", memo: "Design retainer, paid monthly", createdAt: "2026-04-01T09:00:00.000Z" },
  { id: "demo-kemi", label: "Kemi Onboarding Support", address: "GBVZZ5QKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2GQI", memo: "Weekly onboarding help", createdAt: "2026-04-10T11:00:00.000Z" },
  { id: "demo-yusuf", label: "Yusuf QA Partnership", address: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGYWDEAVQBMJ7WGNB55IVJV", federationAddress: "yusuf*qa.example.com", createdAt: "2026-04-15T08:00:00.000Z" },
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ContactSortKey>("recent");
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Contact | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const searchId = useId();
  const toast = useToast();

  useEffect(() => {
    setContacts(loadContacts());
    const storedSort = safeStorage.getItem(CONTACT_SORT_KEY);
    if (isContactSortKey(storedSort)) setSort(storedSort);
  }, []);

  const filtered = useMemo(
    () =>
      sortContacts(filterContacts(contacts, search), sort),
    [contacts, search, sort],
  );

  const handleSortChange = (next: ContactSortKey) => {
    setSort(next);
    safeStorage.setItem(CONTACT_SORT_KEY, next);
  };

  const resetFilters = () => {
    setSearch("");
    handleSortChange("recent");
  };

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
    requiredMemo,
  }: FormSubmitResult) => {
    const contact: Contact = {
      id: crypto.randomUUID(),
      label,
      address: resolvedAddress,
      federationAddress,
      memo: memo || undefined,
      requiredMemo,
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
    requiredMemo,
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
              requiredMemo,
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

          <div>
            <label
              htmlFor="contacts-sort"
              style={{
                display: "block",
                fontSize: "0.75rem",
                color: "var(--muted)",
                marginBottom: "0.25rem",
              }}
            >
              Sort contacts
            </label>
            <select
              id="contacts-sort"
              aria-label="Sort contacts"
              value={sort}
              onChange={(event) =>
                handleSortChange(event.target.value as ContactSortKey)
              }
              style={{
                padding: "0.625rem 2rem 0.625rem 0.75rem",
                background: "var(--panel)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                color: "var(--foreground)",
              }}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <ResetFiltersButton
            onReset={resetFilters}
            isVisible={search.trim() !== "" || sort !== "recent"}
          />

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

        <ContactList
          contacts={contacts}
          filtered={filtered}
          search={search}
          onAdd={() => setAddOpen(true)}
          onEdit={setEditTarget}
          onDelete={setDeleteId}
        />
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
              requiredMemo: editTarget.requiredMemo,
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

// ─── ImportButton ─────────────────────────────────────────────────────────────

interface ImportButtonProps {
  contacts: Contact[];
  onApply: (next: Contact[]) => void;
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}

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

      <ImportPreview
        preview={preview}
        conflictChoices={conflictChoices}
        onConflictChoiceChange={(index, choice) =>
          setConflictChoices((prev) => ({ ...prev, [index]: choice }))
        }
        onCancel={() => setPreview(null)}
        onConfirm={commit}
      />
    </>
  );
}
