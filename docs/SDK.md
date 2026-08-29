# StreamPay Partner SDK

`lib/sdk` exports a small TypeScript client for partners that need REST helpers
and live stream updates without importing Next.js route internals.

## Create a Client

```ts
import { createStreamPayClient } from "../lib/sdk";

const client = createStreamPayClient({
  baseUrl: "https://app.streampay.io",
  token: process.env.STREAMPAY_PARTNER_TOKEN,
});
```

Every REST request sends:

- `Authorization: Bearer <token>` when a token is configured
- `Accept: application/json`
- `x-request-id` for log correlation
- `Idempotency-Key` when passed to mutating helpers

API error envelopes are raised as `StreamPaySdkError` with `code`, `status`,
`requestId`, and optional `details`.

### Diagnostics privacy

`details` is intended for diagnostics, so it is **redacted before it leaves the
SDK**. Error responses commonly echo the submitted request body, which can
contain credentials (tokens, secrets, signing keys, signatures, seeds,
mnemonics, …). The SDK applies a deterministic, least-privilege redaction
(`lib/sdk/redact.ts`) to any body captured into `StreamPaySdkError.details`:

- Sensitive field names (`token`, `secret`, `password`, `privateKey`,
  `api_key`, `signature`, `seed`, …) are replaced with `[REDACTED]`.
- Stellar secret seeds (`S…`) and PEM private-key blocks are redacted even
  under non-sensitive field names.
- Non-sensitive fields (recipient addresses, rates, error messages, field
  errors) are preserved so failures remain diagnosable.
- Redaction is pure and total: it never throws, never mutates the error
  payload, and is deterministic for identical input.

## REST Helpers

```ts
const streams = await client.listStreams({ status: "active", limit: 20 });
const stream = await client.getStream("stream-ada");

const created = await client.createStream(
  { recipient: "G...", rate: "10", schedule: "month", token: "XLM" },
  { idempotencyKey: "partner-stream-ada-2026-06" },
);

await client.deleteStream("stream-ended");
const activity = await client.listActivity({ streamId: "stream-ada" });
```

## SSE Updates

`subscribeToStream` wraps the existing live-events protocol at
`/api/streams/events?streamId=...`.

```ts
const subscription = client.subscribeToStream("stream-ada", {
  onUpdate: (stream) => {
    console.log("updated", stream.status);
  },
  onSettlement: (stream) => {
    console.log("settled", stream.settlement);
  },
  onError: (event) => {
    console.error("stream event error", event);
  },
});

// Later:
subscription.close();
```

Native browser `EventSource` does not support custom headers, so the SDK follows
the current live-events protocol and appends `token` to the SSE URL when a token
is configured. Server-side runtimes can pass `eventSourceFactory` to use a
custom EventSource implementation.

## Testing

Use injected `fetchFn`, `requestIdFactory`, and `eventSourceFactory` to make
partner integrations deterministic without network calls.
