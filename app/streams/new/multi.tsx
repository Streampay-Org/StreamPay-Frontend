"use client";

/**
 * Multi-Recipient Stream Creation Page
 *
 * Fan-out payment form that lets a sender create a single stream
 * distributed across multiple recipients in configurable proportions.
 *
 * Features
 * - Step indicator (Details → Recipients → Review) with WCAG 2.1 AA
 *   `aria-current="step"` semantics
 * - Equal / custom split toggle via RecipientList
 * - Sticky TotalsBar showing running campaign totals at all viewports
 * - Start/end date-time fields anchoring the stream window
 * - Design-token + dark-mode consistent styles (var(--*) throughout)
 * - All interactive elements have associated labels (htmlFor / aria-label)
 * - Navigation via next/link (no window.location.href)
 */

import React, { useState, useId } from "react";
import Link from "next/link";
import { RecipientList, type Recipient } from "./components/RecipientList";
import { TotalsBar } from "./components/TotalsBar";
import { StepIndicator, type Step } from "./components/StepIndicator";

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum recipients allowed per fan-out stream. */
export const MAX_RECIPIENTS = 20;

/** Wizard steps shown in the StepIndicator. */
const STEPS: Step[] = [
  { id: "details",    label: "Details",    description: "Stream name, token, and amount" },
  { id: "recipients", label: "Recipients", description: "Add recipients and set splits" },
  { id: "review",     label: "Review",     description: "Confirm before submitting" },
];

// ── Types ────────────────────────────────────────────────────────────────────

/** One wizard step index. */
type StepIndex = 0 | 1 | 2;

// ── Helper ───────────────────────────────────────────────────────────────────

/** Shared field style matching the single-stream creation page. */
const fieldStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--panel)",
  border: "1px solid var(--border)",
  color: "var(--foreground)",
  padding: "0.75rem",
  borderRadius: "var(--radius-md)",
  fontSize: "var(--text-base)",
};

// ── Component ────────────────────────────────────────────────────────────────

/**
 * MultiRecipientStreamPage
 *
 * Three-step wizard:
 *   0 – Details    (stream name, total amount, token, start/end)
 *   1 – Recipients (recipient list with split controls)
 *   2 – Review     (read-only summary before submit)
 */
export default function MultiRecipientStreamPage() {
  // Form state
  const [streamName, setStreamName]       = useState("");
  const [totalAmount, setTotalAmount]     = useState<number>(1000);
  const [token, setToken]                 = useState<"XLM" | "USDC">("XLM");
  const [startTime, setStartTime]         = useState("");
  const [endTime, setEndTime]             = useState("");
  const [recipients, setRecipients]       = useState<Recipient[]>([
    { id: crypto.randomUUID(), address: "", percentage: 100, amount: 1000 },
  ]);

  // UI state
  const [currentStep, setCurrentStep]     = useState<StepIndex>(0);
  const [isSubmitting, setIsSubmitting]   = useState(false);
  const [submitError, setSubmitError]     = useState<string | null>(null);
  const [success, setSuccess]             = useState(false);

  // Stable IDs for accessible label associations
  const nameId       = useId();
  const amountId     = useId();
  const tokenId      = useId();
  const startTimeId  = useId();
  const endTimeId    = useId();
  const errorId      = useId();

  // ── Derived state ──────────────────────────────────────────────────────────

  const totalAllocated = recipients.reduce((sum, r) => sum + r.percentage, 0);
  const allocationValid = Math.abs(totalAllocated - 100) < 0.001;
  const hasRecipients   = recipients.every((r) => r.address.trim().length > 0);

  const detailsValid =
    streamName.trim().length > 0 &&
    totalAmount > 0 &&
    startTime.length > 0 &&
    endTime.length > 0 &&
    new Date(endTime) > new Date(startTime);

  const canAdvance: Record<StepIndex, boolean> = {
    0: detailsValid,
    1: allocationValid && hasRecipients,
    2: true,
  };

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleTotalAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTotal = Number(e.target.value);
    setTotalAmount(newTotal);
    // Recompute each recipient's absolute amount from their stored percentage.
    setRecipients((prev) =>
      prev.map((r) => ({
        ...r,
        amount: Number(((r.percentage / 100) * newTotal).toFixed(4)),
      }))
    );
  };

  const handleNext = () => {
    if (currentStep < 2) setCurrentStep(((currentStep + 1) as StepIndex));
  };

  const handleBack = () => {
    if (currentStep > 0) setCurrentStep(((currentStep - 1) as StepIndex));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allocationValid || !hasRecipients) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // TODO: replace with real API call to POST /api/v2/streams/multi
      await new Promise<void>((resolve) => window.setTimeout(resolve, 75));
      setSuccess(true);
    } catch {
      setSubmitError("Failed to create stream. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Success screen ─────────────────────────────────────────────────────────

  if (success) {
    return (
      <main className="page-shell" aria-labelledby="success-title">
        <section className="page-hero">
          <div>
            <p className="page-hero__eyebrow">Success</p>
            <h1 id="success-title" className="page-hero__title">
              Stream Created Successfully
            </h1>
            <p className="page-hero__description">
              Your multi-recipient stream has been configured and is ready.
            </p>
          </div>
          <Link href="/streams" className="button button--primary">
            View All Streams
          </Link>
        </section>
      </main>
    );
  }

  // ── Main form ──────────────────────────────────────────────────────────────

  return (
    <main className="page-shell" aria-labelledby="multi-page-title">
      {/* Page header */}
      <section className="page-hero">
        <div>
          <p className="page-hero__eyebrow">New Stream</p>
          <h1 id="multi-page-title" className="page-hero__title">
            Create Multi-Recipient Stream
          </h1>
          <p className="page-hero__description">
            Fan out payments to multiple contributors or vendors simultaneously.
          </p>
        </div>
      </section>

      {/* Step progress indicator */}
      <div
        style={{
          maxWidth: "800px",
          margin: "0 auto",
          padding: "1.5rem 1.5rem 0",
        }}
      >
        <StepIndicator steps={STEPS} currentStep={currentStep} />
      </div>

      {/* Form body */}
      <section
        style={{ maxWidth: "800px", margin: "0 auto", padding: "2rem 1.5rem 8rem" }}
        aria-label="Stream creation form"
      >
        <form onSubmit={handleSubmit} noValidate>

          {/* ── Step 0: Details ── */}
          {currentStep === 0 && (
            <div
              role="group"
              aria-labelledby="step-details-heading"
              style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}
            >
              <h2
                id="step-details-heading"
                style={{ fontSize: "var(--text-xl)", fontWeight: "var(--font-semibold)", margin: 0 }}
              >
                Stream details
              </h2>

              {/* Stream name */}
              <div>
                <label
                  htmlFor={nameId}
                  style={{
                    display: "block",
                    fontSize: "var(--text-sm)",
                    marginBottom: "0.5rem",
                    color: "var(--muted-light)",
                  }}
                >
                  Stream name <span aria-hidden="true">*</span>
                </label>
                <input
                  id={nameId}
                  type="text"
                  required
                  autoComplete="off"
                  value={streamName}
                  onChange={(e) => setStreamName(e.target.value)}
                  placeholder="e.g. GrantFox Q3 Distribution"
                  aria-required="true"
                  style={fieldStyle}
                />
              </div>

              {/* Amount + token — responsive two-column grid */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                  gap: "1rem",
                }}
              >
                <div>
                  <label
                    htmlFor={amountId}
                    style={{
                      display: "block",
                      fontSize: "var(--text-sm)",
                      marginBottom: "0.5rem",
                      color: "var(--muted-light)",
                    }}
                  >
                    Total amount <span aria-hidden="true">*</span>
                  </label>
                  <input
                    id={amountId}
                    type="number"
                    required
                    min="0.0000001"
                    step="any"
                    value={totalAmount}
                    onChange={handleTotalAmountChange}
                    aria-required="true"
                    style={fieldStyle}
                  />
                </div>

                <div>
                  <label
                    htmlFor={tokenId}
                    style={{
                      display: "block",
                      fontSize: "var(--text-sm)",
                      marginBottom: "0.5rem",
                      color: "var(--muted-light)",
                    }}
                  >
                    Token <span aria-hidden="true">*</span>
                  </label>
                  <select
                    id={tokenId}
                    value={token}
                    onChange={(e) => setToken(e.target.value as "XLM" | "USDC")}
                    aria-required="true"
                    style={fieldStyle}
                  >
                    <option value="XLM">XLM</option>
                    <option value="USDC">USDC</option>
                  </select>
                </div>
              </div>

              {/* Start / end date-time — responsive two-column grid */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "1rem",
                }}
              >
                <div>
                  <label
                    htmlFor={startTimeId}
                    style={{
                      display: "block",
                      fontSize: "var(--text-sm)",
                      marginBottom: "0.5rem",
                      color: "var(--muted-light)",
                    }}
                  >
                    Start date / time <span aria-hidden="true">*</span>
                  </label>
                  <input
                    id={startTimeId}
                    type="datetime-local"
                    required
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    aria-required="true"
                    style={fieldStyle}
                  />
                </div>

                <div>
                  <label
                    htmlFor={endTimeId}
                    style={{
                      display: "block",
                      fontSize: "var(--text-sm)",
                      marginBottom: "0.5rem",
                      color: "var(--muted-light)",
                    }}
                  >
                    End date / time <span aria-hidden="true">*</span>
                  </label>
                  <input
                    id={endTimeId}
                    type="datetime-local"
                    required
                    value={endTime}
                    min={startTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    aria-required="true"
                    style={fieldStyle}
                  />
                </div>
              </div>

              {/* Step actions */}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "0.5rem" }}>
                <Link href="/streams/new" className="button button--secondary">
                  Cancel
                </Link>
                <button
                  type="button"
                  className="button button--primary"
                  disabled={!canAdvance[0]}
                  onClick={handleNext}
                  aria-disabled={!canAdvance[0]}
                >
                  Next: Recipients
                </button>
              </div>
            </div>
          )}

          {/* ── Step 1: Recipients ── */}
          {currentStep === 1 && (
            <div
              role="group"
              aria-labelledby="step-recipients-heading"
              style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}
            >
              <h2
                id="step-recipients-heading"
                style={{ fontSize: "var(--text-xl)", fontWeight: "var(--font-semibold)", margin: 0 }}
              >
                Recipients &amp; splits
              </h2>

              <RecipientList
                totalAmount={totalAmount}
                recipients={recipients}
                onChange={setRecipients}
              />

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "0.5rem" }}>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={handleBack}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="button button--primary"
                  disabled={!canAdvance[1]}
                  onClick={handleNext}
                  aria-disabled={!canAdvance[1]}
                >
                  Next: Review
                </button>
              </div>
            </div>
          )}

          {/* ── Step 2: Review ── */}
          {currentStep === 2 && (
            <div
              role="group"
              aria-labelledby="step-review-heading"
              style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}
            >
              <h2
                id="step-review-heading"
                style={{ fontSize: "var(--text-xl)", fontWeight: "var(--font-semibold)", margin: 0 }}
              >
                Review &amp; confirm
              </h2>

              {/* Summary card */}
              <dl
                style={{
                  display: "grid",
                  gridTemplateColumns: "max-content 1fr",
                  columnGap: "1.5rem",
                  rowGap: "0.75rem",
                  padding: "1.25rem",
                  background: "var(--panel)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-md)",
                  margin: 0,
                  fontSize: "var(--text-sm)",
                }}
              >
                <dt style={{ color: "var(--muted-light)" }}>Stream name</dt>
                <dd style={{ margin: 0, color: "var(--foreground)", fontWeight: 600 }}>{streamName}</dd>

                <dt style={{ color: "var(--muted-light)" }}>Total amount</dt>
                <dd style={{ margin: 0, color: "var(--foreground)", fontWeight: 600 }}>
                  {totalAmount.toLocaleString()} {token}
                </dd>

                <dt style={{ color: "var(--muted-light)" }}>Start</dt>
                <dd style={{ margin: 0, color: "var(--foreground)" }}>{startTime}</dd>

                <dt style={{ color: "var(--muted-light)" }}>End</dt>
                <dd style={{ margin: 0, color: "var(--foreground)" }}>{endTime}</dd>

                <dt style={{ color: "var(--muted-light)" }}>Recipients</dt>
                <dd style={{ margin: 0, color: "var(--foreground)" }}>{recipients.length}</dd>
              </dl>

              {/* Recipient breakdown table */}
              <div
                role="region"
                aria-label="Recipient allocation breakdown"
                style={{ overflowX: "auto" }}
              >
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "var(--text-sm)",
                  }}
                >
                  <thead>
                    <tr>
                      <th
                        scope="col"
                        style={{
                          textAlign: "left",
                          padding: "0.5rem 0.75rem",
                          color: "var(--muted-light)",
                          fontWeight: 600,
                          borderBottom: "1px solid var(--border)",
                        }}
                      >
                        Address
                      </th>
                      <th
                        scope="col"
                        style={{
                          textAlign: "right",
                          padding: "0.5rem 0.75rem",
                          color: "var(--muted-light)",
                          fontWeight: 600,
                          borderBottom: "1px solid var(--border)",
                        }}
                      >
                        Share
                      </th>
                      <th
                        scope="col"
                        style={{
                          textAlign: "right",
                          padding: "0.5rem 0.75rem",
                          color: "var(--muted-light)",
                          fontWeight: 600,
                          borderBottom: "1px solid var(--border)",
                        }}
                      >
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipients.map((r) => (
                      <tr key={r.id}>
                        <td
                          style={{
                            padding: "0.5rem 0.75rem",
                            color: "var(--foreground)",
                            fontFamily: "monospace",
                            wordBreak: "break-all",
                            borderBottom: "1px solid var(--border)",
                          }}
                        >
                          {r.address}
                        </td>
                        <td
                          style={{
                            textAlign: "right",
                            padding: "0.5rem 0.75rem",
                            color: "var(--foreground)",
                            borderBottom: "1px solid var(--border)",
                          }}
                        >
                          {r.percentage.toFixed(2)}%
                        </td>
                        <td
                          style={{
                            textAlign: "right",
                            padding: "0.5rem 0.75rem",
                            color: "var(--foreground)",
                            borderBottom: "1px solid var(--border)",
                          }}
                        >
                          {r.amount.toLocaleString()} {token}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Error message */}
              {submitError && (
                <div
                  id={errorId}
                  role="alert"
                  aria-live="assertive"
                  style={{
                    padding: "0.75rem 1rem",
                    background: "var(--error-bg, rgba(220,38,38,0.08))",
                    border: "1px solid var(--error)",
                    borderRadius: "var(--radius-md)",
                    color: "var(--error)",
                    fontSize: "var(--text-sm)",
                  }}
                >
                  {submitError}
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "0.5rem" }}>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={handleBack}
                  disabled={isSubmitting}
                >
                  Back
                </button>
                <button
                  type="submit"
                  className={`button button--primary${isSubmitting ? " button--busy" : ""}`}
                  disabled={isSubmitting}
                  aria-describedby={submitError ? errorId : undefined}
                >
                  {isSubmitting ? "Creating…" : "Confirm & Create Stream"}
                </button>
              </div>
            </div>
          )}
        </form>
      </section>

      {/* Sticky totals bar — visible on all steps */}
      <TotalsBar
        totalAmount={totalAmount.toLocaleString()}
        tokenSymbol={token}
        recipientCount={recipients.length}
      />
    </main>
  );
}
