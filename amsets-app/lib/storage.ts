/**
 * Client-side storage utilities for Arweave (via Irys) and IPFS (via Pinata).
 *
 * Preferred Upload Flow (Phase 1 — decentralized bundle):
 *   1. generateSymmetricKey()
 *   2. encryptFile(key, buffer) → { ciphertext, iv }
 *   3. packEncrypted(iv, ciphertext) → packed ArrayBuffer
 *   4. encryptKeyForContent(key, accessMint) → litBundle
 *   5. encodeBundle({ metadata, previewUri, encryptedBuffer, litBundle, accessMint })
 *   6. uploadBundleToArweave(bundle, wallet) → ar://{txId}
 *
 * The bundle JSON embeds the encrypted file + Lit key — no backend storage needed.
 *
 * IMPORTANT: `wallet` must be the full result of useWallet() from
 * @solana/wallet-adapter-react — NOT wallet.adapter or window.solana.
 * The @irys/web-upload-solana package uses the full wallet context internally.
 */

import { packEncrypted, unpackEncrypted } from "./crypto";
import type { AmsetsBundle } from "./arweave-bundle";

// ─── Irys (Arweave) upload ────────────────────────────────────────────────────

export interface ArweaveUploadResult {
  txId: string;
  uri: string; // "ar://{txId}"
  size: number;
}

/**
 * Upload encrypted file bytes to Arweave via Irys (browser-safe SDK).
 *
 * @param encryptedBuffer - Packed iv+ciphertext buffer
 * @param mimeType        - Original file MIME type (stored as tag)
 * @param title           - Content title (stored as tag)
 * @param wallet          - Full useWallet() result from @solana/wallet-adapter-react
 */
export async function uploadToArweave(
  encryptedBuffer: ArrayBuffer,
  mimeType: string,
  title: string,
  wallet: any
): Promise<ArweaveUploadResult> {
  const { WebUploader } = await import("@irys/web-upload");
  const { WebSolana }   = await import("@irys/web-upload-solana");

  const irys = await WebUploader(WebSolana).withProvider(wallet);

  const uint8 = new Uint8Array(encryptedBuffer);

  // Check balance and fund if needed (devnet requires confirmed balance)
  try {
    const price   = await irys.getPrice(uint8.byteLength);
    const balance = await irys.getLoadedBalance();
    if (balance.lt(price)) {
      const fundAmount = price.multipliedBy(1.2).integerValue();
      await irys.fund(fundAmount);
      // Solana devnet needs ~30-60s for finalized status — wait before uploading
      await new Promise((resolve) => setTimeout(resolve, 45_000));
    }
  } catch {
    // Balance check is non-fatal
  }

  const tags = [
    { name: "Content-Type",      value: "application/octet-stream" },
    { name: "AMSETS-MIME-Type",  value: mimeType },
    { name: "AMSETS-Title",      value: title },
    { name: "AMSETS-Encrypted",  value: "AES-256-GCM" },
  ];

  const receipt = await irys.upload(Buffer.from(uint8), { tags });

  return {
    txId: receipt.id,
    uri: `ar://${receipt.id}`,
    size: uint8.byteLength,
  };
}

/**
 * Upload an AmsetsBundle JSON document to Arweave via Irys (browser-safe SDK).
 * This is the Phase 1 preferred upload method — stores all content metadata,
 * encrypted payload, and Lit key bundle in a single permanent document.
 *
 * @param bundle  - Complete AmsetsBundle object to upload
 * @param wallet  - Full useWallet() result from @solana/wallet-adapter-react
 */
export async function uploadBundleToArweave(
  bundle: AmsetsBundle,
  wallet: any
): Promise<ArweaveUploadResult> {
  // Dynamic import — avoids SSR issues and keeps bundle lean
  const { WebUploader } = await import("@irys/web-upload");
  const { WebSolana }   = await import("@irys/web-upload-solana");

  // Pass the full useWallet() object — Irys uses publicKey + signTransaction internally
  const irys = await WebUploader(WebSolana).withProvider(wallet);

  const json  = JSON.stringify(bundle);
  const uint8 = new TextEncoder().encode(json);

  // Check balance and fund if needed.
  // On Solana devnet, a finalized tx takes 30-60 s — wait before uploading.
  // On mainnet Irys uses lazy funding so this step is usually a no-op.
  try {
    const price   = await irys.getPrice(uint8.byteLength);
    const balance = await irys.getLoadedBalance();
    if (balance.lt(price)) {
      const fundAmount = price.multipliedBy(1.2).integerValue();
      await irys.fund(fundAmount);
      await new Promise((resolve) => setTimeout(resolve, 45_000));
    }
  } catch {
    // Balance check is non-fatal — let upload attempt and surface any real error
  }

  const tags = [
    { name: "Content-Type",      value: "application/json" },
    { name: "AMSETS-Bundle",     value: "1.0" },
    { name: "AMSETS-Title",      value: bundle.metadata.title },
    { name: "AMSETS-MIME-Type",  value: bundle.metadata.mime_type },
    { name: "AMSETS-Hash",       value: bundle.metadata.content_hash },
    { name: "AMSETS-Encrypted",  value: "AES-256-GCM+Lit" },
    { name: "AMSETS-Access",     value: bundle.access.access_mint },
  ];

  const receipt = await irys.upload(Buffer.from(uint8), { tags });

  return {
    txId: receipt.id,
    uri:  `ar://${receipt.id}`,
    size: uint8.byteLength,
  };
}

/**
 * Download and return the packed encrypted buffer from Arweave.
 */
export async function downloadFromArweave(arweaveUri: string): Promise<ArrayBuffer> {
  const txId = arweaveUri.replace("ar://", "");
  const gateway = process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY ?? "https://arweave.net";
  const url = `${gateway}/${txId}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch from Arweave: ${response.status}`);
  }

  return response.arrayBuffer();
}

// ─── IPFS preview upload ──────────────────────────────────────────────────────

export interface IpfsUploadResult {
  cid: string;
  uri: string; // "ipfs://{cid}"
  gatewayUrl: string;
}

/**
 * Upload a preview image to IPFS via Pinata.
 * Preview images are NOT encrypted — they are public teasers.
 *
 * @param file - Preview image File object
 */
export async function uploadPreviewToIPFS(file: File): Promise<IpfsUploadResult> {
  const jwt = process.env.NEXT_PUBLIC_PINATA_JWT;
  if (!jwt) throw new Error("NEXT_PUBLIC_PINATA_JWT not configured");

  const formData = new FormData();
  formData.append("file", file);
  formData.append(
    "pinataMetadata",
    JSON.stringify({ name: `amsets-preview-${Date.now()}` })
  );

  const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: formData,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Pinata upload failed: ${err}`);
  }

  const data = (await response.json()) as { IpfsHash: string };
  const gateway = process.env.NEXT_PUBLIC_PINATA_GATEWAY ?? "https://gateway.pinata.cloud";

  return {
    cid: data.IpfsHash,
    uri: `ipfs://${data.IpfsHash}`,
    gatewayUrl: `${gateway}/ipfs/${data.IpfsHash}`,
  };
}

/**
 * Resolve an IPFS URI to an HTTP gateway URL for display in the browser.
 */
export function resolveIPFS(uri: string): string {
  if (!uri.startsWith("ipfs://")) return uri;
  const cid = uri.replace("ipfs://", "");
  const gateway = process.env.NEXT_PUBLIC_PINATA_GATEWAY ?? "https://gateway.pinata.cloud";
  return `${gateway}/ipfs/${cid}`;
}

export { unpackEncrypted };
