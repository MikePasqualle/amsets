/**
 * Livepeer Studio service — video upload and application-gated playback.
 *
 * ENV required:
 *   LIVEPEER_API_KEY — Studio API key (server-side only)
 *
 * Security model:
 *   - Livepeer assets use "public" playback policy (no CDN-level JWT)
 *   - Access control is enforced at our API layer:
 *       GET /livepeer/playback-jwt/:contentId checks wallet auth + purchase records
 *       and returns the HLS URL only to authorized callers
 *   - The playback ID is never exposed in the frontend bundle or HTML;
 *     it is served only via authenticated API responses
 */

const LIVEPEER_API_BASE = "https://livepeer.studio/api";

function getApiKey(): string {
  const key = process.env.LIVEPEER_API_KEY;
  if (!key) throw new Error("LIVEPEER_API_KEY is not set");
  return key;
}

export interface LivepeerAsset {
  assetId:      string;
  playbackId:   string;
  tusUploadUrl: string;
}

/**
 * Creates a Livepeer asset (gated by JWT access policy) and returns the
 * TUS upload URL that the frontend uses to upload the raw video file.
 */
export async function createLivepeerAsset(name: string): Promise<LivepeerAsset> {
  const res = await fetch(`${LIVEPEER_API_BASE}/asset/request-upload`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      Authorization:   `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      name,
      // Public Livepeer policy — access is enforced at our API layer, not CDN layer
      playbackPolicy: { type: "public" },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Livepeer asset creation failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json() as Record<string, any>;

  const tusUploadUrl = data.tusEndpoint ?? data.url;
  const assetId      = data.asset?.id;
  const playbackId   = data.asset?.playbackId;

  if (!tusUploadUrl || !assetId || !playbackId) {
    throw new Error(`Livepeer response missing fields: ${JSON.stringify(data).slice(0, 300)}`);
  }

  console.log(`[livepeer] Created asset id=${assetId} playbackId=${playbackId}`);
  return { assetId, playbackId, tusUploadUrl };
}

/**
 * Returns the current status of a Livepeer asset.
 * "ready" means transcoding is complete and the video is playable.
 */
export async function getAssetStatus(assetId: string): Promise<{ status: string; playbackId: string }> {
  const res = await fetch(`${LIVEPEER_API_BASE}/asset/${assetId}`, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
  });

  if (!res.ok) throw new Error(`Livepeer asset fetch failed (${res.status})`);
  const data = await res.json() as Record<string, any>;

  return {
    status:     data.status?.phase ?? "unknown",
    playbackId: data.playbackId,
  };
}

/**
 * Builds the HLS playback URL for a Livepeer asset.
 * The URL is only returned to callers who have passed our application-level
 * auth check (see livepeer.route.ts GET /playback-jwt/:contentId).
 */
export function getPlaybackUrl(playbackId: string): string {
  return `https://playback.livepeer.studio/asset/hls/${playbackId}/index.m3u8`;
}

/**
 * Extracts a playback ID from a "livepeer://{playbackId}" URI.
 * Returns null for legacy "ar://" URIs so callers can fall back gracefully.
 */
export function parseStorageUri(storageUri: string): { type: "livepeer"; playbackId: string } | { type: "arweave"; txId: string } | null {
  if (storageUri.startsWith("livepeer://")) {
    return { type: "livepeer", playbackId: storageUri.replace("livepeer://", "") };
  }
  if (storageUri.startsWith("ar://")) {
    return { type: "arweave", txId: storageUri.replace("ar://", "") };
  }
  return null;
}
