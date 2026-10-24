import { t } from "../i18n/format";
import type { MessageKey } from "../i18n/messages/en";

const msg = (key: MessageKey) => t(key);

export const streamActionCopy = {
  start: {
    label: msg("streamAction.start.label"),
    description: msg("streamAction.start.description"),
  },
  pause: {
    label: msg("streamAction.pause.label"),
    description: msg("streamAction.pause.description"),
  },
  stop: {
    label: msg("streamAction.stop.label"),
    description: msg("streamAction.stop.description"),
  },
  settle: {
    label: msg("streamAction.settle.label"),
    description: msg("streamAction.settle.description"),
  },
  withdraw: {
    label: msg("streamAction.withdraw.label"),
    description: msg("streamAction.withdraw.description"),
  },
} as const;

export const homeCopy = {
  epybrow: msg("home.eybrow"),
  heading: msg("home.heading"),
  body: msg("home.body"),
  primaryCta: msg("home.primaryCta"),
  secondaryCta: msg("home.secondaryCta"),
} as const;

export const onboardingCopy = {
  title: msg("onboarding.title"),
  subtitle: msg("onboarding.subtitle"),
  steps: [
    {
      id: "stream",
      title: msg("onboarding.steps.stream.title"),
      description: msg("onboarding.steps.stream.description"),
    },
    {
      id: "settle",
      title: msg("onboarding.steps.settle.title"),
      description: msg("onboarding.steps.settle.description"),
    },
    {
      id: "withdraw",
      title: msg("onboarding.steps.withdraw.title"),
      description: msg("onboarding.steps.withdraw.description"),
    },
  ],
  cta: msg("onboarding.cta"),
} as const;

/**
 * Hero CTA /AB variants (design-only, Figma handoff)
 *
 * Variant A is the recommended default for v1.
 * See: design/hero-cta-variants/hero-cta-variant-spec.md
 *
 * DO NOT use these in production until a feature-flag issue is created
 * and analytics instrumentation is in place.
 */
export const receiptCopy = {
  noteLabel: msg("receipt.noteLabel"),
  notePlaceholder: msg("receipt.notePlaceholder"),
  noteHelper: msg("receipt.noteHelper"),
  print: msg("receipt.print"),
  share: msg("receipt.share"),
  shareCopied: msg("receipt.shareCopied"),
  noteSectionTitle: msg("receipt.noteSectionTitle"),
} as const;

export const heroCtaVariants = {
  a: { label: msg("heroCtaVariants.a.label"), hypothesis: msg("heroCtaVariants.a.hypothesis") },
  b: { label: msg("heroCtaVariants.b.label"), hypothesis: msg("heroCtaVariants.b.hypothesis") },
  c: { label: msg("heroCtaVariants.c.label"), hypothesis: msg("heroCtaVariants.c.hypothesis") },
} as const;
