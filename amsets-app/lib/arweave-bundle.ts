/**
 * AMSETS Arweave Content Bundle format.
 *
 * Everything needed to view and access a piece of content is stored in
 * a single JSON document uploaded to Arweave (ar://{txId}).
 * Because the payload is AES-256-GCM encrypted, the document is safe to
 * publish publicly — only holders of the Lit Protocol access key can decrypt.
 *
 * Bundle schema version: "1.0"
 *
 * {
 *   version: "1.0",
 *   amsets: true,
 *   metadata: { title, description, category, tags, mime_type, content_hash },
 *   preview_uri: "ipfs://...",
 *   encrypted_payload: { ciphertext_b64, iv_b64 },
 *   lit_bundle: { ciphertext, data_to_encrypt_hash },
 *   access: { type: "sol_token_balance", access_mint: "<SPL mint pubkey>" }
 * }
 */

import { packEncrypted, unpackEncrypted } from "./crypto";

const ARWEAVE_GATEWAY =
  process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY ?? "https://arweave.net";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AmsetsBundleMetadata {
  title: string;
  description?: string;
  category?: string;
  tags?: string[];
  mime_type: string;
  content_hash: string; // SHA-256 hex
}

export interface AmsetsLitBundle {
  /** Lit-encrypted symmetric key ciphertext (Lit v7 format) */
  ciphertext: string;
  /** SHA-256 hash of the encrypted data, used for integrity + decryption */
  data_to_encrypt_hash: string;
}

export interface AmsetsBundle {
  version: "1.0";
  amsets: true;
  metadata: AmsetsBundleMetadata;
  preview_uri: string;
  encrypted_payload: {
    /** Base64-encoded AES-GCM ciphertext */
    ciphertext_b64: string;
    /** Base64-encoded 12-byte AES-GCM IV */
    iv_b64: string;
  };
  lit_bundle: AmsetsLitBundle;
  access: {
    type: "sol_token_balance";
    /** SPL mint pubkey — buyers receive 1 token, which unlocks Lit decryption */
    access_mint: string;
  };
}

// ─── Encode ───────────────────────────────────────────────────────────────────

export interface EncodeBundleParams {
  metadata: AmsetsBundleMetadata;
  previewUri: string;
  /** Packed iv+ciphertext buffer (output of packEncrypted) */
  encryptedBuffer: ArrayBuffer;
  litBundle: AmsetsLitBundle;
  accessMint: string;
}

/**
 * Safe base64 encoding that works for arbitrarily large Uint8Arrays.
 *
 * The naive `btoa(String.fromCharCode(...bytes))` spreads all bytes as
 * individual function arguments, which causes "Maximum call stack size exceeded"
 * for files larger than ~250 KB. This implementation processes the data
 * in 8 KB chunks to avoid that limit.
 */
function toBase64Safe(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Assembles an AmsetsBundle from the provided components.
 * The encrypted payload is base64-encoded for JSON storage using a
 * chunk-safe encoder (handles files of any size without stack overflow).
 */
export function encodeBundle(params: EncodeBundleParams): AmsetsBundle {
  const { iv, ciphertext } = unpackEncrypted(params.encryptedBuffer);

  return {
    version: "1.0",
    amsets: true,
    metadata: params.metadata,
    preview_uri: params.previewUri,
    encrypted_payload: {
      ciphertext_b64: toBase64Safe(new Uint8Array(ciphertext)),
      iv_b64:         toBase64Safe(iv),
    },
    lit_bundle: params.litBundle,
    access: {
      type: "sol_token_balance",
      access_mint: params.accessMint,
    },
  };
}

// ─── Decode ───────────────────────────────────────────────────────────────────

/**
 * Fetches the Arweave bundle JSON by txId and parses it.
 * Returns null if the bundle is missing, malformed or not an AMSETS bundle.
 */
export async function decodeBundle(
  arweaveUri: string
): Promise<AmsetsBundle | null> {
  const txId = arweaveUri.replace(/^ar:\/\//, "");

  // Reject placeholder URIs
  if (txId.startsWith("pending_")) return null;

  const url = `${ARWEAVE_GATEWAY}/${txId}`;

  try {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) return null;

    const data = await res.json();

    // Validate that this is an AMSETS bundle
    if (data?.amsets !== true || data?.version !== "1.0") return null;

    return data as AmsetsBundle;
  } catch {
    return null;
  }
}

/**
 * Re-assembles the packed ArrayBuffer (iv + ciphertext) from a bundle.
 * Used in ContentViewer to prepare the buffer for decryptFile().
 */
export function bundleToEncryptedBuffer(bundle: AmsetsBundle): ArrayBuffer {
  const fromBase64 = (b64: string): Uint8Array => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  };

  const iv           = fromBase64(bundle.encrypted_payload.iv_b64);
  const ciphertext   = fromBase64(bundle.encrypted_payload.ciphertext_b64);

  return packEncrypted(iv, ciphertext.buffer as ArrayBuffer);
}
