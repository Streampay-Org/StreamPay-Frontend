"use client";

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type KeyboardEvent,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { EmptyState } from "../components/EmptyState";
import type { StreamTemplate } from "../lib/repositories/templates";

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
  const [activeCategory, setActiveCategory] = useState(() =>
    parseCategory(searchParams.get("category"))
  );
  const [searchQuery, setSearchQuery] = useState(
    () => searchParams.get("q") ?? ""
  );
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
    if (pendingReplacements.current.delete(urlQuery)) {
      if (urlQuery === currentQuery.current) pendingReplacements.current.clear();
      return;
    }

    pendingReplacements.current.clear();
    currentQuery.current = urlQuery;
    cancelSearch();
    const params = new URLSearchParams(urlQuery);
    setActiveCategory(parseCategory(params.get("category")));
    setSearchQuery(params.get("q") ?? "");
  }, [urlQuery, cancelSearch]);

  useEffect(() => cancelSearch, [cancelSearch]);

  const replaceFilters = useCallback(
    (category: CategoryId, query: string) => {
      const params = new URLSearchParams(currentQuery.current);
      if (category === "all") params.delete("category");
      else params.set("category", category);
      if (query === "") params.delete("q");
      else params.set("q", query);

      const nextQuery = params.toString();
      if (nextQuery === currentQuery.current) return;
      currentQuery.current = nextQuery;
      pendingReplacements.current.add(nextQuery);
      router.replace(`${pathname}${nextQuery ? `?${nextQuery}` : ""}`, {
        scroll: false,
      });
    },
    [pathname, router]
  );

  const selectCategory = (category: CategoryId) => {
    setActiveCategory(category);
    replaceFilters(
      category,
      new URLSearchParams(currentQuery.current).get("q") ?? ""
    );
  };

  const changeSearch = (query: string) => {
    setSearchQuery(query);
    cancelSearch();
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null;
      replaceFilters(
        parseCategory(
          new URLSearchParams(currentQuery.current).get("category")
        ),
        query
      );
    }, 300);
  };

  const clearFilters = () => {
    cancelSearch();
    setActiveCategory("all");
    setSearchQuery("");
    replaceFilters("all", "");
  };

  return {
    activeCategory,
    searchQuery,
    selectCategory,
    changeSearch,
    clearFilters,
  };
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

function categorizeTemplate(template: StreamTemplate): CategoryId {
  const name = template.name.toLowerCase();
  const memo = (template.memo ?? "").toLowerCase();
  const text = `${name} ${memo}`;

  if (
    text.includes("savings") ||
    text.includes("invest") ||
    text.includes("roundup")
  )
    return "savings";
  if (
    text.includes("income") ||
    text.includes("freelance") ||
    text.includes("salary") ||
    text.includes("earn")
  )
    return "income";
  if (text.includes("bill") || text.includes("utility") || text.includes("payment"))
    return "bills";
  return "custom";
}

function TemplateCard({
  template,
  onApply,
}: {
  template: StreamTemplate;
  onApply: (template: StreamTemplate) => void;
}) {
  const category = categorizeTemplate(template);

  return (
    <article
      className="template-card"
      aria-labelledby={`template-${template.id}`}
    >
      <div className="template-card__header">
        <span
          className={`template-card__category template-card__category--${category}`}
        >
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

      {template.memo && <p className="template-card__memo">{template.memo}</p>}

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

export interface TemplatesBrowserProps {
  initialTemplates: StreamTemplate[];
}

export function TemplatesBrowser({ initialTemplates }: TemplatesBrowserProps) {
  const router = useRouter();
  const {
    activeCategory,
    searchQuery,
    selectCategory,
    changeSearch,
    clearFilters,
  } = useTemplateFilters();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
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

  const filtered = useMemo(() => {
    let result = initialTemplates;

    if (activeCategory !== "all") {
      result = result.filter((t) => categorizeTemplate(t) === activeCategory);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.memo ?? "").toLowerCase().includes(q) ||
          t.asset.toLowerCase().includes(q)
      );
    }

    return result;
  }, [initialTemplates, activeCategory, searchQuery]);

  const handleApply = useCallback(
    (template: StreamTemplate) => {
      const params = new URLSearchParams({
        templateId: template.id,
        asset: template.asset,
        rate: String(template.amountPerInterval),
        interval: String(template.intervalSeconds),
        memo: template.memo ?? "",
      });
      router.push(`/streams/new?${params.toString()}`);
    },
    [router]
  );

  if (initialTemplates.length === 0) {
    return (
      <EmptyState
        description="No stream templates are currently available. Check back soon or create a custom stream."
        eyebrow="No templates"
        title="No templates available"
      />
    );
  }

  return (
    <>
      <div className="template-controls">
        <div
          className="template-controls__categories"
          role="tablist"
          aria-label="Template categories"
        >
          {CATEGORIES.map((cat, index) => {
            const isActive = activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                id={`template-tab-${cat.id}`}
                aria-controls="template-panel"
                aria-selected={isActive}
                className={`template-controls__tab${
                  isActive ? " template-controls__tab--active" : ""
                }`}
                onClick={() => selectCategory(cat.id)}
                onFocus={(event) => {
                  selectCategory(cat.id);
                  event.currentTarget.scrollIntoView({
                    block: "nearest",
                    inline: "nearest",
                  });
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
          {`Showing ${filtered.length} template${
            filtered.length === 1 ? "" : "s"
          }`}
        </span>
        {filtered.length > 0 ? (
          filtered.map((template) => (
            <TemplateCard
              key={template.id}
              onApply={handleApply}
              template={template}
            />
          ))
        ) : (
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
  );
}

export default TemplatesBrowser;
