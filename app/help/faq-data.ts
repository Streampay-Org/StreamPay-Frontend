export type FaqItem = {
  id: string;
  question: string;
  answer: string;
};

export type FaqSection = {
  id: string;
  title: string;
  items: FaqItem[];
};

export const FAQ_SECTIONS: FajSection[] = [
  {
    id: "getting-started",
    title: "Getting started",
    items: [
      {
        id: "what-is-stellar",
        question: "What is Stellar?",
        answer:
          "Stellar is an open network for moving and settling payments across borders. It connects accounts, assets issuers, and anchors so you can send and receive value in seconds.",
      },
      {
        id: "create-account",
        question: "How do I create an account?",
        answer:
          "Open the Stellar app and choose “Create account”. You will generate a keypair and receive a recovery phrase. Store the phrase offline and never share it.",
      },
      {
        id: "what-is-a-wallet",
        question: "What is a wallet?",
        answer:
          "A wallet is the app or extension that holds your keys and lets you sign transactions. Freighter is the reference wallet for Stellar and is available as a browser extension.",
      },
    ],
  },
  {
    id: "sending-payments",
    title: "Sending payments",
    items: [
      {
        id: "how-long-transfers",
        question: "How long do transfers take?",
        answer:
          "Most Stellar payments settle in about five seconds. Larger or cross-asset payments may take longer if an anchor needs to process a deposit or withdrawal.",
      },
      {
        id: "what-fees-apply",
        question: "What fees apply?",
        answer:
          "Stellar charges a small network fee per operation. Anchors may add their own fees for deposits and withdrawals. Always review the fee breakdown before confirming.",
      },
      {
        id: "why-is-my-payment-pending",
        question: "Why is my payment pending?",
        answer:
          "Payments can be pending while an anchor processes a deposit or while the network is congested. Check the transaction hash in a Stellar explorer and contact the anchor if it remains pending.",
      },
    ],
  },
  {
    id: "withdrawing-funds",
    title: "Withdrawing funds",
    items: [
      {
        id: "withdraw-funds",
        question: "How do I withdraw funds to my bank?",
        answer:
          "To withdraw funds, open the asset in your wallet and choose “Withdraw”. Select a supported anchor, enter the amount, and follow the anchor’s instructions to complete the bank transfer.",
      },
      {
        id: "why-cant-i-withdraw",
        question: "Why can't I withdraw my funds?",
        answer:
          "Withdrawals may be blocked if the anchor does not support your region, if your account lacks trustlines for the asset, or if your account is not fully verified. Contact the anchor for specific requirements.",
      },
    ],
  },
  {
    id: "security",
    title: "Security",
    items: [
      {
        id: "keep-keys-safe",
        question: "How do I keep my keys safe?",
        answer:
          "Never share your secret key or recovery phrase. Store them in a password manager or offline. Be wary of anyone asking for them, including supposed support staff.",
      },
      {
        id: "phishing-scams",
        question: "How do I spot phishing scams?",
        answer:
          "Check the domain carefully, avoid links from unsolicited messages, and never enter your secret key on any website. Legitimate support will never ask for it.",
      },
    ],
  },
];
