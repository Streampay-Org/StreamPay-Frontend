import { Skeleton } from "../components/Skeleton";

export function TemplateCardSkeleton() {
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

export function TemplateGridSkeleton() {
  return (
    <div className="template-grid">
      {Array.from({ length: 6 }).map((_, i) => (
        <TemplateCardSkeleton key={i} />
      ))}
    </div>
  );
}
