"use client";

import { useState, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";

export interface SessionState {
  /** True when the user is authenticated via ANY method */
  isAuthenticated: boolean;
  /** Wallet address string from either Wallet Adapter or Web3Auth */
  walletAddress: string | null;
  /** PublicKey object — only available for Wallet Adapter (Phantom/Solflare) sessions */
  publicKey: PublicKey | null;
  /** JWT token stored in localStorage after login */
  token: string | null;
  /** True only when rendering on the client (avoids SSR hydration mismatches) */
  mounted: boolean;
}

/**
 * Unified session hook that covers BOTH authentication methods:
 *   1. Wallet Adapter (Phantom / Solflare) — via useWallet()
 *   2. Web3Auth  (email / phone / Google / Apple) — via localStorage
 *
 * Use this instead of useWallet() whenever you only need to know:
 * - Is the user authenticated?
 * - What is their wallet address?
 * - What JWT token should I send to the API?
 *
 * For signing Solana transactions use publicKey + signMessage from useWallet()
 * directly (Web3Auth users can't sign through the Wallet Adapter without a plugin).
 *
 * The hook also subscribes to the "amsets_session_changed" custom event that
 * useAuth dispatches on login/logout, so all components update in sync.
 */
export function useSession(): SessionState {
  const { publicKey, connected } = useWallet();

  const [web3authAddress, setWeb3authAddress] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);

    const sync = () => {
      setWeb3authAddress(localStorage.getItem("amsets_wallet"));
      setToken(localStorage.getItem("amsets_token"));
    };

    sync(); // read immediately on mount
    window.addEventListener("amsets_session_changed", sync);
    return () => window.removeEventListener("amsets_session_changed", sync);
  }, []);

  // Before mount: return safe empty state (prevents SSR hydration mismatches)
  if (!mounted) {
    return {
      isAuthenticated: false,
      walletAddress: null,
      publicKey: null,
      token: null,
      mounted: false,
    };
  }

  const walletAddress = publicKey?.toBase58() ?? web3authAddress;
  const isAuthenticated = connected || !!web3authAddress;

  return {
    isAuthenticated,
    walletAddress,
    publicKey: publicKey ?? null,
    token: token ?? localStorage.getItem("amsets_token"),
    mounted: true,
  };
}
