import "./help.css";

/**
 * Help & FAQ page for StreamPay.
 *
 * Server component — the FAQ data is rendered statically, with a small
 * client island (FaqSearch) layered on top for search and deep links.
 * Covers common questions about wallet connection, payment streams, the
 * Stellar network, and troubleshooting local-dev issues.
 */

import { SHORTCUT_GROUPS, formatShortcutKeys, getShortcut } from "@/lib/shortcuts";
import { FAQ_SECTIONS } from "./faq-data";
import FaqSearch from "./FaqSearch";
import type { FaqItem, FaqSection } from "./faq-data";

/** Keys for a single shortcut id, e.g. "⌘/Ctrl + K". */
function keysFor(id: string): string {
  return formatShortcutKeys(getShortcut(id).keys);
}

/**
 * The full reference, generated from the registry so the FAQ can never fall
 * behind the `?` overlay or the in-form hints.
 */
function fullShortcutReference(): string {
  return SHORTCUT_GROUPS.map((group) => {
    const entries = group.shortcuts
      .map((shortcut) => `${formatShortcutKeys(shortcut.keys)} ${shortcut.description}`)
      .join("; ");
    return `${group.label} — ${entries}.`;
  }).join(" ");
}

export const metadata = {
  title: "Help & FAQ — StreamPay",
  description:
    "Answers to the most common questions about StreamPay, Stellar wallets, and payment streams.",
};

export default function HelpPage() {
  return (
    <main className="page-shell">
      <header className="page-hero">
        <div className="page-hero__content">
          <p className="page-hero__eyebrow">Support</p>
          <h1 className="page-hero__title">Help &amp; FAQ</h1>
          <p className="page-hero__description">
            Common questions about StreamPay, Stellar wallets, payment streams,
            and troubleshooting.
          </p>
        </div>
      </header>

      <div className="help-layout">
        {/* Quick-jump nav */}
        <nav aria-label="FAQ sections" className="help-nav">
          <ul className="help-nav__list" role="list">
            {FAQ_SECTIONS.map((section) => (
              <li key={section.id} className="help-nav__item">
                <a href={`#${section.id}`} className="help-nav__link" data-help-nav-link data-help-section={section.id}>
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* FAQ content (client island renders the sections + search) */}
        <div className="help-content">
          <FaqSearch sections={FAQ_SECTIONS} />
        </div>
      </div>
    </main>
  );
}
