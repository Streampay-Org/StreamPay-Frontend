"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { PageError } from "../components/PageError";

interface Template {
  id: string;
  name: string;
  asset: string;
  amountPerInterval: number;
  intervalSeconds: number;
  memo?: string;
  createdAt: string;
}

type TemplatesPageState = "loading" | "populated" | "empty" | "error";

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "savings", label: "Savings" },
  { id: "income", label: "Income" },
  { id: "bills", label: "Bills" },
  { id: "custom", label: "Custom" },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

function formatInterval(seconds: number): string {
  if (seconds >= 86400) {
    const days = seconds / 86400;
    return days === 1 ? "Daily" : `${days} days`;
  }
  if (seconds >= 3600) {
    const hours = seconds / 3600;
    return hours === 1 ? "Hourly" : `${hours} hours`;
  }
  if (seconds >= 60) {
    const mins = seconds / 60;
    return mins === 1 ? "Minute" : `${mins} minutes`;
  }
  return `${seconds}s`;
}

function categorizeTemplate(template: Template): CategoryId {
  const name = template.name.toLowerCase();
  const memo = (template.memo ?? "").toLowerCase();
  const text = `${name} ${memo}`;

  if (text.includes("savings") || text.includes("invest") || text.includes("roundup")) return "savings";
  if (text.includes("income") || text.includes("freelance") || text.includes("salary") || text.includes("earn")) return "income";
  if (text.includes("bill") || text.includes("utility") || text.includes("payment")) return "bills";
  return "custom";
}

function TemplateCard({
  template,
  onApply,
}: {
  template: Template;
  onApply: (template: Template) => void;
}) {
  const category = categorizeTemplate(template);

  return (
    <article className="template-card" aria-labelledby={`template-${template.id}`}>
      <div className="template-card__header">
        <span className={`template-card__category template-card__category--${category}`}>
          {category}
        </span>
      </div>

      <h3 className="template-card__name" id={`template-${template.id}`}>
        {template.name}
      </h3>

      <dl className="template-card__details">
        <div className="template-card__detail">
          <dt className="template-card__detail-label">Rate</dt>
          <dd className="template-card__detail-value">
            {template.amountPerInterval} {template.asset}
          </dd>
        </div>
        <div className="template-card__detail">
          <dt className="template-card__detail-label">Interval</dt>
          <dd className="template-card__detail-value">
            {formatInterval(template.intervalSeconds)}
          </dd>
        </div>
      </dl>

      {template.memo && (
        <p className="template-card__memo">{template.memo}</p>
      )}

      <button
        className="button button--primary template-card__apply"
        onClick={() => onApply(template)}
        type="button"
      >
        Use template
      </button>
    </article>
  );
}

function TemplateCardSkeleton() {
  return (
    <article className="template-card template-card--skeleton">
      <div className="template-card__header">
        <Skeleton className="skeleton--badge" height="1.25rem" width="4rem" />
      </div>
      <Skeleton className="skeleton--title" height="1.25rem" width="8rem" />
      <div className="template-card__details">
        <div className="template-card__detail">
          <Skeleton className="skeleton--label" height="0.75rem" width="3rem" />
          <Skeleton className="skeleton--value" height="1rem" width="6rem" />
        </div>
        <div className="template-card__detail">
          <Skeleton className="skeleton--label" height="0.75rem" width="3rem" />
          <Skeleton className="skeleton--value" height="1rem" width="5rem" />
        </div>
      </div>
      <Skeleton className="skeleton--button" height="2.75rem" width="7.5rem" />
    </article>
  );
}

function TemplateGridSkeleton() {
  return (
    <div className="template-grid">
      {Array.from({ length: 6 }).map((_, i) => (
        <TemplateCardSkeleton key={i} />
      ))}
    </div>
  );
}

export default function TemplatesPage() {
  const router = useRouter();
  const [pageState, setPageState] = useState<TemplatesPageState>("loading");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [activeCategory, setActiveCategory] = useState<CategoryId>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [loadKey, setLoadKey] = useState(0);

  const handleRetry = useCallback(() => {
    setLoadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    setPageState("loading");

    const controller = new AbortController();

    async function fetchTemplates() {
      try {
        const res = await fetch("/api/streams/template", { signal: controller.signal });
        if (!res.ok) throw new Error("Failed to fetch");
        const data = await res.json();
        const list: Template[] = data.templates ?? [];
        setTemplates(list);
        setPageState(list.length > 0 ? "populated" : "empty");
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setPageState("error");
      }
    }

    fetchTemplates();
    return () => controller.abort();
  }, [loadKey]);

  const filtered = useMemo(() => {
    let result = templates;

    if (activeCategory !== "all") {
      result = result.filter((t) => categorizeTemplate(t) === activeCategory);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.memo ?? "").toLowerCase().includes(q) ||
          t.asset.toLowerCase().includes(q),
      );
    }

    return result;
  }, [templates, activeCategory, searchQuery]);

  const handleApply = useCallback(
    (template: Template) => {
      const params = new URLSearchParams({
        templateId: template.id,
        asset: template.asset,
        rate: String(template.amountPerInterval),
        interval: String(template.intervalSeconds),
        memo: template.memo ?? "",
      });
      router.push(`/streams/new?${params.toString()}`);
    },
    [router],
  );

  return (
    <main className="page-shell">
      <section className="page-hero">
        <div>
          <p className="page-hero__eyebrow">Templates</p>
          <h1 className="page-hero__title">Start with a template.</h1>
          <p className="page-hero__description">
            Reusable stream presets to set up recurring payments in seconds.
            Pick a template, adjust the amount, and launch.
          </p>
        </div>
      </section>

      <section
        aria-busy={pageState === "loading"}
        aria-labelledby="templates-overview-title"
        aria-live="polite"
        className="stream-layout"
      >
        <div className="section-heading">
          <div>
            <h2 className="section-heading__title" id="templates-overview-title">
              Browse templates
            </h2>
            <p className="section-heading__description">
              Filter by category or search to find the right preset for your stream.
            </p>
          </div>
        </div>

        <span aria-live="polite" className="sr-only" role="status">
          {pageState === "loading"
            ? "Loading templates…"
            : pageState === "error"
              ? "Failed to load templates."
              : ""}
        </span>

        {pageState === "loading" ? (
          <TemplateGridSkeleton />
        ) : pageState === "error" ? (
          <PageError
            heading="Couldn't load templates"
            message="There was a problem fetching templates. Check your connection and try again."
            onRetry={handleRetry}
          />
        ) : (
          <>
            <div className="template-controls">
              <div className="template-controls__categories" role="tablist" aria-label="Template categories">
                {CATEGORIES.map((cat) => {
                  const isActive = activeCategory === cat.id;
                  return (
                    <button
                      key={cat.id}
                      aria-selected={isActive}
                      className={`template-controls__tab${isActive ? " template-controls__tab--active" : ""}`}
                      onClick={() => setActiveCategory(cat.id)}
                      role="tab"
                      type="button"
                    >
                      {cat.label}
                    </button>
                  );
                })}
              </div>

              <label className="template-controls__search" htmlFor="template-search">
                <span className="sr-only">Search templates</span>
                <input
                  className="template-controls__input"
                  id="template-search"
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search templates…"
                  type="search"
                  value={searchQuery}
                />
              </label>
            </div>

            {filtered.length > 0 ? (
              <div
                aria-label={`Showing ${filtered.length} template${filtered.length === 1 ? "" : "s"}`}
                className="template-grid"
                role="region"
              >
                {filtered.map((template) => (
                  <TemplateCard
                    key={template.id}
                    onApply={handleApply}
                    template={template}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                actionLabel="Clear filters"
                description="No templates match your current filters. Try a different category or search term."
                eyebrow="No results"
                onAction={() => {
                  setActiveCategory("all");
                  setSearchQuery("");
                }}
                title="No templates found"
              />
            )}
          </>
        )}
      </section>
    </main>
  );
}
