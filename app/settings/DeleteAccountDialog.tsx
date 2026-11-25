"use client";

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { Modal, type FocusTarget } from "../components/Modal";
import { Timestamp, formatAbsoluteTimestamp } from "../components/Timestamp";
import { fetchWithIdempotency, type StreamPayError } from "@/lib/apiClient";

const CONFIRMATION_PHRASE = "DELETE";

const SESSION_TOKEN_STORAGE_KEYS = [
  "streampay_auth_token",
  "streampay_token",
  "auth_token",
];

export interface DeleteAccountResult {
  requestId: string;
  status: string;
  message?: string;
  completion_estimate: string;
  scrubbedCount?: number;
}

interface DeleteAccountApiResponse {
  data: DeleteAccountResult;
}

interface DeleteErrorState {
  code?: string;
  message: string;
  requestId?: string;
}

export interface DeleteAccountDialogProps {
  isOpen: boolean;
  onClose: () => void;
  restoreFocusTarget?: FocusTarget;
  /**
   * Optional provider for the stored session Bearer token.
   * Defaults to reading known session token keys from browser storage.
   */
  getAuthToken?: () => string | null | undefined;
  /**
   * Optional callback invoked after a 202 Accepted deletion response.
   */
  onDeleteSuccess?: (result: DeleteAccountResult) => void;
}

function readStoredSessionToken(): string | null {
  if (typeof window === "undefined") return null;

  for (const storage of [window.sessionStorage, window.localStorage]) {
    try {
      for (const key of SESSION_TOKEN_STORAGE_KEYS) {
        const value = storage?.getItem(key);
        if (value && value.trim().length > 0) {
          return value.trim();
        }
      }
    } catch {
      // Ignore storage access errors (e.g. restricted browsing contexts).
    }
  }

  return null;
}

function extractDeleteError(error: unknown): DeleteErrorState {
  if (error && typeof error === "object" && "code" in error) {
    const streamPayError = error as StreamPayError;
    const requestId =
      streamPayError.requestId && streamPayError.requestId !== "unknown"
        ? streamPayError.requestId
        : undefined;

    if (streamPayError.code === "UNAUTHORIZED") {
      return {
        code: streamPayError.code,
        message:
          "Your session has expired or is unauthorized. Please sign in again and retry.",
        requestId,
      };
    }

    return {
      code: streamPayError.code,
      message:
        streamPayError.message ||
        "We could not submit your account deletion request. Please try again.",
      requestId,
    };
  }

  if (error instanceof Error && error.message) {
    return {
      message: error.message,
    };
  }

  return {
    message:
      "We could not submit your account deletion request. Please try again.",
  };
}

export function DeleteAccountDialog({
  isOpen,
  onClose,
  restoreFocusTarget,
  getAuthToken = readStoredSessionToken,
  onDeleteSuccess,
}: DeleteAccountDialogProps) {
  const [confirmationText, setConfirmationText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorState, setErrorState] = useState<DeleteErrorState | null>(null);
  const [result, setResult] = useState<DeleteAccountResult | null>(null);
  const [copied, setCopied] = useState(false);

  const submittingRef = useRef(false);
  const inputId = useId();
  const descriptionId = useId();

  const isConfirmed = confirmationText.trim() === CONFIRMATION_PHRASE;

  useEffect(() => {
    if (!isOpen) {
      setConfirmationText("");
      setIsSubmitting(false);
      setErrorState(null);
      setResult(null);
      setCopied(false);
      submittingRef.current = false;
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    if (submittingRef.current) return;
    onClose();
  }, [onClose]);

  const submitDeletion = useCallback(async () => {
    if (!isConfirmed || submittingRef.current) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    setErrorState(null);

    try {
      const headers = new Headers();
      const token = getAuthToken?.();
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      }

      const response = await fetchWithIdempotency<DeleteAccountApiResponse>(
        "/api/identity/me/delete",
        {
          method: "DELETE",
          headers,
          credentials: "same-origin",
        },
        {
          retries: 0,
        },
      );

      // Decision: Do NOT clear local session data immediately on 202 Accepted.
      // Account deletion is fulfilled asynchronously over a 30-day DSR window,
      // and keeping the session intact lets the user review and copy their
      // request ID without being abruptly signed out mid-confirmation.
      setResult(response.data);
      onDeleteSuccess?.(response.data);
    } catch (error) {
      setErrorState(extractDeleteError(error));
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [getAuthToken, isConfirmed, onDeleteSuccess]);

  const handleFormSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void submitDeletion();
    },
    [submitDeletion],
  );

  const handleCopyRequestId = useCallback(async () => {
    if (!result?.requestId) return;
    try {
      await navigator.clipboard?.writeText(result.requestId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [result]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={result ? "Deletion request received" : "Request account deletion"}
      restoreFocusTarget={restoreFocusTarget}
      ariaDescribedBy={descriptionId}
      closeLabel="Close account deletion dialog"
    >
      {result ? (
        <div className="confirm-action">
          <p id={descriptionId} className="confirm-action__copy">
            {result.message ||
              "Your deletion request has been received and is being processed. All PII will be scrubbed within 30 days."}
          </p>

          <dl className="confirm-action__details" style={{ marginTop: "1rem" }}>
            <div>
              <dt>Request ID</dt>
              <dd
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                <code>{result.requestId}</code>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => void handleCopyRequestId()}
                  aria-label="Copy request ID"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{result.status}</dd>
            </div>
            <div>
              <dt>Estimated completion</dt>
              <dd>
                <span>{formatAbsoluteTimestamp(result.completion_estimate)}</span>{" "}
                (<Timestamp iso={result.completion_estimate} />)
              </dd>
            </div>
          </dl>

          <div
            className="confirm-action__footer"
            style={{
              display: "flex",
              justifyContent: "flex-end",
              marginTop: "1.5rem",
            }}
          >
            <button
              type="button"
              className="button button--primary"
              onClick={handleClose}
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <form className="confirm-action" onSubmit={handleFormSubmit}>
          <p id={descriptionId} className="confirm-action__warning">
            This permanently scrubs your personally identifiable information
            (PII) within 30 days. De-identified aggregate stream records are
            retained for 7 years for legal and audit compliance.
          </p>

          <div
            className="confirm-action__input-wrap"
            style={{ marginTop: "1rem" }}
          >
            <label className="confirm-action__label" htmlFor={inputId}>
              Type <strong>{CONFIRMATION_PHRASE}</strong> to confirm
            </label>
            <input
              id={inputId}
              type="text"
              autoComplete="off"
              className="confirm-action__input"
              value={confirmationText}
              onChange={(event) => setConfirmationText(event.target.value)}
              placeholder={CONFIRMATION_PHRASE}
              disabled={isSubmitting}
              data-focus-trap-initial="true"
            />
          </div>

          {errorState && (
            <div
              role="alert"
              style={{
                color: "var(--system-error-text)",
                marginTop: "1rem",
              }}
            >
              <p>{errorState.message}</p>
              {errorState.requestId && (
                <p style={{ marginTop: "0.25rem", fontSize: "0.875rem" }}>
                  Request ID: <code>{errorState.requestId}</code>
                </p>
              )}
            </div>
          )}

          <div
            className="confirm-action__footer"
            style={{
              display: "flex",
              gap: "0.75rem",
              justifyContent: "flex-end",
              marginTop: "1.5rem",
            }}
          >
            <button
              type="button"
              className="button button--secondary"
              onClick={handleClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>

            {errorState ? (
              <button
                type="button"
                className="button button--danger"
                onClick={() => void submitDeletion()}
                disabled={isSubmitting || !isConfirmed}
              >
                {isSubmitting ? "Requesting deletion..." : "Retry"}
              </button>
            ) : (
              <button
                type="submit"
                className="button button--danger"
                disabled={isSubmitting || !isConfirmed}
              >
                {isSubmitting
                  ? "Requesting deletion..."
                  : "Request account deletion"}
              </button>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}
