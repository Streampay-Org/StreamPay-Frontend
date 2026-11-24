# StreamPay Embeddable Stream Widget

The StreamPay embed widget allows merchants to display a read-only payment stream status on their websites using a sandboxed iframe.

## 1. Generate an Embed Token

Embed tokens are issued through an authenticated API endpoint. Only the owner of a stream can generate its token.

**Endpoint**

`POST /api/embed/stream/:id/token`

**Example request**

```bash
curl -X POST https://your-streampay-domain.com/api/embed/stream/STREAM_ID/token \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN"
```

**Example response**

```json
{
  "data": {
    "token": "SIGNED_EMBED_TOKEN",
    "expiresIn": 900,
    "embedUrl": "/embed/stream/STREAM_ID?t=SIGNED_EMBED_TOKEN"
  }
}
```

Tokens are stream-specific and expire after 15 minutes. Generate a new token when the previous one expires.

## 2. Configure Allowed Origins

Set `EMBED_ALLOWED_ORIGINS` in your server environment to a comma-separated list of HTTPS origins permitted to embed the widget.

```env
EMBED_ALLOWED_ORIGINS=https://merchant.example.com,https://shop.example.com
```

Only valid HTTPS origins are accepted. Paths, wildcards, credentials, and invalid URLs are rejected.

If the variable is unset or empty, embedding is denied by default using:

`Content-Security-Policy: frame-ancestors 'none';`

Non-embed routes also deny framing.

## 3. Add the Widget to Your Website

Include the StreamPay loader script and a container with the stream ID and generated token.

```html
<div
  data-streampay-stream="STREAM_ID"
  data-token="SIGNED_EMBED_TOKEN"
></div>

<script
  async
  src="https://your-streampay-domain.com/embed.js"
></script>
```

The loader creates a responsive iframe for the stream. It uses lazy loading, a restrictive sandbox, and `no-referrer` policy.

## 4. Widget Features

The widget displays:

- Stream payment status.
- Status-based progress indicator.
- Masked recipient information.
- Payment rate.
- Payment schedule.

The widget is read-only. It does not expose full wallet addresses, email addresses, private memos, labels, or partner IDs.

## 5. Security

- Embed tokens are signed using the server's JWT secret and are bound to a specific stream.
- Only authenticated stream owners can request embed tokens.
- Token issuance is rate-limited.
- Invalid tokens and unknown streams return the same not-found response.
- The iframe uses a sandbox and validates resize messages using the widget origin and iframe window.
- The widget communicates its height to the parent page using `postMessage`.
- Embed responses should not be cached publicly because they contain token-authorized stream information.

Keep generated embed tokens private. Anyone holding a valid token can view the corresponding read-only widget until the token expires.