"use client";

import { useState } from "react";
import Modal from "./components/Modal";

const walletOptions = ["Freighter", "Albedo", "xbull"];

export default function Home() {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isWalletOpen, setIsWalletOpen] = useState(false);

  return (
    <main className="hero-shell">
      <section className="hero-card">
        <p className="hero-eyebrow">Stellar stream management</p>
        <h1 className="hero-title">StreamPay</h1>
        <p className="hero-subtitle">Payment streaming on Stellar</p>
        <p className="hero-copy">
          Connect your wallet to create, review, and confirm recurring payouts without
          losing context.
        </p>

        <div className="hero-actions">
          <button type="button" className="button button-primary" onClick={() => setIsWalletOpen(true)}>
            Select wallet
          </button>
          <button type="button" className="button button-secondary" onClick={() => setIsConfirmOpen(true)}>
            Open confirmation
          </button>
        </div>
      </section>

      <Modal
        isOpen={isWalletOpen}
        onClose={() => setIsWalletOpen(false)}
        title="Choose a wallet"
        description="Select the wallet provider you want to connect to StreamPay."
      >
        <div className="modal-stack">
          {walletOptions.map((wallet) => (
            <button key={wallet} type="button" className="wallet-option" onClick={() => setIsWalletOpen(false)}>
              {wallet}
            </button>
          ))}
        </div>
      </Modal>

      <Modal
        isOpen={isConfirmOpen}
        onClose={() => setIsConfirmOpen(false)}
        title="Confirm stream cancellation"
        description="This stops future payouts for the selected stream."
        footer={
          <>
            <button type="button" className="button button-secondary" onClick={() => setIsConfirmOpen(false)}>
              Keep stream
            </button>
            <button type="button" className="button button-primary" onClick={() => setIsConfirmOpen(false)}>
              Cancel stream
            </button>
          </>
        }
      >
        <p className="modal-copy">
          The current recipient will keep funds already settled. Only upcoming payments are affected.
        </p>
      </Modal>
    </main>
  );
}
