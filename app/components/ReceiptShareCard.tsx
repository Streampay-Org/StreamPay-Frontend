"use client";

import React, { useState, useCallback } from "react";
import { LiveRegion } from "./LiveRegion";

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  draft: "Draft",
  ended: "Ended",
  paused: "Paused",
  withdrawn: "Withdrawn",
  cancelled: "Cancelled",
};

type ReceiptShareCardProps = {
  streamId: string;
  recipient: string;
  amount: string;
  assetCode?: string;
  status?: string;
  network?: "testnet" | "mainnet";
  /** Start with the recipient address masked (privacy-first default). */
  defaultMasked?: boolean;
};

export function maskAddress(address: string): string {
  if (address.length <= 10) return "•".repeat(address.length);
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

const COPY_FEEDBACK_MS = 2_000;

export function ReceiptShareCard({
  streamId,
  recipient,
  amount,
  assetCode = "XLM",
  status,
  network,
  defaultMasked = true,
}: ReceiptShareCardProps) {
  const [masked, setMasked] = useState(defaultMasked);
  const [copied, setCopied] = useState(false);
  // SR-only announcement text — see LiveRegion. Overwritten on every state
  // change we care about (copy feedback, mask toggle) so screen readers get
  // it even though nothing visible moves focus.
  const [announcement, setAnnouncement] = useState("");

  const shownRecipient = masked ? maskAddress(recipient) : recipient;

  const networkLabel =
    network === "mainnet" ? "Stellar Mainnet" : "Stellar Testnet";
  const statusLabel = status ? STATUS_LABELS[status] ?? status : undefined;

  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  const handleCopy = useCallback(() => {
    const shareText =
      `StreamPay receipt ${streamId}: ${amount} ${assetCode} to ${shownRecipient}`;
    navigator.clipboard?.writeText(shareText).then(() => {
      setCopied(true);
      setAnnouncement("Share text copied to clipboard.");
      const t = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
      timeoutRef.current = t;
    });
  }, [streamId, amount, assetCode, shownRecipient]);

  const handleMaskToggle = useCallback((next: boolean) => {
    setMasked(next);
    setAnnouncement(
      next ? "Recipient address hidden." : "Recipient address shown.",
    );
  }, []);

  // Cleanup any pending timeout when component unmounts
  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  return (
    <figure className="receipt-share-card" aria-label="Stream receipt share card">
      {/* SR-only — announces copy/mask-toggle state changes without moving focus. */}
      <LiveRegion message={announcement} />
      <div className="receipt-share-card__brand">
        <span className="receipt-share-card__wordmark">StreamPay</span>
        <span className="receipt-share-card__tagline">Receipt</span>
      </div>

      {network && (
        <span className="receipt-share-card__network" data-network={network}>
          {networkLabel}
        </span>
      )}

      <div className="receipt-share-card__amount">
        <span className="receipt-share-card__amount-value">{amount}</span>
        <span className="receipt-share-card__amount-asset">{assetCode}</span>
      </div>

      <dl className="receipt-share-card__meta">
        <div className="receipt-share-card__meta-row">
          <dt>Recipient</dt>
          <dd data-testid="receipt-recipient">{shownRecipient}</dd>
        </div>
        <div className="receipt-share-card__meta-row">
          <dt>Stream</dt>
          <dd>{streamId}</dd>
        </div>
      </dl>

      <div className="receipt-share-card__badges">
        {statusLabel && (
          <span
            className={`receipt-status-badge receipt-status-badge--${status}`}
          >
            {statusLabel}
          </span>
        )}
      </div>

      <div className="receipt-share-card__actions">
        <label className="receipt-share-card__toggle">
          <input
            type="checkbox"
            checked={masked}
            onChange={(e) => handleMaskToggle(e.target.checked)}
            aria-label="Mask recipient address for privacy"
          />
          <span className="receipt-share-card__toggle-label">
            Mask address
          </span>
        </label>

        <button
          type="button"
          className={`receipt-share-card__copy${copied ? " receipt-share-card__copy--copied" : ""}`}
          onClick={handleCopy}
          aria-label={copied ? "Share text copied" : "Copy share text"}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </figure>
  );
}
