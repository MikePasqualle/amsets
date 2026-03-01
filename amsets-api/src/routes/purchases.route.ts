import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { Connection } from "@solana/web3.js";
import { db } from "../db/index";
import { purchases, content as contentTable } from "../db/schema";
import { verifyUserJwt } from "../services/jwt.service";
import { mintAccessTokenToUser } from "../services/mint.service";
import { cacheDel } from "../db/redis";

const solanaConnection = new Connection(
  `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
  "confirmed"
);

const purchasesRouter = new Hono();

function extractWallet(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return verifyUserJwt(authHeader.replace("Bearer ", "")).sub;
  } catch {
    return null;
  }
}

const createPurchaseSchema = z.object({
  content_id:    z.string().min(1),
  tx_signature:  z.string().min(80),
  receipt_pda:   z.string().min(32).max(44).optional(),
  amount_paid:   z.string().or(z.number()),
  payment_token: z.enum(["SOL", "USDC"]).default("SOL"),
  access_mint:   z.string().min(1).optional(),
});

/**
 * POST /api/v1/purchases
 *
 * Cache a completed on-chain purchase in PostgreSQL.
 * The purchase is already confirmed on Solana — this is just a cache write.
 * Idempotent: duplicate tx_signature returns the existing record.
 */
purchasesRouter.post(
  "/",
  zValidator("json", createPurchaseSchema),
  async (c) => {
    const buyerWallet = extractWallet(c.req.header("Authorization"));
    if (!buyerWallet) return c.json({ error: "Unauthorized" }, 401);

    const body = c.req.valid("json");

    // Idempotency check
    const [existing] = await db
      .select({ id: purchases.id })
      .from(purchases)
      .where(eq(purchases.txSignature, body.tx_signature))
      .limit(1);

    if (existing) return c.json({ success: true, purchase_id: existing.id, cached: true });

    // Fetch content to get author + accessMint
    const [contentRow] = await db
      .select({
        authorWallet: contentTable.authorWallet,
        accessMint:   contentTable.accessMint,
        paymentToken: contentTable.paymentToken,
      })
      .from(contentTable)
      .where(eq(contentTable.contentId, body.content_id))
      .limit(1);

    if (!contentRow) return c.json({ error: "Content not found" }, 404);

    const amountPaid =
      typeof body.amount_paid === "string"
        ? BigInt(body.amount_paid)
        : BigInt(Math.round(Number(body.amount_paid)));

    const effectiveMint = body.access_mint ?? contentRow.accessMint ?? null;

    const [record] = await db
      .insert(purchases)
      .values({
        contentId:    body.content_id,
        buyerWallet,
        authorWallet: contentRow.authorWallet,
        accessMint:   effectiveMint,
        txSignature:  body.tx_signature,
        amountPaid,
        paymentToken: body.payment_token,
      })
      .returning({ id: purchases.id });

    // Increment sold_count so available supply is accurate
    await db
      .update(contentTable)
      .set({ soldCount: sql`${contentTable.soldCount} + 1` })
      .where(eq(contentTable.contentId, body.content_id));

    // Invalidate Redis cache so next page load shows updated soldCount
    await cacheDel(`content:${body.content_id}`).catch(() => null);

    // Auto-mint 1 SPL Token-2022 access token to the buyer.
    // Non-fatal: the AccessReceipt PDA already proves purchase on-chain.
    // The token makes ownership visible in the wallet and enables resale.
    if (effectiveMint) {
      mintAccessTokenToUser(effectiveMint, buyerWallet, solanaConnection).catch((err) => {
        console.error(`[mint] Failed to mint access token for purchase ${record.id}:`, err?.message);
      });
    }

    return c.json({ success: true, purchase_id: record.id, cached: false, mint_triggered: !!effectiveMint }, 201);
  }
);

/**
 * GET /api/v1/purchases/my
 *
 * Returns all purchases for the authenticated wallet (from PostgreSQL cache).
 * For the decentralized version, use the on-chain AccessReceipt PDA check.
 */
purchasesRouter.get("/my", async (c) => {
  const buyerWallet = extractWallet(c.req.header("Authorization"));
  if (!buyerWallet) return c.json({ error: "Unauthorized" }, 401);

  const rows = await db
    .select({
      purchaseId:   purchases.id,
      purchasedAt:  purchases.purchasedAt,
      contentId:    purchases.contentId,
      txSignature:  purchases.txSignature,
      amountPaid:   purchases.amountPaid,
      paymentToken: purchases.paymentToken,
    })
    .from(purchases)
    .where(eq(purchases.buyerWallet, buyerWallet))
    .orderBy(desc(purchases.purchasedAt));

  const serialized = rows.map((r) => ({
    ...r,
    amountPaid: r.amountPaid != null ? String(r.amountPaid) : "0",
  }));

  return c.json({ purchases: serialized });
});

export { purchasesRouter };
