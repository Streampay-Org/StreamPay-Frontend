"use client";

import { useState } from "react";
import { WalletBadge, type WalletState } from "../WalletBadge";
import { WalletModal } from "./WalletModal";

type WalletAddressResult = string | { address?: string };

declare global {
  interface Window {
    freighterApi?: {
      getAddress?: () => Promise<WalletAddressResult>;
    };
  }
}

export function WalletConnection() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [state, setState] = useState<WalletState>("disconnected");
  const [address, setAddress] = useState<string | null>(null);
  const [providerName, setProviderName] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();

  const connect = async (providerId: string) => {
    const name = providerId === "freighter" ? "Freighter" : providerId;
    setProviderName(name);
    setState("connecting");
    setErrorMessage(undefined);

    try {
      if (providerId !== "freighter" || !window.freighterApi?.getAddress) {
        throw new Error(`${name} wallet extension is not available.`);
      }

      const result = await window.freighterApi.getAddress();
      const walletAddress =
        typeof result === "string" ? result : result.address;
      if (!walletAddress?.trim()) {
        throw new Error(`${name} did not return a wallet address.`);
      }

      setAddress(walletAddress.trim());
      setState("connected");
    } catch (error) {
      setAddress(null);
      setErrorMessage(
        error instanceof Error ? error.message : "Wallet connection failed.",
      );
      setState("error");
    }
  };

  return (
    <>
      <WalletBadge
        state={state}
        address={address}
        providerName={providerName}
        network={state === "connected" ? "Testnet" : undefined}
        errorMessage={errorMessage}
        onClick={() => setIsModalOpen(true)}
      />
      <WalletModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSelect={(providerId) => void connect(providerId)}
      />
    </>
  );
}
