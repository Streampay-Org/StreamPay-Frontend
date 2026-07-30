/**
 * Streaming loading UI for /streams/[id]/receipt.
 *
 * Next.js renders this file automatically while the server component above it
 * resolves, so users see a skeleton rather than a blank page on slow networks.
 * The skeleton mirrors the section structure of StreamReceipt to prevent layout
 * shift when the real document swaps in.
 */

import { Skeleton } from "../../../components/Skeleton";

function SkeletonField() {
  return (
    <div className="receipt-loading__field">
      <Skeleton variant="label" width="5rem" />
      <Skeleton variant="value" width="12rem" />
    </div>
  );
}

export default function ReceiptLoading() {
  return (
    <div className="receipt-shell" aria-busy="true" aria-label="Loading receipt">
      {/* Toolbar skeleton */}
      <div className="receipt-toolbar no-print">
        <div className="receipt-note-builder__actions">
          <Skeleton variant="button" />
          <Skeleton variant="button" width="5rem" />
        </div>
      </div>

      {/* Note-builder skeleton */}
      <div className="receipt-note-builder receipt-loading__note-builder no-print">
        <Skeleton variant="label" width="6rem" />
        <Skeleton className="receipt-loading__textarea" height="6rem" />
      </div>

      {/* Receipt document skeleton */}
      <article aria-hidden="true" className="receipt-doc receipt-loading__doc">
        {/* Header */}
        <div className="receipt-loading__header">
          <div className="receipt-loading__brand">
            <Skeleton variant="title" width="7rem" />
            <Skeleton variant="text" width="12rem" />
          </div>
          <Skeleton variant="badge" />
        </div>

        <div className="receipt-divider" />

        {/* Stream identity */}
        <div className="receipt-loading__section">
          <Skeleton variant="title" width="9rem" />
          <div className="receipt-loading__identity-row">
            <Skeleton variant="value" width="11rem" />
            <Skeleton variant="badge" width="4.5rem" />
          </div>
        </div>

        <div className="receipt-divider" />

        {/* Recipient section */}
        <div className="receipt-loading__section">
          <Skeleton variant="title" width="6rem" />
          <div className="receipt-loading__field-stack">
            <SkeletonField />
            <SkeletonField />
          </div>
        </div>

        <div className="receipt-divider" />

        {/* Payment details section */}
        <div className="receipt-loading__section">
          <Skeleton variant="title" width="9rem" />
          <div className="receipt-loading__field-stack">
            <SkeletonField />
            <SkeletonField />
            <SkeletonField />
            <SkeletonField />
          </div>
        </div>
      </article>
    </div>
  );
}
