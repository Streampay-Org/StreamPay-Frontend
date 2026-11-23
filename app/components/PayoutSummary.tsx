import React from "react";

interface PayoutSummaryProps {
  campaignName: string;
  totalAmount: string;
  tokenSymbol?: string;
  recipientCount?: number;
}

export function PayoutSummary({
  campaignName,
  totalAmount,
  tokenSymbol = "USDC",
  recipientCount = 0,
}: PayoutSummaryProps) {
  return (
    <section
      aria-labelledby="payout-summary-heading"
      className="w-full rounded-2xl border border-[var(--border)] bg-[var(--panel-elevated)] p-4 shadow-soft backdrop-blur-sm transition-colors sm:p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
            GrantFox campaign
          </p>
          <h2
            id="payout-summary-heading"
            className="text-lg font-semibold tracking-tight text-[var(--foreground)] sm:text-xl"
          >
            GrantFox payout summary
          </h2>
          <p className="text-sm text-[var(--muted-foreground)]">{campaignName}</p>
        </div>

        <div className="grid gap-3 sm:min-w-[240px] sm:justify-items-end">
          <div className="space-y-1 sm:text-right">
            <p className="text-xs font-medium text-[var(--muted)]">Total amount</p>
            <p className="text-2xl font-bold tracking-tight text-[var(--foreground)] sm:text-3xl">
              {`${totalAmount} ${tokenSymbol}`}
            </p>
          </div>

          <p className="text-sm text-[var(--muted-foreground)]">
            <span className="font-semibold text-[var(--foreground)]">
              {`${recipientCount} ${recipientCount === 1 ? "recipient" : "recipients"}`}
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}

export default PayoutSummary;
