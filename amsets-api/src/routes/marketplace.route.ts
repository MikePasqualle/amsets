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
import { eq, ilike, and, desc, inArray } from "drizzle-orm";
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
  if (records.length === 0) return [];

  const onChainIds = records.map((r) => r.contentId.slice(0, 32));

  // Fetch ALL DB rows for the on-chain IDs (both active and draft) so we can
  // check the DB status for each record and auto-sync stale drafts.
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
      status:      content.status,
      onChainPda:  content.onChainPda,
    })
    .from(content)
    .where(inArray(content.contentId, onChainIds));

  const dbMap = new Map(dbRows.map((r) => [r.contentId.slice(0, 32), r]));

  // Auto-sync: content that is confirmed on-chain but still shows "draft" in DB
  // means the PATCH /publish call failed after the Solana tx. Fix it now.
  const draftIds = dbRows
    .filter((r) => r.status === "draft" && onChainIds.includes(r.contentId.slice(0, 32)))
    .map((r) => r.contentId);

  if (draftIds.length > 0) {
    console.log(`[marketplace] Auto-syncing ${draftIds.length} on-chain records stuck in draft:`, draftIds);
    // Update in background — don't block the response
    db.update(content)
      .set({ status: "active" })
      .where(inArray(content.contentId, draftIds))
      .execute()
      .catch((err) => console.error("[marketplace] Auto-sync failed:", err));
    // Reflect immediately in our in-memory map so this response is correct
    draftIds.forEach((id) => {
      const row = dbMap.get(id.slice(0, 32));
      if (row) row.status = "active";
    });
  }

  return records
    .map((onChain) => {
      const normalizedId = onChain.contentId.slice(0, 32);
      const dbRow = dbMap.get(normalizedId);

      // If the DB record explicitly marks it draft AND it's not being auto-synced,
      // keep it out of the public marketplace. Only the author sees drafts.
      if (dbRow && dbRow.status === "draft") return null;

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
        status:       "active",
        isActive:     true,
        totalSupply:  dbRow?.totalSupply  ?? undefined,
        royaltyBps:   dbRow?.royaltyBps   ?? undefined,
        soldCount:    dbRow?.soldCount    ?? 0,
        mimeType:     dbRow?.mimeType     ?? null,
        createdAt:    dbRow?.createdAt,
      } as EnrichedRecord;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null) as EnrichedRecord[];
}

export { marketplaceRouter };
