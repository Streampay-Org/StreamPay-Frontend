"use client";

import React, { useId, useMemo, useState } from "react";

import { formatStroops, parseStroops } from "@/app/lib/amount";

/**
 * QuickDeposit
 *
 * Inline dashboard card that lets a user quickly deposit XLM into their
 * streaming balance without navigating to a separate page.
 *
 * ## Behaviour
 * - Controlled amount input with quick-select preset chips (10 / 50 / 100).
 * - Client-side validation: positive decimal, at most 7 fractional digits
 *   (Stellar precision). Errors are announced to assistive tech.
 * - Amounts are parsed into exact `bigint` stroops (never `Number`), so the
 *   Stellar int64 maximum is enforced without precision loss.
 * - When `availableStroops` (and optionally `reserveStroops`) are supplied the
 *   card is balance-aware: the deposit must not exceed the spendable amount,
 *   a "Max" chip fills the spendable amount, and presets above it are
 *   disabled with an explanation.
 * - On submit, calls `onDeposit(amount)` and reflects a pending state while
 *   the promise resolves. A failed deposit keeps the entered amount.
 *
 * ## Accessibility (WCAG 2.1 AA)
 * - The card is a labelled `<form>`; the input has an associated `<label>`.
 * - Validation errors use `role="alert"` and are linked via `aria-describedby`.
 * - The submit button exposes `aria-busy` while a deposit is in flight.
 *
 * ## Theming
 * Uses design tokens (`--panel`, `--border`, `--accent`, …) so it
 * is consistent in both light and dark mode.
 */

export interface QuickDepositProps {
  /**
   * Called with the validated amount (as a string in XLM) when the user
   * submits. May be async; the card shows a pending state until it settles.
   */
  onDeposit: (amount: string) => void | Promise<void>;
  /** Asset symbol shown in the UI. Defaults to "XLM". */
  asset?: string;
  /** Preset quick-amount chips. Defaults to 10 / 50 / 100. */
  presets?: readonly number[];
  /** Disables the whole card (e.g. wallet not connected). */
  disabled?: boolean;
  /**
   * Spendable wallet balance in stroops (1 XLM = 10_000_000 stroops).
   * When provided, the card validates deposits against the spendable amount
   * and shows a "Max" chip.
   */
  availableStroops?: bigint;
  /**
   * Network reserve that must stay in the account, in stroops. Subtracted
   * from `availableStroops` to obtain the spendable amount.
   */
  reserveStroops?: bigint;
}

/**
 * Parse a preset chip value into stroops without `Number` arithmetic.
 * Returns `null` when the preset is not a valid amount.
 */
function presetToStroops(preset: number): bigint | null {
  if (!Number.isFinite(preset)) return null;

  const result = parseStroops(String(preset));
  return result.ok ? result.value : null;
}

function validateAmount(
  raw: string,
  spendableStroops: bigint | null,
  reserveStroops: bigint,
  asset: string,
): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "Enter an amount to deposit.";

  const parsed = parseStroops(trimmed);

  if (!parsed.ok) {
    if (parsed.error.code === "AMOUNT_OVERFLOW") {
      return "Amount exceeds the Stellar maximum.";
    }

    return "Amount must be a positive number with up to 7 decimal places.";
  }

  if (parsed.value <= 0n) return "Amount must be greater than zero.";

  if (spendableStroops !== null && parsed.value > spendableStroops) {
    const spendable = formatStroops(spendableStroops);

    if (reserveStroops > 0n) {
      return `You can deposit up to ${spendable} ${asset} (keeping ${formatStroops(reserveStroops)} for the network reserve).`;
    }

    return `You can deposit up to ${spendable} ${asset}.`;
  }

  return null;
}

export function QuickDeposit({
  onDeposit,
  asset = "XLM",
  presets = [10, 50, 100],
  disabled = false,
  availableStroops,
  reserveStroops = 0n,
}: QuickDepositProps) {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const inputId = useId();
  const errorId = useId();

  /**
   * The amount the user may actually spend: the balance minus the network
   * reserve. `null` when no balance was supplied (validation is then limited
   * to the Stellar int64 maximum).
   */
  const spendableStroops = useMemo(() => {
    if (availableStroops === undefined) return null;

    const spendable = availableStroops - reserveStroops;
    return spendable > 0n ? spendable : 0n;
  }, [availableStroops, reserveStroops]);

  const spendableText = spendableStroops === null ? null : formatStroops(spendableStroops);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const validationError = validateAmount(amount, spendableStroops, reserveStroops, asset);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setPending(true);
    try {
      await onDeposit(amount.trim());
      setAmount("");
    } catch {
      setError("Deposit failed. Please try again.");
    } finally {
      setPending(false);
    }
  };

  const isDisabled = disabled || pending;

  return (
    <form className="quick-deposit" onSubmit={handleSubmit} aria-labelledby={`${inputId}-title`}>
      <div className="quick-deposit__header">
        <h3 id={`${inputId}-title`} className="quick-deposit__title">
          Quick deposit
        </h3>
        <span className="quick-deposit__asset" aria-hidden="true">
          {asset}
        </span>
      </div>

      <p className="quick-deposit__hint">Top up your balance to keep streams flowing.</p>

      <div className="quick-deposit__presets" role="group" aria-label="Preset amounts">
        {presets.map((preset) => {
          const presetStroops = presetToStroops(preset);
          const exceedsSpendable =
            spendableStroops !== null && presetStroops !== null && presetStroops > spendableStroops;
          const descriptionId = `${inputId}-preset-${preset}`;

          return (
            <React.Fragment key={preset}>
              <button
                type="button"
                className="quick-deposit__chip"
                onClick={() => {
                  setAmount(String(preset));
                  setError(null);
                }}
                disabled={isDisabled || exceedsSpendable}
                aria-describedby={exceedsSpendable ? descriptionId : undefined}
              >
                {preset} {asset}
              </button>
              {exceedsSpendable && (
                <span id={descriptionId} className="sr-only">
                  {`Preset ${preset} ${asset} is above your spendable balance of ${spendableText} ${asset}.`}
                </span>
              )}
            </React.Fragment>
          );
        })}

        {spendableText !== null && (
          <button
            type="button"
            className="quick-deposit__chip"
            onClick={() => {
              setAmount(spendableText);
              setError(null);
            }}
            disabled={isDisabled}
            aria-label={`Max ${spendableText} ${asset}`}
          >
            Max
          </button>
        )}
      </div>

      <label className="quick-deposit__label" htmlFor={inputId}>
        Amount ({asset})
      </label>
      <input
        id={inputId}
        className="quick-deposit__input"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={amount}
        onChange={(event) => {
          setAmount(event.target.value);
          if (error) setError(null);
        }}
        placeholder="0.00"
        disabled={isDisabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />

      {error && (
        <p id={errorId} className="quick-deposit__error" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        className="button button--primary quick-deposit__submit"
        disabled={isDisabled}
        aria-busy={pending}
      >
        {pending ? "Depositing…" : `Deposit ${asset}`}
      </button>

      <style jsx>{`
        .quick-deposit {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          padding: 1.25rem;
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 1rem;
          width: 100%;
          max-width: 28rem;
        }
        .quick-deposit__header {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .quick-deposit__title {
          font-size: 1.05rem;
          margin: 0;
        }
        .quick-deposit__asset {
          font-size: 0.8rem;
          font-weight: 600;
          color: var(--accent);
        }
        .quick-deposit__hint {
          margin: 0;
          font-size: 0.85rem;
          color: var(--muted);
        }
        .quick-deposit__presets {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
        }
        .quick-deposit__chip {
          flex: 1 1 auto;
          min-width: 4.5rem;
          padding: 0.45rem 0.5rem;
          font-size: 0.85rem;
          color: var(--text, inherit);
          background: transparent;
          border: 1px solid var(--border);
          border-radius: 0.5rem;
          cursor: pointer;
        }
        .quick-deposit__chip:hover:not(:disabled) {
          border-color: var(--accent);
          color: var(--accent);
        }
        .quick-deposit__chip:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .quick-deposit__label {
          font-size: 0.8rem;
          color: var(--muted);
        }
        .quick-deposit__input {
          padding: 0.6rem 0.75rem;
          font-size: 1rem;
          color: var(--text, inherit);
          background: var(--background);
          border: 1px solid var(--border);
          border-radius: 0.5rem;
        }
        .quick-deposit__input:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 1px;
        }
        .quick-deposit__error {
          margin: 0;
          font-size: 0.8rem;
          color: #ef4444;
        }
        .quick-deposit__submit {
          margin-top: 0.25rem;
        }
      `}</style>
    </form>
  );
}

export default QuickDeposit;
