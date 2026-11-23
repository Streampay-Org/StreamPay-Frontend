"use client";

import { useToast } from "../components/ToastProvider";

export interface CopyLinkButtonProps {
  /** Anchor id of the FAQ entry. */
  id: string;
  /** Question text, used for the accessible name. */
  question: string;
}

/**
 * Copies a deep link (`/help#<id>`) for one FAQ entry and confirms with a
 * toast. Rendered as a tiny client island inside the server-rendered list.
 */
export default function CopyLinkButton({ id, question }: CopyLinkButtonProps) {
  const { success, error } = useToast();

  const copy = async () => {
    const url = `${window.location.origin}${window.location.pathname}#${id}`;
    try {
      await navigator.clipboard.writeText(url);
      success("Link copied to clipboard");
    } catch {
      error("Could not copy the link to the clipboard");
    }
  };

  return (
    <button
      type="button"
      className="faq-item__copy"
      aria-label={`Copy link to "${question}"`}
      onClick={() => void copy()}
    >
      Copy link
    </button>
  );
}
