const statusBadgeCopy = {
  active: "Active",
  draft: "Draft",
  ended: "Ended",
  paused: "Paused",
} as const;

export type StreamStatus = keyof typeof statusBadgeCopy;

type StatusBadgeProps = {
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

