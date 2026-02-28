"use client";

/**
 * ContentViewer — Livepeer video player with JWT-gated access.
 *
 * Current mode (Livepeer):
 *   storageUri = "livepeer://{playbackId}"
 *   → backend issues a signed JWT → @livepeer/react Player renders the video
 *
 * Legacy Arweave/Lit code is commented out at the bottom for rollback reference.
 * To restore: see the commented section at the end of this file.
 */

// ── Arweave/Lit imports commented out — restore if switching back ─────────────
// import { decryptFile } from "@/lib/crypto";
// import { decryptKeyFromBundle, decryptKeyForContent, buildAuthSig } from "@/lib/lit";
// import { decodeBundle, bundleToEncryptedBuffer } from "@/lib/arweave-bundle";
// import { downloadFromArweave, unpackEncrypted } from "@/lib/storage";
// import bs58 from "bs58";
// ──────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from "react";
import { NeonBadge } from "@/components/ui/NeonBadge";
import { GlowButton } from "@/components/ui/GlowButton";
import { useSession } from "@/hooks/useSession";
// @livepeer/react Player imported only as type reference (composable player for future use)
// import * as Player from "@livepeer/react/player";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const LIVEPEER_CDN = "https://livepeercdn.studio/hls";

interface ContentViewerProps {
  contentId:  string;
  storageUri: string;
  accessMint: string;
  mimeType:   string;
  /** Legacy: encryptedKey from PostgreSQL (Phase 0 Arweave content) */
  encryptedKey?:       string;
  /** Legacy: litConditionsHash from PostgreSQL (Phase 0 Arweave content) */
  litConditionsHash?:  string;
  /** When true, bypass access checks — author always has access */
  isAuthor?: boolean;
}

type ViewerState = "idle" | "loading" | "ready" | "error";

export function ContentViewer({
  contentId,
  storageUri,
  isAuthor = false,
}: ContentViewerProps) {
  const { token } = useSession();

  const [viewerState, setViewerState]   = useState<ViewerState>("idle");
  const [statusText,  setStatusText]    = useState("");
  const [errorText,   setErrorText]     = useState("");
  const [playerSrc,   setPlayerSrc]     = useState<string | null>(null);
  const [livePlaybackId, setLivePlaybackId] = useState<string | null>(null);

  const isLivepeer = storageUri.startsWith("livepeer://");
  const isArweave  = storageUri.startsWith("ar://");

  const fetchPlaybackJwt = useCallback(async () => {
    const authToken = token ?? localStorage.getItem("amsets_token");
    if (!authToken) {
      setErrorText("Connect your wallet to view this content.");
      setViewerState("error");
      return;
    }

    setViewerState("loading");
    setStatusText("Verifying access…");

    try {
      const res = await fetch(
        `${API_URL}/api/v1/livepeer/playback-jwt/${contentId}`,
        { headers: { Authorization: `Bearer ${authToken}` } }
      );

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error ?? `Access denied (${res.status})`);
      }

      const data = await res.json();
      const pid = data.playbackId as string;
      const jwt = data.jwt as string | null;

      setLivePlaybackId(pid);

      // Build HLS URL — append JWT as query param if available (Livepeer JWT-gate)
      const hlsUrl = jwt
        ? `${LIVEPEER_CDN}/${pid}/index.m3u8?jwt=${encodeURIComponent(jwt)}`
        : `${LIVEPEER_CDN}/${pid}/index.m3u8`;

      setPlayerSrc(hlsUrl);
      setViewerState("ready");
      setStatusText("");
    } catch (err: any) {
      setErrorText(err?.message ?? "Failed to load content");
      setViewerState("error");
    }
  }, [contentId, token]);

  // Auto-load for Livepeer content when user has a token
  useEffect(() => {
    if (!isLivepeer) return;
    const authToken = token ?? (typeof window !== "undefined" ? localStorage.getItem("amsets_token") : null);
    if (authToken) {
      fetchPlaybackJwt();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageUri, token]);

  // ─── Render: Livepeer Player ──────────────────────────────────────────────

  if (isLivepeer) {
    if (viewerState === "idle") {
      return (
        <div className="w-full rounded-xl overflow-hidden bg-[#0D0A14] border border-[#3D2F5A] flex flex-col items-center justify-center gap-4 py-16 px-6 text-center">
          <div className="w-14 h-14 rounded-2xl bg-[#221533] border border-[#3D2F5A] flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#F7FF88" strokeWidth="1.5">
              <rect x="2" y="7" width="20" height="14" rx="2"/>
              <path d="M16 11a1 1 0 0 1 0 2 1 1 0 0 1 0-2z" fill="#F7FF88" stroke="none"/>
              <path d="M6 7V5a6 6 0 0 1 12 0v2"/>
            </svg>
          </div>
          <p className="text-[#EDE8F5] font-semibold">Connect wallet to watch</p>
          <p className="text-[#7A6E8E] text-sm max-w-xs">
            Your access token grants you viewing rights. Connect to verify.
          </p>
          <GlowButton variant="primary" size="sm" onClick={fetchPlaybackJwt}>
            Verify Access
          </GlowButton>
        </div>
      );
    }

    if (viewerState === "loading") {
      return (
        <div className="w-full aspect-video rounded-xl bg-[#0D0A14] border border-[#3D2F5A] flex flex-col items-center justify-center gap-3">
          <span className="inline-block w-8 h-8 border-2 border-[#F7FF88] border-t-transparent rounded-full animate-spin" />
          <p className="text-[#7A6E8E] text-sm">{statusText}</p>
        </div>
      );
    }

    if (viewerState === "error") {
      return (
        <div className="w-full aspect-video rounded-xl bg-[#0D0A14] border border-red-500/30 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="text-4xl">🔒</span>
          <p className="text-red-400 text-sm font-medium">{errorText}</p>
          <GlowButton variant="ghost" size="sm" onClick={() => { setViewerState("idle"); setErrorText(""); }}>
            Try Again
          </GlowButton>
        </div>
      );
    }

    if (viewerState === "ready" && playerSrc) {
      // Use Livepeer's embed player (lvpr.tv) — simplest integration, no SDK config needed.
      // The embed URL supports the JWT param natively for gated content.
      const embedUrl = playerSrc; // already has jwt appended if available
      // Convert HLS URL → Livepeer embed iframe URL
      const pid = livePlaybackId ?? storageUri.replace("livepeer://", "");
      const jwtParam = playerSrc.includes("?jwt=") ? `&jwt=${playerSrc.split("?jwt=")[1]}` : "";
      const iframeUrl = `https://lvpr.tv?v=${pid}${jwtParam}`;

      return (
        <div className="w-full rounded-xl overflow-hidden bg-black border border-[#3D2F5A]">
          {/* Livepeer embed player — handles HLS, WebRTC, adaptive streaming */}
          <div className="relative w-full aspect-video bg-black">
            <iframe
              src={iframeUrl}
              title="AMSETS Content Player"
              className="w-full h-full"
              allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
              allowFullScreen
              style={{ border: "none" }}
            />
          </div>

          <div className="px-4 py-2 bg-[#0D0A14] flex items-center gap-2 border-t border-[#3D2F5A]">
            <div className="w-1.5 h-1.5 rounded-full bg-[#00EB88] animate-pulse" />
            <span className="text-[#7A6E8E] text-xs">Delivered by Livepeer decentralized video network</span>
            {pid && (
              <NeonBadge variant="muted" className="ml-auto text-[10px]">
                {pid.slice(0, 12)}…
              </NeonBadge>
            )}
          </div>
        </div>
      );
    }

    // Fallback (should not reach here normally)
    return (
      <div className="w-full aspect-video rounded-xl bg-[#0D0A14] border border-[#3D2F5A] flex items-center justify-center">
        <span className="inline-block w-8 h-8 border-2 border-[#F7FF88] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // ─── Legacy Arweave content (ar://) ─────────────────────────────────────────

  if (isArweave) {
    return (
      <div className="w-full rounded-xl overflow-hidden bg-[#0D0A14] border border-[#3D2F5A] flex flex-col items-center justify-center gap-4 py-16 px-6 text-center">
        <span className="text-4xl">📦</span>
        <p className="text-[#EDE8F5] font-semibold">Legacy Arweave Content</p>
        <p className="text-[#7A6E8E] text-sm max-w-xs">
          This content was stored on Arweave. Decryption via Lit Protocol is temporarily
          disabled while the platform migrates to Livepeer. Contact support if you need access.
        </p>
        <NeonBadge variant="muted">{storageUri.slice(0, 30)}…</NeonBadge>
      </div>
    );
  }

  // ─── Unknown storage type ──────────────────────────────────────────────────
  return (
    <div className="w-full rounded-xl bg-[#0D0A14] border border-[#3D2F5A] flex items-center justify-center py-12">
      <p className="text-[#7A6E8E] text-sm">Unsupported storage URI: {storageUri.slice(0, 40)}</p>
    </div>
  );
}

// ── LEGACY ARWEAVE / LIT DECRYPTION BLOCK (commented out) ────────────────────
//
// To restore Arweave support, uncomment the imports at the top of this file
// and implement the following handleDecrypt function:
//
// async function handleDecrypt() {
//   setViewerState("loading");
//   try {
//     if (storageUri.startsWith("ar://") && !storageUri.includes("pending")) {
//       const txId = storageUri.replace("ar://", "");
//       setStatusText("Fetching bundle from Arweave…");
//       const raw = await downloadFromArweave(txId);
//       const bundle = decodeBundle(raw);
//       setStatusText("Decrypting via Lit Protocol…");
//       const key = await decryptKeyFromBundle(bundle.lit_bundle, bundle.access_mint);
//       const { iv, ciphertext } = unpackEncrypted(bundleToEncryptedBuffer(bundle));
//       const decrypted = await decryptFile(key, ciphertext, iv);
//       const blob = new Blob([decrypted], { type: bundle.metadata.mime_type });
//       const url = URL.createObjectURL(blob);
//       // set url to display content
//     }
//   } catch (err: any) {
//     setErrorText(err?.message ?? "Decryption failed");
//     setViewerState("error");
//   }
// }
// ─────────────────────────────────────────────────────────────────────────────
