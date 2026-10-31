"use client";

import React, { useState, useEffect, useMemo, useId } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useToast } from "../components/ToastProvider";

export type FaqItem = {
  id: string;
  question: string;
  answer: string;
};

export type FaqSection = {
  id: string;
  title: string;
  items: FaqItem[];
};

export type FaqSearchProps = {
  sections: FaqSection[];
  supportHref?: string;
  /**
   * When true (standalone use), every entry is listed while the query is
   * empty. Pages that already server-render the full list pass `false` so
   * the island only renders matches for a non-empty query.
   */
  showAllWhenEmpty?: boolean;
};

function highlightMatch(text: string, query: string) {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  // Splitting on a single capture group puts every match at an odd index.
  // (Re-testing each part with the global regex would be stateful via
  // `lastIndex` and skip alternate matches.)
  const parts = text.split(regex);
  return parts.map((part, index) =>
    index % 2 === 1 ? <mark key={index}>{part}</mark> : part,
  );
}

export default function FaqSearch({
  sections,
  supportHref = "/help",
  showAllWhenEmpty = true,
}: FaqSearchProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { success: showSuccessToast } = useToast();
  const inputId = useId();

  const [query, setQuery] = useState(searchParams?.get("q") ?? "");
  const hasQuery = query.trim().length > 0;

  const allItems = useMemo(() => {
    return sections.flatMap((section) => section.items);
  }, [sections]);

  const filteredItems = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return showAllWhenEmpty ? allItems : [];
    return allItems.filter(
      (item) =>
        item.question.toLowerCase().includes(trimmed) ||
        item.answer.toLowerCase().includes(trimmed),
    );
  }, [allItems, query, showAllWhenEmpty]);

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash) {
      const id = window.location.hash.slice(1);
      const element = document.getElementById(id);
      if (element) {
        const prefersReducedMotion =
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        element.scrollIntoView?.({
          behavior: prefersReducedMotion ? "auto" : "smooth",
        });
      }
    }
  }, []);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (val.trim()) {
      params.set("q", val);
    } else {
      params.delete("q");
    }
    const nextUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
    router.replace(nextUrl);
  };

  const handleCopyLink = async (item: FaqItem) => {
    const url = `${window.location.origin}${pathname}#${item.id}`;
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      showSuccessToast("Link copied to clipboard");
    }
  };

  return (
    <div className="faq-search-wrapper" style={{ margin: "1.5rem 0" }}>
      <div style={{ marginBottom: "1rem" }}>
        <label
          htmlFor={inputId}
          style={{ display: "block", marginBottom: "0.5rem", fontWeight: 600 }}
        >
          Search the FAQ
        </label>
        <input
          id={inputId}
          type="search"
          aria-label="Search FAQ"
          placeholder="Search by keyword (e.g. wallet, cancel, withdraw)..."
          value={query}
          onChange={handleSearchChange}
          style={{
            width: "100%",
            maxWidth: "32rem",
            padding: "0.625rem 1rem",
            borderRadius: "0.5rem",
            border: "1px solid var(--border)",
            background: "var(--panel)",
            color: "var(--foreground)",
          }}
        />
      </div>

      <div role="status" aria-live="polite" style={{ fontSize: "0.875rem", color: "var(--muted)" }}>
        {hasQuery || showAllWhenEmpty
          ? `${filteredItems.length} ${filteredItems.length === 1 ? "answer" : "answers"} found`
          : null}
      </div>

      {!hasQuery && !showAllWhenEmpty ? null : filteredItems.length === 0 ? (
        <div style={{ margin: "2rem 0", textAlign: "center" }}>
          <p style={{ color: "var(--muted)", marginBottom: "0.75rem" }}>
            No answers match your search.
          </p>
          <Link
            href={supportHref}
            className="button button--secondary"
            role="link"
          >
            Contact support
          </Link>
        </div>
      ) : (
        <div className="faq-search-results" style={{ marginTop: "1.5rem" }}>
          {filteredItems.map((item) => (
            <div
              key={item.id}
              // In embedded mode the server-rendered list owns the anchor ids.
              id={showAllWhenEmpty ? item.id : undefined}
              style={{
                marginBottom: "1.5rem",
                padding: "1rem",
                borderRadius: "0.5rem",
                border: "1px solid var(--border)",
                background: "var(--panel)",
              }}
            >
              <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1.1rem" }}>
                <button
                  type="button"
                  onClick={() => handleCopyLink(item)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    font: "inherit",
                    fontWeight: 600,
                    color: "inherit",
                    cursor: "pointer",
                    textAlign: "left",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.5rem",
                  }}
                  aria-label={item.question}
                >
                  {highlightMatch(item.question, query)}
                </button>
              </h3>
              <p style={{ margin: 0, color: "var(--muted-light)", lineHeight: 1.5 }}>
                {highlightMatch(item.answer, query)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
