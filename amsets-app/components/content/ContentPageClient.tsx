"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import Image from "next/image";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { NeonBadge } from "@/components/ui/NeonBadge";
import { GlowButton } from "@/components/ui/GlowButton";
import { ConfettiCanvas } from "@/components/ui/ConfettiCanvas";
import { ContentViewer } from "@/components/content/ContentViewer";
import { resolveIPFS } from "@/lib/storage";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useAuthModal } from "@/providers/AuthContext";
import { useSession } from "@/hooks/useSession";
import {
  purchaseAccess,
  checkHasPurchased,
  ensureFeeVaultFunded,
  checkTokenBalance,
} from "@/lib/anchor";
import {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface ContentItem {
  contentId: string;
  title: string;
  description?: string;
  previewUri: string;
  storageUri?: string;
  mimeType?: string;
  authorWallet: string;
  basePrice: string;
  paymentToken: "SOL" | "USDC";
  license: string;
  category?: string;
  accessMint: string;
  onChainPda?: string;
  status?: string;
  encryptedKey?: string;
  litConditionsHash?: string;
  totalSupply?: number;
  royaltyBps?: number;
  mintAddress?: string;
  soldCount?: number;
}

interface ContentPageClientProps {
  content: ContentItem;
}

interface ActiveListing {
  id: string;
  contentId: string;
  sellerWallet: string;
  price_lamports: string;
  mintAddress: string;
  tokenAccount?: string;
  status: string;
  createdAt: string;
}

const LICENSE_LABELS: Record<string, string> = {
  personal: "Personal Use",
  commercial: "Commercial Use",
  derivative: "Derivative Works",
  unlimited: "Unlimited Rights",
};

/**
 * Client component for the content page.
 *
 * Access rules:
 *   - Draft + non-author  → "Not available" screen
 *   - Author              → always has access (bypass purchase)
 *   - Purchased           → ContentViewer unlocked
 *   - Neither             → purchase flow (blur preview + buy button)
 */
export function ContentPageClient({ content }: ContentPageClientProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previewRef   = useRef<HTMLDivElement | null>(null);
  const metadataRef  = useRef<HTMLDivElement | null>(null);

  const [isPurchasing, setIsPurchasing]   = useState(false);
  const [purchased,    setPurchased]      = useState(false);
  const [showViewer,   setShowViewer]     = useState(false);
  const [showConfetti, setShowConfetti]   = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchaseTxSig, setPurchaseTxSig] = useState<string | null>(null);
  const [previewImgError, setPreviewImgError] = useState(false);

  // Auto-open sell form when navigated from Library with #sell hash
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#sell") {
      setShowSellForm(true);
      // Smooth scroll to sell section after purchase check settles
      setTimeout(() => {
        const el = document.getElementById("sell-section");
        el?.scrollIntoView({ behavior: "smooth" });
      }, 800);
    }
  }, []);

  // ─── Resale listing state ──────────────────────────────────────────────────
  const [activeListings,    setActiveListings]    = useState<ActiveListing[]>([]);
  const [showSellForm,      setShowSellForm]      = useState(false);
  const [sellPriceSOL,      setSellPriceSOL]      = useState("0.1");
  const [isListing,         setIsListing]         = useState(false);
  const [listingError,      setListingError]      = useState<string | null>(null);
  const [isBuyingResale,    setIsBuyingResale]    = useState<string | null>(null); // listingId
  const [resaleError,       setResaleError]       = useState<string | null>(null);

  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection }  = useConnection();
  const { openAuth }    = useAuthModal();
  const { isAuthenticated, walletAddress, token } = useSession();

  const previewUrl = resolveIPFS(content.previewUri);
  const priceSOL   = (Number(content.basePrice) / 1_000_000_000).toFixed(3);

  // Determine access rights
  const isAuthor  = !!(walletAddress && content.authorWallet &&
    walletAddress.toLowerCase() === content.authorWallet.toLowerCase());
  const hasAccess = isAuthor || purchased;

  // ─── Check on-chain access on mount ──────────────────────────────────────
  // Rule:
  //  - If content has an SPL mint: ONLY the token balance counts (pure on-chain,
  //    survives resale). The AccessReceipt PDA is NOT enough for content with a mint,
  //    because resale buyers also have PDA-equivalent DB records but not PDAs.
  //  - If content has NO SPL mint: fall back to AccessReceipt PDA (legacy content
  //    or content where minting failed).
  //  - Author always has access regardless.
  useEffect(() => {
    if (!publicKey) return;

    const checkAccess = async () => {
      if (content.mintAddress) {
        // Content has a mint → SPL token balance is the ONLY valid proof
        // (This includes author token minted by backend at publish time)
        const bal = await checkTokenBalance(connection, content.mintAddress, publicKey).catch(() => 0);
        if (bal > 0) { setPurchased(true); return; }
        // No token found — do NOT fall back to PDA (would allow ex-sellers to retain access)
      } else {
        // No mint configured → use AccessReceipt PDA as fallback proof
        if (content.onChainPda && content.onChainPda !== "pending") {
          const has = await checkHasPurchased(
            connection, new PublicKey(content.onChainPda), publicKey
          ).catch(() => false);
          if (has) setPurchased(true);
        }
      }
    };

    checkAccess();
  }, [publicKey, content.onChainPda, content.mintAddress, connection]);

  // ─── Fetch active listings ────────────────────────────────────────────────
  const fetchListings = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/listings/${content.contentId}`);
      if (res.ok) {
        const data = await res.json();
        setActiveListings(data.listings ?? []);
      }
    } catch { /* non-fatal */ }
  }, [content.contentId]);

  useEffect(() => { fetchListings(); }, [fetchListings]);

  // ─── Create sell listing ──────────────────────────────────────────────────
  const handleCreateListing = useCallback(async () => {
    if (!publicKey || !token) return;
    setIsListing(true);
    setListingError(null);
    try {
      const priceLamports = Math.round(parseFloat(sellPriceSOL) * LAMPORTS_PER_SOL);
      if (isNaN(priceLamports) || priceLamports <= 0) throw new Error("Invalid price");

      // ATA is optional — only computed when the SPL mint exists
      let tokenAccount: string | undefined;
      if (content.mintAddress) {
        const sellerAta = getAssociatedTokenAddressSync(
          new PublicKey(content.mintAddress),
          publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        );
        tokenAccount = sellerAta.toBase58();
      }

      const res = await fetch(`${API_URL}/api/v1/listings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          content_id:     content.contentId,
          price_lamports: priceLamports,
          mint_address:   content.mintAddress,  // may be absent
          token_account:  tokenAccount,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? `HTTP ${res.status}`);
      }
      setShowSellForm(false);
      await fetchListings();
    } catch (err: any) {
      setListingError(err?.message ?? "Failed to create listing");
    } finally {
      setIsListing(false);
    }
  }, [publicKey, token, content, sellPriceSOL, fetchListings]);

  // ─── Buy from resale listing ──────────────────────────────────────────────
  const handleBuyResale = useCallback(async (listing: ActiveListing) => {
    if (!isAuthenticated) { openAuth(); return; }
    if (!connected || !publicKey || !sendTransaction) {
      setResaleError("Connect Phantom or Solflare wallet to purchase.");
      return;
    }

    setIsBuyingResale(listing.id);
    setResaleError(null);

    try {
      const sellerPubkey  = new PublicKey(listing.sellerWallet);
      const totalPrice    = BigInt(listing.price_lamports);

      // Royalty split: author receives royaltyBps/10000 of the price
      const royaltyBps    = BigInt(content.royaltyBps ?? 0);
      const royaltyAmount = royaltyBps > 0n
        ? (totalPrice * royaltyBps) / 10000n
        : 0n;
      const sellerAmount  = totalPrice - royaltyAmount;

      const { blockhash } = await connection.getLatestBlockhash();
      const tx = new Transaction();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      // SOL to seller (minus author royalty)
      tx.add(SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey:   sellerPubkey,
        lamports:   sellerAmount,
      }));

      // Royalty to author (if any)
      if (royaltyAmount > 0n && content.authorWallet) {
        tx.add(SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey:   new PublicKey(content.authorWallet),
          lamports:   royaltyAmount,
        }));
      }

      const signature = await sendTransaction(tx, connection);
      await connection.confirmTransaction(signature, "confirmed");

      // Record access in DB (for Library + access gate)
      await fetch(`${API_URL}/api/v1/purchases`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          content_id:     content.contentId,
          tx_signature:   signature,
          price_lamports: listing.price_lamports,
        }),
      }).catch(() => null);

      // Mark listing as sold in backend
      await fetch(`${API_URL}/api/v1/listings/${listing.id}/sold`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tx_signature: signature }),
      }).catch(() => null);

      setPurchased(true);
      setShowConfetti(true);
      await fetchListings();
    } catch (err: any) {
      setResaleError(err?.message?.slice(0, 200) ?? "Resale purchase failed");
    } finally {
      setIsBuyingResale(null);
    }
  }, [
    isAuthenticated, connected, publicKey, sendTransaction, connection,
    content, token, openAuth, fetchListings,
  ]);

  // ─── Cancel own listing ───────────────────────────────────────────────────
  const handleCancelListing = useCallback(async (listingId: string) => {
    if (!token) return;
    try {
      await fetch(`${API_URL}/api/v1/listings/${listingId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await fetchListings();
    } catch { /* non-fatal */ }
  }, [token, fetchListings]);

  // ─── GSAP animations ─────────────────────────────────────────────────────
  useGSAP(
    () => {
      if (previewRef.current) {
        gsap.fromTo(
          previewRef.current,
          { filter: "blur(10px)", scale: 1.05, opacity: 0 },
          { filter: "blur(0px)", scale: 1, opacity: 1, duration: 0.8, ease: "power2.out" }
        );
      }
      if (metadataRef.current) {
        gsap.fromTo(
          Array.from(metadataRef.current.children),
          { opacity: 0, y: 20 },
          { opacity: 1, y: 0, duration: 0.5, stagger: 0.1, ease: "power2.out", delay: 0.3 }
        );
      }
    },
    { scope: containerRef }
  );

  // ─── Purchase handler ─────────────────────────────────────────────────────
  const handlePurchase = useCallback(async () => {
    if (!isAuthenticated) { openAuth(); return; }

    if (!connected || !publicKey) {
      setPurchaseError(
        "On-chain purchase requires Phantom or Solflare wallet. " +
        "Please connect via the wallet button."
      );
      return;
    }

    if (!content.onChainPda || content.onChainPda === "pending") {
      setPurchaseError(
        "This content has not been published on-chain yet. " +
        "The author needs to complete the deployment first."
      );
      return;
    }

    setIsPurchasing(true);
    setPurchaseError(null);

    try {
      const contentRecordPda = new PublicKey(content.onChainPda);

      const alreadyPurchased = await checkHasPurchased(connection, contentRecordPda, publicKey);
      if (alreadyPurchased) {
        setPurchased(true);
        setShowConfetti(true);
        return;
      }

      try {
        await ensureFeeVaultFunded(publicKey, sendTransaction, connection);
      } catch { /* Non-fatal — vault may already exist */ }

      const { signature, receiptPda } = await purchaseAccess(
        { contentRecordPda: content.onChainPda, authorWallet: content.authorWallet },
        publicKey,
        sendTransaction,
        connection
      );

      setPurchaseTxSig(signature);

      if (token) {
        await fetch(`${API_URL}/api/v1/purchases`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            content_id:    content.contentId,
            tx_signature:  signature,
            receipt_pda:   receiptPda,
            amount_paid:   content.basePrice,
            payment_token: content.paymentToken,
            access_mint:   content.mintAddress ?? content.accessMint,
          }),
        }).catch(() => null);
      }

      setPurchased(true);
      setShowConfetti(true);
    } catch (err: any) {
      const msg = err?.message?.includes("0x1")
        ? "Insufficient SOL balance for purchase + fees"
        : err?.message?.slice(0, 200) ?? "Purchase failed";
      setPurchaseError(msg);
    } finally {
      setIsPurchasing(false);
    }
  }, [
    isAuthenticated, connected, publicKey, content,
    connection, sendTransaction, openAuth, token,
  ]);

  // ─── Draft guard for non-authors ──────────────────────────────────────────
  if (content.status === "draft" && !isAuthor) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-6 px-6">
        <div className="text-center max-w-md">
          <div className="text-5xl mb-4 opacity-40">🔒</div>
          <h1 className="text-2xl font-bold text-[#EDE8F5] mb-2">Content Not Available</h1>
          <p className="text-[#7A6E8E]">
            This content is still in draft mode and has not been published yet.
            Check back later when the author has published it.
          </p>
          <div className="mt-6">
            <GlowButton variant="ghost" size="md" onClick={() => window.location.href = "/"}>
              ← Back to Marketplace
            </GlowButton>
          </div>
        </div>
      </main>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <main ref={containerRef} className="min-h-screen max-w-6xl mx-auto px-6 pt-28 pb-16">

      {/* ── Content Viewer (unlocked) ─────────────────────────────────────── */}
      {(hasAccess || showViewer) && content.storageUri && (
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-4">
            <NeonBadge variant="secondary">
              {isAuthor ? "Author Preview" : "Your Content"}
            </NeonBadge>
            {isAuthor && (
              <span className="text-[#7A6E8E] text-sm">
                You are the author of this content
              </span>
            )}
          </div>
          <ContentViewer
            contentId={content.contentId}
            storageUri={content.storageUri}
            accessMint={content.mintAddress ?? content.accessMint}
            mimeType={content.mimeType ?? "application/octet-stream"}
            encryptedKey={content.encryptedKey}
            litConditionsHash={content.litConditionsHash}
            isAuthor={isAuthor}
          />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
        {/* ── Preview image ─────────────────────────────────────────────── */}
        <div
          ref={previewRef}
          className="relative aspect-square rounded-2xl overflow-hidden bg-[#221533] will-animate"
        >
          {!previewImgError ? (
            <Image
              src={previewUrl}
              alt={content.title}
              fill
              className={`object-cover transition-all duration-500 ${hasAccess ? "" : "blur-sm scale-105"}`}
              unoptimized
              onError={() => setPreviewImgError(true)}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-[#2D1F47] to-[#1A0D2E]">
              <span className="text-5xl opacity-40">🔐</span>
            </div>
          )}

          {/* Blur overlay for non-buyers */}
          {!hasAccess && (
            <div className="absolute inset-0 bg-[#0D0A14]/60 flex items-center justify-center">
              <div className="text-center px-4">
                <div className="text-3xl mb-2">🔐</div>
                <p className="text-[#EDE8F5] text-sm font-medium">Purchase to unlock</p>
              </div>
            </div>
          )}

          {!hasAccess && (
            <div className="absolute inset-0 flex items-end justify-center pb-6">
              <NeonBadge variant="muted">Preview — purchase to unlock full content</NeonBadge>
            </div>
          )}

          {content.status && (
            <div className="absolute top-3 left-3">
              {content.status === "draft" ? (
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-amber-400/20 text-amber-300 border border-amber-400/30">
                  Draft
                </span>
              ) : (
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-500/20 text-green-300 border border-green-500/30">
                  Published
                </span>
              )}
            </div>
          )}
        </div>

        {/* ── Metadata + Purchase / Access ─────────────────────────────── */}
        <div ref={metadataRef} className="flex flex-col gap-5">
          {content.category && (
            <NeonBadge variant="muted" className="self-start">{content.category}</NeonBadge>
          )}

          <h1 className="text-3xl md:text-4xl font-bold text-[#EDE8F5] leading-tight">
            {content.title}
          </h1>

          <div className="flex items-center gap-2">
            <span className="text-[#7A6E8E] text-sm">By</span>
            <span className="text-[#81D0B5] text-sm font-mono">
              {content.authorWallet.slice(0, 8)}…{content.authorWallet.slice(-6)}
            </span>
          </div>

          {content.description && (
            <p className="text-[#7A6E8E] text-base leading-relaxed">{content.description}</p>
          )}

          <div className="flex items-center gap-3 p-4 rounded-xl bg-[#221533] border border-[#3D2F5A]">
            <span className="text-[#7A6E8E] text-sm">License:</span>
            <NeonBadge variant="secondary">
              {LICENSE_LABELS[content.license] ?? content.license}
            </NeonBadge>
          </div>

          {/* Supply info */}
          {content.totalSupply && content.totalSupply > 1 && (
            <div className="flex items-center gap-4 p-3 rounded-xl bg-[#221533] border border-[#3D2F5A] text-sm">
              <div>
                <span className="text-[#7A6E8E]">Available: </span>
                <span className="text-[#EDE8F5] font-bold">
                  {(content.totalSupply - (content.soldCount ?? 0))} / {content.totalSupply}
                </span>
              </div>
              {content.royaltyBps !== undefined && (
                <div>
                  <span className="text-[#7A6E8E]">Royalty: </span>
                  <span className="text-[#F7FF88] font-bold">{(content.royaltyBps / 100).toFixed(1)}%</span>
                </div>
              )}
            </div>
          )}

          {/* Price + actions box */}
          <div className="flex flex-col gap-4 p-6 rounded-2xl bg-[#221533] border border-[#3D2F5A]">
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-black text-[#F7FF88]">◎ {priceSOL}</span>
              <span className="text-[#7A6E8E]">SOL</span>
            </div>

            <ul className="flex flex-col gap-2 text-sm text-[#7A6E8E]">
              <li className="flex items-center gap-2">
                <span className="text-[#81D0B5]">✓</span> Permanent on-chain AccessReceipt
              </li>
              <li className="flex items-center gap-2">
                <span className="text-[#81D0B5]">✓</span> End-to-end encrypted delivery
              </li>
              <li className="flex items-center gap-2">
                <span className="text-[#81D0B5]">✓</span> Verified on Solana blockchain
              </li>
              {content.royaltyBps !== undefined && content.royaltyBps > 0 && (
                <li className="flex items-center gap-2">
                  <span className="text-[#81D0B5]">✓</span> Resellable — author earns {(content.royaltyBps / 100).toFixed(1)}% royalty
                </li>
              )}
            </ul>

            {purchaseError && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                <p className="text-red-400 text-sm">{purchaseError}</p>
              </div>
            )}

            {content.onChainPda === "pending" && !isAuthor && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <p className="text-amber-300 text-sm">
                  This content is a draft and not yet available for purchase.
                </p>
              </div>
            )}

            {/* Author: always has access */}
            {isAuthor ? (
              <div className="flex flex-col gap-3">
                <NeonBadge variant="secondary" className="self-start text-sm">
                  ✓ Author — Full Access
                </NeonBadge>
                {content.storageUri && (
                  <GlowButton
                    variant="secondary"
                    size="md"
                    onClick={() => setShowViewer(true)}
                  >
                    View Your Content ↑
                  </GlowButton>
                )}
              </div>
            ) : purchased ? (
              <div className="flex flex-col gap-3">
                <NeonBadge variant="secondary" className="self-start text-sm">
                  ✓ Access Granted — AccessReceipt on Solana
                </NeonBadge>
                {purchaseTxSig && (
                  <a
                    href={`https://solscan.io/tx/${purchaseTxSig}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-[#81D0B5] underline font-mono"
                  >
                    View tx: {purchaseTxSig.slice(0, 12)}…
                  </a>
                )}
                {content.storageUri && (
                  <GlowButton
                    variant="secondary"
                    size="md"
                    onClick={() => setShowViewer(true)}
                  >
                    View Content ↑
                  </GlowButton>
                )}
              </div>
            ) : (
              <GlowButton
                variant="primary"
                size="lg"
                isLoading={isPurchasing}
                onClick={handlePurchase}
                className="w-full"
                disabled={content.onChainPda === "pending"}
              >
                {!isAuthenticated
                  ? "Connect Wallet to Purchase"
                  : !connected
                  ? "Connect Phantom/Solflare to Purchase"
                  : isPurchasing
                  ? "Confirming on Solana…"
                  : `Buy Access — ◎ ${priceSOL} SOL`}
              </GlowButton>
            )}
          </div>

          {/* ── Sell My Access (purchased non-authors only) ──────────────── */}
          {purchased && !isAuthor && (
            <div id="sell-section" className="flex flex-col gap-3 mt-2">
              {!showSellForm ? (
                <GlowButton variant="ghost" size="sm" onClick={() => setShowSellForm(true)}>
                  List My Access Token for Sale
                </GlowButton>
              ) : (
                <div className="flex flex-col gap-3 p-4 rounded-xl bg-[#221533] border border-[#3D2F5A]">
                  <p className="text-[#EDE8F5] text-sm font-semibold">Set your listing price</p>
                  {content.royaltyBps !== undefined && content.royaltyBps > 0 && (
                    <p className="text-[#7A6E8E] text-xs">
                      Author royalty: {(content.royaltyBps / 100).toFixed(1)}% is deducted from
                      each sale and sent automatically.
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0.001"
                      step="0.001"
                      value={sellPriceSOL}
                      onChange={(e) => setSellPriceSOL(e.target.value)}
                      className="flex-1 bg-[#0D0A14] border border-[#3D2F5A] rounded-lg px-3 py-2 text-[#EDE8F5] text-sm focus:outline-none focus:border-[#81D0B5]"
                      placeholder="0.1"
                    />
                    <span className="text-[#7A6E8E] text-sm">SOL</span>
                  </div>
                  {listingError && (
                    <p className="text-red-400 text-xs">{listingError}</p>
                  )}
                  <div className="flex gap-2">
                    <GlowButton variant="primary" size="sm" isLoading={isListing} onClick={handleCreateListing}>
                      Confirm Listing
                    </GlowButton>
                    <GlowButton variant="ghost" size="sm" onClick={() => setShowSellForm(false)}>
                      Cancel
                    </GlowButton>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Secondary Market Listings (visible to everyone) ──────────── */}
          {activeListings.length > 0 && (
            <div className="flex flex-col gap-3 mt-2">
              <p className="text-[#7A6E8E] text-xs font-semibold uppercase tracking-wide">
                Resale Market
              </p>
              {resaleError && (
                <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/30">
                  <p className="text-red-400 text-xs">{resaleError}</p>
                </div>
              )}
              {activeListings.map((listing) => {
                const isOwnListing = walletAddress?.toLowerCase() === listing.sellerWallet.toLowerCase();
                const priceDisplay = (Number(listing.price_lamports) / LAMPORTS_PER_SOL).toFixed(3);
                const royaltyPct   = ((content.royaltyBps ?? 0) / 100).toFixed(1);
                return (
                  <div
                    key={listing.id}
                    className="flex items-center justify-between gap-3 p-3 rounded-xl bg-[#0D0A14] border border-[#3D2F5A]"
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[#F7FF88] text-sm font-bold">◎ {priceDisplay} SOL</span>
                      <span className="text-[#7A6E8E] text-xs font-mono">
                        {listing.sellerWallet.slice(0, 8)}…{listing.sellerWallet.slice(-4)}
                      </span>
                      {(content.royaltyBps ?? 0) > 0 && (
                        <span className="text-[#81D0B5] text-xs">
                          incl. {royaltyPct}% royalty to author
                        </span>
                      )}
                    </div>
                    {isOwnListing ? (
                      <GlowButton variant="ghost" size="sm" onClick={() => handleCancelListing(listing.id)}>
                        Cancel
                      </GlowButton>
                    ) : purchased || isAuthor ? (
                      <span className="text-[#81D0B5] text-xs">You own access</span>
                    ) : (
                      <GlowButton
                        variant="primary"
                        size="sm"
                        isLoading={isBuyingResale === listing.id}
                        onClick={() => handleBuyResale(listing)}
                      >
                        Buy
                      </GlowButton>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="text-xs text-[#3D2F5A] font-mono break-all">
            <p>Content ID: {content.contentId}</p>
            {content.onChainPda && content.onChainPda !== "pending" && (
              <p>On-chain PDA:{" "}
                <a
                  href={`https://solscan.io/account/${content.onChainPda}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#81D0B5] underline"
                >
                  {content.onChainPda.slice(0, 16)}…
                </a>
              </p>
            )}
            {content.mintAddress && (
              <p>Token Mint:{" "}
                <a
                  href={`https://solscan.io/token/${content.mintAddress}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#81D0B5] underline"
                >
                  {content.mintAddress.slice(0, 16)}…
                </a>
              </p>
            )}
          </div>
        </div>
      </div>

      <ConfettiCanvas trigger={showConfetti} onComplete={() => setShowConfetti(false)} />
    </main>
  );
}
