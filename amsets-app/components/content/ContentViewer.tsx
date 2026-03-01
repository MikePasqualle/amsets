"use client";

/**
 * ContentViewer — native HLS video player with application-level access control.
 *
 * Flow:
 *   storageUri = "livepeer://{playbackId}"
 *   → backend verifies auth + purchase → returns hlsUrl + assetStatus
 *   → HLS.js (Chrome/Firefox/Edge) or native <video> (Safari iOS) plays the stream
 *
 * Security: the playbackId / HLS URL is never embedded in the page source;
 *           it is fetched only after the backend confirms access rights.
 *
 * Legacy Arweave/Lit code is commented out at the bottom for rollback reference.
 */

// ── Arweave/Lit imports commented out — restore if switching back ─────────────
// import { decryptFile } from "@/lib/crypto";
// import { decryptKeyFromBundle, decryptKeyForContent, buildAuthSig } from "@/lib/lit";
// import { decodeBundle, bundleToEncryptedBuffer } from "@/lib/arweave-bundle";
// import { downloadFromArweave, unpackEncrypted } from "@/lib/storage";
// import bs58 from "bs58";
// ──────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useCallback } from "react";
import { NeonBadge } from "@/components/ui/NeonBadge";
import { GlowButton } from "@/components/ui/GlowButton";
import { useSession } from "@/hooks/useSession";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface ContentViewerProps {
  contentId:  string;
  storageUri: string;
  isAuthor?: boolean;
  /** Legacy props kept for API compatibility — not used by current HLS player */
  accessMint?: string;
  mimeType?: string;
  encryptedKey?: string;
  litConditionsHash?: string;
}

type AssetStatus = "ready" | "transcoding" | "not_found";
type ViewerState = "idle" | "loading" | "ready" | "transcoding" | "not_found" | "error";

export function ContentViewer({
  contentId,
  storageUri,
  isAuthor = false,
}: ContentViewerProps) {
  const { token } = useSession();
  const videoRef = useRef<HTMLVideoElement>(null);

  const [viewerState, setViewerState] = useState<ViewerState>("idle");
  const [statusText,  setStatusText]  = useState("");
  const [errorText,   setErrorText]   = useState("");
  const [hlsUrl,      setHlsUrl]      = useState<string | null>(null);
  const [playbackId,  setPlaybackId]  = useState<string | null>(null);
  // Destroy HLS.js instance reference so we can clean up on re-mount
  const hlsRef = useRef<any>(null);

  const isLivepeer = storageUri.startsWith("livepeer://");
  const isArweave  = storageUri.startsWith("ar://");

  const fetchPlaybackAccess = useCallback(async () => {
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
      const pid         = data.playbackId as string;
      const hlsUrlRaw   = data.hlsUrl as string | null;
      const assetStatus = (data.assetStatus as AssetStatus) ?? "ready";

      setPlaybackId(pid);

      if (assetStatus === "not_found") {
        setViewerState("not_found");
        return;
      }

      if (assetStatus === "transcoding") {
        setViewerState("transcoding");
        return;
      }

      if (!hlsUrlRaw) {
        setErrorText("Video is not available yet — please try again shortly.");
        setViewerState("error");
        return;
      }

      setHlsUrl(hlsUrlRaw);
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
    if (authToken) fetchPlaybackAccess();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageUri, token]);

  // Set up HLS player — runs when viewerState becomes "ready" and <video> is in DOM
  useEffect(() => {
    if (viewerState !== "ready" || !hlsUrl) return;

    // Small defer ensures React has committed the <video> element to the DOM
    const timer = setTimeout(() => {
      const video = videoRef.current;
      if (!video) return;

      // Clean up any previous HLS.js instance
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      // Direct MP4 link (Livepeer fallback for very short clips) — play natively
      if (hlsUrl.endsWith(".mp4") || hlsUrl.includes(".mp4?")) {
        const video = videoRef.current!;
        video.src = hlsUrl;
        video.load();
        video.addEventListener("error", () => {
          setErrorText("Could not load video — try refreshing");
          setViewerState("error");
        }, { once: true });
        return;
      }

      import("hls.js").then((mod) => {
        const Hls = mod.default;

        // Prefer HLS.js on all browsers (Chrome, Firefox, Edge, desktop Safari)
        // Falls back to native <video> only when HLS.js MSE is unavailable (e.g. Safari iOS)
        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
          });

          hlsRef.current = hls;

          hls.on(Hls.Events.ERROR, (_: any, data: any) => {
            if (!data.fatal) return;
            console.error("[ContentViewer] HLS fatal:", data.type, data.details);
            if (data.type === "networkError") {
              // 404 from CDN = video not found; other network errors = connectivity
              const statusCode = data.response?.code ?? data.networkDetails?.response?.code;
              if (statusCode === 404) {
                setViewerState("not_found");
              } else {
                setErrorText("Network error — check your connection and try again");
                setViewerState("error");
              }
            } else {
              setErrorText("Playback error — try refreshing the page");
              setViewerState("error");
            }
            hls.destroy();
            hlsRef.current = null;
          });

          hls.loadSource(hlsUrl);
          hls.attachMedia(video);

        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          // Safari native HLS (when HLS.js MSE is unavailable)
          video.src = hlsUrl;
          video.load();
          video.addEventListener("error", () => {
            setViewerState("not_found");
          }, { once: true });

        } else {
          setErrorText("Your browser does not support this video format.");
          setViewerState("error");
        }
      });
    }, 50);

    return () => {
      clearTimeout(timer);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerState, hlsUrl]);

  // Auto-refresh transcoding state every 15 seconds
  useEffect(() => {
    if (viewerState !== "transcoding") return;
    const interval = setInterval(() => {
      fetchPlaybackAccess();
    }, 15_000);
    return () => clearInterval(interval);
  }, [viewerState, fetchPlaybackAccess]);

  // ─── Render: Livepeer content ─────────────────────────────────────────────

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
          <GlowButton variant="primary" size="sm" onClick={fetchPlaybackAccess}>
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

    if (viewerState === "transcoding") {
      return (
        <div className="w-full aspect-video rounded-xl bg-[#0D0A14] border border-[#3D2F5A] flex flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="inline-block w-10 h-10 border-2 border-[#F7FF88] border-t-transparent rounded-full animate-spin" />
          <p className="text-[#EDE8F5] font-semibold">Processing video…</p>
          <p className="text-[#7A6E8E] text-sm max-w-xs">
            Your video is being processed. This usually takes 1–5 minutes. The player will refresh automatically.
          </p>
          <GlowButton variant="ghost" size="sm" onClick={fetchPlaybackAccess}>
            Check Now
          </GlowButton>
        </div>
      );
    }

    if (viewerState === "not_found") {
      return (
        <div className="w-full aspect-video rounded-xl bg-[#0D0A14] border border-amber-500/30 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="text-4xl">⚠️</span>
          <p className="text-amber-400 font-semibold">Video not available</p>
          <p className="text-[#7A6E8E] text-sm max-w-xs">
            This video could not be found in the storage network. The content may need to be re-uploaded.
          </p>
          {isAuthor && (
            <NeonBadge variant="muted">Re-upload in My Works to fix</NeonBadge>
          )}
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

    if (viewerState === "ready" && hlsUrl) {
      return (
        <div className="w-full rounded-xl overflow-hidden bg-black border border-[#3D2F5A]">
          <div className="relative w-full aspect-video bg-black">
            <video
              ref={videoRef}
              className="w-full h-full"
              controls
              playsInline
              preload="metadata"
              style={{ display: "block" }}
            />
          </div>
          {playbackId && (
            <div className="px-4 py-2 bg-[#0D0A14] flex items-center gap-2 border-t border-[#3D2F5A]">
              <div className="w-1.5 h-1.5 rounded-full bg-[#00EB88] animate-pulse" />
              <span className="text-[#7A6E8E] text-xs">Decentralized video network</span>
              <NeonBadge variant="muted" className="ml-auto text-[10px]">
                {playbackId.slice(0, 12)}…
              </NeonBadge>
            </div>
          )}
        </div>
      );
    }

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
        <p className="text-[#EDE8F5] font-semibold">Legacy Content</p>
        <p className="text-[#7A6E8E] text-sm max-w-xs">
          This content was stored on an older network. Contact support if you need access.
        </p>
        <NeonBadge variant="muted">{storageUri.slice(0, 30)}…</NeonBadge>
      </div>
    );
  }

  // ─── Unknown storage type ──────────────────────────────────────────────────
  return (
    <div className="w-full rounded-xl bg-[#0D0A14] border border-[#3D2F5A] flex items-center justify-center py-12">
      <p className="text-[#7A6E8E] text-sm">Unsupported content format.</p>
    </div>
  );
}

// ── LEGACY ARWEAVE / LIT DECRYPTION BLOCK (commented out) ────────────────────
//
// To restore Arweave support:
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
//     }
//   } catch (err: any) {
//     setErrorText(err?.message ?? "Decryption failed");
//     setViewerState("error");
//   }
// }
// ─────────────────────────────────────────────────────────────────────────────
