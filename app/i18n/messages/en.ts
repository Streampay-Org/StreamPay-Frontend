/*
 * Message catalog — English (source of truth).
 *
 * Keys are typed-checked via `typeof enMessages`. Adding a key here is the
 * only way to make it available to `t()`. Values may contain I/CUS-style
 * `{count, plural, one {...} other {...}}` segments and `{name}` interpolation.
 */

const enMessages = {
  // General / shared
  "app.name": "StreamPay",
  "app.tagline": "Streaming payments on Stellar",
  "common.loading": "Loading…",
  "common.retry": "Retry",
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.close": "Close",
  "common.back": "Back",
  "common.next": "Next",
  "common.done": "Done",
  "common.search": "Search",
  "common.empty": "Nothing here yet",
  "common.copy": "Copy",
  "common.copied": "Copied",
  "common.address": "Address",
  "common.amount": "Amount",
  "common.status": "Status",
  "common.date": "Date",
  "common.actions": "Actions",
  "common.learnMore": "Learn more",
  "common.showMore": "Show more",
  "common.showLess": "Show less",

  // Home copy (formerly app/content/copy.ts)
  "home.hero.title": "Streaming payments on Stellar",
  "home.hero.subtitle":
    "Send money on a schedule, or stream it continuously.",
  "home.hero.cta": "Get started",
  "home.features.title": "Why StreamPay",
  "home.features.streaming.title": "Continuous streams",
  "home.features.streaming.body":
    "Pay by the second with streams that settle automatically.",
  "home.features.templates.title": "Reusable templates",
  "home.features.templates.body":
    "Save your favourite schedules and reuse them in one click.",
  "home.features.contacts.title": "Contacts that stay",
  "home.features.contacts.body":
    "Keep your payees and payers organised across devices.",

  // Stream action copy (formerly app/content/copy.ts)
  "streamAction.create": "New stream",
  "streamAction.pause": "Pause stream",
  "streamAction.resume": "Resume stream",
  "streamAction.cancel": "Cancel stream",
  "streamAction.withdraw": "Withdraw",
  "streamAction.confirm": "Confirm stream",
  "streamAction.success": "Stream created",
  "streamAction.failed": "Something went wrong. Please try again.",

  // Activity
  "activity.title": "Activity",
  "activity.subtitle": "Recent events across your streams",
  "activity.empty.title": "No activity yet",
  "activity.empty.body": "Events will appear here once your streams are running.",
  "activity.event.created": "Stream created",
  "activity.event.paused": "Stream paused",
  "activity.event.resumed": "Stream resumed",
  "activity.event.canceled": "Stream cancelled",
  "activity.event.withdrawn": "Withdrawal",
  "activity.event.settled": "Stream settled",
  "activity.today": "Today",
  "activity.yesterday": "Yesterday",
  "activity.count":
    "{count, plural, one {#1 event} other{## events}}",

  // Contacts
  "contacts.title": "Contacts",
  "contacts.subtitle": "People and addresses you pay",
  "contacts.add": "Add contact",
  "contacts.edit": "Edit contact",
  "contacts.delete": "Delete contact",
  "contacts.name": "Name",
  "contacts.namePlaceholder": "E.g. Alice",
  "contacts.addressPlaceholder": "G...",
  "contacts.empty.title": "No contacts yet",
  "contacts.empty.body": "Add a contact to start sending payments.",
  "contacts.count":
    "{count, plural, one {#1 contact} other{## contacts}}",
  "contacts.saved": "Contact saved",
  "contacts.deletedConfirm": "Delete this contact?",

  // Templates
  "templates.title": "Templates",
  "templates.subtitle": "Reusable payment schedules",
  "templates.create": "New template",
  "templates.empty.title": "No templates yet",
  "templates.empty.body": "Create a template to reuse your schedules.",
  "templates.interval": "Interval",
  "templates.duration.hours":
    "{count, plural, one {#1 hour} other{## hours}}",
  "templates.duration.minutes":
    "{count, plural, one {#1 minute} other{## minutes}}",
  "templates.duration.seconds":
    "{count, plural, one {#1 second} other{## seconds}}",
  "templates.duration.days":
    "{count, plural, one {#1 day} other{## days}}",
  "templates.duration.weeks":
    "{count, plural, one {#1 week} other{## weeks}}",
  "templates.duration.months":
    "{count, plural, one {#1 month} other{## months}}",
  "templates.duration.years":
    "{count, plural, one {#1 year} other{## years}}",

  // Settings
  "settings.title": "Settings",
  "settings.subtitle": "Manage your account and preferences",
  "settings.navigation": "Settings navigation",
  "settings.profile": "Profile",
  "settings.profile.displayName": "Display name",
  "settings.profile.email": "Email",
  "settings.profile.saved": "Profile updated",
  "settings.notifications": "Notifications",
  "settings.notifications.email": "Email notifications",
  "settings.notifications.description":
    "Get told when streams settle or fail.",
  "settings.locale": "Language",
  "settings.locale.description": "Choose the language used in the app.",
  "settings.locale.en": "English",
  "settings.locale.pseudo": "Pseudo-locale",
  "settings.danger": "Danger zone",
  "settings.danger.description": "These actions cannot be undone.",
  "settings.danger.deleteAccount": "Delete account",

  // Onboarding
  "onboarding.title": "Welcome to StreamPay",
  "onboarding.subtitle": "Let’s get you set up in a few steps.",
  "onboarding.step.connect": "Connect your wallet",
  "onboarding.step.contacts": "Add your first contact",
  "onboarding.step.template": "Create a template",
  "onboarding.step.done": "You are all set",
  "onboarding.continue": "Continue",
  "onboarding.skip": "Skip for now",
  "onboarding.welcomeTour.title": "Quick tour",
  "onboarding.welcomeTour.body": "Highlights the main parts of the app.",
  "onboarding.welcomeTour.next": "Next tip",
  "onboarding.welcomeTour.finish": "Finish tour",
  "onboarding.manager.progress": "Step {current} of {total}",

  // Help
  "help.title": "Help",
  "help.subtitle": "Answers to common questions",
  "help.contactSupport": "Contact support",
  "help.faq": "Frequently asked questions",

  // Errors
  "notFound.title": "Page not found",
  "notFound.body": "The page you looked for does not exist.",
  "notFound.home": "Go to home page",
  "error.title": "Something went wrong",
  "error.body": "An unexpected error occurred.",
  "error.retry": "Try again",

  // Indexer status
  "indexerStatus.label": "Indexer",
  "indexerStatus.ledger": "Ledger {number}",
  "indexerStatus.syncing": "Syncing",
  "indexerStatus.synced": "Synced",
  "indexerStatus.error": "Unable to reach indexer",
} as const;

export type MessageKey = keyof typeof enMessages;
export type Messages = Record<MessageKey, string>;

export const en = enMessages satisfies Messages;
