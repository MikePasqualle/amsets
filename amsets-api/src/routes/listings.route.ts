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
import { Connection } from "@solana/web3.js";
import { db } from "../db/index";
import { listings, content as contentTable, purchases } from "../db/schema";
import { verifyUserJwt } from "../services/jwt.service";
import { transferTokenFromSeller } from "../services/mint.service";

const solanaConnection = new Connection(
  `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
  "confirmed"
);

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

    const { priceLamports, ...rest } = created;
    return c.json({ listing: { ...rest, price_lamports: priceLamports.toString() } }, 201);
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
    listings: rows.map(({ priceLamports, ...r }) => ({
      ...r,
      price_lamports: priceLamports.toString(),
    })),
  });
});

// ─── GET /check-sold/:contentId?wallet= — was this wallet a seller who sold? ──
// Used by frontend access-check to revoke viewing rights after a successful sale.

listingsRouter.get("/check-sold/:contentId", async (c) => {
  const { contentId } = c.req.param();
  const wallet        = c.req.query("wallet") ?? "";
  if (!wallet) return c.json({ sold: false });

  const [row] = await db
    .select({ id: listings.id })
    .from(listings)
    .where(
      and(
        eq(listings.contentId,    contentId),
        eq(listings.sellerWallet, wallet),
        eq(listings.status,       "sold")
      )
    )
    .limit(1);

  return c.json({ sold: !!row });
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

// ─── POST /:id/fulfill — execute token transfer seller→buyer (backend-mediated) ─

const fulfillSchema = z.object({
  buyer_wallet:  z.string().min(32),
  tx_signature:  z.string().min(40), // SOL payment tx already confirmed by buyer
  amount_paid:   z.string().or(z.number()),
});

listingsRouter.post(
  "/:id/fulfill",
  zValidator("json", fulfillSchema),
  async (c) => {
    const buyerWallet = extractWallet(c.req.header("authorization"));
    if (!buyerWallet) return c.json({ error: "Unauthorized" }, 401);

    const { id }  = c.req.param();
    const body    = c.req.valid("json");

    // Load listing
    const [listing] = await db
      .select()
      .from(listings)
      .where(eq(listings.id, id))
      .limit(1);

    if (!listing)                   return c.json({ error: "Listing not found" }, 404);
    if (listing.status !== "active") return c.json({ error: "Listing already closed" }, 400);
    if (listing.sellerWallet === buyerWallet)
      return c.json({ error: "Cannot buy your own listing" }, 400);

    // Load content for mint address
    const [contentRow] = await db
      .select({ mintAddress: contentTable.mintAddress, accessMint: contentTable.accessMint, authorWallet: contentTable.authorWallet })
      .from(contentTable)
      .where(eq(contentTable.contentId, listing.contentId))
      .limit(1);

    if (!contentRow) return c.json({ error: "Content not found" }, 404);

    const mintAddress = listing.mintAddress ?? contentRow.mintAddress ?? contentRow.accessMint;
    if (!mintAddress || mintAddress === "pending")
      return c.json({ error: "Content has no SPL mint — contact support" }, 400);

    try {
      // Execute token transfer seller → buyer (or mint new if legacy)
      const transferSig = await transferTokenFromSeller(
        mintAddress,
        listing.sellerWallet,
        buyerWallet,
        solanaConnection
      );

      // Mark listing as sold
      await db
        .update(listings)
        .set({ status: "sold", updatedAt: new Date() })
        .where(eq(listings.id, id));

      // Record purchase for buyer (access record)
      const amountPaid =
        typeof body.amount_paid === "string"
          ? BigInt(body.amount_paid)
          : BigInt(Math.round(Number(body.amount_paid)));

      await db.insert(purchases).values({
        contentId:    listing.contentId,
        buyerWallet,
        authorWallet: contentRow.authorWallet,
        accessMint:   mintAddress,
        txSignature:  body.tx_signature,
        amountPaid,
        paymentToken: "SOL",
      }).onConflictDoNothing();

      console.log(`[fulfill] Listing ${id} sold: ${listing.sellerWallet.slice(0, 8)} → ${buyerWallet.slice(0, 8)} | transfer: ${transferSig.slice(0, 12)}`);

      return c.json({ ok: true, transfer_sig: transferSig });
    } catch (err: any) {
      console.error(`[fulfill] Error for listing ${id}:`, err?.message);
      return c.json({ error: `Transfer failed: ${err?.message?.slice(0, 100) ?? "unknown"}` }, 500);
    }
  }
);
