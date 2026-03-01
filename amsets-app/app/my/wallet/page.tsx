import type { Metadata } from "next";
import WalletCleanupClient from "@/components/wallet/WalletCleanupClient";

export const metadata: Metadata = {
  title: "My Wallet — AMSETS",
  description: "Manage and burn unknown or orphaned tokens in your wallet.",
};

export default function WalletPage() {
  return <WalletCleanupClient />;
}
