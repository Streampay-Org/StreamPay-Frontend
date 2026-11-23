"use client";

import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal";
import type { Stream } from "../types/openapi";

export interface AmendStreamModalProps {
  isOpen: boolean;
  onClose: () => void;
  stream: Stream;
  onAmended: (updated: Stream) => void;
  onApprovalRequired?: (approval: unknown) => void;
}

function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `amend-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toDateTimeLocal(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseNumericRate(value: string): number | null {
  const match = /^\s*([+-]?\d+(?:\.\d+)?)(?:\s+[A-Za-z0-9/._-]+)?\s*$/.exec(value);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

export function AmendStreamModal({
  isOpen,
  onClose,
  stream,
  onAmended,
  onApprovalRequired,
}: AmendStreamModalProps) {
  const [rate, setRate] = useState(stream.rate ?? "");
  const [endsAt, setEndsAt] = useState(() => toDateTimeLocal(stream.endTime));
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ rate?: string; endsAt?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [approvalNotice, setApprovalNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setRate(stream.rate ?? "");
      setEndsAt(toDateTimeLocal(stream.endTime));
      setIdempotencyKey(generateIdempotencyKey());
      setFieldErrors({});
      setServerError(null);
      setApprovalNotice(null);
      setIsSubmitting(false);
    }
  }, [isOpen, stream.rate, stream.endTime]);

  const tokenLabel = stream.token || "XLM";

  const previewTotal = useMemo(() => {
    const parsedRate = parseNumericRate(rate);
    if (parsedRate === null || parsedRate <= 0) return null;

    const endMs = endsAt ? Date.parse(endsAt) : stream.endTime ? Date.parse(stream.endTime) : NaN;
    if (!Number.isFinite(endMs)) return null;

    const startMs = stream.startTime ? Date.parse(stream.startTime) : Date.now();
    if (!Number.isFinite(startMs) || endMs <= startMs) return null;

    const durationSeconds = Math.floor((endMs - startMs) / 1000);
    const total = parsedRate * durationSeconds;
    if (!Number.isFinite(total)) return null;

    return total.toLocaleString("en-US", { maximumFractionDigits: 4 });
  }, [rate, endsAt, stream.endTime, stream.startTime]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setServerError(null);
    setApprovalNotice(null);

    const errors: { rate?: string; endsAt?: string } = {};
    const trimmedRate = rate.trim();
    const trimmedEndsAt = endsAt.trim();

    if (!trimmedRate && !trimmedEndsAt) {
      errors.rate = "Provide a new rate or end date.";
    }

    if (trimmedRate) {
      const parsedRate = parseNumericRate(trimmedRate);
      if (parsedRate === null || parsedRate <= 0) {
        errors.rate = "Rate must be greater than 0.";
      }
    }

    let endsAtIso: string | undefined;
    if (trimmedEndsAt) {
      const parsedEnd = Date.parse(trimmedEndsAt);
      if (!Number.isFinite(parsedEnd)) {
        errors.endsAt = "Enter a valid end date and time.";
      } else if (parsedEnd <= Date.now()) {
        errors.endsAt = "End date must be in the future.";
      } else if (stream.startTime && parsedEnd <= Date.parse(stream.startTime)) {
        errors.endsAt = "End date must be after the stream start time.";
      } else {
        endsAtIso = new Date(parsedEnd).toISOString();
      }
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    setIsSubmitting(true);

    const payload: { rate?: string; endsAt?: string } = {};
    if (trimmedRate) payload.rate = trimmedRate;
    if (endsAtIso) payload.endsAt = endsAtIso;

    try {
      const response = await fetch(`/api/streams/${encodeURIComponent(stream.id)}/amend`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      const body = await response.json().catch(() => null);

      if (response.status === 202) {
        setApprovalNotice(
          "Amendment submitted for organization approval. Changes will take effect once required approvals are met.",
        );
        onApprovalRequired?.(body?.data);
        return;
      }

      if (response.ok && body?.data) {
        onAmended(body.data as Stream);
        onClose();
        return;
      }

      const apiFields = body?.error?.details?.fields;
      if (apiFields && typeof apiFields === "object") {
        setFieldErrors({
          rate: typeof apiFields.rate === "string" ? apiFields.rate : undefined,
          endsAt: typeof apiFields.endsAt === "string" ? apiFields.endsAt : undefined,
        });
      }

      const message =
        typeof body?.error?.message === "string"
          ? body.error.message
          : typeof body?.message === "string"
            ? body.message
            : "Failed to amend stream. Please try again.";
      setServerError(message);
    } catch {
      setServerError("Network error while amending stream. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Amend stream">
      <form className="amend-stream" onSubmit={handleSubmit} noValidate>
        <p className="amend-stream__intro">
          Update the stream rate or end date. Changes take effect immediately for individual streams
          or enter approval for multi-sig organizations.
        </p>

        <div className="amend-stream__field">
          <label htmlFor="amend-stream-rate">Rate ({tokenLabel}/sec)</label>
          <input
            id="amend-stream-rate"
            name="rate"
            type="text"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            aria-invalid={fieldErrors.rate ? "true" : "false"}
            aria-describedby={fieldErrors.rate ? "amend-stream-rate-error" : undefined}
            disabled={isSubmitting}
          />
          {fieldErrors.rate && (
            <p id="amend-stream-rate-error" className="amend-stream__error" role="alert">
              {fieldErrors.rate}
            </p>
          )}
        </div>

        <div className="amend-stream__field">
          <label htmlFor="amend-stream-ends-at">End date</label>
          <input
            id="amend-stream-ends-at"
            name="endsAt"
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            aria-invalid={fieldErrors.endsAt ? "true" : "false"}
            aria-describedby={fieldErrors.endsAt ? "amend-stream-ends-at-error" : undefined}
            disabled={isSubmitting}
          />
          {fieldErrors.endsAt && (
            <p id="amend-stream-ends-at-error" className="amend-stream__error" role="alert">
              {fieldErrors.endsAt}
            </p>
          )}
        </div>

        {previewTotal !== null && (
          <div className="amend-stream__preview" data-testid="amend-total-preview">
            <span>Estimated new total: </span>
            <strong>
              {previewTotal} {tokenLabel}
            </strong>
          </div>
        )}

        {approvalNotice && (
          <p className="amend-stream__notice" role="status" data-testid="amend-approval-notice">
            {approvalNotice}
          </p>
        )}

        {serverError && (
          <p className="amend-stream__server-error" role="alert" data-testid="amend-server-error">
            {serverError}
          </p>
        )}

        <div className="amend-stream__footer">
          <button
            className="button button--secondary"
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
          >
            {approvalNotice ? "Close" : "Cancel"}
          </button>
          {!approvalNotice && (
            <button
              className="button button--primary"
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Amending..." : "Save amendment"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
