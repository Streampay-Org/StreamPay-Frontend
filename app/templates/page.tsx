"use client";

import {
  Suspense,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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

function parseCategory(value: string | null): CategoryId {
  return CATEGORIES.find((category) => category.id === value)?.id ?? "all";
}

function useTemplateFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlQuery = searchParams.toString();
  const [activeCategory, setActiveCategory] = useState(() => parseCategory(searchParams.get("category")));
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get("q") ?? "");
  const currentQuery = useRef(urlQuery);
  const pendingReplacements = useRef(new Set<string>());
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelSearch = useCallback(() => {
    if (searchTimer.current !== null) {
      clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
  }, []);

  useEffect(() => {
    // Our category replacements must not discard a search still being typed.
    if (pendingReplacements.current.delete(urlQuery)) {
      if (urlQuery === currentQuery.current) pendingReplacements.current.clear();
      return;
    }

    // A shared URL or browser navigation replaces local filters and pending work.
    pendingReplacements.current.clear();
    currentQuery.current = urlQuery;
    cancelSearch();
    const params = new URLSearchParams(urlQuery);
    setActiveCategory(parseCategory(params.get("category")));
    setSearchQuery(params.get("q") ?? "");
  }, [urlQuery, cancelSearch]);

  useEffect(() => cancelSearch, [cancelSearch]);

  const replaceFilters = useCallback((category: CategoryId, query: string) => {
    const params = new URLSearchParams(currentQuery.current);
    if (category === "all") params.delete("category");
    else params.set("category", category);
    if (query === "") params.delete("q");
    else params.set("q", query);

    const nextQuery = params.toString();
    if (nextQuery === currentQuery.current) return;
    currentQuery.current = nextQuery;
    pendingReplacements.current.add(nextQuery);
    router.replace(`${pathname}${nextQuery ? `?${nextQuery}` : ""}`, { scroll: false });
  }, [pathname, router]);

  const selectCategory = (category: CategoryId) => {
    setActiveCategory(category);
    replaceFilters(category, new URLSearchParams(currentQuery.current).get("q") ?? "");
  };

  const changeSearch = (query: string) => {
    setSearchQuery(query);
    cancelSearch();
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null;
      replaceFilters(parseCategory(new URLSearchParams(currentQuery.current).get("category")), query);
    }, 300);
  };

  const clearFilters = () => {
    cancelSearch();
    setActiveCategory("all");
    setSearchQuery("");
    replaceFilters("all", "");
  };

  return { activeCategory, searchQuery, selectCategory, changeSearch, clearFilters };
}

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

function TemplatesContent() {
  const router = useRouter();
  const [pageState, setPageState] = useState<TemplatesPageState>("loading");
  const [templates, setTemplates] = useState<Template[]>([]);
  const { activeCategory, searchQuery, selectCategory, changeSearch, clearFilters } = useTemplateFilters();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [loadKey, setLoadKey] = useState(0);

  const handleRetry = useCallback(() => {
    setLoadKey((k) => k + 1);
  }, []);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number;
    switch (event.key) {
      case "ArrowLeft":
        nextIndex = (index - 1 + CATEGORIES.length) % CATEGORIES.length;
        break;
      case "ArrowRight":
        nextIndex = (index + 1) % CATEGORIES.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = CATEGORIES.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    tabRefs.current[nextIndex]?.focus();
  };

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
    <TemplatesPageShell pageState={pageState}>
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
              {CATEGORIES.map((cat, index) => {
                const isActive = activeCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    ref={(element) => { tabRefs.current[index] = element; }}
                    id={`template-tab-${cat.id}`}
                    aria-controls="template-panel"
                    aria-selected={isActive}
                    className={`template-controls__tab${isActive ? " template-controls__tab--active" : ""}`}
                    onClick={() => selectCategory(cat.id)}
                    onFocus={(event) => {
                      selectCategory(cat.id);
                      event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
                    }}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                    role="tab"
                    tabIndex={isActive ? 0 : -1}
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
                onChange={(e) => changeSearch(e.target.value)}
                placeholder="Search templates…"
                type="search"
                value={searchQuery}
              />
            </label>
          </div>

          <div
            aria-labelledby={`template-tab-${activeCategory}`}
            className={filtered.length > 0 ? "template-grid" : undefined}
            id="template-panel"
            role="tabpanel"
            tabIndex={0}
          >
            <span className="sr-only" role="status">
              {`Showing ${filtered.length} template${filtered.length === 1 ? "" : "s"}`}
            </span>
            {filtered.length > 0 ? filtered.map((template) => (
              <TemplateCard
                key={template.id}
                onApply={handleApply}
                template={template}
              />
            )) : (
              <EmptyState
                actionLabel="Clear filters"
                description="No templates match your current filters. Try a different category or search term."
                eyebrow="No results"
                onAction={() => {
                  clearFilters();
                  tabRefs.current[0]?.focus();
                }}
                title="No templates found"
              />
            )}
          </div>
        </>
      )}
    </TemplatesPageShell>
  );
}

function TemplatesPageShell({ pageState, children }: {
  pageState: TemplatesPageState;
  children: ReactNode;
}) {
  return (
    <main className="page-shell templates-page">
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

        {children}
      </section>
    </main>
  );
}

/** Templates gallery with URL-backed filters inside the App Router's Suspense boundary. */
export default function TemplatesPage() {
  return (
    <Suspense fallback={
      <TemplatesPageShell pageState="loading">
        <TemplateGridSkeleton />
      </TemplatesPageShell>
    }>
      <TemplatesContent />
    </Suspense>
  );
}
