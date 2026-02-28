"use client";

import { useEffect, useRef, useState } from "react";
import { NeonBadge } from "@/components/ui/NeonBadge";
import { GlowButton } from "@/components/ui/GlowButton";
import { decryptFile } from "@/lib/crypto";
import { decryptKeyFromBundle, decryptKeyForContent, buildAuthSig } from "@/lib/lit";
import { decodeBundle, bundleToEncryptedBuffer } from "@/lib/arweave-bundle";
import { downloadFromArweave, unpackEncrypted } from "@/lib/storage";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSession } from "@/hooks/useSession";
import bs58 from "bs58";

interface ContentViewerProps {
  contentId: string;
  storageUri: string;
  accessMint: string;
  mimeType: string;
  /** Legacy: encryptedKey from PostgreSQL (Phase 0 content) */
  encryptedKey?: string;
  /** Legacy: litConditionsHash from PostgreSQL (Phase 0 content) */
  litConditionsHash?: string;
  /** When true, bypass Lit Protocol checks — author always has access */
  isAuthor?: boolean;
}

type ViewerState = "idle" | "loading" | "ready" | "error";

/**
 * Secure content viewer with two decryption paths:
 *
 * Path A (Phase 1+ — decentralized):
 *   ar://txId → fetch AmsetsBundle JSON → extract lit_bundle + encrypted_payload
 *   → Lit Protocol decryption (no backend involved)
 *
 * Path B (Legacy — Phase 0):
 *   encryptedKey + litConditionsHash passed as props (came from PostgreSQL)
 *   → Lit Protocol decryption with legacy authSig
 *
 * Supported output formats:
 *   - Video: HTML5 <video> with blob: URL
 *   - Image: <img> with watermark overlay
 *   - PDF: PDF.js canvas rendering
 *   - Audio: <audio> player
 */
export function ContentViewer({
  contentId,
  storageUri,
  accessMint,
  mimeType,
  encryptedKey,
  litConditionsHash,
  isAuthor = false,
}: ContentViewerProps) {
  const { publicKey, signMessage } = useWallet();
  const { isAuthenticated, walletAddress } = useSession();

  // All hooks must come before any conditional return (Rules of Hooks)
  const [state, setState] = useState<ViewerState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [decryptStatus, setDecryptStatus] = useState<string>("Initialising…");
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  // ─── Pending upload guard (after all hooks) ────────────────────────────────
  if (storageUri.startsWith("ar://pending_")) {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <div className="text-4xl opacity-40">⏳</div>
        <p className="text-[#EDE8F5] font-semibold">Content upload pending</p>
        <p className="text-[#7A6E8E] text-sm max-w-sm">
          The author has not yet uploaded the encrypted file to Arweave.
          The content preview and metadata are available, but the full file will
          appear here once the upload completes.
        </p>
      </div>
    );
  }

  const handleDecryptAndView = async () => {
    if (!isAuthenticated || !walletAddress) {
      setError("Please connect your wallet first");
      return;
    }

    // Authors always have access — but still need a wallet for the actual decryption signature.
    // Lit Protocol is bypassed only if we store content without encryption (not yet implemented).
    // For now, all content — including author's — goes through Lit but with relaxed conditions.
    if (!publicKey || !signMessage) {
      setError(
        "Content decryption requires a Phantom or Solflare wallet for signing. " +
        "Please connect via the wallet button."
      );
      return;
    }

    setState("loading");
    setError(null);

    try {
      let symmetricKey: CryptoKey;
      let encryptedBuffer: ArrayBuffer;

      // ─── Attempt Path A: read from Arweave bundle ─────────────────────────

      setDecryptStatus("Fetching content bundle from Arweave…");
      const bundle = await decodeBundle(storageUri);

      if (bundle) {
        setDecryptStatus("Decrypting access key via Lit Protocol…");
        symmetricKey = await decryptKeyFromBundle({
          litBundle: bundle.lit_bundle,
          accessMint: bundle.access.access_mint !== "pending"
            ? bundle.access.access_mint
            : accessMint,
          walletAddress: publicKey.toBase58(),
          signMessage,
        });

        setDecryptStatus("Assembling encrypted payload…");
        encryptedBuffer = bundleToEncryptedBuffer(bundle);

      } else if (encryptedKey && litConditionsHash) {
        // ─── Path B: legacy PostgreSQL-sourced keys ──────────────────────────

        setDecryptStatus("Using legacy Lit key data…");

        const timestamp  = Date.now();
        const message    = `AMSETS view: ${contentId} at ${timestamp}`;
        const msgBytes   = new TextEncoder().encode(message);
        const sigBytes   = await signMessage(msgBytes);
        const signature  = bs58.encode(sigBytes);
        const authSig    = buildAuthSig(publicKey.toBase58(), signature, message);

        setDecryptStatus("Decrypting access key via Lit Protocol…");
        symmetricKey = await decryptKeyForContent(
          encryptedKey,
          litConditionsHash,
          authSig,
          accessMint
        );

        setDecryptStatus("Downloading encrypted file from Arweave…");
        const packed = await downloadFromArweave(storageUri);
        const { iv, ciphertext } = unpackEncrypted(packed);
        encryptedBuffer = (await Promise.resolve(null))!;

        setDecryptStatus("Decrypting content…");
        const { iv: iv2, ciphertext: ct2 } = unpackEncrypted(packed);
        const decrypted = await decryptFile(symmetricKey, iv2, ct2);
        const blob = new Blob([decrypted], { type: mimeType });
        setBlobUrl(URL.createObjectURL(blob));
        setState("ready");
        return;

      } else {
        throw new Error(
          "Content is not yet available for viewing. " +
          "The Arweave upload may still be propagating (this can take a few minutes)."
        );
      }

      // ─── Decrypt file from bundle ─────────────────────────────────────────

      setDecryptStatus("Decrypting content…");
      const { iv, ciphertext } = unpackEncrypted(encryptedBuffer);
      const decrypted = await decryptFile(symmetricKey, iv, ciphertext);

      const blob = new Blob([decrypted], { type: mimeType });
      setBlobUrl(URL.createObjectURL(blob));
      setState("ready");

    } catch (err: any) {
      setState("error");
      const msg: string = err.message ?? "Failed to decrypt content";
      if (msg.toLowerCase().includes("not_authorized") || msg.toLowerCase().includes("access denied")) {
        setError(
          "Access denied — you must hold the access token to view this content. " +
          "Purchase the content first."
        );
      } else {
        setError(msg);
      }
    }
  };

  if (state === "idle") {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <NeonBadge variant="secondary">Access Verified ✓</NeonBadge>
        <p className="text-[#7A6E8E] text-sm">
          Click to decrypt and view your content securely in-browser.
          Your decryption key is verified on Lit Protocol — the content never leaves your browser unencrypted.
        </p>
        <GlowButton variant="primary" size="md" onClick={handleDecryptAndView}>
          Decrypt & View
        </GlowButton>
      </div>
    );
  }

  if (state === "loading") {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <div className="w-10 h-10 border-2 border-[#F7FF88] border-t-transparent rounded-full animate-spin" />
        <p className="text-[#7A6E8E] text-sm">{decryptStatus}</p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="flex flex-col items-center gap-4 py-12 text-center">
        <p className="text-red-400 text-sm max-w-sm">{error}</p>
        <GlowButton variant="ghost" size="sm" onClick={() => setState("idle")}>
          Try Again
        </GlowButton>
      </div>
    );
  }

  return (
    <div className="w-full rounded-xl overflow-hidden bg-[#0D0A14] border border-[#3D2F5A]">
      {mimeType.startsWith("video/") && blobUrl && (
        <video
          ref={videoRef}
          src={blobUrl}
          controls
          controlsList="nodownload nofullscreen"
          disablePictureInPicture
          className="w-full max-h-[70vh]"
          onContextMenu={(e) => e.preventDefault()}
        />
      )}

      {mimeType.startsWith("image/") && blobUrl && (
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={blobUrl}
            alt="Decrypted content"
            className="w-full object-contain max-h-[80vh]"
            onContextMenu={(e) => e.preventDefault()}
            draggable={false}
          />
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center opacity-10">
            <span className="text-white text-4xl font-black rotate-[-30deg] select-none">
              AMSETS
            </span>
          </div>
        </div>
      )}

      {mimeType === "application/pdf" && blobUrl && (
        <PdfViewer url={blobUrl} />
      )}

      {mimeType.startsWith("audio/") && blobUrl && (
        <div className="p-6">
          <audio
            src={blobUrl}
            controls
            controlsList="nodownload"
            className="w-full"
          />
        </div>
      )}

      {!mimeType.startsWith("video/") &&
        !mimeType.startsWith("image/") &&
        mimeType !== "application/pdf" &&
        !mimeType.startsWith("audio/") && (
          <div className="p-8 text-center">
            <p className="text-[#7A6E8E]">Content decrypted successfully.</p>
            <p className="text-[#3D2F5A] text-sm mt-2">File type: {mimeType}</p>
          </div>
        )}
    </div>
  );
}

function PdfViewer({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function renderPdf() {
      try {
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";

        const pdf      = await pdfjsLib.getDocument(url).promise;
        const container = containerRef.current;
        if (!container || cancelled) return;

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          if (cancelled) break;
          const page     = await pdf.getPage(pageNum);
          const viewport = page.getViewport({ scale: 1.5 });

          const canvas  = document.createElement("canvas");
          canvas.width  = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width        = "100%";
          canvas.style.marginBottom = "8px";
          canvas.oncontextmenu = (e) => e.preventDefault();

          const ctx = canvas.getContext("2d");
          if (!ctx) continue;

          await page.render({ canvasContext: ctx as any, viewport, canvas }).promise;
          container.appendChild(canvas);
        }
      } catch (err) {
        console.error("PDF render failed:", err);
      }
    }

    renderPdf();
    return () => { cancelled = true; };
  }, [url]);

  return (
    <div ref={containerRef} className="overflow-y-auto max-h-[80vh] p-4 bg-[#0D0A14]" />
  );
}
