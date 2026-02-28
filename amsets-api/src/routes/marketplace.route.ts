/**
 * Marketplace API route.
 *
 * Data flow (decentralized — Phase 3):
 *   Request → Redis (5 min TTL) → return cached
 *          ↓ (cache miss)
 *   Helius DAS API → fetch all ContentRecord PDAs → parse → enrich from Arweave bundles → cache
 *          ↓ (Helius unavailable)
 *   PostgreSQL fallback → cache
 *
 * PostgreSQL is the primary source for: title, description, category (cached from Arweave bundles).
 * Solana is the primary source for: price, status, access_mint, storage_uri.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, ilike, and, desc } from "drizzle-orm";
import { db } from "../db/index";
import { content } from "../db/schema";
import { cacheGet, cacheSet } from "../db/redis";
import { fetchAllContentRecords } from "../services/helius.service";

const marketplaceRouter = new Hono();

const listQuerySchema = z.object({
  category: z.string().optional(),
  search:   z.string().optional(),
  page:     z.coerce.number().int().min(1).default(1),
  limit:    z.coerce.number().int().min(1).max(50).default(20),
  source:   z.enum(["auto", "chain", "db"]).default("auto"),
});

/**
 * GET /api/v1/marketplace
 *
 * Returns paginated content visible to everyone.
 * Data source priority: Helius (on-chain) → PostgreSQL fallback.
 * Results are Redis-cached for 5 minutes.
 */
marketplaceRouter.get(
  "/",
  zValidator("query", listQuerySchema),
  async (c) => {
    const { category, search, page, limit, source } = c.req.valid("query");
    const offset    = (page - 1) * limit;
    const cacheKey  = `marketplace:${category ?? "all"}:${search ?? ""}:${page}:${limit}`;

    // ── Cache check ──────────────────────────────────────────────────────────
    if (source !== "chain") {
      const cached = await cacheGet<unknown>(cacheKey);
      if (cached) return c.json(cached);
    }

    // ── Try Helius (on-chain source) ─────────────────────────────────────────
    if (source !== "db" && process.env.HELIUS_API_KEY) {
      try {
        const chainRecords = await fetchAllContentRecords();

        if (chainRecords.length > 0) {
          // Enrich on-chain data with metadata from PostgreSQL cache
          const enriched = await enrichWithDbMetadata(chainRecords);

          // Apply filters
          let filtered = enriched;
          if (category) {
            filtered = filtered.filter((r) =>
              r.category?.toLowerCase() === category.toLowerCase()
            );
          }
          if (search) {
            const q = search.toLowerCase();
            filtered = filtered.filter(
              (r) => r.title?.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q)
            );
          }

          // Sort: active first, then by newest
          filtered.sort((a, b) => {
            if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
            return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
          });

          // Paginate
          const paginated = filtered.slice(offset, offset + limit);

          const response = {
            items:  paginated,
            page,
            limit,
            total:  filtered.length,
            source: "chain",
          };

          await cacheSet(cacheKey, response, 300);
          return c.json(response);
        }
      } catch (err) {
        console.warn("[marketplace] Helius fetch failed, falling back to PostgreSQL:", err);
      }
    }

    // ── PostgreSQL fallback ───────────────────────────────────────────────────
    // Only show published (active) content on the public marketplace.
    // Drafts are visible only in the author's own /my/content page.
    const conditions = [eq(content.status, "active")];
    if (category) conditions.push(eq(content.category, category));
    if (search)   conditions.push(ilike(content.title, `%${search}%`));

    const items = await db
      .select({
        id:           content.id,
        contentId:    content.contentId,
        title:        content.title,
        description:  content.description,
        category:     content.category,
        tags:         content.tags,
        previewUri:   content.previewUri,
        authorWallet: content.authorWallet,
        basePrice:    content.basePrice,
        paymentToken: content.paymentToken,
        license:      content.license,
        accessMint:   content.accessMint,
        onChainPda:   content.onChainPda,
        status:       content.status,
        storageUri:   content.storageUri,
        createdAt:    content.createdAt,
      })
      .from(content)
      .where(and(...conditions))
      .orderBy(desc(content.createdAt))
      .limit(limit)
      .offset(offset);

    const serialized = items.map((item) => ({
      ...item,
      basePrice: item.basePrice?.toString() ?? "0",
      isActive:  item.status === "active",
    }));

    const response = { items: serialized, page, limit, source: "db" };
    await cacheSet(cacheKey, response, 300);
    return c.json(response);
  }
);

// ─── Enrich on-chain records with PostgreSQL metadata ────────────────────────

interface EnrichedRecord {
  contentId: string;
  pdaAddress: string;
  title: string;
  description?: string;
  category?: string;
  tags?: string[];
  previewUri: string;
  authorWallet: string;
  basePrice: string;
  paymentToken: "SOL" | "USDC";
  license: string;
  accessMint: string;
  mintAddress?: string | null;
  onChainPda: string;
  storageUri: string;
  status: string;
  isActive: boolean;
  totalSupply?: number;
  royaltyBps?: number;
  soldCount?: number;
  mimeType?: string | null;
  createdAt?: Date;
}

async function enrichWithDbMetadata(
  records: Awaited<ReturnType<typeof fetchAllContentRecords>>
): Promise<EnrichedRecord[]> {
  // Pull all active DB rows in one query — includes token/supply fields needed by the frontend
  const dbRows = await db
    .select({
      contentId:   content.contentId,
      title:       content.title,
      description: content.description,
      category:    content.category,
      tags:        content.tags,
      previewUri:  content.previewUri,
      mintAddress: content.mintAddress,
      totalSupply: content.totalSupply,
      royaltyBps:  content.royaltyBps,
      soldCount:   content.soldCount,
      mimeType:    content.mimeType,
      createdAt:   content.createdAt,
    })
    .from(content)
    .where(eq(content.status, "active"));

  // Normalize keys to 32-char hex so lookup succeeds whether the on-chain
  // ID was deserialized as 32-char (fixed) or 64-char (legacy).
  const dbMap = new Map(dbRows.map((r) => [r.contentId.slice(0, 32), r]));

  return records.map((onChain) => {
    const normalizedId = onChain.contentId.slice(0, 32);
    const dbRow = dbMap.get(normalizedId);
    return {
      contentId:    normalizedId,
      pdaAddress:   onChain.pdaAddress,
      title:        dbRow?.title        ?? `Content ${normalizedId.slice(0, 8)}`,
      description:  dbRow?.description  ?? undefined,
      category:     dbRow?.category     ?? "general",
      tags:         dbRow?.tags         ?? [],
      previewUri:   dbRow?.previewUri   ?? onChain.previewUri,
      authorWallet: onChain.primaryAuthor,
      basePrice:    String(onChain.basePrice),
      paymentToken: onChain.paymentToken,
      license:      onChain.license,
      accessMint:   onChain.accessMint,
      mintAddress:  dbRow?.mintAddress  ?? null,
      onChainPda:   onChain.pdaAddress,
      storageUri:   onChain.storageUri,
      status:       onChain.isActive ? "active" : "inactive",
      isActive:     onChain.isActive,
      totalSupply:  dbRow?.totalSupply  ?? undefined,
      royaltyBps:   dbRow?.royaltyBps   ?? undefined,
      soldCount:    dbRow?.soldCount    ?? 0,
      mimeType:     dbRow?.mimeType     ?? null,
      createdAt:    dbRow?.createdAt,
    };
  });
}

export { marketplaceRouter };
