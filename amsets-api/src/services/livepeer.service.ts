/**
 * Livepeer Studio service — video upload and JWT-gated playback.
 *
 * ENV required:
 *   LIVEPEER_API_KEY        — Studio API key (server-side only)
 *   LIVEPEER_SIGNING_KEY_ID — ID of the signing key created in Studio
 *   LIVEPEER_PRIVATE_KEY    — Base64-encoded PEM private key for ES256 JWT signing
 *
 * Flow:
 *   1. createAsset()        → backend requests TUS upload URL from Livepeer Studio
 *   2. Frontend uploads video directly to TUS URL (no API key exposed)
 *   3. storageUri stored as "livepeer://{playbackId}"
 *   4. signPlaybackJwt()    → backend signs ES256 JWT for authorized viewers
 *   5. Frontend passes JWT to Livepeer Player
 */

import jwt from "jsonwebtoken";

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
      // Gate playback with signed JWTs — only authorized viewers can watch
      playbackPolicy: { type: "jwt" },
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
 * Signs an ES256 JWT that allows an authorized viewer to play the gated asset.
 * The JWT is valid for 1 hour and is passed to the Livepeer Player component.
 *
 * JWT claims required by Livepeer Studio:
 *   sub    — playback ID of the asset
 *   action — "pull"
 *   pub    — signing key ID from Studio
 *   iss    — "Livepeer"
 *   exp    — Unix timestamp (1 hour from now)
 */
export function signPlaybackJwt(playbackId: string): string {
  const signingKeyId  = process.env.LIVEPEER_SIGNING_KEY_ID;
  const privateKeyB64 = process.env.LIVEPEER_PRIVATE_KEY;

  if (!signingKeyId || !privateKeyB64) {
    throw new Error("LIVEPEER_SIGNING_KEY_ID or LIVEPEER_PRIVATE_KEY is not set");
  }

  // Decode base64-encoded PEM private key stored in env
  const privateKey = Buffer.from(privateKeyB64, "base64").toString("utf-8");

  const token = jwt.sign(
    {
      sub:    playbackId,
      action: "pull",
      pub:    signingKeyId,
      iss:    "Livepeer",
    },
    privateKey,
    {
      algorithm: "ES256",
      expiresIn: "1h",
    }
  );

  return token;
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
