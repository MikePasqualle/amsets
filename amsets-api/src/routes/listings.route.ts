/**
 * Listings Route — secondary market for AMSETS access tokens.
 *
 * POST   /api/v1/listings               — create listing, move token to escrow
 * GET    /api/v1/listings/:contentId    — active listings (public)
 * GET    /check-sold/:contentId?wallet  — was wallet a seller who sold?
 * DELETE /api/v1/listings/:id           — cancel listing, return token from escrow
 * PATCH  /api/v1/listings/:id/sold      — mark sold (legacy compatibility)
 * POST   /api/v1/listings/:id/fulfill   — deliver token from escrow to buyer
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { Connection } from "@solana/web3.js";
import { db } from "../db/index";
import { listings, content as contentTable, purchases } from "../db/schema";
import { verifyUserJwt } from "../services/jwt.service";
import {
  moveTokenToEscrow,
  moveTokenFromEscrow,
  returnTokenFromEscrow,
  transferTokenFromSeller,
  resolveAuthorNftHolder,
} from "../services/mint.service";

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

// ─── POST / — create listing, move token to backend escrow ───────────────────

const createListingSchema = z.object({
  content_id:         z.string().min(1),
  price_lamports:     z.number().int().positive(),
  mint_address:       z.string().optional(),
  token_account:      z.string().optional(),
  on_chain_listing_pda: z.string().optional(), // ListingRecord PDA from on-chain tx
});

listingsRouter.post(
  "/",
  async (c, next) => {
    if (!extractWallet(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
    await next();
  },
  zValidator("json", createListingSchema),
  async (c) => {
    const sellerWallet = extractWallet(c.req.header("authorization"))!;

    const body = c.req.valid("json");

    // Verify content exists
    const [row] = await db
      .select({
        mintAddress:   contentTable.mintAddress,
        authorNftMint: contentTable.authorNftMint,
        status:        contentTable.status,
      })
      .from(contentTable)
      .where(eq(contentTable.contentId, body.content_id))
      .limit(1);

    if (!row) return c.json({ error: "Content not found" }, 404);
    if (row.status !== "active")
      return c.json({ error: "Cannot list draft content" }, 400);

    const effectiveMint = body.mint_address ?? row.mintAddress ?? null;
    if (!effectiveMint || effectiveMint === "pending")
      return c.json({ error: "Content has no SPL mint yet — cannot create listing" }, 400);

    // Prevent duplicate active listings from same seller for same content
    const [existing] = await db
      .select({ id: listings.id })
      .from(listings)
      .where(
        and(
          eq(listings.contentId,    body.content_id),
          eq(listings.sellerWallet, sellerWallet),
          eq(listings.status,       "active")
        )
      )
      .limit(1);

    if (existing) return c.json({ error: "You already have an active listing for this content" }, 409);

    // Move seller's access token to backend escrow ATA (via PermanentDelegate)
    let escrowAta: string | null = null;
    try {
      const result = await moveTokenToEscrow(effectiveMint, sellerWallet, solanaConnection);
      escrowAta = result.escrowAta;
      console.log(`[listings] Token moved to escrow ${escrowAta.slice(0, 8)}… for seller ${sellerWallet.slice(0, 8)}…`);
    } catch (err: any) {
      console.error(`[listings] Failed to move token to escrow: ${err?.message?.slice(0, 100)}`);
      // Continue — listing is still created so seller can try again or cancel
    }

    const [created] = await db
      .insert(listings)
      .values({
        contentId:          body.content_id,
        sellerWallet,
        priceLamports:      BigInt(body.price_lamports),
        mintAddress:        effectiveMint,
        tokenAccount:       body.token_account ?? null,
        onChainListingPda:  body.on_chain_listing_pda ?? null,
        escrowAta,
        status:             "active",
      })
      .returning();

    const { priceLamports, ...rest } = created;
    return c.json({ listing: { ...rest, price_lamports: priceLamports.toString() } }, 201);
  }
);

// ─── GET /:contentId — active listings for content ────────────────────────────

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

// ─── DELETE /:id — cancel listing, return token from escrow ──────────────────

listingsRouter.delete("/:id", async (c) => {
  const sellerWallet = extractWallet(c.req.header("authorization"));
  if (!sellerWallet) return c.json({ error: "Unauthorized" }, 401);

  const { id } = c.req.param();

  const [row] = await db
    .select({
      sellerWallet: listings.sellerWallet,
      status:       listings.status,
      mintAddress:  listings.mintAddress,
      escrowAta:    listings.escrowAta,
    })
    .from(listings)
    .where(eq(listings.id, id))
    .limit(1);

  if (!row) return c.json({ error: "Listing not found" }, 404);
  if (row.sellerWallet.toLowerCase() !== sellerWallet.toLowerCase())
    return c.json({ error: "Forbidden — only the listing creator can cancel it" }, 403);
  if (row.status !== "active")
    return c.json({ error: "Listing is already closed" }, 400);

  // Return token from escrow to seller
  if (row.mintAddress && row.escrowAta) {
    returnTokenFromEscrow(row.mintAddress, sellerWallet, solanaConnection).catch((err) => {
      console.error(`[listings] Failed to return token from escrow for listing ${id}:`, err?.message?.slice(0, 80));
    });
  }

  await db
    .update(listings)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(listings.id, id));

  return c.json({ ok: true });
});

// ─── PATCH /:id/sold — mark listing sold (legacy compatibility) ───────────────

const soldSchema = z.object({ tx_signature: z.string().min(40) });

listingsRouter.patch(
  "/:id/sold",
  async (c, next) => {
    if (!extractWallet(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
    await next();
  },
  zValidator("json", soldSchema),
  async (c) => {
    const buyerWallet = extractWallet(c.req.header("authorization"))!;

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

// ─── POST /:id/fulfill — deliver escrowed token to buyer ──────────────────────
// Called by frontend after execute_sale on-chain tx confirms.
// Backend burns escrow token + mints fresh to buyer, records purchase.

const fulfillSchema = z.object({
  buyer_wallet:  z.string().min(32),
  tx_signature:  z.string().min(1),
  amount_paid:   z.string().or(z.number()),
});

listingsRouter.post(
  "/:id/fulfill",
  async (c, next) => {
    if (!extractWallet(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
    await next();
  },
  zValidator("json", fulfillSchema),
  async (c) => {
    const buyerWallet = extractWallet(c.req.header("authorization"))!;

    const { id } = c.req.param();
    const body   = c.req.valid("json");

    // Load listing
    const [listing] = await db
      .select()
      .from(listings)
      .where(eq(listings.id, id))
      .limit(1);

    if (!listing)                   return c.json({ error: "Listing not found" }, 404);
    if (listing.status !== "active") return c.json({ error: "Listing already closed" }, 400);
    if (listing.sellerWallet.toLowerCase() === buyerWallet.toLowerCase())
      return c.json({ error: "Cannot buy your own listing" }, 400);

    // Load content for mint address and Author NFT
    const [contentRow] = await db
      .select({
        mintAddress:   contentTable.mintAddress,
        accessMint:    contentTable.accessMint,
        authorWallet:  contentTable.authorWallet,
        authorNftMint: contentTable.authorNftMint,
      })
      .from(contentTable)
      .where(eq(contentTable.contentId, listing.contentId))
      .limit(1);

    if (!contentRow) return c.json({ error: "Content not found" }, 404);

    const mintAddress = listing.mintAddress ?? contentRow.mintAddress ?? contentRow.accessMint;
    if (!mintAddress || mintAddress === "pending")
      return c.json({ error: "Content has no SPL mint — contact support" }, 400);

    // Resolve current Author NFT holder for royalty info (non-blocking)
    let royaltyHolder: string | null = null;
    if (contentRow.authorNftMint) {
      royaltyHolder = await resolveAuthorNftHolder(contentRow.authorNftMint, solanaConnection)
        .catch(() => null);
    }
    royaltyHolder ??= contentRow.authorWallet;

    try {
      // Deliver access token: burn from escrow + mint fresh to buyer
      let transferSig: string;
      if (listing.escrowAta) {
        transferSig = await moveTokenFromEscrow(mintAddress, buyerWallet, solanaConnection);
      } else {
        // Fallback for legacy listings without escrow
        transferSig = await transferTokenFromSeller(
          mintAddress,
          listing.sellerWallet,
          buyerWallet,
          solanaConnection
        );
      }

      // Mark listing as sold
      await db
        .update(listings)
        .set({ status: "sold", updatedAt: new Date() })
        .where(eq(listings.id, id));

      // Record purchase for buyer
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

      console.log(
        `[fulfill] Listing ${id} sold: ${listing.sellerWallet.slice(0, 8)} → ${buyerWallet.slice(0, 8)} | sig: ${transferSig.slice(0, 12)} | royalty→${royaltyHolder?.slice(0, 8)}`
      );

      return c.json({ ok: true, transfer_sig: transferSig, royalty_holder: royaltyHolder });
    } catch (err: any) {
      console.error(`[fulfill] Error for listing ${id}:`, err?.message);
      return c.json({ error: `Transfer failed: ${err?.message?.slice(0, 100) ?? "unknown"}` }, 500);
    }
  }
);
