"use client";

import { useEffect, useState, useCallback } from "react";
import { ContentCard } from "./ContentCard";
import { GlowButton } from "@/components/ui/GlowButton";
import { useAuthModal } from "@/providers/AuthContext";
import { useScrollReveal } from "@/components/animations/useScrollReveal";
import { useSession } from "@/hooks/useSession";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  deriveAccessReceiptPda,
  deriveContentRecordPda,
  uuidToBytes32,
} from "@/lib/anchor";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface LibraryItem {
  contentId: string;
  title: string;
  description?: string;
  category?: string;
  previewUri: string;
  authorWallet: string;
  basePrice: string;
  paymentToken: "SOL" | "USDC";
  license: string;
  accessMint: string;
  onChainPda?: string;
  status?: string;
  purchasedAt?: string;
}

/**
 * Decentralized library that reads the user's purchased content from two sources:
 *
 * 1. On-chain AccessReceipt PDAs (Phase 4 — primary source of truth)
 *    For each content item from the marketplace, checks if the user has an AccessReceipt PDA.
 *    If yes, adds it to the library. No backend needed.
 *
 * 2. Backend PostgreSQL cache (fallback + legacy purchases)
 *    Fetches purchases from GET /api/v1/content/library/:wallet.
 *    Used as fallback when on-chain check is unavailable, and for legacy content.
 *
 * Both sources are merged, deduplicated by contentId.
 */
export function LibraryClient() {
  const { isAuthenticated, walletAddress, token, mounted } = useSession();
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [source, setSource] = useState<"chain" | "db" | "mixed" | null>(null);
  const { openAuth } = useAuthModal();
  const gridRef = useScrollReveal({ stagger: 0.08, fromY: 30 });

  const loadLibrary = useCallback(async () => {
    if (!walletAddress) return;
    setIsLoading(true);

    const merged = new Map<string, LibraryItem>();

    // ── Source 1: Backend cache (fast, always available) ──────────────────

    if (token) {
      try {
        const res = await fetch(`${API_URL}/api/v1/content/library/${walletAddress}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          const dbItems: LibraryItem[] = data.items ?? [];
          dbItems.forEach((item) => merged.set(item.contentId, item));
          if (dbItems.length > 0) setSource("db");
        }
      } catch {
        // Non-fatal
      }
    }

    // ── Source 2: On-chain AccessReceipt PDAs ─────────────────────────────
    // Only do on-chain check if Wallet Adapter (Phantom/Solflare) is connected,
    // since we need a real PublicKey to derive the PDA.

    if (publicKey && connected) {
      try {
        // Fetch all marketplace content to check against
        const marketRes = await fetch(`${API_URL}/api/v1/marketplace?limit=50`);
        if (marketRes.ok) {
          const marketData = await marketRes.json();
          const allContent: LibraryItem[] = marketData.items ?? [];

          // Batch check AccessReceipt PDAs for all content
          const checkPromises = allContent
            .filter((item) => item.onChainPda && item.onChainPda !== "pending")
            .map(async (item) => {
              try {
                const contentRecordPda = new PublicKey(item.onChainPda!);
                const receiptPda       = deriveAccessReceiptPda(contentRecordPda, publicKey);
                const info             = await connection.getAccountInfo(receiptPda);

                if (info !== null) {
                  return { ...item, status: item.status ?? "active" } as LibraryItem;
                }
              } catch {
                // Skip items with invalid PDAs
              }
              return null;
            });

          const chainItems = (await Promise.all(checkPromises)).filter(
            (item): item is LibraryItem => item !== null
          );

          if (chainItems.length > 0) {
            chainItems.forEach((item) => {
              if (!merged.has(item.contentId)) {
                merged.set(item.contentId, item);
              }
            });
            setSource((prev) => (prev === "db" ? "mixed" : "chain"));
          }
        }
      } catch {
        // On-chain check failed — DB fallback is already loaded
      }
    }

    setItems(Array.from(merged.values()));
    setIsLoading(false);
  }, [walletAddress, token, publicKey, connected, connection]);

  useEffect(() => {
    if (!mounted || !isAuthenticated) return;
    loadLibrary();
  }, [mounted, isAuthenticated, loadLibrary]);

  if (!mounted) return null;

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center gap-6 py-24 text-center">
        <p className="text-[#7A6E8E] text-lg">Connect your wallet to view your library</p>
        <GlowButton variant="primary" size="md" onClick={openAuth}>
          Connect Wallet
        </GlowButton>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card-surface animate-pulse aspect-[3/4] rounded-xl" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center">
        <p className="text-[#7A6E8E] text-lg">Your library is empty</p>
        <p className="text-[#3D2F5A] text-sm">
          Purchase content from the marketplace to see it here
        </p>
        <GlowButton variant="secondary" size="md" onClick={() => (window.location.href = "/")}>
          Browse Marketplace
        </GlowButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {source && (
        <div className="flex items-center gap-2 text-xs text-[#7A6E8E]">
          <span className={`w-2 h-2 rounded-full ${
            source === "chain" || source === "mixed"
              ? "bg-[#81D0B5]"
              : "bg-[#7A6E8E]"
          }`} />
          {source === "chain" && "Library loaded from Solana blockchain"}
          {source === "db"    && "Library loaded from backend cache"}
          {source === "mixed" && "Library: on-chain + cached purchases"}
        </div>
      )}

      <div
        ref={gridRef}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5"
      >
        {items.map((item) => (
          <ContentCard key={item.contentId} {...item} />
        ))}
      </div>
    </div>
  );
}
