export interface RequiredMemo {
  type: "text" | "id" | "hash";
  value: string;
}

export interface Contact {
  id: string;
  label: string;
  /** Resolved Stellar account ID (G…) */
  address: string;
  /** Original federation address when the user entered one (user*domain.com) */
  federationAddress?: string;
  memo?: string;
  requiredMemo?: RequiredMemo;
  createdAt: string;
}

export interface ContactPaymentTarget {
  address: string;
  memo?: RequiredMemo;
}

export function getContactPaymentTarget(contact: Contact): ContactPaymentTarget {
  return {
    address: contact.address,
    ...(contact.requiredMemo ? { memo: contact.requiredMemo } : {}),
  };
}
