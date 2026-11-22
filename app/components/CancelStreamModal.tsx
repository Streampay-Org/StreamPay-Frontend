"use client";

import { useMemo, useState } from "react";
import { Modal } from "./Modal";
import { STROOPS_SCALE } from "../lib/amount";
import { computeCancellationSplit } from "../lib/cancel-stream";
import { escrowNow, resolveEscrowState } from "../lib/escrow-state";
import type { Stream } from "../types/openapi";

type CancelStreamModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  /** Persisted stream data used by the same escrow resolver as the API. */
  stream: Stream;
  /** Injected clock for deterministic previews and tests. */
  now?: Date;
  tokenLabel?: string;
};

/** Format a raw i128 (stroops) amount as a trimmed decimal string. */
function formatRaw(raw: bigint): string {
  const whole = raw / STROOPS_SCALE;
  const fraction = (raw % STROOPS_SCALE).toString().padStart(7, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/**
 * Cancel-stream confirmation modal with an exact refund preview.
 *
 * Before allowing the (irreversible) cancellation, it shows the precise split
 * the recipient keeps vs. the amount refunded to the sender, computed by the
 * shared `computeCancellationSplit` logic. If the stream cannot be cancelled
 * (terminal/draft state, or a broken escrow invariant) the confirm action is
 * disabled and the reason is shown instead of a preview.
 */
export function CancelStreamModal({
  isOpen,
  onClose,
  onConfirm,
  stream,
  now,
  tokenLabel = "tokens",
}: CancelStreamModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const result = useMemo(() => {
    const escrow = resolveEscrowState(stream, now ?? escrowNow());
    if (!escrow.ok) {
      return { ok: false as const, message: "Escrow state is unavailable for this stream." };
    }
    return computeCancellationSplit(stream, {
      totalAmount: escrow.value.total,
      releasedAmount: escrow.value.released,
      vestedAmount: escrow.value.vested,
      token: stream.token ?? "XLM",
      senderAddress: stream.senderAddress ?? "",
      recipientAddress: stream.recipient,
    });
  }, [stream, now]);

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Cancel stream">
      <div className="cancel-stream">
        <p className="cancel-stream__warning" role="alert">
          Cancelling stops all future payouts. This action cannot be undone.
        </p>

        {result.ok ? (
          <>
            <p className="cancel-stream__intro">Review the exact refund split before confirming:</p>
            <dl className="cancel-stream__split">
              <div>
                <dt>Recipient keeps</dt>
                <dd data-testid="recipient-payout">
                  {formatRaw(result.split.recipientPayout)} {tokenLabel}
                </dd>
              </div>
              <div>
                <dt>Refunded to you</dt>
                <dd data-testid="sender-refund">
                  {formatRaw(result.split.senderRefund)} {tokenLabel}
                </dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="cancel-stream__blocked" role="alert" data-testid="cancel-blocked">
            {result.message}
          </p>
        )}

        <div className="cancel-stream__footer">
          <button className="button button--secondary" onClick={onClose} type="button">
            Keep stream
          </button>
          <button
            className="button button--danger"
            disabled={!result.ok || isSubmitting}
            onClick={handleConfirm}
            type="button"
          >
            {isSubmitting ? "Cancelling..." : "Confirm cancellation"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
