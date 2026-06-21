/** Props for the {@link EmptyState} component. */
type EmptyStateProps = {
  /** Short category label rendered above the title (e.g. "Streams"). */
  eyebrow: string;
  /** Primary heading (used as the accessible section label). */
  title: string;
  /** Supporting text that explains the empty state or guides the user. */
  description: string;
  /** Label for the primary call-to-action button. */
  actionLabel: string;
};

export function EmptyState({ eyebrow, title, description, actionLabel }: EmptyStateProps) {
  return (
    <section className="empty-state" aria-labelledby="empty-state-title">
      <p className="empty-state__eyebrow">{eyebrow}</p>
      <h2 className="empty-state__title" id="empty-state-title">
        {title}
      </h2>
      <p className="empty-state__description">{description}</p>
      <button className="button button--primary" type="button">
        {actionLabel}
      </button>
    </section>
  );
}
