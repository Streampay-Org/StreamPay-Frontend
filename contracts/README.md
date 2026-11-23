# StreamPay Soroban Contracts

This workspace contains the StreamPay Soroban contracts.

## streampay-stream

`streampay-stream` manages funded token streams with a draft-to-active
lifecycle:

- `create_stream(..., draft: true)` creates a funded Draft stream.
- `start_stream(stream_id)` can only be called by the stream sender and changes
  a Draft stream to Active.
- Draft streams accrue nothing. Activation anchors `start_time` and
  `last_update` to the current ledger timestamp and derives `end_time` from the
  configured duration.
- Escrow funding happens at `create_stream` for both Draft and Active streams,
  so a stream is fully funded before it can accrue or be withdrawn.

The contract exposes stable `#[contracterror]` codes from
`contracts/streampay-stream/src/error.rs` for backend error mapping.

## Split streams

`streampay-stream` also supports multi-recipient split streams. A split stream
escrows one `total_amount` and releases it proportionally by recipient weight:

- `create_split_stream(sender, token, total_amount, start_time, end_time, recipients, weights)`
  funds the escrow and returns the new split stream id.
- `withdraw_split(stream_id, recipient, amount)` pays a recipient their vested,
  not-yet-withdrawn share.
- `pause_split_stream(stream_id)` freezes accrual for every recipient at the
  pause timestamp. Only the sender may call it, and the stream must be `Active`.
- `resume_split_stream(stream_id)` restarts accrual and extends `end_time` by
  the paused span so the unstreamed time is preserved. Only the sender may call
  it, and the stream must be `Paused`.
- `cancel_split_stream(stream_id)` pays each recipient their frozen or accrued
  share and returns the remainder to the sender.

Both pause and resume are blocked by the contract-wide pause flag and emit
`split_pa` / `split_re` events.

## Storage migrations

`migrate(admin)` advances the contract's storage layout one version at a time.
`storage_version()` reports the current version (`0` before the first
migration).

| Version | Layout |
|---|---|
| `0` | Unset — pre-migration contract. |
| `1` | Initial layout marker. |
| `2` | Pause bookkeeping normalised on split and recurring records. |

Version 2 rewrites split and recurring records in batches of 50 ids per call so
a large dataset cannot exceed the Soroban per-transaction budget. When a batch
limit is reached the version stays at the previous value; call `migrate` again
until `storage_version()` returns `2`. Re-running `migrate` at the latest
version is a no-op. Only the admin may migrate, and the global pause flag does
not block migration.

## Deploy

Deploy the contract to Stellar testnet with:

```sh
STELLAR_SEED_SECRET_KEY=S... bash ../operations/deploy-testnet.sh
```

The script:

- Builds the WASM via `stellar contract build`
- Deploys via `stellar contract deploy` using the built-in testnet config
- Saves the contract ID to `contracts/.contracts/streampay-stream.id`
- Is idempotent — re-running skips deployment unless `FORCE_DEPLOY=true`

### Prerequisites

- `stellar` CLI — `cargo install stellar-cli`
- Rust `wasm32v1-none` target — `rustup target add wasm32v1-none`
- A funded testnet account with its secret key in `STELLAR_SEED_SECRET_KEY`

### Environment variables

| Variable | Default | Required | Description |
|---|---|---|---|
| `STELLAR_SEED_SECRET_KEY` | — | yes | Deployer secret key |
| `STELLAR_NETWORK` | `testnet` | no | Network name (`testnet`, `futurenet`, or a JSON config) |
| `STELLAR_HORIZON_URL` | — | no | Custom Horizon RPC URL |
| `CONTRACT_NAME` | `streampay-stream` | no | Contract package name |
| `FORCE_DEPLOY` | `false` | no | Re-deploy over an existing deployment |

### Idempotency

Deployed contract IDs are stored in `contracts/.contracts/<name>.id`. This file is
gitignored (do not commit it). On re-run, the script reads the existing ID and
exits early. To force a fresh deployment:

```sh
FORCE_DEPLOY=true STELLAR_SEED_SECRET_KEY=S... bash ../operations/deploy-testnet.sh
```

## Tests

Run the contract tests from this directory:

```sh
cargo test -p streampay-stream
```
