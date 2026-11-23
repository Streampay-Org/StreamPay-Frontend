export type ContactSortKey =
  | "label-asc"
  | "label-desc"
  | "recent"
  | "oldest";

export type SortableContact = {
  label: string;
  address: string;
  federationAddress?: string;
  memo?: string;
  createdAt?: string;
};

export function filterContacts<T extends SortableContact>(
  contacts: T[],
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...contacts];

  return contacts.filter((contact) =>
    [
      contact.label,
      contact.address,
      contact.federationAddress,
      contact.memo,
    ].some((value) =>
      value?.toLocaleLowerCase().includes(normalizedQuery),
    ),
  );
}

function timestamp(createdAt?: string): number | null {
  const value = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isNaN(value) ? null : value;
}

export function sortContacts<T extends SortableContact>(
  contacts: T[],
  sortKey: ContactSortKey,
): T[] {
  return contacts
    .map((contact, index) => ({ contact, index }))
    .sort((a, b) => {
      let comparison = 0;

      if (sortKey === "label-asc" || sortKey === "label-desc") {
        comparison = a.contact.label.localeCompare(
          b.contact.label,
          undefined,
          { sensitivity: "base" },
        );
        if (sortKey === "label-desc") comparison *= -1;
      } else {
        const aTime = timestamp(a.contact.createdAt);
        const bTime = timestamp(b.contact.createdAt);

        if (aTime === null && bTime === null) comparison = 0;
        else if (aTime === null) comparison = 1;
        else if (bTime === null) comparison = -1;
        else comparison =
          sortKey === "recent" ? bTime - aTime : aTime - bTime;
      }

      return comparison || a.index - b.index;
    })
    .map(({ contact }) => contact);
}
