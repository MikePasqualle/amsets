/**
 * Storage service — wraps Irys (Arweave) and Pinata (IPFS).
 *
 * Irys: permanent encrypted content upload → returns "ar://{txId}"
 * Pinata: preview images + metadata JSON → returns "ipfs://{cid}"
 */

// ─── Pinata ───────────────────────────────────────────────────────────────────

interface PinataResponse {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
}

/**
 * Upload a JSON metadata object to IPFS via Pinata.
 * Returns the full "ipfs://{cid}" URI.
 */
export async function uploadMetadataToPinata(
  metadata: Record<string, unknown>,
  name: string
): Promise<string> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT not configured");

  const body = JSON.stringify({
    pinataContent: metadata,
    pinataMetadata: { name },
  });

  const response = await fetch(
    "https://api.pinata.cloud/pinning/pinJSONToIPFS",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body,
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Pinata upload failed: ${err}`);
  }

  const data = (await response.json()) as PinataResponse;
  return `ipfs://${data.IpfsHash}`;
}

/**
 * Build the content metadata JSON for a registered piece of IP.
 */
export function buildContentMetadata(params: {
  title: string;
  description: string;
  author: string;
  contentId: string;
  contentHash: string;
  previewUri: string;
  license: string;
  category: string;
}): Record<string, unknown> {
  return {
    name: params.title,
    description: params.description,
    image: params.previewUri,
    attributes: [
      { trait_type: "Author", value: params.author },
      { trait_type: "Content ID", value: params.contentId },
      { trait_type: "SHA-256 Hash", value: params.contentHash },
      { trait_type: "License", value: params.license },
      { trait_type: "Category", value: params.category },
    ],
    properties: {
      category: params.category,
      files: [{ uri: params.previewUri, type: "image/jpeg" }],
    },
  };
}

// ─── Irys / Arweave ───────────────────────────────────────────────────────────

/**
 * Note: Irys uploads are done client-side in the browser (amsets-app/lib/storage.ts)
 * to avoid sending encrypted content through the backend.
 *
 * The backend only receives the resulting Arweave transaction ID after the
 * client-side upload and stores "ar://{txId}" in the database.
 *
 * This function validates an Arweave transaction ID format.
 */
export function validateArweaveUri(uri: string): boolean {
  if (!uri.startsWith("ar://")) return false;
  const txId = uri.replace("ar://", "");
  // Standard Arweave TxIDs are 43 base64url chars; Irys devnet may vary slightly.
  // Accept any non-empty base64url string (32–64 chars) to handle both environments.
  return /^[a-zA-Z0-9_-]{32,64}$/.test(txId);
}
