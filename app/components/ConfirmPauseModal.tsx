"use client";

import { useRef, useState } from "react";
import { Modal } from "./Modal";

export type ConfirmPauseModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  /** Stream identifier shown in the confirmation summary. */
  streamId: string;
  /** Payment rate / amount label (e.g. "120 XLM / month"). */
  amountLabel: string;
  /** Recipient display string (label, email, or address). */
  recipientLabel: string;
  /** Schedule / timing text shown before pausing. */
  timingLabel: string;
};

/**
 * Pause confirmation modal — distinct from cancel.
 *
 * Freezes accrual without refunding escrow. Shows stream, amount, recipient,
 * and timing before the user confirms. Guards against duplicate submits while
 * pending, and surfaces rejection / timeout failures without closing.
 */
export function ConfirmPauseModal({
  isOpen,
  onClose,
  onConfirm,
  streamId,
  amountLabel,
  recipientLabel,
  timingLabel,
}: ConfirmPauseModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const closeAndReset = () => {
    if (inFlightRef.current) return;
    setErrorMessage(null);
    setIsSubmitting(false);
    onClose();
  };

  const handleConfirm = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      await onConfirm();
      inFlightRef.current = false;
      setIsSubmitting(false);
      setErrorMessage(null);
      onClose();
    } catch (err: unknown) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Pause failed. Please try again.";
      setErrorMessage(message);
      inFlightRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={closeAndReset} title="Pause stream">
      <div className="confirm-action" data-testid="confirm-pause-modal">
        <p className="confirm-action__warning">
          Pausing freezes accrual until you resume. Escrow stays locked — this is
          not a cancellation.
        </p>

        <dl className="confirm-action__details">
          <div>
            <dt>Stream</dt>
            <dd data-testid="pause-stream-id">{streamId}</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd data-testid="pause-amount">{amountLabel}</dd>
          </div>
          <div>
            <dt>Recipient</dt>
            <dd data-testid="pause-recipient">{recipientLabel}</dd>
          </div>
          <div>
            <dt>Timing</dt>
            <dd data-testid="pause-timing">{timingLabel}</dd>
          </div>
        </dl>

        <p className="confirm-action__copy">
          Confirm to pause this stream. You can resume later from the stream
          detail page.
        </p>

        {errorMessage && (
          <p className="confirm-action__error" role="alert" data-testid="pause-error">
            {errorMessage}
          </p>
        )}

        <div className="confirm-action__footer">
          <button
            className="button button--secondary"
            onClick={closeAndReset}
            type="button"
            disabled={isSubmitting}
          >
            Keep streaming
          </button>
          <button
            className="button button--primary"
            disabled={isSubmitting}
            onClick={handleConfirm}
            type="button"
            data-testid="pause-confirm"
          >
            {isSubmitting ? "Pausing..." : "Confirm pause"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
