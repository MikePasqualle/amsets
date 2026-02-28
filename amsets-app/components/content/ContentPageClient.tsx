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
  deriveFeeVaultPda,
  deriveContentRecordPda,
  uuidToBytes32,
} from "@/lib/anchor";

/** Platform fee on all sales (primary + secondary): 2.5% = 250 bps */
const PLATFORM_FEE_BPS = 250n;

/** Format SOL amounts with appropriate decimal places (avoids "0.0000") */
function fmtSOL(amount: number): string {
  if (amount === 0) return "0";
  if (amount < 0.000001) return "< 0.000001";
  if (amount < 0.001) return amount.toFixed(6);
  if (amount < 0.01)  return amount.toFixed(5);
  return amount.toFixed(4);
}
import {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createApproveInstruction,
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

  // All addresses for this user (Web3Auth + Phantom both checked)
  const myAddresses = [walletAddress, publicKey?.toBase58()]
    .filter(Boolean)
    .map((a) => a!.toLowerCase());

  // Determine access rights
  const isAuthor  = !!(content.authorWallet &&
    myAddresses.includes(content.authorWallet.toLowerCase()));
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
      // Step 1: check SPL token balance (primary proof, enables resale revocation)
      if (content.mintAddress) {
        const bal = await checkTokenBalance(connection, content.mintAddress, publicKey).catch(() => 0);
        if (bal > 0) {
          // Step 1b: if the user has a token BUT sold their listing, revoke access.
          // This handles legacy mints where we couldn't burn the seller's token on-chain.
          try {
            const soldRes = await fetch(
              `${API_URL}/api/v1/listings/check-sold/${content.contentId}?wallet=${publicKey.toBase58()}`
            );
            if (soldRes.ok) {
              const { sold } = await soldRes.json();
              if (sold) return; // sold their listing → no access even if token still in wallet
            }
          } catch { /* non-fatal — if check fails, grant access */ }
          setPurchased(true);
          return;
        }
      }

      // Step 2: fallback to AccessReceipt PDA (covers buyers before token was minted,
      // or when mint authority had no SOL to execute the mint)
      try {
        let pdaPubkey: PublicKey;
        if (content.onChainPda && content.onChainPda !== "pending") {
          pdaPubkey = new PublicKey(content.onChainPda);
        } else {
          const authorPubkey   = new PublicKey(content.authorWallet);
          const contentIdBytes = uuidToBytes32(content.contentId);
          pdaPubkey            = deriveContentRecordPda(authorPubkey, contentIdBytes);
        }
        const has = await checkHasPurchased(connection, pdaPubkey, publicKey).catch(() => false);
        if (has) setPurchased(true);
      } catch { /* ignore */ }
    };

    checkAccess();
  }, [publicKey, content.onChainPda, content.mintAddress, content.authorWallet, content.contentId, connection]);

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
    if (!publicKey || !token || !sendTransaction) return;
    setIsListing(true);
    setListingError(null);
    try {
      const priceLamports = Math.round(parseFloat(sellPriceSOL) * LAMPORTS_PER_SOL);
      if (isNaN(priceLamports) || priceLamports <= 0) throw new Error("Invalid price");

      let tokenAccount: string | undefined;

      // Grant backend delegate permission to transfer exactly 1 token on sale.
      // This allows a true seller→buyer transfer without the seller being online at purchase time.
      if (content.mintAddress) {
        const mintPubkey = new PublicKey(content.mintAddress);
        const sellerAta  = getAssociatedTokenAddressSync(
          mintPubkey,
          publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        );
        tokenAccount = sellerAta.toBase58();

        const backendAuthority = process.env.NEXT_PUBLIC_MINT_AUTHORITY_PUBKEY;
        if (backendAuthority) {
          try {
            const approveTx = new Transaction().add(
              createApproveInstruction(
                sellerAta,
                new PublicKey(backendAuthority),
                publicKey,
                1n,
                [],
                TOKEN_2022_PROGRAM_ID
              )
            );
            const { blockhash } = await connection.getLatestBlockhash("confirmed");
            approveTx.recentBlockhash = blockhash;
            approveTx.feePayer = publicKey;
            const approveSig = await sendTransaction(approveTx, connection);
            await connection.confirmTransaction(approveSig, "confirmed");
            console.log("[listing] Approved backend as delegate for token transfer");
          } catch (approveErr: any) {
            // Non-fatal — listing will still be created, but transfer may be less clean
            console.warn("[listing] Approve tx failed:", approveErr?.message);
          }
        }
      }

      const payload = {
        content_id:     content.contentId,
        price_lamports: priceLamports,
        mint_address:   content.mintAddress ?? undefined,
        token_account:  tokenAccount,
      };

      let res = await fetch(`${API_URL}/api/v1/listings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });

      // If duplicate active listing exists (409), cancel it then retry once
      if (res.status === 409) {
        await fetchListings(); // refresh to find the existing listing ID
        const myListing = activeListings.find(
          (l) => myAddresses.includes(l.sellerWallet.toLowerCase())
        );
        if (myListing) {
          await fetch(`${API_URL}/api/v1/listings/${myListing.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          });
        }
        // Retry creation
        res = await fetch(`${API_URL}/api/v1/listings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
      }

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
  }, [publicKey, token, content, sellPriceSOL, fetchListings, activeListings]);

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

      // ── Fee distribution (same model as primary sale) ──────────────────
      // Platform fee : 2.5%  → FeeVault PDA (same vault as primary sales)
      // Author royalty: royaltyBps/10000 → author wallet
      // Seller receives: remainder
      const royaltyBps    = BigInt(content.royaltyBps ?? 0);
      const platformFee   = (totalPrice * PLATFORM_FEE_BPS) / 10000n;
      const royaltyAmount = royaltyBps > 0n
        ? (totalPrice * royaltyBps) / 10000n
        : 0n;
      const sellerAmount  = totalPrice - platformFee - royaltyAmount;

      if (sellerAmount <= 0n) {
        throw new Error("Price too low to cover platform fee + royalty. Set a higher price.");
      }

      const feeVaultPda = deriveFeeVaultPda();

      const { blockhash } = await connection.getLatestBlockhash();
      const tx = new Transaction();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      // Solana rejects 0-lamport transfers — only add each leg if > 0.
      // 1. Platform fee (2.5%) → FeeVault PDA
      if (platformFee > 0n) {
        tx.add(SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey:   feeVaultPda,
          lamports:   platformFee,
        }));
      }

      // 2. Author royalty → author wallet (if any)
      if (royaltyAmount > 0n && content.authorWallet) {
        tx.add(SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey:   new PublicKey(content.authorWallet),
          lamports:   royaltyAmount,
        }));
      }

      // 3. Remaining → seller
      if (sellerAmount > 0n) {
        tx.add(SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey:   sellerPubkey,
          lamports:   sellerAmount,
        }));
      }

      const signature = await sendTransaction(tx, connection);
      await connection.confirmTransaction(signature, "confirmed");

      // Backend executes the token transfer seller→buyer (PermanentDelegate or legacy mint)
      // and records the purchase + marks listing sold atomically.
      const fulfillRes = await fetch(`${API_URL}/api/v1/listings/${listing.id}/fulfill`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          buyer_wallet:  publicKey.toBase58(),
          tx_signature:  signature,
          amount_paid:   listing.price_lamports,
        }),
      });

      if (!fulfillRes.ok) {
        const errData = await fulfillRes.json().catch(() => ({}));
        throw new Error((errData as any).error ?? `Fulfill failed (${fulfillRes.status})`);
      }

      setPurchased(true);
      setShowConfetti(true);
      await fetchListings();
      // Refresh access check after token transfer
      setTimeout(() => window.location.reload(), 2000);
    } catch (err: any) {
      // Normalise the error to a human-readable string regardless of the
      // shape thrown by the Wallet Adapter / web3.js / anchor.
      let msg: string;
      if (typeof err?.message === "string" && err.message.length > 0) {
        msg = err.message;
      } else if (typeof err === "string") {
        msg = err;
      } else {
        try { msg = JSON.stringify(err); } catch { msg = "Resale purchase failed"; }
      }
      setResaleError(msg.slice(0, 300));
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

    if (content.status === "draft") {
      setPurchaseError("This content is a draft and not yet available for purchase.");
      return;
    }

    setIsPurchasing(true);
    setPurchaseError(null);

    try {
      // Use stored PDA if available, otherwise derive it from content ID + author
      let contentRecordPda: PublicKey;
      if (content.onChainPda && content.onChainPda !== "pending") {
        contentRecordPda = new PublicKey(content.onChainPda);
      } else {
        const authorPubkey   = new PublicKey(content.authorWallet);
        const contentIdBytes = uuidToBytes32(content.contentId);
        contentRecordPda     = deriveContentRecordPda(authorPubkey, contentIdBytes);
      }

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
        { contentRecordPda: contentRecordPda.toBase58(), authorWallet: content.authorWallet },
        publicKey,
        sendTransaction,
        connection
      );

      setPurchaseTxSig(signature);

      if (token) {
        // Only send access_mint if it's a real Solana public key (not "pending" or null)
        const rawMint = content.mintAddress ?? content.accessMint;
        const validMint = rawMint && rawMint !== "pending" && rawMint.length >= 32 ? rawMint : undefined;

        await fetch(`${API_URL}/api/v1/purchases`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            content_id:    content.contentId,
            tx_signature:  signature,
            receipt_pda:   receiptPda,
            amount_paid:   content.basePrice,
            payment_token: content.paymentToken,
            ...(validMint ? { access_mint: validMint } : {}),
          }),
        }).catch(() => null);
      }

      setPurchased(true);
      setShowConfetti(true);
      // Reload to show updated available count
      setTimeout(() => window.location.reload(), 2000);
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
                  {Math.max(0, content.totalSupply - (content.soldCount ?? 0))} / {content.totalSupply}
                </span>
              </div>
              <div>
                <span className="text-[#7A6E8E]">Sold: </span>
                <span className="text-[#EDE8F5] font-bold">{content.soldCount ?? 0}</span>
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

            {/* Fee breakdown for primary sale */}
            <div className="flex flex-col gap-1 p-3 rounded-xl bg-[#0D0A14] border border-[#3D2F5A] text-xs">
              <p className="text-[#7A6E8E] font-semibold uppercase tracking-wide mb-1">Fee breakdown</p>
              <div className="flex justify-between">
                <span className="text-[#7A6E8E]">Author receives</span>
                <span className="text-[#81D0B5] font-mono">
                  {fmtSOL((Number(content.basePrice) / 1e9) * (1 - 0.025))} SOL (97.5%)
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#7A6E8E]">Platform fee</span>
                <span className="text-[#F7FF88] font-mono">
                  {fmtSOL((Number(content.basePrice) / 1e9) * 0.025)} SOL (2.5%)
                </span>
              </div>
            </div>

            <ul className="flex flex-col gap-2 text-sm text-[#7A6E8E]">
              <li className="flex items-center gap-2">
                <span className="text-[#81D0B5]">✓</span> Access token minted to your wallet
              </li>
              <li className="flex items-center gap-2">
                <span className="text-[#81D0B5]">✓</span> End-to-end encrypted delivery
              </li>
              <li className="flex items-center gap-2">
                <span className="text-[#81D0B5]">✓</span> Verified on Solana blockchain
              </li>
              {content.royaltyBps !== undefined && content.royaltyBps > 0 && (
                <li className="flex items-center gap-2">
                  <span className="text-[#81D0B5]">✓</span> Resellable — author earns {(content.royaltyBps / 100).toFixed(1)}% on every transfer
                </li>
              )}
            </ul>

            {purchaseError && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                <p className="text-red-400 text-sm">{purchaseError}</p>
              </div>
            )}

            {content.status === "draft" && !isAuthor && (
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
                disabled={content.status === "draft"}
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
                  {/* Live seller payout preview */}
                  {parseFloat(sellPriceSOL) > 0 && (
                    <div className="flex flex-col gap-1 p-2 rounded-lg bg-[#0D0A14] border border-[#3D2F5A] text-xs">
                      <p className="text-[#7A6E8E] font-semibold mb-0.5">You will receive:</p>
                      {(() => {
                        const p = parseFloat(sellPriceSOL) || 0;
                        const royBps = content.royaltyBps ?? 0;
                        const platformCut = p * 0.025;
                        const royaltyCut  = p * (royBps / 10000);
                        const sellerGets  = p - platformCut - royaltyCut;
                        return (
                          <>
                            <div className="flex justify-between">
                              <span className="text-[#7A6E8E]">Platform fee (2.5%)</span>
                              <span className="text-[#F7FF88] font-mono">− ◎ {fmtSOL(platformCut)}</span>
                            </div>
                            {royBps > 0 && (
                              <div className="flex justify-between">
                                <span className="text-[#7A6E8E]">Author royalty ({(royBps / 100).toFixed(1)}%)</span>
                                <span className="text-[#81D0B5] font-mono">− ◎ {fmtSOL(royaltyCut)}</span>
                              </div>
                            )}
                            <div className="flex justify-between border-t border-[#3D2F5A] pt-1 mt-1">
                              <span className="text-[#EDE8F5] font-semibold">You get</span>
                              <span className="text-[#F7FF88] font-mono font-bold">◎ {fmtSOL(sellerGets)}</span>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  )}
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
                const isOwnListing  = myAddresses.includes(listing.sellerWallet.toLowerCase());
                const priceSOLNum   = Number(listing.price_lamports) / LAMPORTS_PER_SOL;
                const priceDisplay  = priceSOLNum.toFixed(3);
                const royaltyBpNum  = content.royaltyBps ?? 0;
                const platformFeeAmt = priceSOLNum * 0.025;
                const royaltyAmt    = priceSOLNum * (royaltyBpNum / 10000);
                const sellerAmt     = priceSOLNum - platformFeeAmt - royaltyAmt;
                return (
                  <div
                    key={listing.id}
                    className="flex flex-col gap-2 p-3 rounded-xl bg-[#0D0A14] border border-[#3D2F5A]"
                  >
                    {/* Price header */}
                    <div className="flex items-center justify-between">
                      <span className="text-[#F7FF88] text-sm font-bold">◎ {priceDisplay} SOL</span>
                      <span className="text-[#7A6E8E] text-xs font-mono">
                        {listing.sellerWallet.slice(0, 8)}…{listing.sellerWallet.slice(-4)}
                      </span>
                    </div>
                    {/* Fee breakdown */}
                    <div className="flex flex-col gap-0.5 text-xs border-t border-[#3D2F5A] pt-2">
                      <div className="flex justify-between">
                        <span className="text-[#7A6E8E]">Seller receives</span>
                        <span className="text-[#EDE8F5] font-mono">◎ {sellerAmt.toFixed(4)}</span>
                      </div>
                      {royaltyBpNum > 0 && (
                        <div className="flex justify-between">
                          <span className="text-[#7A6E8E]">Author royalty ({(royaltyBpNum / 100).toFixed(1)}%)</span>
                          <span className="text-[#81D0B5] font-mono">◎ {royaltyAmt.toFixed(4)}</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-[#7A6E8E]">Platform fee (2.5%)</span>
                        <span className="text-[#F7FF88] font-mono">◎ {platformFeeAmt.toFixed(4)}</span>
                      </div>
                    </div>
                    {isOwnListing ? (
                      <GlowButton variant="ghost" size="sm" onClick={() => handleCancelListing(listing.id)}>
                        Cancel listing
                      </GlowButton>
                    ) : purchased || isAuthor ? (
                      <span className="text-[#81D0B5] text-xs font-medium">✓ You own access</span>
                    ) : (
                      <GlowButton
                        variant="primary"
                        size="sm"
                        isLoading={isBuyingResale === listing.id}
                        onClick={() => handleBuyResale(listing)}
                        className="w-full"
                      >
                        Buy for ◎ {priceDisplay} SOL
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
