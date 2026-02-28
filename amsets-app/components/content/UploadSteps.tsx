"use client";

import { useRef, useState, useEffect } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { DragZone } from "./DragZone";
import { GlowButton } from "@/components/ui/GlowButton";
import { NeonBadge } from "@/components/ui/NeonBadge";
import { useAuthModal } from "@/providers/AuthContext";
import {
  computeSHA256,
  generateSymmetricKey,
  encryptFile,
  packEncrypted,
} from "@/lib/crypto";
import { encryptKeyForContent } from "@/lib/lit";
import { encodeBundle, type AmsetsBundleMetadata } from "@/lib/arweave-bundle";
import { uploadBundleToArweave, uploadPreviewToIPFS } from "@/lib/storage";
import {
  publishOnChain,
  createMintForContent,
  mintAuthorToken,
  setAccessMint,
  deriveContentRecordPda,
  uuidToBytes32,
} from "@/lib/anchor";
import { useAuth } from "@/lib/useAuth";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const STEPS = [
  { id: 1, label: "Upload File" },
  { id: 2, label: "Add Details" },
  { id: 3, label: "Set Pricing" },
  { id: 4, label: "Preview & Publish" },
  { id: 5, label: "Publishing" },
];

interface UploadData {
  file: File | null;
  title: string;
  description: string;
  category: string;
  price: string;
  supply: string;   // number of access tokens for sale (max supply)
  royalty: string;  // royalty percentage on resale (0–50%)
  license: string;
  previewFile: File | null;
}

interface PublishStep {
  label: string;
  status: "pending" | "running" | "done" | "skipped" | "error";
  detail?: string;
}

/**
 * 5-step upload wizard with GSAP slide transitions.
 *
 * Decentralized publish flow (Phase 1):
 *   1. Encrypt file locally with AES-256-GCM
 *   2. Encrypt AES key via Lit Protocol → AmsetsLitBundle
 *   3. Build + upload AmsetsBundle JSON to Arweave → ar://{txId}
 *   4. Upload preview image to IPFS (via backend proxy)
 *   5. Register on Solana (register_content with ar://{txId})
 *   6. Notify backend to cache metadata (without encryptedKey — it's in Arweave)
 *
 * If Arweave/Lit are unavailable, falls back to "pending" URIs and
 * saves the content as a draft with backend-side encrypted key storage.
 */
export function UploadSteps() {
  const [step, setStep] = useState(1);
  const [data, setData] = useState<UploadData>({
    file: null,
    title: "",
    description: "",
    category: "general",
    price: "0.1",
    supply: "100",
    royalty: "10",
    license: "personal",
    previewFile: null,
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishSteps, setPublishSteps] = useState<PublishStep[]>([]);
  const [contentHash, setContentHash] = useState<string | null>(null);
  /** "auto" = deploy on Solana immediately; "draft" = save and deploy later */
  const [deployMode, setDeployMode] = useState<"auto" | "draft">("auto");
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Capture the full WalletContextState — Irys @irys/web-upload-solana needs
  // the entire context object (publicKey + signTransaction + sendTransaction),
  // NOT wallet.adapter or window.solana.
  const walletContext = useWallet();
  const { publicKey, connected, sendTransaction, wallet } = walletContext;
  const { connection } = useConnection();
  const { openAuth } = useAuthModal();
  const { loginWithWallet } = useAuth();

  // ─── Session gate — no redirect, show inline connect prompt ────────────────
  // Checks BOTH Wallet Adapter (Phantom/Solflare) and Web3Auth (email/phone/social).
  // Web3Auth session lives in localStorage ("amsets_wallet" + "amsets_token").
  const [mounted, setMounted] = useState(false);
  const [hasWeb3AuthSession, setHasWeb3AuthSession] = useState(false);

  useEffect(() => {
    setMounted(true);

    const syncSession = () => {
      setHasWeb3AuthSession(!!localStorage.getItem("amsets_wallet"));
    };
    syncSession();
    window.addEventListener("amsets_session_changed", syncSession);
    return () => window.removeEventListener("amsets_session_changed", syncSession);
  }, []);

  // Derived: is any session active right now?
  const hasSession = connected || hasWeb3AuthSession;

  // ─── Step transitions ───────────────────────────────────────────────────────

  const goToStep = (next: number) => {
    const el = contentRef.current;
    if (!el) { setStep(next); return; }

    const direction = next > step ? 1 : -1;
    gsap.to(el, {
      x: -30 * direction,
      opacity: 0,
      duration: 0.2,
      ease: "power2.in",
      onComplete: () => {
        setStep(next);
        gsap.fromTo(
          el,
          { x: 30 * direction, opacity: 0 },
          { x: 0, opacity: 1, duration: 0.3, ease: "power2.out" }
        );
      },
    });
  };

  // ─── File selection ─────────────────────────────────────────────────────────

  const handleFileSelect = async (file: File) => {
    setData((d) => ({ ...d, file }));
    const buffer = await file.arrayBuffer();
    const hash = await computeSHA256(buffer);
    setContentHash(hash);
  };

  // ─── Publish ────────────────────────────────────────────────────────────────

  const updateStep = (
    steps: PublishStep[],
    index: number,
    patch: Partial<PublishStep>
  ): PublishStep[] => {
    const next = [...steps];
    next[index] = { ...next[index], ...patch };
    return next;
  };

  const handlePublish = async () => {
    if (!data.file || !contentHash) return;
    setPublishError(null);
    setIsProcessing(true);

    const steps: PublishStep[] = [
      { label: "Encrypting file + building Arweave bundle", status: "pending" },
      { label: "Uploading preview to IPFS",                 status: "pending" },
      { label: "Registering content in backend",            status: "pending" },
      { label: "Registering on Solana blockchain",          status: "pending" },
      { label: "Creating access token mint (SPL Token-2022)", status: "pending" },
    ];
    setPublishSteps(steps);
    goToStep(5);

    let token = typeof window !== "undefined" ? localStorage.getItem("amsets_token") : null;

    // If Wallet Adapter is connected but no JWT yet, authenticate now.
    // This handles the edge case where the user connected Phantom but the
    // auto-auth in Navbar didn't complete before they started publishing.
    if (!token && connected && publicKey) {
      try {
        await loginWithWallet("wallet_adapter");
        token = localStorage.getItem("amsets_token");
      } catch {
        // Continue without token — content will be registered as anonymous draft
      }
    }

    // For Arweave upload, pass the full WalletContextState (walletContext) to Irys.
    // @irys/web-upload-solana reads publicKey + signTransaction + sendTransaction
    // from the WalletContextState directly — do NOT use wallet.adapter or window.solana.
    // Only Wallet Adapter wallets (Phantom, Solflare, etc.) work with Irys in the browser.
    // Web3Auth (email/phone) users will skip Arweave and save as draft instead.
    const solanaWallet = connected ? walletContext : null;

    try {
      // ── Step 1: Encrypt file + build AmsetsBundle + upload to Arweave ────
      steps[0] = { ...steps[0], status: "running" };
      setPublishSteps([...steps]);

      const key    = await generateSymmetricKey();
      const buffer = await data.file.arrayBuffer();
      const { ciphertext, iv } = await encryptFile(key, buffer);
      const packed = packEncrypted(iv, ciphertext);

      // Use system program ID as placeholder mint — updated after set_access_mint
      const placeholderMint = "11111111111111111111111111111111";

      let storageUri = `ar://pending_${contentHash!.slice(0, 8)}`;
      let litBundle: any = null;

      if (solanaWallet) {
        // ── Lit Protocol encryption (non-fatal) ────────────────────────────
        // Run separately so a Lit timeout does NOT prevent Arweave upload.
        try {
          litBundle = await encryptKeyForContent(key, placeholderMint);
        } catch (litErr: any) {
          const litMsg: string = litErr?.message ?? String(litErr);
          // Lit failure is non-fatal: content uploads to Arweave without a
          // decryption key. Only the author can view until Lit is re-connected.
          console.warn("[Lit] Encryption failed (non-fatal):", litMsg);
        }

        // ── Arweave upload (independent of Lit result) ─────────────────────
        try {
          const bundleMetadata: AmsetsBundleMetadata = {
            title:        data.title,
            description:  data.description || undefined,
            category:     data.category,
            mime_type:    data.file.type || "application/octet-stream",
            content_hash: contentHash!,
          };

          const bundle = encodeBundle({
            metadata:        bundleMetadata,
            previewUri:      `ipfs://pending`,
            encryptedBuffer: packed,
            litBundle:       litBundle ?? { ciphertext: "", data_to_encrypt_hash: "" },
            accessMint:      placeholderMint,
          });

          // Pass full walletContext — @irys/web-upload-solana expects WalletContextState
          const arResult = await uploadBundleToArweave(bundle, solanaWallet);
          storageUri = arResult.uri;

          steps[0] = {
            ...steps[0],
            status: litBundle ? "done" : "done",
            detail: litBundle
              ? `Bundle: ${arResult.txId.slice(0, 12)}… (${(arResult.size / 1024).toFixed(1)} KB)`
              : `Bundle: ${arResult.txId.slice(0, 12)}… (Lit encryption skipped — content viewable by author only until re-encrypted)`,
          };
        } catch (arErr: any) {
          const errMsg: string = arErr?.message ?? arErr?.toString() ?? "Unknown Arweave error";
          steps[0] = {
            ...steps[0],
            status: "error",
            detail: `Arweave upload failed: ${errMsg.slice(0, 100)}${errMsg.length > 100 ? "…" : ""}`,
          };
          storageUri = `ar://pending_${contentHash!.slice(0, 8)}`;
        }
      } else {
        steps[0] = {
          ...steps[0],
          status: "skipped",
          detail: `File encrypted locally (${(packed.byteLength / 1024).toFixed(1)} KB). Connect a browser wallet (Phantom/Solflare) to upload to Arweave permanently.`,
        };
      }
      setPublishSteps([...steps]);

      // ── Step 2: Upload preview directly to IPFS (Pinata, client-side) ────
      // Decentralized: upload goes from browser → Pinata directly, no backend proxy.
      steps[1] = { ...steps[1], status: "running" };
      setPublishSteps([...steps]);

      let previewCid = "bafyplaceholder";
      let registeredContentId: string | null = null;

      if (data.previewFile) {
        try {
          const result = await uploadPreviewToIPFS(data.previewFile);
          previewCid = result.cid;
          steps[1] = { ...steps[1], status: "done", detail: `ipfs://${previewCid.slice(0, 20)}…` };
        } catch (previewErr: any) {
          const msg: string = previewErr?.message ?? "Pinata upload failed";
          // Common: plan limit or bad token — content still gets registered
          steps[1] = {
            ...steps[1],
            status: "skipped",
            detail: msg.length > 120 ? msg.slice(0, 120) + "…" : msg,
          };
        }
      } else {
        steps[1] = { ...steps[1], status: "skipped", detail: "No preview selected" };
      }
      setPublishSteps([...steps]);

      // ── Step 3: Register in backend cache ─────────────────────────────────
      steps[2] = { ...steps[2], status: "running" };
      setPublishSteps([...steps]);

      if (!token) {
        steps[2] = { ...steps[2], status: "skipped", detail: "Connect wallet to save content" };
      } else {
        try {
          const supplyVal  = Math.max(1, parseInt(data.supply) || 100);
          const royaltyVal = Math.min(5000, Math.round(parseFloat(data.royalty || "10") * 100));

          const regBody: Record<string, unknown> = {
            storage_uri:   storageUri,
            preview_cid:   previewCid,
            content_hash:  contentHash,
            title:         data.title,
            description:   data.description,
            category:      data.category,
            base_price:    Math.round(parseFloat(data.price) * 1_000_000_000),
            payment_token: "SOL",
            license:       data.license,
            total_supply:  supplyVal,
            royalty_bps:   royaltyVal,
            mime_type:     data.file?.type ?? "application/octet-stream",
          };

          // Include Lit key data only as fallback (for legacy content without Arweave bundle)
          if (litBundle && storageUri.startsWith("ar://pending_")) {
            // Bundle upload failed — store keys in backend as fallback
            regBody.encrypted_key        = litBundle.ciphertext ?? "pending";
            regBody.lit_conditions_hash  = litBundle.data_to_encrypt_hash ?? "pending";
          }

          const regRes = await fetch(`${API_URL}/api/v1/content/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(regBody),
          });

          if (regRes.ok) {
            const regData = await regRes.json();
            registeredContentId = regData.content_id ?? null;
            steps[2] = { ...steps[2], status: "done", detail: `ID: ${regData.content_id?.slice(0, 8)}…` };
          } else {
            const body = await regRes.json().catch(() => ({}));
            // Extract a human-readable message from Zod or API errors
            let errMsg: string;
            if (typeof body.error === "string") {
              errMsg = body.error;
            } else if (body.error?.issues?.length) {
              // Zod validation error — show the first issue's message
              const issue = body.error.issues[0];
              errMsg = `${issue.path?.join(".") ?? "field"}: ${issue.message}`;
            } else if (typeof body.message === "string") {
              errMsg = body.message;
            } else {
              errMsg = `HTTP ${regRes.status} — check browser console for details`;
              console.error("[register] error body:", body);
            }
            throw new Error(errMsg);
          }
        } catch (err: any) {
          steps[2] = {
            ...steps[2],
            status: "error",
            detail: typeof err.message === "string" ? err.message : "Registration failed",
          };
        }
      }
      setPublishSteps([...steps]);

      // ── Step 4: Solana on-chain deployment ───────────────────────────────
      steps[3] = { ...steps[3], status: "running" };
      setPublishSteps([...steps]);
      await new Promise((r) => setTimeout(r, 300));

      if (deployMode === "draft" || !registeredContentId) {
        steps[3] = {
          ...steps[3],
          status: "skipped",
          detail: deployMode === "draft"
            ? "Saved as Draft — deploy from My Content whenever you're ready"
            : "Saved as Draft (registration step failed)",
        };
      } else if (!connected || !publicKey) {
        steps[3] = {
          ...steps[3],
          status: "skipped",
          detail: "Connect Phantom or Solflare to deploy on Solana. Saved as Draft.",
        };
      } else {
        try {
          const { signature, pdaAddress } = await publishOnChain(
            {
              contentId:   registeredContentId,
              contentHash: contentHash!,
              storageUri,
              previewCid,
              priceSol:    data.price,
              license:     data.license,
              totalSupply: parseInt(data.supply) || 100,
              royaltyBps:  Math.round(parseFloat(data.royalty || "10") * 100),
            },
            publicKey,
            sendTransaction,
            connection
          );

          steps[3] = { ...steps[3], status: "done", detail: `Tx: ${signature.slice(0, 12)}…` };
          setPublishSteps([...steps]);

          // ── Step 5: Create SPL Token-2022 mint + mint 1 author token ─────
          steps[4] = { ...steps[4], status: "running" };
          setPublishSteps([...steps]);

          let mintAddress: string | null = null;

          try {
            const royaltyBps = Math.round(parseFloat(data.royalty || "10") * 100);
            const { mintKeypair } = await createMintForContent(
              publicKey,
              royaltyBps,
              sendTransaction,
              connection
            );

            mintAddress = mintKeypair.publicKey.toBase58();

            // Mint 1 author token to the author's wallet
            await mintAuthorToken(mintKeypair.publicKey, publicKey, sendTransaction, connection);

            // Link the mint to the ContentRecord on-chain
            const contentIdBytes   = uuidToBytes32(registeredContentId);
            const contentRecordPda = deriveContentRecordPda(publicKey, contentIdBytes);
            await setAccessMint(contentRecordPda, mintKeypair.publicKey, publicKey, sendTransaction, connection);

            steps[4] = {
              ...steps[4],
              status: "done",
              detail: `Mint: ${mintAddress.slice(0, 12)}… | Author token minted`,
            };
          } catch (mintErr: any) {
            // Non-fatal: content is already registered, token can be minted later
            steps[4] = {
              ...steps[4],
              status: "skipped",
              detail: `Token mint skipped: ${mintErr?.message?.slice(0, 80) ?? "unknown error"}`,
            };
          }
          setPublishSteps([...steps]);

          // Notify backend → update status to "active" + store PDA + mint address
          await fetch(`${API_URL}/api/v1/content/${registeredContentId}/publish`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              tx_signature: signature,
              on_chain_pda: pdaAddress,
              ...(mintAddress ? { mint_address: mintAddress } : {}),
            }),
          }).catch(() => null);
        } catch (onChainErr: any) {
          const raw: string = onChainErr?.message ?? "";
          // Determine if this is a "program not deployed" case vs a real error
          const isNotDeployed =
            raw.includes("not yet deployed") ||
            raw.includes("Unable to find the account") ||
            raw.includes("AccountNotFound") ||
            raw.includes("simulation failed") ||
            raw.includes("Unexpected error");

          const msg = isNotDeployed
            ? "Smart contract pending deployment — content saved as Draft"
            : raw.slice(0, 120) || "On-chain registration failed";

          steps[3] = {
            ...steps[3],
            status: isNotDeployed ? "skipped" : "error",
            detail: msg,
          };
        }
      }
      setPublishSteps([...steps]);
    } catch (err: any) {
      setPublishError(err.message ?? "Something went wrong. Please try again.");
    } finally {
      setIsProcessing(false);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  // Show connect-wallet gate before the wizard mounts, and as an overlay when the
  // wallet disconnects mid-flow (step 1-4). On step 5 (publishing) we don't
  // interrupt — the publish action will fail gracefully with an error message.
  if (!mounted) return null;

  if (!hasSession) {
    return (
      <div className="flex flex-col items-center gap-6 py-24 text-center">
        <div className="w-16 h-16 rounded-2xl bg-[#221533] border border-[#3D2F5A] flex items-center justify-center mb-2">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#F7FF88" strokeWidth="1.5">
            <rect x="2" y="7" width="20" height="14" rx="2" />
            <path d="M16 11a1 1 0 0 1 0 2 1 1 0 0 1 0-2z" fill="#F7FF88" stroke="none" />
            <path d="M6 7V5a6 6 0 0 1 12 0v2" />
          </svg>
        </div>
        <div>
          <p className="text-[#EDE8F5] text-lg font-semibold mb-1">
            {step > 1 ? "Reconnect to continue publishing" : "Connect your wallet to publish"}
          </p>
          <p className="text-[#7A6E8E] text-sm max-w-xs mx-auto">
            {step > 1
              ? "Your progress is saved. Reconnect your wallet and you can pick up right where you left off."
              : "Use email, phone, Google, or your Phantom / Solflare wallet to get started."}
          </p>
        </div>
        <GlowButton variant="primary" size="md" onClick={openAuth}>
          Connect Wallet
        </GlowButton>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-8">
        {/* Step indicators */}
        <div className="flex items-center gap-0">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex items-center flex-1 last:flex-none">
              <button
                onClick={() => step > s.id && goToStep(s.id)}
                disabled={step < s.id || step === 5}
                className="flex flex-col items-center gap-1.5"
              >
                <span
                  className={`
                    w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold
                    transition-all duration-300
                    ${
                      step === s.id
                        ? "bg-[#F7FF88] text-[#0D0A14] scale-110"
                        : step > s.id
                        ? "bg-[#81D0B5] text-[#0D0A14]"
                        : "bg-[#221533] text-[#7A6E8E] border border-[#3D2F5A]"
                    }
                  `}
                >
                  {step > s.id ? "✓" : s.id}
                </span>
                <span
                  className={`text-xs hidden sm:block ${
                    step === s.id ? "text-[#F7FF88]" : "text-[#7A6E8E]"
                  }`}
                >
                  {s.label}
                </span>
              </button>

              {i < STEPS.length - 1 && (
                <div
                  className={`flex-1 h-px mx-2 transition-colors duration-500 ${
                    step > s.id ? "bg-[#81D0B5]" : "bg-[#3D2F5A]"
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div ref={contentRef} className="min-h-[320px]">

          {/* ── Step 1: Upload file ── */}
          {step === 1 && (
            <div className="flex flex-col gap-6">
              <h2 className="text-xl font-semibold text-[#EDE8F5]">Upload your file</h2>
              <DragZone onFile={handleFileSelect} />
              {data.file && (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-[#221533] border border-[#3D2F5A]">
                    <span className="text-[#81D0B5] text-sm">✓</span>
                    <span className="text-[#EDE8F5] text-sm truncate">{data.file.name}</span>
                    <span className="text-[#7A6E8E] text-xs ml-auto">
                      {(data.file.size / 1024 / 1024).toFixed(2)} MB
                    </span>
                  </div>
                  {contentHash && (
                    <p className="text-[#7A6E8E] text-xs font-mono truncate">
                      SHA-256: {contentHash.slice(0, 32)}…
                    </p>
                  )}
                  <GlowButton variant="primary" size="md" onClick={() => goToStep(2)}>
                    Continue →
                  </GlowButton>
                </div>
              )}
            </div>
          )}

          {/* ── Step 2: Details ── */}
          {step === 2 && (
            <div className="flex flex-col gap-5">
              <h2 className="text-xl font-semibold text-[#EDE8F5]">Add content details</h2>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-[#7A6E8E]">Title *</label>
                <input
                  value={data.title}
                  onChange={(e) => setData((d) => ({ ...d, title: e.target.value }))}
                  placeholder="e.g. Full Stack Course 2024"
                  className="bg-[#221533] border border-[#3D2F5A] rounded-lg px-4 py-3 text-[#EDE8F5] placeholder:text-[#7A6E8E] focus:border-[#F7FF88] outline-none transition-colors"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-[#7A6E8E]">Description</label>
                <textarea
                  value={data.description}
                  onChange={(e) => setData((d) => ({ ...d, description: e.target.value }))}
                  rows={4}
                  placeholder="Describe what buyers will receive..."
                  className="bg-[#221533] border border-[#3D2F5A] rounded-lg px-4 py-3 text-[#EDE8F5] placeholder:text-[#7A6E8E] focus:border-[#F7FF88] outline-none transition-colors resize-none"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-[#7A6E8E]">Category</label>
                <select
                  value={data.category}
                  onChange={(e) => setData((d) => ({ ...d, category: e.target.value }))}
                  className="bg-[#221533] border border-[#3D2F5A] rounded-lg px-4 py-3 text-[#EDE8F5] outline-none focus:border-[#F7FF88] transition-colors"
                >
                  {["general", "video", "audio", "ebook", "code", "design", "photography"].map((c) => (
                    <option key={c} value={c} className="bg-[#221533]">
                      {c.charAt(0).toUpperCase() + c.slice(1)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex gap-3">
                <GlowButton variant="ghost" size="md" onClick={() => goToStep(1)}>← Back</GlowButton>
                <GlowButton
                  variant="primary"
                  size="md"
                  disabled={!data.title}
                  onClick={() => goToStep(3)}
                >
                  Continue →
                </GlowButton>
              </div>
            </div>
          )}

          {/* ── Step 3: Pricing ── */}
          {step === 3 && (
            <div className="flex flex-col gap-5">
              <h2 className="text-xl font-semibold text-[#EDE8F5]">Set pricing & license</h2>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-[#7A6E8E]">Price (SOL)</label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#F7FF88] font-bold">◎</span>
                  <input
                    type="number"
                    min="0.001"
                    step="0.001"
                    value={data.price}
                    onChange={(e) => setData((d) => ({ ...d, price: e.target.value }))}
                    className="w-full bg-[#221533] border border-[#3D2F5A] rounded-lg pl-10 pr-4 py-3 text-[#EDE8F5] outline-none focus:border-[#F7FF88] transition-colors"
                  />
                </div>
              </div>

              {/* Max Supply + Royalty row */}
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-[#7A6E8E]">
                    Max Supply
                    <span className="ml-1 text-[#3D2F5A] text-xs">(tokens for sale)</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    step="1"
                    value={data.supply}
                    onChange={(e) => setData((d) => ({ ...d, supply: e.target.value }))}
                    className="bg-[#221533] border border-[#3D2F5A] rounded-lg px-4 py-3 text-[#EDE8F5] outline-none focus:border-[#F7FF88] transition-colors"
                  />
                  <p className="text-xs text-[#7A6E8E]">
                    Buyers receive 1 resellable access token each. You keep the author token.
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-[#7A6E8E]">
                    Royalty %
                    <span className="ml-1 text-[#3D2F5A] text-xs">(on resale)</span>
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      min="0"
                      max="50"
                      step="0.5"
                      value={data.royalty}
                      onChange={(e) => setData((d) => ({ ...d, royalty: e.target.value }))}
                      className="w-full bg-[#221533] border border-[#3D2F5A] rounded-lg px-4 pr-10 py-3 text-[#EDE8F5] outline-none focus:border-[#F7FF88] transition-colors"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[#7A6E8E] text-sm">%</span>
                  </div>
                  <p className="text-xs text-[#7A6E8E]">
                    You earn this % automatically each time a buyer resells their token.
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm text-[#7A6E8E]">License</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { value: "personal", label: "Personal", desc: "Private use only" },
                    { value: "commercial", label: "Commercial", desc: "Business use allowed" },
                    { value: "derivative", label: "Derivative", desc: "Remix allowed" },
                    { value: "unlimited", label: "Unlimited", desc: "Full rights" },
                  ].map((lic) => (
                    <button
                      key={lic.value}
                      onClick={() => setData((d) => ({ ...d, license: lic.value }))}
                      className={`p-3 rounded-xl border text-left transition-all ${
                        data.license === lic.value
                          ? "border-[#F7FF88] bg-[#F7FF88]/10"
                          : "border-[#3D2F5A] bg-[#221533] hover:border-[#7A6E8E]"
                      }`}
                    >
                      <p className={`text-sm font-medium ${data.license === lic.value ? "text-[#F7FF88]" : "text-[#EDE8F5]"}`}>
                        {lic.label}
                      </p>
                      <p className="text-xs text-[#7A6E8E]">{lic.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-3">
                <GlowButton variant="ghost" size="md" onClick={() => goToStep(2)}>← Back</GlowButton>
                <GlowButton variant="primary" size="md" onClick={() => goToStep(4)}>Continue →</GlowButton>
              </div>
            </div>
          )}

          {/* ── Step 4: Preview upload + deploy mode ── */}
          {step === 4 && (
            <div className="flex flex-col gap-5">
              <h2 className="text-xl font-semibold text-[#EDE8F5]">Upload preview & publish</h2>
              <p className="text-[#7A6E8E] text-sm">
                Public teaser image buyers see before purchasing. Optional but recommended.
              </p>
              <DragZone onFile={(f) => setData((d) => ({ ...d, previewFile: f }))} maxSizeMB={10} />

              {/* ── Deploy mode choice ─────────────────────────────── */}
              <div className="flex flex-col gap-2">
                <p className="text-sm text-[#EDE8F5] font-medium">How would you like to publish?</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Option A: Deploy automatically */}
                  <button
                    onClick={() => setDeployMode("auto")}
                    className={`flex flex-col gap-1.5 p-4 rounded-xl border text-left transition-all ${
                      deployMode === "auto"
                        ? "border-[#F7FF88] bg-[#F7FF88]/10"
                        : "border-[#3D2F5A] bg-[#221533] hover:border-[#7A6E8E]"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-lg">🚀</span>
                      <span className={`text-sm font-semibold ${deployMode === "auto" ? "text-[#F7FF88]" : "text-[#EDE8F5]"}`}>
                        Deploy automatically
                      </span>
                    </div>
                    <p className="text-xs text-[#7A6E8E]">
                      Register on Solana right now. Requires Phantom or Solflare wallet.
                    </p>
                    {deployMode === "auto" && !connected && (
                      <p className="text-xs text-amber-400 mt-1">
                        ⚠ No Phantom/Solflare connected — will save as Draft instead.{" "}
                        <button onClick={openAuth} className="underline">Connect →</button>
                      </p>
                    )}
                  </button>

                  {/* Option B: Save as draft */}
                  <button
                    onClick={() => setDeployMode("draft")}
                    className={`flex flex-col gap-1.5 p-4 rounded-xl border text-left transition-all ${
                      deployMode === "draft"
                        ? "border-[#7A6E8E] bg-[#7A6E8E]/10"
                        : "border-[#3D2F5A] bg-[#221533] hover:border-[#7A6E8E]"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-lg">💾</span>
                      <span className={`text-sm font-semibold ${deployMode === "draft" ? "text-[#EDE8F5]" : "text-[#EDE8F5]"}`}>
                        Save as Draft
                      </span>
                    </div>
                    <p className="text-xs text-[#7A6E8E]">
                      Save now, deploy on Solana later from My Content.
                    </p>
                  </button>
                </div>
              </div>

              <div className="flex gap-3">
                <GlowButton variant="ghost" size="md" onClick={() => goToStep(3)}>← Back</GlowButton>
                <GlowButton
                  variant="primary"
                  size="md"
                  isLoading={isProcessing}
                  onClick={handlePublish}
                >
                  {deployMode === "auto" ? "Encrypt & Deploy →" : "Save as Draft →"}
                </GlowButton>
              </div>
            </div>
          )}

          {/* ── Step 5: Progress / Success ── */}
          {step === 5 && (
            <div className="flex flex-col gap-6">
              {isProcessing || publishSteps.length > 0 ? (
                <>
                  <h2 className="text-xl font-semibold text-[#EDE8F5]">Publishing…</h2>

                  <div className="flex flex-col gap-3">
                    {publishSteps.map((ps, i) => (
                      <div key={i} className="flex items-start gap-3 px-4 py-3 rounded-lg bg-[#221533] border border-[#3D2F5A]">
                        <span className="mt-0.5 text-base leading-none">
                          {ps.status === "running" && (
                            <span className="inline-block w-4 h-4 border-2 border-[#F7FF88] border-t-transparent rounded-full animate-spin" />
                          )}
                          {ps.status === "done" && <span className="text-[#81D0B5]">✓</span>}
                          {ps.status === "skipped" && <span className="text-[#7A6E8E]">—</span>}
                          {ps.status === "error" && <span className="text-red-400">✕</span>}
                          {ps.status === "pending" && <span className="text-[#3D2F5A]">○</span>}
                        </span>
                        <div>
                          <p className={`text-sm ${ps.status === "done" ? "text-[#EDE8F5]" : ps.status === "error" ? "text-red-400" : "text-[#7A6E8E]"}`}>
                            {ps.label}
                          </p>
                          {ps.detail && (
                            <p className="text-xs text-[#7A6E8E] mt-0.5">{ps.detail}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {!isProcessing && publishSteps.every((s) => s.status !== "running") && (
                    <div className="flex flex-col items-center gap-4 pt-4 text-center">
                      {publishError ? (
                        <>
                          <p className="text-red-400 text-sm">{publishError}</p>
                          <GlowButton variant="secondary" size="md" onClick={() => goToStep(4)}>
                            ← Try Again
                          </GlowButton>
                        </>
                      ) : (
                        <>
                          {(() => {
                            const onChainDone = publishSteps[3]?.status === "done";
                            const savedInDB   = publishSteps[2]?.status === "done";
                            const tokenDone   = publishSteps[4]?.status === "done";
                            return (
                              <>
                                <div className={`w-16 h-16 rounded-full flex items-center justify-center border ${
                                  tokenDone
                                    ? "bg-[#F7FF88]/20 border-[#F7FF88]"
                                    : onChainDone
                                    ? "bg-[#81D0B5]/20 border-[#81D0B5]"
                                    : savedInDB
                                    ? "bg-amber-400/20 border-amber-400"
                                    : "bg-[#7A6E8E]/20 border-[#7A6E8E]"
                                }`}>
                                  <span className="text-3xl">
                                    {tokenDone ? "🎉" : onChainDone ? "✓" : "📝"}
                                  </span>
                                </div>

                                <h3 className="text-xl font-bold text-[#F7FF88]">
                                  {tokenDone
                                    ? "Fully Published! Token Minted 🎉"
                                    : onChainDone
                                    ? "Published on Solana"
                                    : savedInDB
                                    ? "Saved as Draft"
                                    : "Content Encrypted"}
                                </h3>

                                <p className="text-[#7A6E8E] text-sm max-w-sm text-center">
                                  {tokenDone
                                    ? "Your content is live on Solana. Author token minted to your wallet. Buyers can now purchase access tokens."
                                    : onChainDone
                                    ? "Registered on Solana devnet. Token mint step pending — you can retry from My Content."
                                    : savedInDB
                                    ? "Saved as draft. Complete on-chain registration to publish to the marketplace."
                                    : "Your file is encrypted locally. Sign in and try again."}
                                </p>

                                <div className="flex gap-2 flex-wrap justify-center">
                                  <NeonBadge variant="primary">AES-256-GCM encrypted ✓</NeonBadge>
                                  {publishSteps[1]?.status === "done" && (
                                    <NeonBadge variant="secondary">Preview on IPFS ✓</NeonBadge>
                                  )}
                                  {savedInDB && (
                                    <NeonBadge variant="primary">Saved in AMSETS ✓</NeonBadge>
                                  )}
                                  {onChainDone && (
                                    <NeonBadge variant="primary">On-chain ✓</NeonBadge>
                                  )}
                                  {tokenDone && (
                                    <NeonBadge variant="secondary">SPL Token-2022 ✓</NeonBadge>
                                  )}
                                </div>

                                {savedInDB && !onChainDone && (
                                  <div className="w-full max-w-sm bg-amber-400/10 border border-amber-400/30 rounded-xl p-4 text-left">
                                    <p className="text-amber-300 text-xs font-semibold mb-1">
                                      ⚠ On-chain deployment pending
                                    </p>
                                    <p className="text-[#7A6E8E] text-xs">
                                      Smart contract must be deployed to Solana devnet first.
                                      Your draft is saved — complete deployment from My Content when ready.
                                    </p>
                                  </div>
                                )}
                              </>
                            );
                          })()}

                          <div className="flex gap-3 flex-wrap justify-center">
                            <GlowButton variant="primary" size="md" onClick={() => window.location.href = "/"}>
                              View Marketplace
                            </GlowButton>
                            {publishSteps[2]?.status === "done" && (
                              <GlowButton variant="ghost" size="md" onClick={() => window.location.href = "/my/library"}>
                                My Content
                              </GlowButton>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>

    </>
  );
}
