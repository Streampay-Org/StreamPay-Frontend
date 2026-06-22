type EmptyStateProps = {
  eyebrow: string;
  title: string;
  description: string;
  actionLabel: string;
  onAction?: () => void;
};

export function EmptyState({ eyebrow, title, description, actionLabel, onAction }: EmptyStateProps) {
  return (
    <section className="empty-state" aria-labelledby="empty-state-title">
      <p className="empty-state__eyebrow">{eyebrow}</p>
      <h2 className="empty-state__title" id="empty-state-title">
        {title}
      </h2>
      <p className="empty-state__description">{description}</p>
      <button className="button button--primary" type="button" onClick={onAction}>
        {actionLabel}
      </button>
    </section>
  );
}
