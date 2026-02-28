"use client";

import { ReactNode } from "react";
import { SmoothScrollProvider } from "./SmoothScrollProvider";
import { WalletProvider } from "./WalletProvider";
import { AuthProvider } from "./AuthContext";

interface Props {
  children: ReactNode;
}

/**
 * Root providers wrapper — order matters:
 * SmoothScroll → Wallet → Auth (AuthModal lives here) → children
 */
export function Providers({ children }: Props) {
  return (
    <SmoothScrollProvider>
      <WalletProvider>
        <AuthProvider>{children}</AuthProvider>
      </WalletProvider>
    </SmoothScrollProvider>
  );
}
