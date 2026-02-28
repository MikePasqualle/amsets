import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and, ne, desc } from "drizzle-orm";
import { db } from "../db/index";
import { content as contentTable, purchases } from "../db/schema";
import { cacheGet, cacheSet, cacheDel } from "../db/redis";
import { verifyUserJwt, verifyContentJwt } from "../services/jwt.service";
import { validateArweaveUri } from "../services/storage.service";
import { v4 as uuidv4 } from "uuid";

const contentRouter = new Hono();

// ─── Auth helper ──────────────────────────────────────────────────────────────

function extractWallet(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  try {
    return verifyUserJwt(authHeader.replace("Bearer ", "")).sub;
  } catch {
    return null;
  }
}

/** Serialize a DB content row for JSON responses (converts BigInt → string). */
function serializeContent(item: Record<string, unknown>) {
  return {
    ...item,
    basePrice: item.basePrice != null ? String(item.basePrice) : "0",
  };
}

// ─── IMPORTANT: specific routes MUST come before parameterized /:id ──────────

// ─── POST /api/v1/content/register ───────────────────────────────────────────

const registerSchema = z.object({
  storage_uri: z.string().refine(
    (uri) =>
      validateArweaveUri(uri) ||
      /^ar:\/\/pending_[a-zA-Z0-9]{1,64}$/.test(uri),
    {
      message:
        'Must be a valid Arweave URI ("ar://{43-char txId}") or "ar://pending_{id}"',
    }
  ),
  preview_cid: z.string().min(1),
  content_hash: z.string().length(64),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  base_price: z.number().int().positive(),
  payment_token: z.enum(["SOL", "USDC"]).default("SOL"),
  license: z
    .enum(["personal", "commercial", "derivative", "unlimited"])
    .default("personal"),
  // Phase 1+: These fields are embedded in the Arweave bundle — NOT stored in PostgreSQL.
  // Accepted here only as legacy fallback when Arweave upload fails.
  encrypted_key: z.string().optional(),
  lit_conditions_hash: z.string().optional(),
  // Phase 2: Token system fields
  total_supply: z.number().int().min(1).default(1),
  royalty_bps: z.number().int().min(0).max(5000).default(1000),
  mime_type: z.string().optional(),
});

contentRouter.post(
  "/register",
  zValidator("json", registerSchema),
  async (c) => {
    const wallet = extractWallet(c.req.header("Authorization"));
    if (!wallet) return c.json({ error: "Unauthorized" }, 401);

    const body = c.req.valid("json");
    const contentId = uuidv4().replace(/-/g, "");

    // Build the preview URI from the IPFS CID provided by the client.
    // Metadata upload to Pinata is done client-side — backend is just a cache layer.
    const previewUri = body.preview_cid !== "bafyplaceholder"
      ? `ipfs://${body.preview_cid}`
      : "ipfs://bafyplaceholder";

    const [record] = await db
      .insert(contentTable)
      .values({
        contentId,
        authorWallet: wallet,
        title: body.title,
        description: body.description,
        category: body.category ?? "general",
        tags: body.tags ?? [],
        storageUri: body.storage_uri,
        previewUri,
        contentHash: body.content_hash,
        accessMint: "pending",
        onChainPda: "pending",
        basePrice: BigInt(body.base_price),
        paymentToken: body.payment_token,
        license: body.license,
        status: "draft",
        encryptedKey: body.encrypted_key ?? null,
        litConditionsHash: body.lit_conditions_hash ?? null,
        totalSupply: body.total_supply,
        royaltyBps: body.royalty_bps,
        mimeType: body.mime_type ?? null,
      })
      .returning({ id: contentTable.id, contentId: contentTable.contentId });

    // Bust both the individual content cache (prevent stale pending record)
    // and the marketplace listing cache so the draft appears immediately.
    await cacheDel(`content:${contentId}`);
    await cacheDel(`marketplace:all::1:20`);

    return c.json({
      record_id: record.id,
      content_id: contentId,
      anchor_params: {
        content_id: contentId,
        content_hash: body.content_hash,
        storage_uri: body.storage_uri,
        preview_uri: previewUri,
        base_price: body.base_price,
        payment_token: body.payment_token,
        license: body.license,
      },
    });
  }
);

// ─── GET /api/v1/content/by-author/:wallet ────────────────────────────────────
// Must be defined BEFORE /:id — otherwise Hono matches /:id first.
// Returns all non-archived content for the authenticated wallet.

contentRouter.get("/by-author/:wallet", async (c) => {
  const wallet = c.req.param("wallet");
  const authWallet = extractWallet(c.req.header("Authorization"));

  if (!authWallet || authWallet !== wallet) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const items = await db
    .select({
      id: contentTable.id,
      contentId: contentTable.contentId,
      title: contentTable.title,
      description: contentTable.description,
      category: contentTable.category,
      tags: contentTable.tags,
      previewUri: contentTable.previewUri,
      authorWallet: contentTable.authorWallet,
      basePrice: contentTable.basePrice,
      paymentToken: contentTable.paymentToken,
      license: contentTable.license,
      accessMint: contentTable.accessMint,
      onChainPda: contentTable.onChainPda,
      status: contentTable.status,
      contentHash: contentTable.contentHash,
      createdAt: contentTable.createdAt,
    })
    .from(contentTable)
    .where(
      and(
        eq(contentTable.authorWallet, wallet),
        ne(contentTable.status, "archived")
      )
    )
    .orderBy(desc(contentTable.createdAt));

  return c.json({ items: items.map(serializeContent) });
});

// ─── GET /api/v1/content/library/:wallet ─────────────────────────────────────
// Returns all content purchased by the authenticated wallet (from DB cache).
// Primary source of truth is on-chain AccessReceipt PDAs (checked client-side).
// Must be defined BEFORE /:id.

contentRouter.get("/library/:wallet", async (c) => {
  const wallet = c.req.param("wallet");
  const authWallet = extractWallet(c.req.header("Authorization"));

  if (!authWallet || authWallet !== wallet) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // JOIN purchases with content to return full content details
  const rows = await db
    .select({
      purchaseId: purchases.id,
      purchasedAt: purchases.purchasedAt,
      amountPaid: purchases.amountPaid,
      txSignature: purchases.txSignature,
      contentId: contentTable.contentId,
      title: contentTable.title,
      description: contentTable.description,
      category: contentTable.category,
      previewUri: contentTable.previewUri,
      authorWallet: contentTable.authorWallet,
      basePrice: contentTable.basePrice,
      paymentToken: contentTable.paymentToken,
      license: contentTable.license,
      accessMint: contentTable.accessMint,
      status: contentTable.status,
    })
    .from(purchases)
    .innerJoin(
      contentTable,
      eq(purchases.contentId, contentTable.contentId)
    )
    .where(eq(purchases.buyerWallet, wallet))
    .orderBy(desc(purchases.purchasedAt));

  const serialized = rows.map((row) => ({
    ...row,
    basePrice: row.basePrice != null ? String(row.basePrice) : "0",
    amountPaid: row.amountPaid != null ? String(row.amountPaid) : "0",
  }));

  return c.json({ items: serialized });
});

// ─── GET /api/v1/content/:id — public content metadata ───────────────────────

contentRouter.get("/:id", async (c) => {
  const rawId = c.req.param("id");
  // Normalize: Helius returns 64-char hex (32 bytes); DB stores 32-char hex (16 bytes).
  // Accept both by truncating to 32 chars when the caller supplies the full on-chain ID.
  const id = rawId.length === 64 ? rawId.slice(0, 32) : rawId;

  const cacheKey = `content:${id}`;
  const cached = await cacheGet<unknown>(cacheKey);
  if (cached) return c.json(cached);

  const [item] = await db
    .select({
      id: contentTable.id,
      contentId: contentTable.contentId,
      title: contentTable.title,
      description: contentTable.description,
      category: contentTable.category,
      tags: contentTable.tags,
      previewUri: contentTable.previewUri,
      storageUri: contentTable.storageUri,
      mimeType: contentTable.mimeType,
      authorWallet: contentTable.authorWallet,
      basePrice: contentTable.basePrice,
      paymentToken: contentTable.paymentToken,
      license: contentTable.license,
      accessMint: contentTable.accessMint,
      mintAddress: contentTable.mintAddress,
      onChainPda: contentTable.onChainPda,
      status: contentTable.status,
      totalSupply: contentTable.totalSupply,
      royaltyBps: contentTable.royaltyBps,
      soldCount: contentTable.soldCount,
      encryptedKey: contentTable.encryptedKey,
      litConditionsHash: contentTable.litConditionsHash,
      createdAt: contentTable.createdAt,
    })
    .from(contentTable)
    .where(eq(contentTable.contentId, id))
    .limit(1);

  if (!item) return c.json({ error: "Content not found" }, 404);

  const serialized = serializeContent(item as Record<string, unknown>);
  await cacheSet(cacheKey, serialized, 600);
  return c.json(serialized);
});

// ─── PATCH /api/v1/content/:id/publish — promote draft → active ──────────────

contentRouter.patch("/:id/publish", async (c) => {
  const contentId = c.req.param("id");
  const wallet = extractWallet(c.req.header("Authorization"));
  if (!wallet) return c.json({ error: "Unauthorized" }, 401);

  const [item] = await db
    .select({ authorWallet: contentTable.authorWallet, status: contentTable.status })
    .from(contentTable)
    .where(eq(contentTable.contentId, contentId))
    .limit(1);

  if (!item) return c.json({ error: "Content not found" }, 404);
  if (item.authorWallet !== wallet)
    return c.json({ error: "Forbidden: you are not the author" }, 403);

  const body = await c.req.json().catch(() => ({}));
  const updateFields: Record<string, unknown> = {
    status: "active",
    updatedAt: new Date(),
  };
  if (body.on_chain_pda) updateFields.onChainPda = body.on_chain_pda;
  if (body.mint_address)  updateFields.mintAddress = body.mint_address;

  await db
    .update(contentTable)
    .set(updateFields)
    .where(eq(contentTable.contentId, contentId));

  await cacheDel(`content:${contentId}`);

  return c.json({ success: true, content_id: contentId, status: "active" });
});

// ─── POST /api/v1/content/:id/confirm — legacy endpoint ──────────────────────

const confirmSchema = z.object({
  tx_signature: z.string().min(80),
  access_mint: z.string().min(32).max(44),
  on_chain_pda: z.string().min(32).max(44),
});

contentRouter.post(
  "/:id/confirm",
  zValidator("json", confirmSchema),
  async (c) => {
    const contentId = c.req.param("id");
    const wallet = extractWallet(c.req.header("Authorization"));
    if (!wallet) return c.json({ error: "Unauthorized" }, 401);

    const { tx_signature, access_mint, on_chain_pda } = c.req.valid("json");

    await db
      .update(contentTable)
      .set({ accessMint: access_mint, onChainPda: on_chain_pda, status: "active" })
      .where(eq(contentTable.contentId, contentId));

    await cacheDel(`content:${contentId}`);
    return c.json({ success: true, tx_signature });
  }
);

// ─── GET /api/v1/content/:id/lit-data — Lit Protocol decryption keys ─────────

contentRouter.get("/:id/lit-data", async (c) => {
  const contentId = c.req.param("id");

  const contentTokenHeader = c.req.header("X-Content-Token");
  if (!contentTokenHeader) return c.json({ error: "Content token required" }, 401);

  let tokenPayload;
  try {
    tokenPayload = verifyContentJwt(contentTokenHeader);
  } catch {
    return c.json({ error: "Invalid or expired content token" }, 401);
  }

  if (tokenPayload.contentId !== contentId) {
    return c.json({ error: "Content token mismatch" }, 403);
  }

  const [item] = await db
    .select({
      encryptedKey: contentTable.encryptedKey,
      litConditionsHash: contentTable.litConditionsHash,
      accessMint: contentTable.accessMint,
    })
    .from(contentTable)
    .where(eq(contentTable.contentId, contentId))
    .limit(1);

  if (!item) return c.json({ error: "Content not found" }, 404);

  return c.json({
    encrypted_key: item.encryptedKey,
    lit_conditions_hash: item.litConditionsHash,
    access_mint: item.accessMint,
  });
});

export { contentRouter };
