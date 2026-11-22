# StreamPay

StreamPay is a dashboard for paying collaborators, vendors and grant
recipients in a continuous flow instead of lump sums: create a stream, watch funds accrue, pause or stop at any time,
and let the recipient withdraw what has vested.

## Live demo: [https://streampay-frontend-alpha.vercel.app](https://streampay-frontend-alpha.vercel.app)

> Explore [streams](https://streampay-frontend-alpha.vercel.app/streams), a [stream detail](https://streampay-frontend-alpha.vercel.app/streams/stream-ada), [activity](https://streampay-frontend-alpha.vercel.app/activity) and the in-app [docs](https://streampay-frontend-alpha.vercel.app/docs). The demo needs no wallet and no backend:
> the API serves seeded sample data, so every screen is populated.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FStreampay-Org%2FStreamPay-Frontend&env=JWT_SECRET,STELLAR_NETWORK,ALLOWED_ORIGINS)

## Features

- Streams list with status badges, accrual progress, density toggle and per-stream actions (start, pause, stop, settle, withdraw)
- Stream detail page with payment timeline, settlement transaction and shareable receipt
- Guided stream creation, multi-recipient splits, previews and reusable templates
- Activity feed, address book, notification settings, onboarding tour, light/dark/high-contrast themes
- Command palette and keyboard shortcuts, accessible components, mobile bottom navigation
- REST API (`/api/v1`, `/api/v2`) with OpenAPI spec, JWT wallet auth, rate limiting, CSRF, request fingerprinting, audit log, webhooks and Prometheus metrics
- Soroban escrow contract sources in [`contracts/`](contracts)

## Quick start

Requires Node.js 20+.

```bash
git clone https://github.com/Streampay-Org/StreamPay-Frontend.git
cd StreamPay-Frontend
npm ci
cp .env.example .env.local   # then edit, see "Environment variables"
npm run dev              # http://localhost:3000
```

Minimal `.env.local` for local development:

```env
STELLAR_NETWORK=testnet
JWT_SECRET=dev-secret-key-at-least-32-characters-long
ALLOWED_ORIGINS=http://localhost:3000
```

## Environment variables

The app refuses to boot without the first three. Everything else is optional and has a safe default; the complete
inventory with comments is in [`.env.example`](.env.example).

| Variable | Required | Description |
|----------|----------|-------------|
| `STELLAR_NETWORK` | yes | `testnet` or `mainnet`. No implicit default, to avoid accidental mainnet use. |
| `JWT_SECRET` | yes | Session signing secret, at least 32 characters. |
| `ALLOWED_ORIGINS` | yes | Comma-separated CORS allow-list (no `*` in production). |
| `DATABASE_URL` | no | Postgres connection string. Without it the API uses seeded in-memory data. |
| `HORIZON_URL` / `SOROBAN_RPC_URL` | no | Stellar endpoints (testnet defaults). |
| `WEBHOOK_SECRET`, `METRICS_AUTH_TOKEN`, `FEE_BUMP_SECRET_KEY`, ... | no | Feature specific, see `.env.example`. |

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Start the dev server |
| `npm run build` / `npm start` | Production build / serve it |
| `npm test` | Unit and component tests (Jest) |
| `npm run smoke` | OpenAPI validation and API smoke tests |
| `npm run lint` | ESLint |
| `npm run openapi:generate` | Regenerate TypeScript types from `openapi.json` |

## Architecture

```
app/            Next.js App Router: pages, components and API route handlers (app/api)
app/lib/        Server-side helpers: auth, config validation, errors, audit log, repositories
lib/, src/      Shared clients, middleware (rate limit, timeout, ETag) and metrics
contracts/      Soroban escrow contract (Rust)
docs/           Long-form documentation and runbooks
scripts/         Operational scripts (reconciliation, backfills, OpenAPI tooling)
middleware.ts   Edge middleware: CORS, CSRF, body-size caps, request ids, fingerprinting
```

Request flow: browser, then `middleware.ts`, then a route handler in `app/api/**`, which validates input, calls a
repository behind a pluggable store interface (in-memory by default, Postgres when configured) and returns the shared
error envelope. Stellar and Soroban calls go through a client with caching and circuit breaking. See
[docs/architecture.md](docs/architecture.md) for details.

## Documentation

- In-app overview: `/docs`
- [docs/reference.md](docs/reference.md) - the full original reference (API versioning, lifecycle, security, webhooks, troubleshooting)
- [docs/architecture.md](docs/architecture.md), [docs/STATE_MACHINE.md](docs/STATE_MACHINE.md), [docs/api-v2-migration.md](docs/api-v2-migration.md)
- [docs/DEPLOYMENT-CHECKLIST.md](docs/DEPLOYMENT-CHECKLIST.md) and [docs/runbooks](docs/runbooks)
- [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md)

## Deploying to Vercel

1. Import the repository in Vercel (or use the button above). The framework preset is detected from `vercel.json`.
2. Set `STELLAR_NETWORK=testnet`, `JWT_SECRET` (32+ random characters) and `ALLOWED_ORIGINS` (your deployment URL).
3. Deploy. No database is required for the demo.

CLI: `vercel link && vercel env add JWT_SECRET production && vercel --prod`.

A container image is also available via the included `Dockerfile` (Next.js standalone output).

## Contract fees

The Soroban escrow contract in [`contracts/`](contracts) charges fees on withdrawal. The fee
rate is fixed per stream at creation (`stream.fee_bps`) and is paid to the configured
fee collector. Both withdrawal entrypoints use the same economics:

| Entrypoint | Fee rate charged | Fee recipient | Authorization |
|------------|------------------|---------------|---------------|
| `withdraw` | `stream.fee_bps` | fee collector | recipient or allowlisted withdrawer |
| `withdraw_with_max_fee_bps` / `withdraw_guarded` | `stream.fee_bps` | fee collector | recipient or allowlisted withdrawer |

The guarded variant additionally rejects the call with `FeeTooHigh` when `stream.fee_bps > max_fee_bps`,
before any state change. The global `fee_bps` / `default_fee_bps` admin knobs only see the
default applied to newly created streams; they are never charged at withdrawal time.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Before opening a PR run `npm test`, `npm run smoke` and `npm run build`.
Some legacy test suites are quarantined in `jest.config.js` (`testPathIgnorePatterns`); fixing one and removing it from
that list is a welcome first contribution.

## License

See the repository license file.
