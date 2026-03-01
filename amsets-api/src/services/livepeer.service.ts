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
 * Fetches the real HLS playback URL for an asset from the Livepeer /api/playback
 * endpoint. The URL domain changes per asset (e.g. vod-cdn.lp-playback.studio)
 * so we must NOT hardcode it — always resolve it through this endpoint.
 *
 * Returns the HLS URL and the asset status ("ready" | "transcoding" | "not_found").
 */
export async function resolvePlaybackUrl(playbackId: string): Promise<{
  hlsUrl:      string | null;
  assetStatus: "ready" | "transcoding" | "not_found";
}> {
  try {
    // Step 1: confirm the asset is ready via Studio API
    const assetRes = await fetch(
      `${LIVEPEER_API_BASE}/asset?playbackId=${playbackId}`,
      { headers: { Authorization: `Bearer ${getApiKey()}` } }
    );
    const assets = assetRes.ok ? (await assetRes.json() as any[]) : [];
    if (!Array.isArray(assets) || assets.length === 0) {
      return { hlsUrl: null, assetStatus: "not_found" };
    }
    const phase = assets[0]?.status?.phase as string | undefined;
    if (phase !== "ready") {
      return { hlsUrl: null, assetStatus: "transcoding" };
    }

    // Step 2: get the actual CDN URL from the playback info endpoint
    const playbackRes = await fetch(
      `${LIVEPEER_API_BASE}/playback/${playbackId}`,
      { headers: { Authorization: `Bearer ${getApiKey()}` } }
    );
    if (!playbackRes.ok) {
      return { hlsUrl: null, assetStatus: "not_found" };
    }
    const playbackData = await playbackRes.json() as Record<string, any>;
    const sources: any[] = playbackData?.meta?.source ?? [];
    const hlsSource = sources.find(
      (s: any) => s.type === "html5/application/vnd.apple.mpegurl" || s.hrn === "HLS (TS)"
    );

    if (!hlsSource?.url) {
      // Fallback: Livepeer sometimes only has MP4 for very short clips
      const mp4Source = sources.find((s: any) => s.type?.includes("mp4"));
      return { hlsUrl: mp4Source?.url ?? null, assetStatus: mp4Source ? "ready" : "not_found" };
    }

    return { hlsUrl: hlsSource.url, assetStatus: "ready" };
  } catch (err) {
    console.error("[livepeer] resolvePlaybackUrl error:", err);
    return { hlsUrl: null, assetStatus: "not_found" };
  }
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
