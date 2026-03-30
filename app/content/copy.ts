export const streamActionCopy = {
  start: {
    label: "Start",
    description: "Start a new payment stream.",
  },
  pause: {
    label: "Pause",
    description: "Pause an active payment stream.",
  },
  stop: {
    label: "Stop",
    description: "Stop a stream that should not continue.",
  },
  settle: {
    label: "Settle",
    description: "Settle the outstanding balance for a stream.",
  },
  withdraw: {
    label: "Withdraw",
    description: "Withdraw available funds from a settled stream.",
  },
} as const;

export const homeCopy = {
  eyebrow: "Payment streaming on Stellar",
  heading: "Manage payment streams with clear, consistent actions.",
  body: "Connect your wallet to start, pause, stop, settle, and withdraw from streams with confidence.",
  primaryCta: "Connect Wallet",
  secondaryCta: "View Stream Actions",
} as const;
