# Address Book

A client-side address book for saving Stellar addresses with human-readable labels, federation address resolution, and optional memos/notes.

## Route

`/contacts` — renders the Address Book page.

## Data model

Contacts are stored in **localStorage** under the key `streampay_contacts`.

### Contact (TypeScript interface)

| Field | Type | Description |
|---|---|---|
| `id` | `string` | UUID v4 generated via `crypto.randomUUID()` at creation time |
| `label` | `string` | User-defined, human-readable name (max 64 characters) |
| `address` | `string` | Resolved Stellar account ID (`G` + 55 base-32 chars) |
| `federationAddress` | `string?` | Original federation address (e.g. `alice*example.com`), if the user entered one |
| `memo` | `string?` | Optional note (max 256 characters) |
| `createdAt` | `string` | ISO 8601 timestamp of when the contact was created |

```typescript
export interface Contact {
  id: string;
  label: string;
  address: string;
  federationAddress?: string;
  memo?: string;
  createdAt: string;
}
```

## Federation address resolution

When the user enters a federation address (format: `user*domain.com`), the
application resolves it through the Stellar federation protocol on **blur** of the
address field. The implementation lives in
[`app/utils/federation.ts`](../app/utils/federation.ts).

### Resolution sequence

1. **Format check.** `isFederationAddress()` matches
   `^[^*\s]+\*[^*\s]+\.[^*\s]+$` — a non-empty local part, exactly one `*`, and a
   dotted domain with no whitespace. Input that fails this check raises
   `FederationError` with code `INVALID_FORMAT` before any network call is made.
2. **Cache lookup.** Unless the caller passes `{ bypassCache: true }`, a
   still-fresh entry for the lower-cased address is returned immediately and no
   network request is made (see [Cache semantics](#cache-semantics)).
3. **`stellar.toml` discovery.** `fetchFederationServerUrl()` requests
   `https://<domain>/.well-known/stellar.toml` with a 10-second timeout and reads
   the `FEDERATION_SERVER` entry out of it. The request is always HTTPS, even
   when the user typed a bare domain.
4. **Federation query.** The discovered federation server URL is called with
   `?q=<address>&type=name`, again with a 10-second timeout. The server is
   expected to answer with a SEP-0002 record (`stellar_address`, `account_id`,
   and an optional `memo_type`/`memo`).
5. **Cache write and return.** On success the record is stored under the
   lower-cased address and returned to the page.

### UI behaviour

1. If the input matches the federation format, the app calls
   `resolveFederationAddress()`.
2. While resolving, a spinning indicator (`⟳`) is shown inside the input field.
3. On success, the resolved Stellar account ID is displayed beneath the input
   (labelled `Resolved:`) and the original federation address is kept in the
   form's `federationAddress` state.
4. On failure, the error message is displayed below the input and the form
   submission is blocked until the address resolves.

The form accepts either a raw Stellar address (`G…` format) or a federation
address. Raw addresses are stored directly without resolution. Editing the
address field clears the previous resolution, so a stale `Resolved:` value can
never be saved against a new input.

### Cache semantics

| Property | Value |
|---|---|
| Storage | In-memory `Map`s (`cache`, `cacheTimestamps`) inside the module |
| Key | The federation address, lower-cased |
| TTL | `CACHE_TTL_MS` = `5 * 60 * 1000` (5 minutes) |
| Scope | The current browser tab / module instance only |
| Lifespan | Cleared by a page reload; never written to `localStorage` |
| Bypass | `resolveFederationAddress(address, { bypassCache: true })` |
| Manual clear | `clearFederationCache()` |

Only entries older than the TTL are refetched; expired entries are not
proactively evicted, they are overwritten on the next resolution. Two
simultaneous resolutions of the same address are not deduplicated and may both
hit the network. A resolve failure is never cached, so retrying after a
`NETWORK_ERROR` or `SERVER_ERROR` does perform a fresh request.

### Error codes

`FederationError` carries a `code` from the `FederationErrorCode` union so the
UI can distinguish "the address is wrong" from "the remote server is unhappy".

| Code | Raised when | Typical fix |
|---|---|---|
| `INVALID_FORMAT` | The input does not match the federation pattern (from `resolveFederationAddress()` or `parseFederationAddress()`). | Correct the address to `user*domain.com`. |
| `NETWORK_ERROR` | The `stellar.toml` or federation-server request failed or exceeded its 10-second timeout (DNS, TLS, CORS, offline, or a dropped connection). | Retry; confirm the domain is reachable over HTTPS. |
| `NOT_FOUND` | `stellar.toml` returned a non-2xx status, contained no `FEDERATION_SERVER` entry, or the federation server answered `404` for the address. | Confirm the domain publishes `stellar.toml` and that the account exists. |
| `SERVER_ERROR` | The federation server responded with any other non-2xx status (for example `500` or `503`). | Retry later; the federation server is failing. |

Failures that are not `FederationError` — a 2xx response whose body is not valid
JSON, or a record missing `account_id` — surface as the underlying error and are
shown with a generic message rather than one of the codes above.

### Security considerations

- **HTTPS only.** Both the `stellar.toml` lookup and the federation query are
  constructed with `https://`; the domain is never contacted over plaintext.
- **No credentials.** Federation is an unauthenticated public protocol. No API
  keys, signatures, or wallet secrets are attached to either request.
- **Timeouts.** Both requests use `AbortSignal.timeout(10_000)`, so a
  non-responsive domain cannot hang the form indefinitely.
- **Input is only used in a query string.** The address is parsed into
  `username`/`domain` and the domain becomes a hostname; the full address is
  passed through `URLSearchParams`, which percent-encodes it.
- **Client-side only.** Federation resolution happens in the browser; no contact
  data is proxied through the StreamPay backend.
- **The resolved address is a snapshot.** A contact stores the `account_id`
  returned at save time, not the federation address's live value. If the domain
  later points the same federation address at a different account, the saved
  contact keeps the old G-address until the user edits it and lets it resolve
  again. This is deliberate — silently following a remote server's new address
  could redirect a payment — but it is the behaviour users ask about most often.
- **Federation responses are untrusted input.** The returned `account_id` is used
  as-is; the `G[A-Z2-7]{55}` check only runs on addresses the user types
  directly, not on what the federation server returns. Verify an unexpected
  address before sending funds to it.
- **The federation `memo` is not used.** A contact's `memo` field is the user's
  own free-text note; the `memo`/`memo_type` from the federation record are
  neither displayed nor persisted.

## Validation rules

| Field | Rule | Error message |
|---|---|---|
| `label` | Required, max 64 chars | `"Label is required"` / `"Label must be 64 characters or fewer"` |
| `address` | Required. Must be a valid Stellar address (`G[A-Z2-7]{55}`) or a federation address (`user*domain.com`). If a federation address, it must be resolved before saving. | `"Address is required"` / `"Enter a valid Stellar address (G…) or federation address (user*domain.com)"` / `"Resolve the federation address before saving"` |
| `memo` | Optional, max 256 chars | `"Note must be 256 characters or fewer"` |

## User interactions

### Empty state
When no contacts exist, the page displays an `EmptyState` component with:
- Eyebrow: "Contacts"
- Title: "No contacts yet"
- Description: invites the user to add their first Stellar address
- CTA: "Add your first contact" — opens the Add Contact modal
- Guidance steps: three numbered steps for first-time users

### Add contact
Clicking "+ Add contact" or the empty-state CTA opens a modal with the `ContactForm`. The form includes:
- Label (required, text input)
- Stellar address or federation address (required, text input with federation resolution on blur)
- Note (optional, text input)
- Cancel and Submit buttons

### Edit contact
Each contact row has an "Edit" button that opens the same form pre-filled with the contact's existing data. The address field is pre-filled with the federation address if one exists, otherwise the raw Stellar address.

### Delete contact
Each contact row has a "Delete" button that opens a confirmation modal. The modal displays the contact's name and warns that the action cannot be undone. Confirming removes the contact from localStorage.

### Search/filter
The page includes a search input that filters contacts in real-time by:
- Label
- Stellar address
- Federation address
- Memo/note

A live counter shows the filtered count vs total (e.g. "3 of 10 contacts").

## Persistence

All contact data is stored client-side in `localStorage` under the key `streampay_contacts`.

```typescript
const CONTACTS_KEY = "streampay_contacts";
```

The data is serialized as a JSON array of `Contact` objects. Reading/writing is wrapped in try/catch blocks so that localStorage unavailability (e.g. incognito mode, private browsing, or quota exceeded) degrades gracefully without crashing the page.

## Accessibility

- All form inputs use `aria-required`, `aria-invalid`, and `aria-describedby` for screen-reader support.
- Error messages use `role="alert"`.
- The search input has a visually-hidden `<label>` with `htmlFor` for screen-reader identification.
- Modal dialogs use `aria-label` for identification.
- The contact list is wrapped in `<section aria-label="Contact list">` with proper `<ul>` / `<li>` structure.
- The contact count uses `aria-live="polite"` to announce changes to screen readers.

## Responsive design

- The `.contact-row` component uses CSS Grid with `1fr auto` columns on wider viewports and stacks to a single column below 35rem.
- The toolbar (search + add button) uses `flex-wrap: wrap` to stack on narrow screens.
- The search input has a `min-width: 200px` to remain usable on small viewports.
- All modals use the existing `Modal` component which handles focus trapping and responsive sizing.

## Dark mode / high contrast

All colors use CSS custom properties defined in `globals.css`. The page inherits the theme automatically and works with dark, light, and high-contrast variants in both dark and light modes.

## Related components

| Component | Location | Purpose |
|---|---|---|
| `ContactForm` | `app/contacts/page.tsx` | Form for adding/editing contacts |
| `ContactRow` | `app/contacts/page.tsx` | Displays a single contact with edit/delete actions |
| `Modal` | `app/components/Modal.tsx` | Dialog wrapper for add/edit/delete flows |
| `EmptyState` | `app/components/EmptyState.tsx` | Empty state with guidance steps |
| `CopyAddress` | `app/components/CopyAddress.tsx` | Truncated address display with copy-to-clipboard |
| `loadContacts()` | `app/contacts/page.tsx` | Reads contacts from localStorage |
| `persistContacts()` | `app/contacts/page.tsx` | Writes contacts to localStorage |

## Security considerations

- Contact data is stored entirely client-side; no contact data is transmitted to any server.
- Stellar addresses are validated client-side using the regex `^G[A-Z2-7]{55}$` before saving.
- Federation addresses are resolved via the public Stellar federation protocol; no credentials are required.
- All contact data is stored unencrypted in `localStorage`; users should not store sensitive information in the memo field.
