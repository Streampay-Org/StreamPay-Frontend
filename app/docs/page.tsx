import "./docs.module.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Docs - StreamPay",
  description: "How StreamPay works: streams, lifecycle, API, configuration and deployment.",
};

const apiRoutes: [string, string, string][] = [
  ["GET", "/api/healthz", "Liveness probe"],
  ["GET", "/api/readyz", "Readiness probe (config, Horizon, KMS)"],
  ["GET", "/api/streams", "List streams (cursor-paginated, seeded demo data when no database is configured)"],
  ["POST", "/api/streams", "Create a stream (authenticated)"],
  ["GET", "/api/streams/:id", "Stream detail"],
  ["POST", "/api/streams/:id/{start,pause,stop,settle,withdraw}", "Lifecycle actions"],
  ["GET", "/api/activity", "Activity feed"],
  ["GET/POST", "/api/auth/wallet", "Wallet challenge and signature verification, returns a JWT"],
  ["GET", "/api/webhooks/health", "Webhook delivery health"],
  ["GET", "/api/metrics", "Prometheus metrics (token protected)"],
];

export default function DocsPage() {
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
      <div className="docs__table-wrap">
      <table>
        <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
        <tbody>
          {apiRoutes.map(([m, p, d]) => (
            <tr key={`${m} ${p}`}><td><code>{m}</code></td><td><code>{p}</code></td><td>{d}</td></tr>
          ))}
        </tbody>
      </table>
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
