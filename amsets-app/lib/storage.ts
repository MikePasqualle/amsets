/**
 * Client-side storage utilities.
 *
 * Current mode (Livepeer):
 *   Videos are uploaded to Livepeer Studio via TUS (handled in UploadSteps.tsx).
 *   This file now only exposes uploadPreviewToIPFS for preview images.
 *
 * Legacy Arweave/Irys upload functions are commented out below.
 * To restore: uncomment the Arweave block and re-add imports.
 */

// ── Arweave/Irys imports commented out ────────────────────────────────────────
// import { packEncrypted, unpackEncrypted } from "./crypto";
// import type { AmsetsBundle } from "./arweave-bundle";
// ─────────────────────────────────────────────────────────────────────────────


// ── ARWEAVE UPLOAD FUNCTIONS (commented out — replaced by Livepeer) ───────────
//
// export interface ArweaveUploadResult { txId: string; uri: string; size: number; }
//
// export async function uploadToArweave(
//   encryptedBuffer: ArrayBuffer, mimeType: string, title: string, wallet: any
// ): Promise<ArweaveUploadResult> {
//   const { WebUploader } = await import("@irys/web-upload");
//   const { WebSolana }   = await import("@irys/web-upload-solana");
//   const rpcUrl  = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
//   const isDevnet = (process.env.NEXT_PUBLIC_IRYS_NETWORK ?? "devnet") === "devnet";
//   const irysBuilder = WebUploader(WebSolana).withProvider(wallet).withRpc(rpcUrl);
//   const irys = await (isDevnet ? irysBuilder.devnet() : irysBuilder);
//   // ... fund + upload ...
// }
//
// export async function uploadBundleToArweave(
//   bundle: AmsetsBundle, wallet: any, onProgress?: (msg: string) => void,
//   solanaConnection?: any, walletPublicKey?: any
// ): Promise<ArweaveUploadResult> {
//   // Full Irys TUS upload with balance check + retry + wait flow
//   // (see git history for full implementation)
// }
//
// export async function downloadFromArweave(arweaveUri: string): Promise<ArrayBuffer> {
//   const txId = arweaveUri.replace("ar://", "");
//   const gateway = process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY ?? "https://arweave.net";
//   const res = await fetch(`${gateway}/${txId}`);
//   if (!res.ok) throw new Error(`Arweave fetch failed: ${res.status}`);
//   return res.arrayBuffer();
// }
// ─────────────────────────────────────────────────────────────────────────────

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

// export { unpackEncrypted }; // Arweave legacy — not needed for Livepeer mode
