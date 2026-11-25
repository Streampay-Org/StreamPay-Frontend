# Organization receipt themes

Open **Settings → Receipts**, enter the organization ID and your member wallet
address and the session token returned by wallet authentication, then select **Load receipt theme**. Members can view the theme.
Owners can edit the accent colour, logo URL, and message and see the changes in
the sample receipt. Select **Save theme** to apply the changes to organization
receipts or **Reset theme** to restore the default receipt. The Settings
navigation prompt lets you save or discard pending edits.

The logo is optional. Deployments set `RECEIPT_LOGO_ALLOWED_HOSTS` to a
comma-separated list of allowed hosts, such as
`cdn.example.org,*.assets.example.org`. An empty list disables logos. Use an
absolute HTTPS URL with no credentials or non-default port. Receipts display
the StreamPay wordmark if an image fails. The message is plain text, with a
limit of 140 UTF-16 code units.

## API

All operations use `/api/orgs/{orgId}/receipt-theme` and the organization
policy route's actor resolver. Send the bearer token issued by
`POST /api/auth/wallet` after signing the wallet challenge. When supplied,
`Actor-Wallet-Address` must match the verified wallet. Header-only access
is available when `STREAMPAY_ALLOW_ACTOR_HEADER=true` and defaults to
disabled in production.

| Method | Access | Behavior |
| --- | --- | --- |
| GET | Any organization member | Read the current theme. |
| PUT | Organization owner | Replace the theme with the supplied fields. |
| DELETE | Organization owner | Remove the theme and restore the default receipt. |

PUT accepts a JSON object with optional `accentColor`, `logoUrl`, and
`message` fields. Omitted or null fields use the default accent or clear the
optional logo and message. The accent accepts three or six hexadecimal digits
prefixed by `#`, and is trimmed and lowercased. The logo and message are
trimmed. Example request body:

```json
{
  "accentColor": "#2563eb",
  "logoUrl": "https://cdn.example.org/mark.png",
  "message": "Thanks for working with us!"
}
```

Success returns HTTP 200 with `data.orgId`, `data.theme` (null when unset),
`data.canEdit`, `data.logoAllowedHosts` for editor validation, and
`links.self`. Requests return 403 when the wallet lacks access, 404 for an
unknown organization, 400 for malformed JSON, and 422 with `error.fields`
for invalid input.

Theme updates and resets are recorded in the organization audit log under
`org.receipt_theme.updated` and `org.receipt_theme.reset`. The org repository
currently stores themes in memory, so a process restart clears changes.
