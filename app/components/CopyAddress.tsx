"use client";

import { useState } from "react";

interface CopyAddressProps {
  /** The address or hash to copy */
  value: string;
  /** Number of characters to show at start and end when truncating (default: 6) */
  truncateChars?: number;
  /** Optional custom class name for the wrapper */
  className?: string;
  /** Whether to show the copy button (default: true) */
  showCopyButton?: boolean;
  /**
   * When true, the full value is shown on print only (and hidden on screen).
   * Use this only when the value is not sensitive and you intentionally
   * want the full address/hash on the printed page.
   */
  printOnly?: boolean;
}

/**
 * Truncates an address/hash by showing first N and last N characters
 */
function truncateAddress(address: string, chars = 6): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * CopyButton - Internal component for the copy button with success state
 */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy text: ", err);
    }
  };

  return (
    <button
      aria-label="Copy to clipboard"
      className="receipt-copy-btn no-print"
      onClick=handleCopy
      type="button"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * CopyAddress - Reusable component for displaying addresses/hashes with inline copy button
 *
 * Features:
 * - Automatic address truncation for screen and print display
 * - Inline copy button with success state (hidden in print)
 * - By default, the full value is not printed to avoid leaking sensitive data
 * - Accessible with proper ARIA labels
 * - WCAG 2.1 AA compliant
 *
 * @example
 * <CopyAddress value="GAJJJJKMOKYE4RVYZWZTWKH5FVY4PA3VL7GK2LFNUBSGBV3JKAKZK7G" />
 *
 * @example
 * <CopyAddress
 *   value="abc123def456"
 *   truncateChars={4}
 *   showCopyButton={false}
 * />
 */
export function CopyAddress({
  value,
  truncateChars = 6,
  className = "",
  showCopyButton = true,
  printOnly = false,
}: CopyAddressProps) {
  // printOnly explicitly opts into printing the full, unredacted value.
  // It is hidden on screen to avoid accidental exposure, but will still print.
  if (printOnly) {
    return <span className={print-only ${className}`}>{value}</span>
  }

  return (
    <span className={receipt-address-wrap ${className}`}>
      /* Truncated address is shown both on screen and in print to avoid leaking the full value */
      <span>{truncateAddress(value, truncateChars)}</span>
      {showCopyButton && <CopyButton value={value} />}
    </span>
  );
}
