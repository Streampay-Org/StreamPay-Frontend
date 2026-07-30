/**
 * Help & FAQ page for StreamPay.
 *
 * Static server component — no client-side state or interactivity required.
 * Covers common questions about wallet connection, payment streams, the
 * Stellar network, and troubleshooting local-dev issues.
 */

export const metadata = {
  title: "Help & FAQ — StreamPay",
  description:
    "Answers to the most common questions about StreamPay, Stellar wallets, and payment streams.",
};

interface FaqItem {
  id: string;
  question: string;
  answer: string;
}

interface FaqSection {
  id: string;
  title: string;
  items: FaqItem[];
}

const FAQ_SECTIONS: FaqSection[] = [
  {
    id: "getting-started",
    title: "Getting Started",
    items: [
      {
        id: "what-is-streampay",
        question: "What is StreamPay?",
        answer:
          "StreamPay is a dashboard for creating and managing real-time payment streams on the Stellar network. Instead of sending a lump-sum payment, you can stream funds continuously over a set period — useful for payroll, subscriptions, grants, and recurring payments.",
      },
      {
        id: "connect-wallet",
        question: "How do I connect my Stellar wallet?",
        answer:
          'Click \u201cConnect Wallet\u201d on the home page. StreamPay uses a challenge/signature flow: you\u2019ll receive a one-time nonce, sign it with your Stellar private key via your wallet software, and submit the signature to receive a bearer token. No private key is ever sent to the server.',
      },
      {
        id: "supported-wallets",
        question: "Which wallets are supported?",
        answer:
          "Any wallet that can sign a Stellar challenge transaction — including Freighter, LOBSTR, and command-line tools such as stellar-cli. Hardware wallets that expose a Stellar signing interface are also compatible.",
      },
      {
        id: "testnet-vs-mainnet",
        question: "How do I switch between testnet and mainnet?",
        answer:
          "The network is selected at deployment time via the STELLAR_NETWORK environment variable (\"testnet\" or \"mainnet\"). Testnet assets are clearly labelled in the UI to prevent accidental mainnet operations. Contact your administrator to change the active network for a given deployment.",
      },
    ],
  },
  {
    id: "keyboard-shortcuts",
    title: "Keyboard Shortcuts",
    items: [
      {
        id: "shortcuts-overlay",
        question: "How do I view all available keyboard shortcuts?",
        answer:
          'Press <kbd>?</kbd> anywhere in the app to open the Keyboard Shortcuts overlay, which lists every available shortcut. Press <kbd>?</kbd> again or <kbd>Esc</kbd> to close the overlay. Press <kbd>&#8984;/Ctrl</kbd>&thinsp;+&thinsp;<kbd>K</kbd> to open the command palette for searching streams.',
      },
      {
        id: "shortcuts-list",
        question: "What keyboard shortcuts are available?",
        answer:
          "Global shortcuts: <kbd>?</kbd> toggles the shortcuts overlay, <kbd>&#8984;/Ctrl</kbd>&thinsp;+&thinsp;<kbd>K</kbd> opens the command palette, and <kbd>Esc</kbd> closes any open dialog or panel. Navigation shortcuts: <kbd>Tab</kbd> and <kbd>Shift</kbd>&thinsp;+&thinsp;<kbd>Tab</kbd> move focus forward and backward, arrow keys navigate lists and tabs, <kbd>Home</kbd> and <kbd>End</kbd> jump to the first and last tab, and <kbd>Enter</kbd> selects or activates the focused element.",
      },
    ],
  },
  {
    id: "payment-streams",
    title: "Payment Streams",
    items: [
      {
        id: "create-stream",
        question: "How do I create a payment stream?",
        answer:
          "Navigate to Streams → New Stream. Enter the recipient's Stellar address, the total amount, the start date, and the end date. Funds are escrowed on-chain when the stream is created (Draft state) and begin vesting linearly once activated.",
      },
      {
        id: "stream-states",
        question: "What are the different stream states?",
        answer:
          "A stream moves through: Draft (created, not yet streaming), Active (vesting linearly), Paused (accrual frozen, vested funds still withdrawable), Settled (all funds released, terminal), and Cancelled (sender ended early — unvested funds refund to sender).",
      },
      {
        id: "pause-stream",
        question: "Can I pause or cancel a stream?",
        answer:
          "Yes. Active streams can be paused and later resumed. You can also cancel a stream at any time — the recipient keeps all vested funds up to the moment of cancellation, and the remaining unvested balance is refunded to you.",
      },
      {
        id: "withdraw-funds",
        question: "How does a recipient withdraw vested funds?",
        answer:
          "Any portion that has vested is available for withdrawal at any time while the stream is Active or Paused. The recipient initiates a withdrawal from the stream detail page, which submits an on-chain transaction to release the vested balance.",
      },
      {
        id: "proration",
        question: "How are mid-month starts and short months handled?",
        answer:
          "All calculations use UTC day boundaries for proration. Mid-month starts and last-day pauses are prorated using inclusive UTC days. Short months use actual day counts — no fixed 30- or 32-day approximation. Local time display may shift with DST, but calculations remain UTC.",
      },
    ],
  },
  {
    id: "account-security",
    title: "Account & Security",
    items: [
      {
        id: "session-security",
        question: "How are sessions secured?",
        answer:
          "Sessions use short-lived JWT bearer tokens signed with a server-side secret (JWT_SECRET, minimum 32 characters). Tokens are scoped to a single wallet address and expire after a fixed interval. All writes require a valid token.",
      },
      {
        id: "cors",
        question: "Why am I seeing CORS errors?",
        answer:
          "Your origin must be listed in the ALLOWED_ORIGINS environment variable (comma-separated). For local development the default is http://localhost:3000. Ask your administrator to add your origin if you are running on a different host or port.",
      },
      {
        id: "private-key-safety",
        question: "Does StreamPay ever see my private key?",
        answer:
          "No. The challenge/signature authentication flow only transmits your public address and the signature of a one-time nonce. Your private key stays in your wallet and is never sent over the network.",
      },
    ],
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    items: [
      {
        id: "app-wont-start",
        question: "The app won't start — I see a STELLAR_NETWORK error.",
        answer:
          "Copy .env.example to .env.local and set STELLAR_NETWORK=testnet (or mainnet). The application performs fail-fast validation on startup and refuses to run with missing or invalid configuration.",
      },
      {
        id: "jwt-errors",
        question: "I'm getting JWT errors during local authentication.",
        answer:
          "Ensure JWT_SECRET in .env.local is at least 32 characters long. You can generate a suitable value with: openssl rand -base64 32",
      },
      {
        id: "stale-build",
        question: "I see stale UI after a code change.",
        answer:
          "Delete the .next/ directory and rebuild: rm -rf .next && npm run build. Stale build artifacts occasionally cause unexpected behaviour after significant dependency or configuration changes.",
      },
      {
        id: "port-in-use",
        question: "Port 3000 is already in use.",
        answer:
          "Start the dev server on an alternative port: PORT=3001 npm run dev. You will also need to add the new origin to ALLOWED_ORIGINS in your .env.local.",
      },
      {
        id: "balance-lag",
        question: "My wallet balance looks out of date.",
        answer:
          "StreamPay uses a short-TTL read-through cache for account and balance reads to keep the UI responsive during Horizon/Soroban outages. If the circuit breaker is open, stale reads may be served. Balances are eventually consistent and may lag the chain by the cache TTL. Refreshing the page will re-fetch the latest data when the network recovers.",
      },
    ],
  },
  {
    id: "api-integration",
    title: "API & Integration",
    items: [
      {
        id: "api-versioning",
        question: "Which API version should I use?",
        answer:
          "Use /api/v2/streams — it is the current supported version. The /api/v1/streams path was deprecated on 2026-04-28 and will stop responding on 2026-12-31. Deprecated responses include Deprecation and Sunset headers per RFC 9745.",
      },
      {
        id: "v1-to-v2-migration",
        question: "How do I migrate from v1 to v2?",
        answer:
          "The main changes are: the actions field is renamed to allowed_actions, timestamps are now snake_case (createdAt → created_at), and a new settlement field appears (null until settled). See docs/api-v2-migration.md for the full field-by-field diff and migration checklist. Deadline: 2026-12-31.",
      },
      {
        id: "webhooks",
        question: "Does StreamPay support webhooks?",
        answer:
          "Yes. POST /api/webhooks/dlq receives dead-letter queue events, and GET /api/webhooks/deliveries lists past delivery attempts. See docs/webhook-delivery.md for the full event schema and retry behaviour.",
      },
    ],
  },
];

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
                <a href={`#${section.id}`} className="help-nav__link">
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* FAQ content */}
        <div className="help-content">
          {FAQ_SECTIONS.map((section) => (
            <section
              key={section.id}
              id={section.id}
              aria-labelledby={`${section.id}-heading`}
              className="help-section"
            >
              <h2
                id={`${section.id}-heading`}
                className="help-section__title"
              >
                {section.title}
              </h2>

              <dl className="faq-list">
                {section.items.map((item) => (
                  <div key={item.id} id={item.id} className="faq-item">
                    <dt className="faq-item__question">{item.question}</dt>
                    <dd className="faq-item__answer">{item.answer}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
