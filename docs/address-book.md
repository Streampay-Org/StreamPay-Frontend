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

When the user enters a federation address (format: `user*domain.com`), the application resolves it via the Stellar federation protocol on blur of the address field:

1. If the input matches the federation format (`user*domain.com`), the app calls `resolveFederationAddress()` from `../utils/federation`.
2. While resolving, a spinning indicator (`⟳`) is shown inside the input field.
3. On success, the resolved Stellar account ID is displayed beneath the input in green, and the original federation address is stored in the `federationAddress` field.
4. On failure, the error message is displayed in red below the input, and the form submission is blocked until the address is resolved.

The form accepts either a raw Stellar address (`G…` format) or a federation address. Raw addresses are stored directly without resolution.

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
