# StreamPay Event Topic Catalog

This document catalogs the events emitted by the StreamPay smart contracts.

All events use a two-topic scheme: `("stream", "<event>")` or `("StreamPay", "<event>")`.
Events are emitted AFTER successful state mutation and any token transfer. Failed calls do not emit events.

## Stream Events

| Primary Topic | Sub-topic | Description |
| --- | --- | --- |
| `"stream"` | `"created"` | Emitted when a new stream is created. |
| `"stream"` | `"started"` | Emitted when a draft stream is started. |
| `"stream"` | `"withdrawn"` | Emitted when tokens are withdrawn from a stream. |
| `"stream"` | `"settled"` | Emitted when a stream is fully settled. Emitted in addition to `withdrawn` when fully drained. |
| `"stream"` | `"paused"` | Emitted when an active stream is paused. |
| `"stream"` | `"resumed"` | Emitted when a paused stream is resumed. |
| `"stream"` | `"cancelled"` | Emitted when a stream is cancelled. |
| `"stream"` | `"amended"` | Emitted when a stream is amended. |

## Administrative Events

| Primary Topic | Sub-topic | Description |
| --- | --- | --- |
| `"stream"` | `"adminact"` | Emitted for general administrative actions on a stream. |
| `"stream"` | `"set_pause"` | Emitted when the admin toggles the global pause flag. |
| `"stream"` | `"set_admin"` | Emitted when the admin role is transferred. |
| `"stream"` | `"set_token"` | Emitted when a token's allowlist status is changed. |
| `"stream"` | `"set_fee_c"` | Emitted when the fee collector address is updated. |
| `"stream"` | `"set_dfee"` | Emitted when the global default fee bps is updated. |
| `"stream"` | `"fee"` | Emitted for every withdrawal that incurs a non-zero fee. |
| `"stream"` | `"swept"` | Emitted when the admin successfully sweeps accumulated protocol fees. |
| `"stream"` | `"deprecated_entrypoint"` | Emitted when a legacy/deprecated contract entrypoint is invoked. |

## Contract Events

| Primary Topic | Sub-topic | Description |
| --- | --- | --- |
| `"StreamPay"` | `"upgraded"` | Emitted when the contract is upgraded. |

For detailed data payloads of each event, refer to the `events.rs` module in the smart contract source code.
