/**
 * Livepeer routes — video upload & JWT-gated playback.
 *
 * POST /api/v1/livepeer/request-upload
 *   Auth: Bearer JWT (any registered user)
 *   Body: { name: string }
 *   Returns: { tusUploadUrl, assetId, playbackId, storageUri }
 *
 * GET /api/v1/livepeer/playback-jwt/:contentId
 *   Auth: Bearer JWT (buyer or author)
 *   Returns: { jwt } — ES256 token for Livepeer Player
 *
 * GET /api/v1/livepeer/asset-status/:assetId
 *   Auth: Bearer JWT
 *   Returns: { status, playbackId } — "ready" means playable
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index";
import { content as contentTable, purchases } from "../db/schema";
import { verifyUserJwt } from "../services/jwt.service";
import {
  createLivepeerAsset,
  signPlaybackJwt,
  getAssetStatus,
} from "../services/livepeer.service";

export const livepeerRouter = new Hono();

function extractWallet(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return verifyUserJwt(authHeader.replace("Bearer ", "")).sub;
  } catch {
    return null;
  }
}

// ─── POST /request-upload ─────────────────────────────────────────────────────

const requestUploadSchema = z.object({
  name: z.string().min(1).max(200),
});

livepeerRouter.post(
  "/request-upload",
  zValidator("json", requestUploadSchema),
  async (c) => {
    const wallet = extractWallet(c.req.header("authorization"));
    if (!wallet) return c.json({ error: "Unauthorized" }, 401);

    const { name } = c.req.valid("json");

    try {
      const asset = await createLivepeerAsset(name);
      return c.json({
        tusUploadUrl: asset.tusUploadUrl,
        assetId:      asset.assetId,
        playbackId:   asset.playbackId,
        storageUri:   `livepeer://${asset.playbackId}`,
      });
    } catch (err: any) {
      console.error("[livepeer] request-upload error:", err?.message);
      return c.json({ error: err?.message ?? "Failed to create Livepeer asset" }, 500);
    }
  }
);

// ─── GET /playback-jwt/:contentId ────────────────────────────────────────────

livepeerRouter.get("/playback-jwt/:contentId", async (c) => {
  const wallet = extractWallet(c.req.header("authorization"));
  if (!wallet) return c.json({ error: "Unauthorized" }, 401);

  const { contentId } = c.req.param();

  // Load content record
  const [row] = await db
    .select({
      storageUri:   contentTable.storageUri,
      authorWallet: contentTable.authorWallet,
      status:       contentTable.status,
    })
    .from(contentTable)
    .where(eq(contentTable.contentId, contentId))
    .limit(1);

  if (!row) return c.json({ error: "Content not found" }, 404);
  if (row.status !== "active") return c.json({ error: "Content not published" }, 403);

  // Verify storage type
  if (!row.storageUri.startsWith("livepeer://")) {
    return c.json({ error: "Content is not stored on Livepeer" }, 400);
  }

  const playbackId = row.storageUri.replace("livepeer://", "");

  // Access check: author always has access
  const isAuthor = row.authorWallet.toLowerCase() === wallet.toLowerCase();

  if (!isAuthor) {
    // Check if user has a purchase record for this content
    const [purchase] = await db
      .select({ id: purchases.id })
      .from(purchases)
      .where(
        and(
          eq(purchases.contentId, contentId),
          eq(purchases.buyerWallet, wallet)
        )
      )
      .limit(1);

    if (!purchase) {
      return c.json({ error: "Access denied — purchase required" }, 403);
    }
  }

  try {
    const token = signPlaybackJwt(playbackId);
    return c.json({ jwt: token, playbackId });
  } catch (err: any) {
    console.error("[livepeer] JWT signing error:", err?.message);
    // If signing keys not configured, return playbackId without JWT
    // (works for public/unprotected assets during development)
    if (err?.message?.includes("not set")) {
      console.warn("[livepeer] No signing keys — returning playbackId without JWT (dev mode)");
      return c.json({ jwt: null, playbackId });
    }
    return c.json({ error: "JWT signing failed" }, 500);
  }
});

// ─── GET /asset-status/:assetId ──────────────────────────────────────────────

livepeerRouter.get("/asset-status/:assetId", async (c) => {
  const wallet = extractWallet(c.req.header("authorization"));
  if (!wallet) return c.json({ error: "Unauthorized" }, 401);

  const { assetId } = c.req.param();

  try {
    const status = await getAssetStatus(assetId);
    return c.json(status);
  } catch (err: any) {
    return c.json({ error: err?.message ?? "Failed to fetch asset status" }, 500);
  }
});
