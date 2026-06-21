const statusBadgeCopy = {
  active: "Active",
  draft: "Draft",
  ended: "Ended",
  paused: "Paused",
} as const;

export type StreamStatus = keyof typeof statusBadgeCopy;

/** Props for the {@link StatusBadge} component. */
type StatusBadgeProps = {
  /** The current lifecycle state of a payment stream.
   *  Maps directly to a CSS modifier class `status-badge--{status}`. */
  status: StreamStatus;
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const label = statusBadgeCopy[status];

  return (
    <span
      aria-label={`Stream status: ${label}`}
      className={`status-badge status-badge--${status}`}
    >
      {label}
    </span>
  );
}

