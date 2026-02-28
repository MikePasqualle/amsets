"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import Image from "next/image";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { NeonBadge } from "@/components/ui/NeonBadge";
import { GlowButton } from "@/components/ui/GlowButton";
import { useAuthModal } from "@/providers/AuthContext";
import { useAuth } from "@/lib/useAuth";
import { useSession } from "@/hooks/useSession";
import {
  publishOnChain,
  createMintForContent,
  setAccessMint,
  deriveContentRecordPda,
  uuidToBytes32,
} from "@/lib/anchor";
import { resolveIPFS } from "@/lib/storage";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface ContentItem {
  id: string;
  contentId: string;
  title: string;
  description?: string;
  category?: string;
  previewUri: string;
  authorWallet: string;
  basePrice: string;
  paymentToken: "SOL" | "USDC";
  license: string;
  status: "draft" | "active" | string;
  contentHash: string;
  onChainPda: string;
  mintAddress: string | null;
  totalSupply: number;
  soldCount: number;
  royaltyBps: number;
  createdAt: string;
}

const LICENSE_LABELS: Record<string, string> = {
  personal: "Personal",
  commercial: "Commercial",
  derivative: "Derivative",
  unlimited: "Unlimited",
};

/**
 * My Content page — shows all content published by the connected wallet.
 * Draft items show a "Publish On-Chain" button to deploy to Solana.
 */
export function MyContentClient() {
  const { isAuthenticated, walletAddress, mounted } = useSession();
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { loginWithWallet } = useAuth();
  const [items, setItems] = useState<ContentItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [deployingId,   setDeployingId]   = useState<string | null>(null);
  const [deployStep,    setDeployStep]    = useState<Record<string, string>>({});
  const [deployError,   setDeployError]   = useState<Record<string, string>>({});
  const { openAuth } = useAuthModal();

  // ─── Fetch author's content ──────────────────────────────────────────────
  // Always reads token fresh from localStorage so an expired/missing JWT
  // triggers re-authentication rather than silently showing empty state.

  const fetchContent = useCallback(async () => {
    if (!walletAddress) return;

    // Read token fresh — the state value may lag behind localStorage
    let activeToken = localStorage.getItem("amsets_token");

    // If token is missing and we have a browser wallet, re-auth now
    if (!activeToken && connected && publicKey) {
      try {
        await loginWithWallet("wallet_adapter");
        activeToken = localStorage.getItem("amsets_token");
      } catch {
        // Re-auth failed — user will see the sign-in prompt
      }
    }

    if (!activeToken) return;

    setIsLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`${API_URL}/api/v1/content/by-author/${walletAddress}`, {
        headers: { Authorization: `Bearer ${activeToken}` },
      });

      if (res.status === 401) {
        // Token expired — clear it so next visit triggers fresh auth
        localStorage.removeItem("amsets_token");
        window.dispatchEvent(new Event("amsets_session_changed"));
        setFetchError("Session expired — please sign in again.");
        return;
      }
      if (!res.ok) {
        setFetchError(`Server error (${res.status}). Please try refreshing.`);
        return;
      }

      const data = await res.json();
      setItems(data.items ?? []);
    } catch {
      setFetchError("Network error. Please check your connection and refresh.");
    } finally {
      setIsLoading(false);
    }
  }, [walletAddress, connected, publicKey, loginWithWallet]);

  useEffect(() => {
    if (walletAddress) {
      fetchContent();
    }
  }, [walletAddress, fetchContent]);

  // ─── Publish draft on-chain (register → mint → link → backend update) ────

  const handlePublishOnChain = async (item: ContentItem) => {
    if (!publicKey || !connected) { openAuth(); return; }
    const token = localStorage.getItem("amsets_token");
    if (!token) { openAuth(); return; }

    const id = item.contentId;
    setDeployingId(id);
    setDeployError((e)  => ({ ...e, [id]: "" }));
    setDeployStep((s)   => ({ ...s, [id]: "Step 1/3 — Registering on Solana…" }));

    try {
      // ── Step 1: register_content on-chain ──────────────────────────────
      const storageUri = item.onChainPda === "pending"
        ? `ar://pending_${item.contentHash.slice(0, 8)}`
        : `ar://${item.onChainPda}`;

      const { signature, pdaAddress } = await publishOnChain(
        {
          contentId:   id,
          contentHash: item.contentHash,
          storageUri,
          previewCid:  item.previewUri.replace("ipfs://", "").replace("https://ipfs.io/ipfs/", ""),
          priceSol:    (Number(item.basePrice) / 1_000_000_000).toFixed(4),
          license:     item.license,
          totalSupply: 100,
          royaltyBps:  item.royaltyBps ?? 1000,
        },
        publicKey,
        sendTransaction,
        connection
      );

      // ── Step 2: create SPL Token-2022 mint ─────────────────────────────
      setDeployStep((s) => ({ ...s, [id]: "Step 2/3 — Creating access token mint…" }));
      let mintAddress: string | null = null;

      try {
        const { mintKeypair } = await createMintForContent(
          publicKey,
          item.royaltyBps ?? 1000,
          sendTransaction,
          connection
        );
        mintAddress = mintKeypair.publicKey.toBase58();

        // ── Step 3: link mint to ContentRecord on-chain ──────────────────
        setDeployStep((s) => ({ ...s, [id]: "Step 3/3 — Linking mint to content record…" }));
        const contentIdBytes   = uuidToBytes32(id);
        const contentRecordPda = deriveContentRecordPda(publicKey, contentIdBytes);
        await setAccessMint(contentRecordPda, mintKeypair.publicKey, publicKey, sendTransaction, connection);
      } catch (mintErr: any) {
        // Non-fatal — content will be active without SPL mint; mint can be added later
        console.warn("[deploy] Mint creation skipped:", mintErr?.message);
      }

      // ── Backend update: mark active + store PDA + mint ─────────────────
      setDeployStep((s) => ({ ...s, [id]: "Finalising…" }));
      const patchRes = await fetch(`${API_URL}/api/v1/content/${id}/publish`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          tx_signature: signature,
          on_chain_pda: pdaAddress,
          ...(mintAddress ? { mint_address: mintAddress } : {}),
        }),
      });

      if (!patchRes.ok) {
        const errBody = await patchRes.json().catch(() => ({}));
        throw new Error(
          errBody.error ?? `Backend update failed (HTTP ${patchRes.status}). Content IS on Solana — try refreshing.`
        );
      }

      // Reflect "active" in local state immediately
      setItems((prev) =>
        prev.map((i) =>
          i.contentId === id
            ? { ...i, status: "active", onChainPda: pdaAddress, mintAddress: mintAddress ?? i.mintAddress }
            : i
        )
      );
      setDeployStep((s) => ({ ...s, [id]: "" }));
    } catch (err: any) {
      const msg = typeof err?.message === "string" ? err.message : "Deployment failed";
      setDeployError((e) => ({ ...e, [id]: msg.slice(0, 200) }));
    } finally {
      setDeployingId(null);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  if (!mounted) return null;

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center gap-6 py-24 text-center">
        <p className="text-[#7A6E8E] text-lg">Connect wallet to manage your content</p>
        <GlowButton variant="primary" onClick={openAuth}>
          Connect Wallet
        </GlowButton>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card-surface animate-pulse aspect-[3/4] rounded-xl" />
        ))}
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center border-2 border-dashed border-red-500/30 rounded-2xl">
        <p className="text-red-400 text-lg">{fetchError}</p>
        <GlowButton variant="primary" onClick={() => { openAuth(); fetchContent(); }}>
          Sign In Again
        </GlowButton>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center border-2 border-dashed border-[#3D2F5A] rounded-2xl">
        <p className="text-[#7A6E8E] text-lg">Nothing published yet</p>
        <Link href="/upload">
          <GlowButton variant="primary">Publish Your First Work</GlowButton>
        </Link>
      </div>
    );
  }

  const drafts   = items.filter((i) => i.status === "draft");
  const published = items.filter((i) => i.status === "active");

  return (
    <div className="flex flex-col gap-10">
      {/* ── Drafts section ── */}
      {drafts.length > 0 && (
        <section>
          <div className="flex items-center gap-3 mb-5">
            <h3 className="text-lg font-semibold text-[#EDE8F5]">Drafts</h3>
            <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-amber-400/20 text-amber-300 border border-amber-400/40">
              {drafts.length}
            </span>
            <p className="text-sm text-[#7A6E8E] ml-1">Registered in AMSETS, not yet on Solana</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {drafts.map((item) => (
              <ContentManageCard
                key={item.contentId}
                item={item}
                onPublish={() => handlePublishOnChain(item)}
                isDeploying={deployingId === item.contentId}
                deployStep={deployStep[item.contentId]}
                deployError={deployError[item.contentId]}
                canDeploy={connected && !!publicKey}
                openAuth={openAuth}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Published section ── */}
      {published.length > 0 && (
        <section>
          <div className="flex items-center gap-3 mb-5">
            <h3 className="text-lg font-semibold text-[#EDE8F5]">Published</h3>
            <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold bg-green-500/20 text-green-300 border border-green-500/30">
              {published.length}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {published.map((item) => (
              <ContentManageCard
                key={item.contentId}
                item={item}
                isDeploying={false}
                canDeploy={false}
                openAuth={openAuth}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Individual content management card ──────────────────────────────────────

interface ContentManageCardProps {
  item: ContentItem;
  onPublish?: () => void;
  isDeploying: boolean;
  deployStep?: string;
  deployError?: string;
  canDeploy: boolean;
  openAuth: () => void;
}

function ContentManageCard({
  item,
  onPublish,
  isDeploying,
  deployStep,
  deployError,
  canDeploy,
  openAuth,
}: ContentManageCardProps) {
  const previewUrl  = resolveIPFS(item.previewUri);
  const priceSOL    = (Number(item.basePrice) / 1_000_000_000).toFixed(3);
  const isDraft     = item.status === "draft";
  const available   = Math.max(0, (item.totalSupply ?? 0) - (item.soldCount ?? 0));
  const hasMint     = !!item.mintAddress;

  return (
    <article className="card-surface overflow-hidden flex flex-col">
      {/* Preview */}
      <div className="relative w-full aspect-[4/3] overflow-hidden bg-[#2D1F47]">
        <Image
          src={previewUrl}
          alt={item.title}
          fill
          className="object-cover"
          unoptimized
        />
        {/* Status badge */}
        <div className="absolute top-3 left-3">
          {isDraft ? (
            <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold bg-amber-400/20 text-amber-300 border border-amber-400/40">
              Draft
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold bg-green-500/20 text-green-300 border border-green-500/30">
              Published
            </span>
          )}
        </div>
      </div>

      {/* Info */}
      <div className="p-4 flex flex-col gap-3 flex-1">
        <div>
          <h4 className="text-[#EDE8F5] font-semibold text-sm line-clamp-1">{item.title}</h4>
          <div className="flex items-center gap-2 mt-1">
            <NeonBadge variant="muted">{LICENSE_LABELS[item.license] ?? item.license}</NeonBadge>
            {item.category && <NeonBadge variant="muted">{item.category}</NeonBadge>}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[#F7FF88] font-bold text-sm">◎ {priceSOL}</span>
          <Link
            href={`/c/${item.contentId}`}
            className="text-xs text-[#7A6E8E] hover:text-[#EDE8F5] underline underline-offset-2 transition-colors"
          >
            View →
          </Link>
        </div>

        {/* Token supply info for active content */}
        {!isDraft && (
          <div className="flex items-center justify-between text-xs text-[#7A6E8E]">
            <span>{available} / {item.totalSupply ?? "?"} tokens available</span>
            {hasMint ? (
              <span className="text-green-400">✓ Mint active</span>
            ) : (
              <span className="text-amber-400">⚠ No mint yet</span>
            )}
          </div>
        )}

        {/* Draft: Publish On-Chain button */}
        {isDraft && onPublish && (
          <div className="flex flex-col gap-2 mt-auto pt-2 border-t border-[#3D2F5A]">
            {canDeploy ? (
              <GlowButton
                variant="primary"
                size="sm"
                isLoading={isDeploying}
                onClick={onPublish}
              >
                {isDeploying ? (deployStep || "Deploying…") : "Publish On-Chain"}
              </GlowButton>
            ) : (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-[#7A6E8E]">
                  Connect Phantom or Solflare to deploy on Solana
                </p>
                <GlowButton variant="ghost" size="sm" onClick={openAuth}>
                  Connect Wallet
                </GlowButton>
              </div>
            )}
            {deployError && (
              <p className="text-xs text-red-400 line-clamp-3">{deployError}</p>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
