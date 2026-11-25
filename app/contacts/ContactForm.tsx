"use client";

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { isValidStellarPublicKey } from "../lib/stellar-address";
import {
  FederationError,
  isFederationAddress,
  resolveFederationAddress,
} from "../utils/federation";
import type { RequiredMemo } from "./types";

// ─── Validation ───────────────────────────────────────────────────────────────

function isValidStellarAddress(value: string): boolean {
  return isValidStellarPublicKey(value);
}

export const LABEL_MAX_LENGTH = 64;
export const MEMO_MAX_LENGTH = 256;

const INVALID_ADDRESS_MESSAGE =
  "Enter a valid Stellar address (G…) or federation address (user*domain.com)";

const STELLAR_ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

export type NormaliseResult =
  | { resolved: string; federation?: string; requiredMemo?: RequiredMemo }
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
export async function normaliseAddressInput(
  raw: string,
): Promise<NormaliseResult> {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "Address is required" };

  if (isFederationAddress(trimmed)) {
    try {
      const record = await resolveFederationAddress(trimmed);
      const requiredMemo: RequiredMemo | undefined =
        record.memo_type && record.memo
          ? {
              type: record.memo_type,
              value: record.memo,
            }
          : undefined;
      return {
        resolved: record.account_id,
        federation: trimmed,
        requiredMemo,
      };
    } catch (err) {
      return {
        error:
          err instanceof FederationError
            ? err.message
            : "Failed to resolve federation address",
      };
    }
  }

  // Strkeys are case-insensitive base32; validate and store the canonical
  // uppercase form so a lowercase paste is accepted and normalised.
  const upper = trimmed.toUpperCase();
  if (STELLAR_ACCOUNT_RE.test(upper)) {
    if (!isValidStellarAddress(upper)) {
      return { error: "Invalid Stellar address" };
    }
    return { resolved: upper };
  }

  return { error: INVALID_ADDRESS_MESSAGE };
}

// ─── ContactForm ──────────────────────────────────────────────────────────────

export interface FormValues {
  label: string;
  address: string;
  memo: string;
  requiredMemo?: RequiredMemo;
}

export interface FormSubmitResult extends FormValues {
  resolvedAddress: string;
  federationAddress?: string;
  requiredMemo?: RequiredMemo;
}

export interface ContactFormProps {
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

export function ContactForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel,
}: ContactFormProps) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [requiredMemo, setRequiredMemo] = useState<RequiredMemo | undefined>(
    initial?.requiredMemo,
  );

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
  const requiredMemoId = useId();
  const summaryId = useId();

  const labelRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const memoRef = useRef<HTMLInputElement>(null);
  const requiredMemoRef = useRef<HTMLInputElement>(null);

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
          setRequiredMemo(result.requiredMemo);
          setResolveError("");
          setErrors((prev) => ({ ...prev, address: undefined }));
        } else {
          setResolvedAddress("");
          setFederationAddress(undefined);
          setRequiredMemo(undefined);
          // Surface resolver failures and invalid checksum errors immediately
          setResolveError(
            isFederation || result.error === "Invalid Stellar address"
              ? result.error
              : "",
          );
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
      let finalRequiredMemo = requiredMemo;
      if (!finalAddress) {
        const result = await (pendingRef.current ?? runNormalise(address));
        if (result === null) return; // superseded by a newer edit
        if ("resolved" in result) {
          finalAddress = result.resolved;
          finalFederation = result.federation;
          finalRequiredMemo = result.requiredMemo;
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
        requiredMemo: finalRequiredMemo,
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
                setRequiredMemo(undefined);
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

        {/* Required memo from federation */}
        {requiredMemo && (
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "0.5rem",
                marginBottom: "0.5rem",
                flexWrap: "wrap",
              }}
            >
              <label htmlFor={requiredMemoId} style={labelStyle}>
                Required memo
              </label>
              <span
                role="status"
                aria-label={`Required by ${federationAddress || address}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  padding: "0.2rem 0.6rem",
                  borderRadius: "9999px",
                  background: "var(--muted)",
                  color: "var(--foreground)",
                }}
              >
                Required by {federationAddress || address}
              </span>
            </div>
            <input
              ref={requiredMemoRef}
              id={requiredMemoId}
              type="text"
              value={requiredMemo.value}
              readOnly
              aria-readonly="true"
              style={{
                ...fieldStyle,
                backgroundColor: "rgba(125, 125, 125, 0.08)",
                cursor: "not-allowed",
              }}
            />
            <p style={hintStyle}>
              Memo type: {requiredMemo.type} · Cannot be edited or cleared
            </p>
          </div>
        )}

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
