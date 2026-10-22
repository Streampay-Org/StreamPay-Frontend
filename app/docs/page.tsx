import type { Metadata } from "next";
import Link from "next/link";
import { groupOpenApiRoutesByTag } from "./openapi-routes";

export const metadata: Metadata = {
  title: "Docs - StreamPay",
  description: "How StreamPay works: streams, lifecycle, API, configuration and deployment.",
};

function LockIcon() {
  return (
    <svg
      className="docs__auth-icon"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3.25" y="7.25" width="9.5" height="6.5" rx="1.5" />
      <path d="M5.25 7.25V5a2.75 2.75 0 0 1 5.5 0v2.25" />
    </svg>
  );
}

export default function DocsPage() {
  const routeGroups = groupOpenApiRoutesByTag();

  return (
    <main className="docs">
      <p className="home__eyebrow">Documentation</p>
      <h1>StreamPay docs</h1>
      <p>
        StreamPay is a payment-streaming dashboard on the Stellar network: pay collaborators, vendors and grant
        recipients in a continuous flow instead of lump sums. This page is a quick tour; the full documentation lives
        in the repository&apos;s <code>docs/</code> folder.
      </p>
      <ul className="docs__toc">
        {["concepts", "lifecycle", "demo-mode", "api", "config", "deploy"].map((id) => (
          <li key={id}><a href={`#${id}`}>{id.replace("-", " ")}</a></li>
        ))}
      </ul>

      <h2 id="concepts">Core concepts</h2>
      <ul>
        <li><strong>Stream</strong> - a payment from a sender to a recipient that accrues at a fixed rate (for example 120 XLM / month).</li>
        <li><strong>Escrow</strong> - funds are locked in a Soroban contract; the recipient can withdraw what has vested.</li>
        <li><strong>Settlement</strong> - periodic on-chain settlement keeps the contract state and the dashboard in sync.</li>
      </ul>

      <h2 id="lifecycle">Stream lifecycle</h2>
      <p>
        <code>draft</code> → <code>active</code> ⇄ <code>paused</code> → <code>ended</code> → <code>withdrawn</code>. A
        stream can also be <code>cancelled</code>. Only valid transitions are accepted by the API
        (see <code>docs/STATE_MACHINE.md</code>).
      </p>

      <h2 id="demo-mode">Demo mode</h2>
      <p>
        The live demo runs without a database or a wallet backend. The API serves deterministic seeded data
        (Ada Creative Studio, Kemi Onboarding Support, Yusuf QA Partnership) and the UI falls back to the same fixtures
        if a request fails, so every screen renders. Browse the <Link href="/streams">streams</Link>, open a stream for
        its timeline and receipt, or walk through <Link href="/streams/new">stream creation</Link>.
      </p>

      <h2 id="api">HTTP API</h2>
      <p>
        Generated at build time from <code>openapi.json</code> and grouped by tag.
      </p>
      <div className="docs__api-groups">
        {routeGroups.map((group) => (
          <section
            key={group.tag}
            className="docs__api-group"
            aria-label={`${group.tag} API routes`}
          >
            <div className="docs__api-group-header">
              <h3>{group.tag}</h3>
              {group.description ? (
                <p className="docs__api-group-description">{group.description}</p>
              ) : null}
            </div>
            <div className="docs__table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Path</th>
                    <th>Auth</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {group.routes.map((route) => (
                    <tr key={`${route.method} ${route.path}`}>
                      <td><code>{route.method}</code></td>
                      <td><code>{route.path}</code></td>
                      <td>
                        {route.security ? (
                          <span className="docs__auth-badge" data-secured="true">
                            <LockIcon />
                            <span>Requires auth</span>
                          </span>
                        ) : (
                          <span className="docs__public-badge" data-secured="false">
                            Public
                          </span>
                        )}
                      </td>
                      <td>{route.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
      <p>The full contract is in <code>openapi.json</code> in the repository.</p>

      <h2 id="config">Configuration</h2>
      <div className="docs__table-wrap">
      <table>
        <thead><tr><th>Variable</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td><code>STELLAR_NETWORK</code></td><td><code>testnet</code> or <code>mainnet</code> (required)</td></tr>
          <tr><td><code>JWT_SECRET</code></td><td>At least 32 characters; signs session tokens (required)</td></tr>
          <tr><td><code>ALLOWED_ORIGINS</code></td><td>Comma-separated CORS allow-list (required)</td></tr>
          <tr><td><code>DATABASE_URL</code></td><td>Optional Postgres URL; seeded in-memory data otherwise</td></tr>
        </tbody>
      </table>
      </div>
      <p>See <code>.env.example</code> for every option.</p>

      <h2 id="deploy">Deploying</h2>
      <pre><code>{`npm install
npm run build
npm start`}</code></pre>
      <p>On Vercel, import the repo, set the three required variables above and deploy. No other setup is needed.</p>
    </main>
  );
}
