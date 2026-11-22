"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal";
import { STROOPS_SCALE } from "../lib/amount";
import { computeCancellationSplit, type CancellationSplitResult } from "../lib/cancel-stream";
import { escrowNow, resolveEscrowState } from "../lib/escrow-state";
import { buildCancelInput } from "../lib/stream-outcome-preview";
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

type PreviewResult =
  | { ok: true; split: CancellationSplitResult }
  | { ok: false; message: string };

/** Format a raw i128 (stroops) amount as a trimmed decimal string. */
function formatRaw(raw: bigint): string {
  const whole = raw / STROOPS_SCALE;
  const fraction = (raw % STROOPS_SCALE).toString().padStart(7, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/**
 * Cancel-stream confirmation modal with an exact refund preview.
 *
 * Fetches the authoritative cancel preview from `GET /api/streams/:id/cancel/preview`
 * when opened, falling back to the shared local `computeCancellationSplit` calculation
 * if the request fails or the client is offline.
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
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [serverResult, setServerResult] = useState<PreviewResult | null>(null);
  const [previewFallbackNotice, setPreviewFallbackNotice] = useState<string | null>(null);

  const localResult = useMemo<PreviewResult>(() => {
    const escrow = resolveEscrowState(stream, now ?? escrowNow());
    if (!escrow.ok) {
      return { ok: false, message: "Escrow state is unavailable for this stream." };
    }
    return computeCancellationSplit(stream, buildCancelInput(stream, escrow.value));
  }, [stream, now]);

  useEffect(() => {
    if (!isOpen || !stream.id || typeof fetch !== "function") {
      setServerResult(null);
      setIsLoadingPreview(false);
      setPreviewFallbackNotice(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    setIsLoadingPreview(true);
    setPreviewFallbackNotice(null);

    fetch(`/api/streams/${encodeURIComponent(stream.id)}/cancel/preview`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (cancelled) return;
        const body = await response.json().catch(() => null);

        if (response.ok && body?.data) {
          const { recipientPayout, senderRefund, escrowDrained } = body.data;
          if (
            typeof recipientPayout === "string" &&
            typeof senderRefund === "string" &&
            typeof escrowDrained === "string"
          ) {
            setServerResult({
              ok: true,
              split: {
                recipientPayout: BigInt(recipientPayout),
                senderRefund: BigInt(senderRefund),
                escrowDrained: BigInt(escrowDrained),
              },
            });
            setPreviewFallbackNotice(null);
            return;
          }
        }

        if ((response.status === 409 || response.status === 422) && typeof body?.error?.message === "string") {
          setServerResult({ ok: false, message: body.error.message });
          setPreviewFallbackNotice(null);
          return;
        }

        setServerResult(null);
        setPreviewFallbackNotice("Unable to refresh preview from server; showing local estimate.");
      })
      .catch(() => {
        if (cancelled) return;
        setServerResult(null);
        setPreviewFallbackNotice("Unable to refresh preview from server; showing local estimate.");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingPreview(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isOpen, stream.id]);

  const result = serverResult ?? localResult;

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

        {isLoadingPreview && (
          <p className="cancel-stream__loading" data-testid="cancel-preview-loading">
            Refreshing preview...
          </p>
        )}

        {previewFallbackNotice && (
          <p className="cancel-stream__notice" data-testid="cancel-preview-error">
            {previewFallbackNotice}
          </p>
        )}

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
