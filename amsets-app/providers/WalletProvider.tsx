"use client";

import { ReactNode, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

interface Props {
  children: ReactNode;
}

/**
 * Provides Solana wallet connection.
 *
 * We pass an empty explicit wallets array and rely entirely on the
 * Wallet Standard auto-detection (built into @solana/wallet-adapter-react v0.15+).
 * This prevents duplicate keys when a wallet (e.g. MetaMask Snap, Phantom) is
 * registered both via the explicit adapter AND via the Wallet Standard detection.
 *
 * For email/phone/social login, Web3Auth is used separately via useAuth hook.
 */
export function WalletProvider({ children }: Props) {
  // Empty array — all wallets detected via Wallet Standard automatically
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
