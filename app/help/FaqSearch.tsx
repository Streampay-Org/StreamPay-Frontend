"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useToast } from "../components/ToastProvider";

export type FaqSearchProps = {
  sections: {
    id: string;
    title: string;
    items: { id: string; question: string; answer: string }[];
  }[];
  supportHref?: string;
};

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}

/**
 * Client island for /help: filters the FAQ, keeps the query in the URL,
 * supports deep links (`#item-id`) and copies a shareable link per entry.
 */
export default function FaqSearch({ sections, supportHref }: FaqSearchProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { showToast } = useToast();

  const [query, setQuery] = useState("");
  const firstRender = useRef(true);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sections;
    return sections
      .map((section) => ({
        ...section,
        items: section.items.filter(
          (item) =>
            item.question.toLowerCase().includes(needle) ||
            item.answer.toLowerCase().includes(needle),
        ),
      }))
      .filter((section) => section.items.length > 0);
  }, [query, sections]);

  const resultCount = filtered.reduce(
    (total, section) => total + section.items.length,
    0,
  );

  // Seed the query from ?q= without requiring a Suspense boundary.
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get("q");
    if (initial) setQuery(initial);
  }, []);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (query.trim()) {
      params.set("q", query);
    } else {
      params.delete("q");
    }
    const suffix = params.toString();
    router.replace(suffix ? `${pathname}?${suffix}` : pathname, {
      scroll: false,
    });
  }, [query, pathname, router]);

  useEffect(() => {
    const id = window.location.hash.replace(/^#/, "");
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    )?.matches;
    target.scrollIntoView?.({ 
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
    (target as HTMLElement).focus?.({ preventScroll: true });
  }, []);

  const copyLink = async (item: { id: string; question: string }) => {
    const url = `${window.location.origin}${pathname}#${item.id}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast("Link copied to clipboard");
    } catch {
      showToast("Could not copy the link");
    }
  };

  return (
    <div className="faq-search">
      <label htmlFor="faq-search-input" className="faq-search__label">
        Search the FAQ
      </label>
      <input
        id="faq-search-input"
        type="search"
        className="faq-search__input"
        placeholder="Search answers"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      <p role="status" aria-live="polite" className="faq-search__status">
        {resultCount} {resultCount === 1 ? "answer" : "answers"}
      </p>

      {resultCount === 0 ? (
        <p className="faq-search__empty">
          No answers match “{query}”.{" "}
          <a href={supportHref ?? "/contact"}>Contact support</a>
        </p>
      ) : (
        filtered.map((section) => (
          <section
            key={section.id}
            id={section.id}
            aria-labelledby={`${section.id}-heading`}
          >
            <h2 id={`${section.id}-heading`}>{section.title}</h2>
            <dl className="faq-list">
              {section.items.map((item) => (
                <div key={item.id} id={item.id} className="faq-item">
                  <dt
                    id={`${item.id}-question`}
                    className="faq-item__question"
                  >
                    <Highlight text={item.question} query={query} />
                  </dt>
                  <dd className="faq-item__answer">
                    <Highlight text={item.answer} query={query} />
                    <button
                      type="button"
                      className="button button--secondary"
                      aria-label={`Copy link to ${item.question}`}
                      onClick={() => void copyLink(item)}
                    >
                      Copy link
                    </button>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))
      )}
    </div>
  );
}
