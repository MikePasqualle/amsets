"use client";

import Link from "next/link";
import Image from "next/image";
import { useRef, useState } from "react";
import { useHoverGlow } from "@/components/animations/useHoverGlow";
import { NeonBadge } from "@/components/ui/NeonBadge";
import { resolveIPFS } from "@/lib/storage";

interface ContentCardProps {
  contentId: string;
  title: string;
  description?: string;
  previewUri: string;
  authorWallet: string;
  basePrice: string; // bigint as string from API
  paymentToken: "SOL" | "USDC";
  license: string;
  category?: string;
  /** "draft" = registered but not yet on-chain; "active" = published on Solana */
  status?: "draft" | "active" | string;
  /** Royalty in basis points (e.g. 500 = 5%) */
  royaltyBps?: number;
  /** Author NFT mint address — present means the 1-of-1 authorship token exists */
  authorNftMint?: string;
}

const LICENSE_LABELS: Record<string, string> = {
  personal: "Personal",
  commercial: "Commercial",
  derivative: "Derivative",
  unlimited: "Unlimited",
};

/**
 * Marketplace content card with hover glow + ScrollTrigger reveal.
 * ScrollTrigger is applied by the parent ContentGrid.
 */
export function ContentCard({
  contentId,
  title,
  description,
  previewUri,
  authorWallet,
  basePrice,
  paymentToken,
  license,
  category,
  status = "active",
  royaltyBps,
  authorNftMint,
}: ContentCardProps) {
  const cardRef = useHoverGlow("rgba(247, 255, 136, 0.25)");
  const [imgError, setImgError] = useState(false);

  const isPlaceholder =
    !previewUri ||
    previewUri === "ipfs://bafyplaceholder" ||
    previewUri.endsWith("bafyplaceholder");

  const previewUrl = isPlaceholder ? null : resolveIPFS(previewUri);
  const priceSOL = (Number(basePrice) / 1_000_000_000).toFixed(3);

  const shortAddress = `${authorWallet.slice(0, 4)}…${authorWallet.slice(-4)}`;

  return (
    <Link href={`/c/${contentId}`}>
      <article
        ref={cardRef}
        className="card-surface group cursor-pointer overflow-hidden transition-all duration-300"
      >
        {/* Preview image */}
        <div className="relative w-full aspect-[4/3] overflow-hidden bg-[#2D1F47]">
          {previewUrl && !imgError ? (
            <Image
              src={previewUrl}
              alt={title}
              fill
              className="object-cover group-hover:scale-105 transition-transform duration-500"
              unoptimized={previewUrl.includes("pinata") || previewUrl.includes("ipfs")}
              onError={() => setImgError(true)}
            />
          ) : (
            /* Fallback: gradient placeholder when no preview or image fails */
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-[#2D1F47] to-[#1A0D2E]">
              <span className="text-4xl opacity-40">🔐</span>
              <span className="text-[#7A6E8E] text-xs">No preview</span>
            </div>
          )}
          {/* Status badge — top-left */}
          <div className="absolute top-3 left-3">
            {status === "draft" ? (
              <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold bg-amber-400/20 text-amber-300 border border-amber-400/40">
                Draft
              </span>
            ) : status === "active" ? (
              <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold bg-green-500/20 text-green-300 border border-green-500/30">
                Published
              </span>
            ) : null}
          </div>
          {/* License badge — top-right */}
          <div className="absolute top-3 right-3">
            <NeonBadge variant="primary">{LICENSE_LABELS[license] ?? license}</NeonBadge>
          </div>
        </div>

        {/* Metadata */}
        <div className="p-4 flex flex-col gap-2">
          {category && (
            <NeonBadge variant="muted" className="self-start">
              {category}
            </NeonBadge>
          )}

          <h3 className="text-[#EDE8F5] font-semibold text-base leading-snug line-clamp-2">
            {title}
          </h3>

          {description && (
            <p className="text-[#7A6E8E] text-sm line-clamp-2">{description}</p>
          )}

          <div className="flex items-center justify-between mt-2 pt-3 border-t border-[#3D2F5A]">
            <div className="flex flex-col gap-0.5">
              <span className="text-[#7A6E8E] text-xs font-mono">{shortAddress}</span>
              {royaltyBps !== undefined && royaltyBps > 0 && (
                <span className="text-[#B49FCC] text-[10px]">
                  {(royaltyBps / 100).toFixed(1)}% royalty
                </span>
              )}
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-[#F7FF88] font-bold text-sm">
                {paymentToken === "SOL" ? `◎ ${priceSOL}` : `$${(Number(basePrice) / 1_000_000).toFixed(2)}`}
              </span>
              {authorNftMint && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-[#F7FF88]/10 text-[#F7FF88] border border-[#F7FF88]/20">
                  NFT ✓
                </span>
              )}
            </div>
          </div>
        </div>
      </article>
    </Link>
  );
}
