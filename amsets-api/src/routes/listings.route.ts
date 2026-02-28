/**
 * Listings Route — secondary market for AMSETS access tokens.
 *
 * POST   /api/v1/listings               — create a new listing (JWT auth)
 * GET    /api/v1/listings/:contentId    — get active listings for a content item (public)
 * DELETE /api/v1/listings/:id           — cancel a listing (JWT auth, seller only)
 * PATCH  /api/v1/listings/:id/sold      — mark a listing as sold (JWT auth, buyer)
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/index";
import { listings, content as contentTable } from "../db/schema";
import { verifyUserJwt } from "../services/jwt.service";

export const listingsRouter = new Hono();

function extractWallet(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return verifyUserJwt(authHeader.replace("Bearer ", "")).sub;
  } catch {
    return null;
  }
}

// ─── POST / — create listing ──────────────────────────────────────────────────

const createListingSchema = z.object({
  content_id:     z.string().min(1),
  price_lamports: z.number().int().positive(),
  mint_address:   z.string().optional(),   // Optional — content may not have SPL mint yet
  token_account:  z.string().optional(),
});

listingsRouter.post(
  "/",
  zValidator("json", createListingSchema),
  async (c) => {
    const sellerWallet = extractWallet(c.req.header("authorization"));
    if (!sellerWallet) return c.json({ error: "Unauthorized" }, 401);

    const body = c.req.valid("json");

    // Verify content exists and has the given mint
    const [row] = await db
      .select({ mintAddress: contentTable.mintAddress, status: contentTable.status })
      .from(contentTable)
      .where(eq(contentTable.contentId, body.content_id))
      .limit(1);

    if (!row) return c.json({ error: "Content not found" }, 404);
    if (row.status !== "active")
      return c.json({ error: "Cannot list draft content" }, 400);
    // Only validate mint match when both the content record AND the request have a mint
    if (row.mintAddress && body.mint_address && row.mintAddress !== body.mint_address)
      return c.json({ error: "mint_address does not match content" }, 400);

    // Prevent duplicate active listings from same seller
    const [existing] = await db
      .select({ id: listings.id })
      .from(listings)
      .where(
        and(
          eq(listings.contentId, body.content_id),
          eq(listings.sellerWallet, sellerWallet),
          eq(listings.status, "active")
        )
      )
      .limit(1);

    if (existing) return c.json({ error: "You already have an active listing for this content" }, 409);

    // Use content's mintAddress if the request omitted it
    const effectiveMint = body.mint_address ?? row.mintAddress ?? null;

    const [created] = await db
      .insert(listings)
      .values({
        contentId:     body.content_id,
        sellerWallet,
        priceLamports: BigInt(body.price_lamports),
        mintAddress:   effectiveMint,
        tokenAccount:  body.token_account ?? null,
        status:        "active",
      })
      .returning();

    return c.json({ listing: created }, 201);
  }
);

// ─── GET /:contentId — active listings ────────────────────────────────────────

listingsRouter.get("/:contentId", async (c) => {
  const { contentId } = c.req.param();

  const rows = await db
    .select()
    .from(listings)
    .where(and(eq(listings.contentId, contentId), eq(listings.status, "active")))
    .orderBy(desc(listings.createdAt));

  return c.json({
    listings: rows.map((r) => ({
      ...r,
      price_lamports: r.priceLamports.toString(),
    })),
  });
});

// ─── DELETE /:id — cancel listing ─────────────────────────────────────────────

listingsRouter.delete("/:id", async (c) => {
  const sellerWallet = extractWallet(c.req.header("authorization"));
  if (!sellerWallet) return c.json({ error: "Unauthorized" }, 401);

  const { id } = c.req.param();

  const [row] = await db
    .select({ sellerWallet: listings.sellerWallet, status: listings.status })
    .from(listings)
    .where(eq(listings.id, id))
    .limit(1);

  if (!row) return c.json({ error: "Listing not found" }, 404);
  if (row.sellerWallet !== sellerWallet)
    return c.json({ error: "Forbidden — not your listing" }, 403);
  if (row.status !== "active")
    return c.json({ error: "Listing is already closed" }, 400);

  await db
    .update(listings)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(listings.id, id));

  return c.json({ ok: true });
});

// ─── PATCH /:id/sold — mark listing sold (called by buyer after transfer) ─────

const soldSchema = z.object({ tx_signature: z.string().min(40) });

listingsRouter.patch(
  "/:id/sold",
  zValidator("json", soldSchema),
  async (c) => {
    const buyerWallet = extractWallet(c.req.header("authorization"));
    if (!buyerWallet) return c.json({ error: "Unauthorized" }, 401);

    const { id } = c.req.param();

    const [row] = await db
      .select({ status: listings.status })
      .from(listings)
      .where(eq(listings.id, id))
      .limit(1);

    if (!row) return c.json({ error: "Listing not found" }, 404);
    if (row.status !== "active") return c.json({ error: "Listing is already closed" }, 400);

    await db
      .update(listings)
      .set({ status: "sold", updatedAt: new Date() })
      .where(eq(listings.id, id));

    return c.json({ ok: true });
  }
);
