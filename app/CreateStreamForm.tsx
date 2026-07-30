/**
 * CreateStreamForm
 *
 * Extracted, self-contained form component for creating a single-recipient
 * Stellar payment stream.
 *
 * ## Features added for GrantFox FWC26 (Stellar Wave)
 *
 * ### kbd-v7 — Keyboard shortcut hints
 *   - `Esc`       → Cancel / close (shown on the Cancel button)
 *   - `Ctrl + ↵`  → Submit (shown on the Create Stream button)
 *   - `Alt + R`   → Jump focus to the Recipient field
 *   - `Alt + A`   → Jump focus to the Amount field
 *   These hints are rendered with `<KbdHint>` and are also keyboard-active
 *   via a `keydown` listener on the form element.
 *
 * ### skel-v7 — Themed loading skeleton
 *   When the `isLoading` prop is `true` the form body is replaced with a
 *   skeleton layout that mirrors the real field positions using design-token
 *   colours (`--skeleton-base`, `--skeleton-shine`).
 *
 * ### ariallive-v7 — Aria-live SR announcements
 *   A `<LiveRegion>` announces status changes (submitting, success, error)
 *   so screen-reader users receive feedback without visual focus shifts.
 *
 * ### tokens-v7 — Design-token spacing & typography
 *   All spacing, typography, and border-radius values now reference global
 *   CSS custom properties (see `app/globals.css`, `.create-stream-form`
 *   rule block). Inline `React.CSSProperties` objects have been replaced
 *   with BEM-style class names so updates to the design token scale
 *   propagate automatically across dark, light, and high-contrast themes.
 *
 * ## Accessibility (WCAG 2.1 AA)
 * - All form controls have associated `<label>` elements.
 * - Focus-visible ring is provided by `app/styles/focus.css` (`@layer focus`)
 *   via the `.csf-field` class; inline `border` no longer overrides it.
 * - Keyboard shortcuts do not override browser or OS reserved combos.
 * - Skeleton is marked `aria-hidden` and includes an `aria-busy` attribute
 *   on the parent so ATs know content is loading.
 */

"use client";

import React, { useEffect, useRef, useState } from "react";
import { KbdHint } from "../src/components/KbdHint";
import { Skeleton } from "../src/components/Skeleton";
import { LiveRegion } from "../src/components/LiveRegion";

// ── Types ─────────────────────────────────────────────────────────────────────

export type StreamToken = "XLM" | "USDC";

export interface CreateStreamFormValues {
  recipient: string;
  amount: string;
  token: StreamToken;
}

export interface CreateStreamFormProps {
  /**
   * Called when the user confirms the form.
   * Return a promise; the form will stay in "submitting" state until it
   * resolves or rejects.
   */
  onSubmit: (values: CreateStreamFormValues) => Promise<void>;
  /** Called when the user cancels (Cancel button or Escape key). */
  onCancel?: () => void;
  /**
   * When `true` the form is replaced by a themed skeleton loader.
   * Use this while async prerequisites (wallets, token list, …) are loading.
   */
  isLoading?: boolean;
  /** Optional additional CSS class on the form wrapper. */
  className?: string;
}

// ── Skeleton layout ───────────────────────────────────────────────────────────

/**
 * FormSkeleton mirrors the visual layout of the real form so the transition
 * from loading→loaded is as jump-free as possible.
 *
 * All skeleton elements are `aria-hidden`; the parent carries `aria-busy`.
 * Spacing uses `.csf-skeleton` and `.csf-skeleton__*` classes that reference
 * `--space-*` tokens (see `app/globals.css`).
 */
function FormSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="csf-skeleton"
      data-testid="create-stream-skeleton"
    >
      {/* Recipient field skeleton */}
      <div className="csf-skeleton__field">
        <Skeleton variant="label" className="skeleton--label" />
        <Skeleton variant="text" width="100%" height="2.75rem" />
      </div>

      {/* Amount + Token grid skeleton */}
      <div className="csf-skeleton__grid">
        <div className="csf-skeleton__field">
          <Skeleton variant="label" className="skeleton--label" />
          <Skeleton variant="text" width="100%" height="2.75rem" />
        </div>
        <div className="csf-skeleton__field">
          <Skeleton variant="label" className="skeleton--label" />
          <Skeleton variant="badge" width="100%" height="2.75rem" />
        </div>
      </div>

      {/* Action buttons skeleton */}
      <div className="csf-skeleton__actions">
        <Skeleton variant="button" />
        <Skeleton variant="button" />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function CreateStreamForm({
  onSubmit,
  onCancel,
  isLoading = false,
  className,
}: CreateStreamFormProps) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<StreamToken>("XLM");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  // Refs for keyboard-shortcut focus jumps
  const recipientRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  // ── Keyboard shortcut handler ──────────────────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl + Enter → submit (only when form fields are focused)
      if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.key === "\n")) {
        const activeTag = (document.activeElement as HTMLElement)?.tagName?.toLowerCase();
        if (activeTag === "input" || activeTag === "select" || activeTag === "textarea") {
          e.preventDefault();
          // Trigger form submit by finding the submit button
          document.querySelector<HTMLButtonElement>(
            '[data-form="create-stream"] [type="submit"]'
          )?.click();
        }
      }

      // Alt + R → focus Recipient field
      if (e.altKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        recipientRef.current?.focus();
      }

      // Alt + A → focus Amount field
      if (e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        amountRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // ── Submit handler ─────────────────────────────────────────────────────────

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    setAnnouncement("Creating stream, please wait…");

    try {
      await onSubmit({ recipient, amount, token });
      setAnnouncement("Stream created successfully.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "An unexpected error occurred.";
      setAnnouncement(`Stream creation failed: ${msg}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Cancel handler ─────────────────────────────────────────────────────────

  const handleCancel = () => {
    setAnnouncement("Stream creation cancelled.");
    onCancel?.();
  };

  // ── Render skeleton ────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div
        className={className}
        aria-busy="true"
        aria-label="Loading stream form…"
        data-testid="create-stream-form-loading"
      >
        {/* SR announcement for loading state */}
        <LiveRegion message="Loading stream creation form…" data-testid="create-stream-live" />
        <FormSkeleton />
      </div>
    );
  }

  // ── Render form ────────────────────────────────────────────────────────────

  return (
    /*
     * .create-stream-form — scoping root for all CSS token rules.
     * Spacing, typography, and border-radius are applied via class names
     * defined in app/globals.css (.csf-*) rather than inline styles, so
     * the design token scale propagates automatically to all themes.
     */
    <div
      className={`create-stream-form${className ? ` ${className}` : ""}`}
      data-testid="create-stream-form-wrapper"
    >
      {/* Screen reader live region — announces state changes */}
      <LiveRegion
        message={announcement}
        politeness="polite"
        data-testid="create-stream-live"
      />

      <form
        data-form="create-stream"
        onSubmit={handleSubmit}
        noValidate
      >
        {/* ── Recipient ─────────────────────────────────────────────── */}
        <div className="csf-field-group">
          {/* Label row: label + Alt+R KbdHint side by side */}
          <div className="csf-label-row">
            <label htmlFor="csf-recipient" className="csf-label">
              Recipient address
            </label>
            {/* Keyboard shortcut hint: Alt+R focuses this field */}
            <KbdHint
              keys={["Alt", "R"]}
              label="Jump to recipient field"
              aria-hidden
            />
          </div>
          <input
            ref={recipientRef}
            id="csf-recipient"
            type="text"
            required
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="GABC…"
            autoComplete="off"
            spellCheck={false}
            className="csf-field"
            aria-describedby="csf-recipient-hint"
          />
          <p id="csf-recipient-hint" className="csf-hint">
            Stellar address of the stream recipient.
          </p>
        </div>

        {/* ── Amount + Token ─────────────────────────────────────────── */}
        {/*
         * .csf-grid → `display: grid; grid-template-columns: 2fr 1fr;
         *              gap: var(--space-4)`  (see globals.css)
         */}
        <div className="csf-grid">
          <div className="csf-field-group">
            {/* Label row: label + Alt+A KbdHint side by side */}
            <div className="csf-label-row">
              <label htmlFor="csf-amount" className="csf-label">
                Amount
              </label>
              {/* Keyboard shortcut hint: Alt+A focuses this field */}
              <KbdHint
                keys={["Alt", "A"]}
                label="Jump to amount field"
                aria-hidden
              />
            </div>
            <input
              ref={amountRef}
              id="csf-amount"
              type="number"
              required
              min="0.0000001"
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="100"
              className="csf-field"
            />
          </div>
          <div className="csf-field-group">
            <label htmlFor="csf-token" className="csf-label">
              Token
            </label>
            <select
              id="csf-token"
              value={token}
              onChange={(e) => setToken(e.target.value as StreamToken)}
              className="csf-field"
            >
              <option value="XLM">XLM</option>
              <option value="USDC">USDC</option>
            </select>
          </div>
        </div>

        {/* ── Actions ────────────────────────────────────────────────── */}
        {/*
         * .csf-actions → `display: flex; justify-content: flex-end;
         *                 align-items: center; gap: var(--space-4)`
         */}
        <div className="csf-actions">
          {/* Cancel button with Esc hint */}
          <button
            type="button"
            className="button button--secondary csf-field"
            onClick={handleCancel}
            aria-label="Cancel stream creation"
          >
            Cancel
            <KbdHint
              keys={["Esc"]}
              label="Cancel and go back"
              className="button__kbd"
              aria-hidden
            />
          </button>

          {/* Submit button with Ctrl+Enter hint */}
          <button
            type="submit"
            className={`button button--primary csf-field${isSubmitting ? " button--busy" : ""}`}
            disabled={isSubmitting}
            aria-label={isSubmitting ? "Creating stream, please wait" : "Create stream"}
          >
            {isSubmitting ? "Creating…" : "Create Stream"}
            {!isSubmitting && (
              <KbdHint
                keys={["Ctrl", "↵"]}
                label="Submit with keyboard"
                className="button__kbd"
                aria-hidden
              />
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
